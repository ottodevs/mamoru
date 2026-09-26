import { createECDH } from 'node:crypto'
import { encodeFunctionData, getAddress, parseEventLogs, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, nonfungiblePositionManagerAbi, safeAbi, safeProxyFactoryAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { computeCaps, instantiateGrant, type Caps, type GrantName, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import {
  OPERATION_CALL,
  configureSharedSigner,
  createProxyCall,
  execTransactionData,
  multiSendCallOnly,
  packVerifiers,
  signSafeTx,
  type MultiSendCall,
  type SafeTx,
} from '@mamoru/account/safe'
import { activationCall, registryTrustCalls, revocationCalls } from '@mamoru/account/sessions'
import { SessionLedger } from '@mamoru/account/precheck'
import { approve, exactInputSingle, mint } from '@mamoru/uniswap-v3'
import { Lab, devAccount, type TxResult } from './lab.ts'
import { sendSessionOp, type SessionOpOutcome } from './session-op.ts'

/** Public holder of USDC and cbBTC on Base at the catalog block, impersonated for fx-usdc and fx-whale. */
export const WHALE: Address = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')

export const DEPOSIT_USDC = 10_000_000_000n
export const SECOND_DEPOSIT_USDC = 5_000_000_000n
export const GAS_RESERVE_WEI = 50_000_000_000_000_000n
export const POOL = 'pool:USDC/cbBTC/500'

/** Fixed test scalars for the software passkeys. Test material only. */
const PASSKEY_SCALARS = {
  a1: '0x1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100',
  a2: '0x2f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
} as const

export function passkeyPublicKey(scalar: Hex): { x: bigint; y: bigint } {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(scalar.slice(2), 'hex'))
  const pub = ecdh.getPublicKey()
  return { x: BigInt(`0x${pub.subarray(1, 33).toString('hex')}`), y: BigInt(`0x${pub.subarray(33, 65).toString('hex')}`) }
}

export type ActiveGrant = { name: string; grant: SessionGrant; permissionId: Hex }

export type AccountFixture = {
  label: string
  safe: Address
  backupOwner: PrivateKeyAccount
  passkey: { x: bigint; y: bigint }
  sessionKey: PrivateKeyAccount
  caps: Caps
  grants: ActiveGrant[]
  /** Positions minted by the session and covered by a manage grant. */
  managedTokenIds: bigint[]
  ownerTokenIds: bigint[]
  ledger: SessionLedger
  signedOwnerTxs: { tx: SafeTx; signature: Hex; data: Hex }[]
}

export type World = {
  lab: Lab
  policy: PolicyVersion
  relayer: PrivateKeyAccount
  gasPayer: PrivateKeyAccount
  attacker: PrivateKeyAccount
  a1: AccountFixture
  a2: AccountFixture
  fixtures: string[]
  t0: number
  saltCounter: number
  /** Every session userOp built in this world, with the pre-check and chain verdicts (SESS-25). */
  opLog: OpRecord[]
  /** Label of the scenario step that is running, for the log. */
  context: string
  /** Engine-side reads go through the engine port, which refuses anvil methods. */
  engineNow: () => Promise<number>
}

export type OpRecord = {
  context: string
  grant: string
  batch: string
  precheck: string
  verdict: string
  failedOp?: string
  /** Revert data of the account's validation, from FailedOpWithRevert. */
  inner?: Hex
  /** SmartSession.validateUserOp called directly from the account. */
  validator?: string
}

export async function ownerExec(
  lab: Lab,
  relayer: PrivateKeyAccount,
  acct: AccountFixture,
  op: { to: Address; data: Hex; operation?: 0 | 1 },
): Promise<TxResult & { tx: SafeTx; signature: Hex; data: Hex }> {
  const nonce = await lab.client.readContract({ address: acct.safe, abi: safeAbi, functionName: 'nonce' })
  const tx: SafeTx = { to: op.to, value: 0n, data: op.data, operation: op.operation ?? OPERATION_CALL, nonce }
  const signature = await signSafeTx(acct.backupOwner, acct.safe, lab.chainId, tx)
  const data = execTransactionData(tx, signature)
  const r = await lab.send(relayer, acct.safe, data)
  acct.signedOwnerTxs.push({ tx, signature, data })
  return { ...r, tx, signature, data }
}

export async function ownerBatch(lab: Lab, relayer: PrivateKeyAccount, acct: AccountFixture, calls: MultiSendCall[]) {
  const b = multiSendCallOnly(calls)
  return ownerExec(lab, relayer, acct, { to: b.to, data: b.data, operation: b.operation })
}

function must(r: TxResult, what: string): void {
  if (!r.ok) throw new Error(`fixture step failed: ${what} (${r.hash})`)
}

export async function poolTick(lab: Lab): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const s = await lab.client.readContract({ address: address(POOL), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  return { sqrtPriceX96: s[0], tick: s[1] }
}

export function rangeAround(tick: number, width: number, spacing: number): { tickLower: number; tickUpper: number } {
  const half = Math.floor(width / 2 / spacing) * spacing
  const base = Math.floor(tick / spacing) * spacing
  return { tickLower: base - half, tickUpper: base + half + spacing }
}

function mintedTokenId(r: TxResult, safe: Address): bigint {
  const logs = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: r.receipt.logs, eventName: 'Transfer' })
  const t = logs.find((l) => l.address.toLowerCase() === address('NonfungiblePositionManager').toLowerCase() && l.args.to.toLowerCase() === safe.toLowerCase())
  if (!t) throw new Error('no position minted to the account')
  return t.args.tokenId
}

