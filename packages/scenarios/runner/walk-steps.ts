import { readdirSync } from 'node:fs'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseEventLogs, stringToHex, toEventSelector, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, erc20Abi, nonfungiblePositionManagerAbi, safe7579Abi, safeAbi, safeProxyFactoryAbi, smartSessionAbi } from '@mamoru/registry'
import { OPERATION_CALL, execTransactionData, signSafeTx } from '@mamoru/account/safe'
import { WALKAWAY_TOKENS, walkawayCalls, type WalkawayPosition } from '@mamoru/account/owner'
import { deployCallFromKit, recoveryKit, type RecoveryKit } from '@mamoru/account/recovery'
import { WHALE, ownerBatch, type World } from '../fixtures/world.ts'
import { processCmdline, writeJson, type StepResult } from '../report/index.ts'
import type { ScenarioCtx, StepHandler } from './context.ts'

const FALLBACK_HANDLER_SLOT = keccak256(stringToHex('fallback_manager.handler.address'))
const EXECUTION_SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)')

function world(ctx: ScenarioCtx): World {
  if (!ctx.world) throw new Error(`${ctx.scenario.id} needs a world`)
  return ctx.world
}

function check(step: string, ok: boolean, detail: string): StepResult {
  return { step, ok, detail }
}

/** The kit as the user downloaded it: plain JSON, read back without Mamoru state. */
async function downloadKit(ctx: ScenarioCtx, kit: RecoveryKit): Promise<RecoveryKit> {
  const path = `${ctx.dir}/recovery-kit.json`
  await writeJson(path, kit)
  return JSON.parse(await Bun.file(path).text()) as RecoveryKit
}

function forwarded(ctx: ScenarioCtx): number {
  return ctx.enginePort?.stats().forwarded ?? 0
}

/**
 * A local Mamoru service: workerd or `wrangler dev` (engine, app) or Alto
 * (bundler), judged by the launcher and script, not by free-text arguments.
 */
function serviceOf(argv: string[]): string | undefined {
  const head = argv.slice(0, 4).filter((a) => !/\s/.test(a)).map((a) => a.split('/').at(-1)!)
  if (head[0] === 'workerd') return 'workerd'
  if (head.includes('alto') || argv.slice(0, 4).some((a) => a.includes('@pimlico/alto'))) return 'alto'
  if ((head.includes('wrangler') || argv.slice(0, 4).some((a) => a.includes('/wrangler/'))) && argv.includes('dev')) return 'wrangler dev'
  return undefined
}

/**
 * The engine, the app and the bundler are not running on this host. MultiBaas
 * is remote: the walkaway path holds no client for it, only the fork RPC.
 */
const servicesOff: StepHandler = async () => {
  const found: string[] = []
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    const service = serviceOf(processCmdline(Number(pid)))
    if (service) found.push(`${pid} ${service}`)
  }
  return check('engine, app and bundler are not running', found.length === 0, found.join('; ') || 'no workerd, wrangler dev or Alto process')
}

/** Liquidity and tokens owed per position, read from the NonfungiblePositionManager. */
async function readPositions(w: World, account: Address, tokenIds: bigint[]) {
  const c = w.lab.client
  const npm = address('NonfungiblePositionManager')
  const deadline = BigInt(Number(await w.lab.timestamp()) + 3600)
  const positions: WalkawayPosition[] = []
  const collected: Record<string, bigint> = { USDC: 0n, cbBTC: 0n }
  for (const tokenId of tokenIds) {
    const p = await c.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] })
    const liquidity = p[7]
    positions.push({ tokenId, liquidity })
    // What decreaseLiquidity plus collect pays out, simulated as the account at the current block.
    const steps: Hex[] = [
      ...(liquidity > 0n
        ? [encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'decreaseLiquidity', args: [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }] })]
        : []),
      encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', args: [{ tokenId, recipient: account, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }] }),
    ]
    const r = await c.call({ account, to: npm, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'multicall', args: [steps] }) })
    const results = decodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'multicall', data: r.data! })
    const [a0, a1] = decodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', data: results.at(-1)! })
    for (const [token, amount] of [[p[2], a0], [p[3], a1]] as const) {
      const name = WALKAWAY_TOKENS.find((t) => address(t).toLowerCase() === token.toLowerCase())
      if (!name) throw new Error(`position ${tokenId} holds ${token}, outside the walkaway tokens`)
      collected[name]! += amount
    }
  }
  return { positions, collected, deadline }
}

