// MONAD-01 (otto/mamoru#65): on a Monad fork, deploy the session policies as Base did (#62), activate an account
// with the session grants of the Monad lab policy, enter the WMON/USDC position with the session key, harvest the
// fees it earns and exit to USDC. Then the policies are shown enforcing: usage limit and time frame.
import { encodeFunctionData } from 'viem'
import { assertCodeHashes, entry, erc20Abi, monadRegistry, nonfungiblePositionManagerAbi, type Registry } from '@mamoru/registry'
import { MONAD_LAB_POLICIES } from '@mamoru/policy'
import { uniswapV3 } from '@mamoru/uniswap-v3'
import { Lab, devAccount } from '../fixtures/lab.ts'
import {
  activate,
  assertAccountStackParity,
  balances,
  buyUsdc,
  capsAt,
  churn,
  deployAccount,
  deployBasePolicies,
  forkRegistryWith,
  grantOf,
  mintedTokenId,
  poolSlot0,
  sessionOp,
  type MonadManifest,
  type MonadWorld,
  type PolicyDeploy,
} from './harness.ts'

export const DEPOSIT_USDC = 1_000_000_000n // 1,000 USDC
/** Half the deposit is swapped to WMON (enter-swap caps it at 25% per call: two calls). */
const SWAP_EACH = 240_000_000n

export type Monad01Result = { policies: PolicyDeploy[]; safe: string; tokenId: bigint; feesUsdc: bigint; harvestedUsdc: bigint; exitUsdc: bigint; checks: string[] }

export type Check = (ok: boolean, what: string) => void

/** Everything up to an open position held by a Safe whose session grants are enabled. Shared with the operator E2E. */
export async function buildPosition(lab: Lab, m: MonadManifest, check: Check, log: (s: string) => void): Promise<{ w: MonadWorld; policies: PolicyDeploy[]; tokenId: bigint }> {
  // LAB-05 on Monad: every monad.json entry has its pinned code hash on the fork.
  const hashes = await assertCodeHashes(lab.client, monadRegistry)
  check(hashes.every((c) => c.ok), `LAB-05: ${hashes.length} monad.json entries match their pinned code hash at block ${m.fork.block}`)

  // #62 inside the fork: the two policies from the Base calldata, same address, Base bytecode.
  const policies = await deployBasePolicies(lab, devAccount(3))
  for (const p of policies) check(true, `#62 ${p.name} at ${p.address}: ${p.runtimeBytes} bytes, code hash ${p.codeHash} = Base (Base tx ${p.baseTx.slice(0, 10)}…); ModuleRecord under Base's resolver${p.registerTx ? ' (registered)' : ''}`)
  const registry: Registry = forkRegistryWith(policies, (await lab.client.getBlock()).number)
  assertAccountStackParity(registry)
  check(true, 'account stack: every name the account and session encoders resolve has the Base address on the fork registry')
  const policy = MONAD_LAB_POLICIES[m.policy]
  if (!policy) throw new Error(`unknown Monad lab policy ${m.policy}`)
  check(entry(m.pool, registry).kind === 'pool' && policy.buckets.some((b) => b.pools.includes(m.pool)), `policy ${policy.policyId} allocates to ${m.pool}`)

  const lab2 = new Lab(lab.url, lab.chainId, registry)
  const relayer = devAccount(0)
  const acct = await deployAccount(lab2, relayer, BigInt(m.fork.block))
  const w: MonadWorld = { lab: lab2, registry, policy, relayer, trader: devAccount(8), acct, pool: m.pool, log }
  // Gas for the userOps' prefund: MON on the Safe (the EntryPoint takes it from the account).
  await lab2.setBalance(acct.safe, 50n * 10n ** 18n)
  const buyer = devAccount(2)
  await buyUsdc(w, buyer, DEPOSIT_USDC)
  const r = await lab2.send(buyer, entry('USDC', registry).address, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [acct.safe, DEPOSIT_USDC] }))
  check(r.ok && (await balances(lab2, acct.safe)).usdc === DEPOSIT_USDC, `deposit: ${fmt(DEPOSIT_USDC, 6)} USDC in Safe ${acct.safe}`)

  acct.caps = await capsAt(w, DEPOSIT_USDC)
  await activate(w, [{ name: 'enter-swap' }, { name: 'enter-mint' }], { trust: true })
  check(true, 'activation: registry trust, self-attestation of TimeFramePolicy/UsageLimitPolicy on Monad’s ModuleRegistry, enter-swap and enter-mint enabled (one passkey-signed owner transaction)')

  // Enter: two swaps of USDC to WMON (enter-swap), then the mint (enter-mint).
  const v3 = uniswapV3(registry)
  const fee = entry(m.pool, registry).fee!
  for (let i = 0; i < 2; i++) {
    const o = await sessionOp(w, 'enter-swap', [v3.approve('USDC', 'SwapRouter02', SWAP_EACH), v3.exactInputSingle({ account: acct.safe, tokenIn: 'USDC', tokenOut: 'WMON', fee, amountIn: SWAP_EACH, amountOutMinimum: 1n })])
    check(o.included && o.success, `enter-swap ${i + 1}: ${fmt(SWAP_EACH, 6)} USDC to WMON by the session key (${o.reason ?? 'included'})`)
  }
  const held = await balances(lab2, acct.safe)
  const { tick } = await poolSlot0(lab2, m.pool)
  const spacing = entry(m.pool, registry).tickSpacing!
  const half = Math.floor(policy.range.widthTicks / 2 / spacing) * spacing
  const center = Math.floor(tick / spacing) * spacing
  const deadline = BigInt(Number(await lab2.timestamp()) + 3600)
  // Within the enter-mint caps (usdcMint 50%, wmonMint 55% of the deposit): UsageLimit is not the only bound.
  const usdcIn = held.usdc - 1_000_000n < acct.caps.usdcMint! ? held.usdc - 1_000_000n : acct.caps.usdcMint!
  if (held.wmon > acct.caps.wmonMint!) throw new Error(`WMON ${held.wmon} over the wmonMint cap ${acct.caps.wmonMint}`)
  const mint = await sessionOp(w, 'enter-mint', [
    v3.approve('WMON', 'NonfungiblePositionManager', held.wmon),
    v3.approve('USDC', 'NonfungiblePositionManager', usdcIn),
    v3.mint({ account: acct.safe, pool: m.pool, tickLower: center - half, tickUpper: center + half + spacing, amount0Desired: held.wmon, amount1Desired: usdcIn, amount0Min: 1n, amount1Min: 1n, deadline }),
    v3.approve('WMON', 'NonfungiblePositionManager', 0n),
    v3.approve('USDC', 'NonfungiblePositionManager', 0n),
  ])
  check(mint.included && mint.success, `enter-mint: position in ${m.pool}, ticks ${center - half}..${center + half + spacing} around ${tick} (${mint.reason ?? 'included'})`)
  const receipt = await lab2.client.getTransactionReceipt({ hash: mint.txHash! })
  const tokenId = mintedTokenId(mint.txHash!, receipt.logs, acct.safe, registry)
  acct.tokenIds.push(tokenId)
  await activate(w, [{ name: 'manage', tokenId }], { trust: false })
  check(true, `manage grant enabled for position #${tokenId}`)
  return { w, policies, tokenId }
}