function nextSalt(world: World): Hex {
  world.saltCounter++
  return `0x${world.saltCounter.toString(16).padStart(64, '0')}`
}

// fx-owners + fx-safe
async function deployAccount(lab: Lab, relayer: PrivateKeyAccount, label: string, backupIndex: number, sessionIndex: number, scalar: Hex, saltNonce: bigint): Promise<AccountFixture> {
  const backupOwner = devAccount(backupIndex)
  const passkey = passkeyPublicKey(scalar)
  const call = createProxyCall({
    owners: [address('SafeWebAuthnSharedSigner'), backupOwner.address],
    threshold: 1n,
    validators: [{ module: address('SmartSession'), initData: '0x' }],
    saltNonce,
  })
  const r = await lab.send(relayer, call.to, call.data)
  must(r, `${label} deploy`)
  const safe = parseEventLogs({ abi: safeProxyFactoryAbi, logs: r.receipt.logs, eventName: 'ProxyCreation' })[0]!.args.proxy
  const acct: AccountFixture = {
    label,
    safe,
    backupOwner,
    passkey,
    sessionKey: devAccount(sessionIndex),
    caps: {},
    grants: [],
    managedTokenIds: [],
    ownerTokenIds: [],
    ledger: new SessionLedger(),
    signedOwnerTxs: [],
  }
  const cfg = configureSharedSigner(passkey.x, passkey.y, packVerifiers(0x100, address('P256Verifier')))
  must(await ownerExec(lab, relayer, acct, cfg), `${label} passkey configure`)
  must(await ownerBatch(lab, relayer, acct, registryTrustCalls(safe)), `${label} registry trust`)
  return acct
}

export async function activateGrants(world: World, acct: AccountFixture, specs: { name: GrantName; tokenId?: bigint; caps?: Caps }[]): Promise<ActiveGrant[]> {
  const now = Number(await world.lab.timestamp())
  const grants = specs.map((s) =>
    instantiateGrant(world.policy, s.name, {
      account: acct.safe,
      sessionKey: acct.sessionKey.address,
      chainId: world.lab.chainId,
      salt: nextSalt(world),
      validAfter: now - 60,
      validUntil: now + world.policy.session.validitySeconds,
      caps: s.caps ?? acct.caps,
      tokenId: s.tokenId,
    }),
  )
  const act = activationCall(grants, acct.ledger.revokedIds())
  must(await ownerExec(world.lab, world.relayer, acct, { to: act.to, data: act.data }), `${acct.label} activation`)
  const active = grants.map((g, i) => ({ name: g.tokenId === undefined ? g.name : `${g.name}:${g.tokenId}`, grant: g, permissionId: act.permissionIds[i]! }))
  for (const a of active) acct.ledger.activate(a.permissionId, a.grant)
  acct.grants.push(...active)
  return active
}

export async function revokeGrants(world: World, acct: AccountFixture, names: string[]) {
  const targets = acct.grants.filter((g) => names.includes(g.name))
  const r = await ownerBatch(world.lab, world.relayer, acct, revocationCalls(targets.map((g) => g.permissionId)))
  must(r, `${acct.label} revoke`)
  for (const g of targets) acct.ledger.revoke(g.permissionId)
  return r
}