/**
 * WALK-01: the backup owner closes everything from the recovery kit and the
 * chain alone. One Safe transaction through MultiSendCallOnly, sent and paid
 * by another development account.
 */
const ownerWalkaway: StepHandler = async (ctx) => {
  const w = world(ctx)
  const acct = w.a1
  const c = w.lab.client
  const out: StepResult[] = []
  const engineCalls = forwarded(ctx)

  const owners = await c.readContract({ address: acct.safe, abi: safeAbi, functionName: 'getOwners' })
  const kit = await downloadKit(
    ctx,
    recoveryKit({ chainId: w.lab.chainId, owners: [...owners], saltNonce: 1n, permissionIds: acct.grants.map((g) => g.permissionId), tokenIds: acct.managedTokenIds }),
  )
  out.push(check('recovery kit names the account', kit.address.toLowerCase() === acct.safe.toLowerCase() && kit.chainId === w.lab.chainId, `${kit.address} on ${kit.chainId}`))

  const safe = kit.address
  const recipient = acct.backupOwner.address
  const tokenIds = kit.tokenIds.map(BigInt)
  const { positions, collected, deadline } = await readPositions(w, safe, tokenIds)
  const before = {
    USDC: await w.lab.balanceOf('USDC', safe),
    cbBTC: await w.lab.balanceOf('cbBTC', safe),
    ownerUSDC: await w.lab.balanceOf('USDC', recipient),
    ownerCbBTC: await w.lab.balanceOf('cbBTC', recipient),
    ownerEth: await c.getBalance({ address: recipient }),
    safeEth: await c.getBalance({ address: safe }),
    nfts: await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [safe] }),
  }
  const amounts = { USDC: before.USDC + collected.USDC!, cbBTC: before.cbBTC + collected.cbBTC! }
  const calls = walkawayCalls({ account: safe, permissionIds: kit.permissionIds, positions, recipient, amounts, deadline })

  const r = await ownerBatch(w.lab, w.gasPayer, acct, calls)
  const success = r.receipt.logs.filter((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === EXECUTION_SUCCESS)
  out.push(
    check(
      'backup owner signs one Safe transaction, the gas payer sends it',
      r.ok && success.length === 1 && r.receipt.from.toLowerCase() === w.gasPayer.address.toLowerCase(),
      `${calls.length} calls through MultiSendCallOnly, ${r.receipt.gasUsed} gas paid by ${r.receipt.from}`,
    ),
  )

  const enabled: string[] = []
  for (const pid of kit.permissionIds) {
    const on = await c.readContract({ address: address('SmartSession'), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [pid, safe] })
    if (on) enabled.push(pid.slice(0, 10))
  }
  out.push(check('every grant in the kit is revoked', enabled.length === 0 && kit.permissionIds.length > 0, enabled.length ? `still enabled: ${enabled.join(', ')}` : `${kit.permissionIds.length} removed`))

  const alive: string[] = []
  for (const id of tokenIds) {
    const owner = await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', args: [id] }).catch(() => null)
    if (owner) alive.push(`${id} owned by ${owner}`)
  }
  const nfts = await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [safe] })
  out.push(check('every managed position is burned', alive.length === 0 && tokenIds.length > 0 && nfts === before.nfts - BigInt(tokenIds.length), alive.join('; ') || `${tokenIds.join(', ')} burned`))

  const after = {
    USDC: await w.lab.balanceOf('USDC', safe),
    cbBTC: await w.lab.balanceOf('cbBTC', safe),
    ownerUSDC: await w.lab.balanceOf('USDC', recipient),
    ownerCbBTC: await w.lab.balanceOf('cbBTC', recipient),
  }
  const moved = after.ownerUSDC - before.ownerUSDC === amounts.USDC && after.ownerCbBTC - before.ownerCbBTC === amounts.cbBTC
  out.push(
    check(
      'USDC and cbBTC are at the owner address',
      moved && after.USDC === 0n && after.cbBTC === 0n && amounts.USDC > 0n && amounts.cbBTC > 0n,
      `owner received ${amounts.USDC} USDC and ${amounts.cbBTC} cbBTC; account holds ${after.USDC} USDC, ${after.cbBTC} cbBTC`,
    ),
  )

  const ownerEth = await c.getBalance({ address: recipient })
  const safeEth = await c.getBalance({ address: safe })
  out.push(check('the owner and the account paid no gas', ownerEth === before.ownerEth && safeEth === before.safeEth, `owner ETH ${before.ownerEth} -> ${ownerEth}, account ETH ${before.safeEth} -> ${safeEth}`))
  out.push(check('the walkaway made no call through the engine port', forwarded(ctx) === engineCalls, `${forwarded(ctx) - engineCalls} engine calls`))
  return out
}