export function fmt(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, '0')
  return `${s.slice(0, -decimals)}.${s.slice(-decimals, -decimals + 2 || undefined)}`
}

export async function runMonad01(lab: Lab, m: MonadManifest, check: Check, log: (s: string) => void): Promise<Monad01Result> {
  const { w, policies, tokenId } = await buildPosition(lab, m, check, log)
  const { acct, registry } = w
  const v3 = uniswapV3(registry)
  const fee = entry(m.pool, registry).fee!
  const npm = entry('NonfungiblePositionManager', registry).address

  // Fees: a trader that is not the account swaps back and forth through the pool.
  await churn(w, 6, 5_000_000_000n)
  const owed = await lab.client.simulateContract({
    account: acct.safe,
    address: npm,
    abi: nonfungiblePositionManagerAbi,
    functionName: 'collect',
    args: [{ tokenId, recipient: acct.safe, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }],
  })
  const [fee0, fee1] = owed.result
  check(fee0 > 0n && fee1 > 0n, `fees accrued on #${tokenId}: ${fmt(fee0, 18)} WMON + ${fmt(fee1, 6)} USDC`)

  // Harvest: collect, then the WMON fees to USDC (manage grant).
  const before = await balances(w.lab, acct.safe)
  const h1 = await sessionOp(w, `manage:${tokenId}`, [v3.collect({ account: acct.safe, tokenId })])
  check(h1.included && h1.success, `harvest: collect #${tokenId} by the session key (${h1.reason ?? 'included'})`)
  const mid = await balances(w.lab, acct.safe)
  const wmonFees = mid.wmon - before.wmon
  const h2 = await sessionOp(w, `manage:${tokenId}`, [v3.approve('WMON', 'SwapRouter02', wmonFees), v3.exactInputSingle({ account: acct.safe, tokenIn: 'WMON', tokenOut: 'USDC', fee, amountIn: wmonFees, amountOutMinimum: 1n })])
  check(h2.included && h2.success, `harvest: ${fmt(wmonFees, 18)} WMON of fees converted to USDC (${h2.reason ?? 'included'})`)
  const after = await balances(w.lab, acct.safe)
  const harvested = after.usdc - before.usdc
  check(harvested > 0n, `harvest: +${fmt(harvested, 6)} USDC in the Safe`)

  // Exit: decrease all, collect, WMON to USDC, burn.
  const pos = await lab.client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] })
  const deadline = BigInt(Number(await w.lab.timestamp()) + 3600)
  const x1 = await sessionOp(w, `manage:${tokenId}`, [v3.decreaseLiquidity({ tokenId, liquidity: pos[7], amount0Min: 0n, amount1Min: 0n, deadline }), v3.collect({ account: acct.safe, tokenId }), v3.burn(tokenId)])
  check(x1.included && x1.success, `exit: decrease ${pos[7]} liquidity, collect and burn #${tokenId} (${x1.reason ?? 'included'})`)
  const out = await balances(w.lab, acct.safe)
  const x2 = await sessionOp(w, `manage:${tokenId}`, [v3.approve('WMON', 'SwapRouter02', out.wmon), v3.exactInputSingle({ account: acct.safe, tokenIn: 'WMON', tokenOut: 'USDC', fee, amountIn: out.wmon, amountOutMinimum: 1n })])
  check(x2.included && x2.success, `exit: ${fmt(out.wmon, 18)} WMON back to USDC (${x2.reason ?? 'included'})`)
  const end = await balances(w.lab, acct.safe)
  check(end.wmon === 0n, 'exit: no WMON left in the Safe')
  // Two swaps through a 0.30% pool and the trader's moves of the price: the exit is within a few percent of the deposit.
  check(end.usdc * 100n >= DEPOSIT_USDC * 95n, `exit: ${fmt(end.usdc, 6)} USDC in the Safe from ${fmt(DEPOSIT_USDC, 6)} deposited`)

  // Enforcement by the deployed policies.
  // UsageLimitPolicy: enter-swap allows 8 userOps; 2 were used. Six more are included, the ninth is refused.
  const tiny = 1_000_000n
  const swapCalls = () => [v3.approve('USDC', 'SwapRouter02', tiny), v3.exactInputSingle({ account: acct.safe, tokenIn: 'USDC', tokenOut: 'WMON', fee, amountIn: tiny, amountOutMinimum: 1n })]
  const limit = grantOf(acct, 'enter-swap').grant.userOp.usageLimit
  for (let i = 3; i <= limit; i++) {
    const o = await sessionOp(w, 'enter-swap', swapCalls())
    if (!o.included) throw new Error(`enter-swap use ${i} of ${limit} refused: ${o.reason} ${o.validator ?? ''}`)
  }
  const over = await sessionOp(w, 'enter-swap', swapCalls())
  check(!over.included && over.validator === 'PolicyViolation(UsageLimitPolicy)', `UsageLimitPolicy: use ${limit + 1} of enter-swap (limit ${limit}) refused: ${over.reason}, ${over.validator}`)
  // A recipient that is not the account: refused by UniActionPolicy, whatever the usage.
  const thief = devAccount(9).address
  const steal = await sessionOp(w, `manage:${tokenId}`, [{ ...v3.collect({ account: acct.safe, tokenId }), data: v3.collect({ account: thief, tokenId }).data }])
  check(!steal.included && steal.validator === 'PolicyViolation(UniActionPolicy)', `UniActionPolicy: collect to another recipient refused: ${steal.reason}, ${steal.validator}`)
  // TimeFramePolicy: past validUntil the grant is dead.
  const until = grantOf(acct, 'enter-mint').grant.userOp.validUntil
  await w.lab.warp(until - Number(await w.lab.timestamp()) + 60)
  const late = await sessionOp(w, 'enter-mint', [v3.approve('USDC', 'NonfungiblePositionManager', 0n)])
  check(!late.included && /^AA22/.test(late.reason ?? ''), `TimeFramePolicy: enter-mint after validUntil refused: ${late.reason}, ${late.validator}`)

  return { policies, safe: acct.safe, tokenId, feesUsdc: fee1, harvestedUsdc: harvested, exitUsdc: end.usdc, checks: [] }
}