export function grantOf(acct: AccountFixture, name: string): ActiveGrant {
  const g = [...acct.grants].reverse().find((x) => x.name === name)
  if (!g) throw new Error(`${acct.label} has no grant ${name}`)
  return g
}

// fx-lp-direct: the session swaps and mints; the owner then scopes a manage grant to the new tokenId.
async function lpDirect(world: World, acct: AccountFixture, swapUsdc: bigint, mintUsdc: bigint): Promise<bigint> {
  const { lab } = world
  const swapGrant = grantOf(acct, 'enter-swap')
  const s = await sendSessionOp(world, acct, swapGrant, 'lp-direct-swap', [
    approve('USDC', 'SwapRouter02', swapUsdc),
    exactInputSingle({ account: acct.safe, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: swapUsdc, amountOutMinimum: 1n }),
  ])
  mustInclude(s, `${acct.label} lp-direct swap`)
  const cbbtc = await lab.balanceOf('cbBTC', acct.safe)
  const { tick } = await poolTick(lab)
  const range = rangeAround(tick, world.policy.range.widthTicks, 10)
  const deadline = BigInt(Number(await lab.timestamp()) + 3600)
  const m = await sendSessionOp(world, acct, grantOf(acct, 'enter-mint'), 'lp-direct-mint', [
    approve('USDC', 'NonfungiblePositionManager', mintUsdc),
    approve('cbBTC', 'NonfungiblePositionManager', cbbtc),
    mint({ account: acct.safe, pool: POOL, ...range, amount0Desired: mintUsdc, amount1Desired: cbbtc, amount0Min: 1n, amount1Min: 1n, deadline }),
    approve('USDC', 'NonfungiblePositionManager', 0n),
    approve('cbBTC', 'NonfungiblePositionManager', 0n),
  ])
  mustInclude(m, `${acct.label} lp-direct mint`)
  const tokenId = mintedTokenId({ hash: m.txHash!, receipt: m.receipt!, ok: true }, acct.safe)
  await activateGrants(world, acct, [{ name: 'manage', tokenId }])
  acct.managedTokenIds.push(tokenId)
  return tokenId
}

function mustInclude(o: SessionOpOutcome, what: string): void {
  if (o.verdict !== 'INCLUDED') throw new Error(`fixture session op not included: ${what}: ${o.verdict} ${o.failedOp?.reason ?? ''}`)
}

// fx-owner-position: the owner mints with its own transaction, outside any grant.
export async function ownerMint(world: World, acct: AccountFixture, usdc: bigint, cbbtc: bigint): Promise<bigint> {
  const { lab } = world
  const { tick } = await poolTick(lab)
  const range = rangeAround(tick, 4000, 10)
  const deadline = BigInt(Number(await lab.timestamp()) + 3600)
  const calls = [
    approve('USDC', 'NonfungiblePositionManager', usdc),
    approve('cbBTC', 'NonfungiblePositionManager', cbbtc),
    mint({ account: acct.safe, pool: POOL, ...range, amount0Desired: usdc, amount1Desired: cbbtc, amount0Min: 1n, amount1Min: 1n, deadline }),
    approve('USDC', 'NonfungiblePositionManager', 0n),
    approve('cbBTC', 'NonfungiblePositionManager', 0n),
  ]
  const r = await ownerBatch(world.lab, world.relayer, acct, calls.map((c) => ({ to: c.to, value: 0n, data: c.data })))
  must(r, `${acct.label} owner mint`)
  const tokenId = mintedTokenId(r, acct.safe)
  acct.ownerTokenIds.push(tokenId)
  return tokenId
}

async function capsFor(lab: Lab, policy: PolicyVersion, deposit: bigint): Promise<Caps> {
  const { sqrtPriceX96 } = await poolTick(lab)
  return computeCaps(policy, deposit, { cbBTC: { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n } })
}