/**
 * WALK-04: a counterfactual account holding USDC. The owner deploys it from
 * the kit parameters and withdraws, with no Mamoru code on the path.
 */
const counterfactualWalkaway: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const c = w.lab.client
  const out: StepResult[] = []
  const engineCalls = forwarded(ctx)
  const owner = w.a1.backupOwner
  const deposit = BigInt((args.usdc as number | undefined) ?? 1_000_000_000)

  // fx-owners with a salt no fixture has used: fx-safe, counterfactual variant.
  const kit = await downloadKit(
    ctx,
    recoveryKit({ chainId: w.lab.chainId, owners: [address('SafeWebAuthnSharedSigner'), owner.address], saltNonce: BigInt((args.saltNonce as number | undefined) ?? 4), permissionIds: [], tokenIds: [] }),
  )
  const codeBefore = await c.getCode({ address: kit.address })
  out.push(check('the kit address has no code yet', !codeBefore || codeBefore === '0x', `${kit.address} on ${kit.chainId}`))

  // fx-usdc on the counterfactual address.
  await w.lab.whaleTransfer('USDC', WHALE, kit.address, deposit)
  out.push(check('USDC is sent to the counterfactual address', (await w.lab.balanceOf('USDC', kit.address)) === deposit, `${deposit} USDC`))

  // The owner deploys with the kit parameters alone.
  const deploy = deployCallFromKit(kit)
  const d = await w.lab.send(owner, deploy.to, deploy.data)
  const created = d.ok ? parseEventLogs({ abi: safeProxyFactoryAbi, logs: d.receipt.logs, eventName: 'ProxyCreation' })[0]?.args.proxy : undefined
  const match = !!created && created.toLowerCase() === kit.address.toLowerCase()
  if (match) ctx.codes.add('ONB_ADDRESS_MATCH')
  out.push({ step: 'the owner deploys the Safe from the kit', ok: match, detail: `${match ? 'ONB_ADDRESS_MATCH' : 'address differs'}: deployed ${created ?? 'nothing'}, kit ${kit.address}`, codes: match ? ['ONB_ADDRESS_MATCH'] : [] })
  if (!match) return out

  const safe = kit.address
  const owners = await c.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })
  const threshold = await c.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' })
  const adapter = await c.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [kit.modules.adapter] })
  const handler = await c.getStorageAt({ address: safe, slot: FALLBACK_HANDLER_SLOT })
  const sessions = await c.readContract({ address: safe, abi: safe7579Abi, functionName: 'isModuleInstalled', args: [1n, address('SmartSession'), '0x'] })
  const setupOk =
    owners.map((o) => o.toLowerCase()).join() === kit.owners.map((o) => o.toLowerCase()).join() &&
    threshold.toString() === kit.setup.threshold &&
    adapter &&
    `0x${(handler ?? '0x').slice(-40)}`.toLowerCase() === kit.modules.adapter.toLowerCase() &&
    sessions
  out.push(check('the deployed Safe has the kit owners and modules', setupOk, `owners ${owners.length}, threshold ${threshold}, Safe7579 ${adapter}, SmartSession ${sessions}`))

  // The owner withdraws with one Safe transaction it signs and sends itself.
  const ownerBefore = await w.lab.balanceOf('USDC', owner.address)
  const nonce = await c.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
  const tx = { to: address('USDC'), value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner.address, deposit] }), operation: OPERATION_CALL as 0, nonce }
  const signature = await signSafeTx(owner, safe, w.lab.chainId, tx)
  const r = await w.lab.send(owner, safe, execTransactionData(tx, signature))
  const ownerAfter = await w.lab.balanceOf('USDC', owner.address)
  const left = await w.lab.balanceOf('USDC', safe)
  out.push(check('the owner withdraws the USDC', r.ok && ownerAfter - ownerBefore === deposit && left === 0n, `owner received ${ownerAfter - ownerBefore} USDC; account holds ${left}`))
  out.push(check('deploy and withdrawal made no call through the engine port', forwarded(ctx) === engineCalls, `${forwarded(ctx) - engineCalls} engine calls`))
  return out
}

export const WALK_STEPS: Record<string, StepHandler> = {
  'services-off': servicesOff,
  'owner-walkaway': ownerWalkaway,
  'counterfactual-walkaway': counterfactualWalkaway,
}