/** Builds the SESS world on a fresh fork. The caller snapshots it. */
export async function buildSessWorld(lab: Lab, policy: PolicyVersion, engineNow: () => Promise<number>): Promise<World> {
  const relayer = devAccount(0)
  const world: World = {
    lab,
    policy,
    relayer,
    gasPayer: devAccount(2),
    attacker: devAccount(9),
    a1: undefined as never,
    a2: undefined as never,
    fixtures: [],
    t0: Number(await lab.timestamp()),
    saltCounter: 0,
    opLog: [],
    context: 'fixtures',
    engineNow,
  }
  // fx-owners, fx-safe
  world.a1 = await deployAccount(lab, relayer, 'A1', 1, 5, PASSKEY_SCALARS.a1, 1n)
  world.fixtures.push('fx-owners', 'fx-safe')
  // fx-gas
  must(await lab.send(world.gasPayer, world.a1.safe, '0x', GAS_RESERVE_WEI), 'fx-gas')
  world.fixtures.push('fx-gas')
  // fx-usdc, fx-whale
  await lab.whaleTransfer('USDC', WHALE, world.a1.safe, DEPOSIT_USDC)
  world.fixtures.push('fx-usdc', 'fx-whale')
  world.a1.caps = await capsFor(lab, policy, DEPOSIT_USDC)
  // fx-owner-position, before activation
  await lab.whaleTransfer('cbBTC', WHALE, world.a1.safe, 200_000n)
  await ownerMint(world, world.a1, 100_000_000n, 200_000n)
  world.fixtures.push('fx-owner-position')
  // fx-sessions
  await activateGrants(world, world.a1, [{ name: 'enter-swap' }, { name: 'enter-mint' }])
  world.fixtures.push('fx-sessions')
  // fx-lp-direct
  await lpDirect(world, world.a1, 2_000_000_000n, 2_000_000_000n)
  world.fixtures.push('fx-lp-direct')
  // fx-second-account
  world.a2 = await deployAccount(lab, relayer, 'A2', 6, 7, PASSKEY_SCALARS.a2, 2n)
  must(await lab.send(world.gasPayer, world.a2.safe, '0x', GAS_RESERVE_WEI), 'fx-gas A2')
  await lab.whaleTransfer('USDC', WHALE, world.a2.safe, SECOND_DEPOSIT_USDC)
  world.a2.caps = await capsFor(lab, policy, SECOND_DEPOSIT_USDC)
  await activateGrants(world, world.a2, [{ name: 'enter-swap' }, { name: 'enter-mint' }])
  await lpDirect(world, world.a2, 1_000_000_000n, 1_000_000_000n)
  world.fixtures.push('fx-second-account')
  return world
}

type AccountState = Pick<AccountFixture, 'grants' | 'managedTokenIds' | 'ownerTokenIds' | 'ledger' | 'signedOwnerTxs'>

/** The in-memory side of a chain snapshot: grants, positions and the engine ledger. The op log is kept across scenarios. */
export type WorldCheckpoint = Partial<Record<'a1' | 'a2', AccountState>>

function accountState(a: AccountFixture): AccountState {
  return { grants: [...a.grants], managedTokenIds: [...a.managedTokenIds], ownerTokenIds: [...a.ownerTokenIds], ledger: a.ledger.clone(), signedOwnerTxs: [...a.signedOwnerTxs] }
}

export function checkpointWorld(w: World): WorldCheckpoint {
  const cp: WorldCheckpoint = {}
  for (const k of ['a1', 'a2'] as const) if (w[k]) cp[k] = accountState(w[k])
  return cp
}

export function restoreWorld(w: World, cp: WorldCheckpoint): void {
  for (const k of ['a1', 'a2'] as const) {
    const s = cp[k]
    if (s && w[k]) Object.assign(w[k], accountState({ ...w[k], ...s }))
  }
}

/** M05 world: fx-owners, fx-safe, fx-gas and fx-usdc only. */
export async function buildBasicWorld(lab: Lab, policy: PolicyVersion, engineNow: () => Promise<number>): Promise<World> {
  const relayer = devAccount(0)
  const world: World = {
    lab,
    policy,
    relayer,
    gasPayer: devAccount(2),
    attacker: devAccount(9),
    a1: undefined as never,
    a2: undefined as never,
    fixtures: [],
    t0: Number(await lab.timestamp()),
    saltCounter: 0,
    opLog: [],
    context: 'fixtures',
    engineNow,
  }
  world.a1 = await deployAccount(lab, relayer, 'A1', 1, 5, PASSKEY_SCALARS.a1, 1n)
  must(await lab.send(world.gasPayer, world.a1.safe, '0x', GAS_RESERVE_WEI), 'fx-gas')
  await lab.whaleTransfer('USDC', WHALE, world.a1.safe, DEPOSIT_USDC)
  world.fixtures.push('fx-owners', 'fx-safe', 'fx-gas', 'fx-usdc')
  return world
}