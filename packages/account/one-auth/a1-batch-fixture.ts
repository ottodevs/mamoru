// otto/mamoru#348: V4 session batches built by `buildA1Batch` (and malformed ones), as a fixture contracts/action-policy/
// test/A1BatchParity.t.sol runs through the real MamoruGasPolicyV2.checkUserOpPolicy (Base, no fork). Each case says
// what the gas policy must answer (`shape`) and what `checkA1Batch` answers (`check`, the shape plus V4's static
// checkAction rules); batch.test.ts fails while the committed file differs from what this builds, and checks that
// `a1Shape` gives `shape` for every case. Regenerate: bun packages/account/one-auth/a1-batch-fixture.ts --write
import { writeFileSync } from 'node:fs'
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { encodeBatchExecution, encodeMode, encodeSingleExecution, type Execution } from '../safe/index.ts'
import { a1Abi, a1CallData, a1CallRefusal, a1Calls, A1_CHAINS, buildA1Batch, type A1Context, type A1Intent } from './batch.ts'

export const A1_FIXTURE_PATH = new URL('../../../contracts/action-policy/test/fixtures/a1-batches.json', import.meta.url)

const BASE = A1_CHAINS[8453]!
export const A1_FIXTURE_CTX: A1Context = { chainId: 8453, account: getAddress('0x0000000000000000000000000000000000a11ce0'), policy: '0x0000000000000000000000000000000000004444', t: 1_800_000_000n }
const USDC = BASE.stables[0]!
const USDT = BASE.stables[1]!
const WETH = BASE.wrapped
const CBBTC: Address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'
const POOL: Address = '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef'
const VAULT: Address = '0x000000000000000000000000000000000000Fa17'
const DL = A1_FIXTURE_CTX.t + 600n

const swap = (tokenIn: Address, amountIn: bigint): A1Intent => ({ kind: 'swap', params: { pool: POOL, tokenIn, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 4295128740n, deadline: DL } })
const mint: A1Intent = { kind: 'mint', params: { token0: USDC, token1: CBBTC, fee: 500, tickLower: -600, tickUpper: 600, amount0Desired: 1_000_000_000n, amount1Desired: 1_000_000n, amount0Min: 990_000_000n, amount1Min: 990_000n, recipient: A1_FIXTURE_CTX.account, deadline: DL } }
const decrease = (tokenId: bigint, extra: Partial<Extract<A1Intent, { kind: 'decrease' }>> = {}): A1Intent => ({ kind: 'decrease', tokenId, liquidity: 123_456_789n, amount0Min: 1_000n, amount1Min: 2_000n, deadline: DL, ...extra })

/** The batches the operator builds, by name (engine, sibling, remote, noema-d3's announceReady). */
export const A1_FIXTURE_INTENTS: readonly (readonly [string, readonly A1Intent[]])[] = [
  ['engine swap (entry)', [swap(USDC, 1_000_000_000n)]],
  ['engine mint', [mint]],
  ['engine increase', [{ kind: 'increase', token0: USDC, token1: CBBTC, params: { tokenId: 7n, amount0Desired: 5_000_000n, amount1Desired: 5_000n, amount0Min: 4_000_000n, amount1Min: 4_000n, deadline: DL } }]],
  ['engine increase, one side only', [{ kind: 'increase', token0: USDC, token1: CBBTC, params: { tokenId: 7n, amount0Desired: 5_000_000n, amount1Desired: 0n, amount0Min: 0n, amount1Min: 0n, deadline: DL } }]],
  ['engine rerange exit (checkExit + decrease + collect + burn)', [decrease(7n, { burn: true, positionLiquidity: 123_456_789n })]],
  ['engine reduce exit (checkExit + decrease + collect)', [decrease(7n)]],
  ['engine harvest (collect)', [{ kind: 'collect', tokenId: 7n }]],
  ['engine rerange of an emptied position (collect + burn)', [{ kind: 'collect', tokenId: 7n }, { kind: 'burn', tokenId: 7n }]],
  ['engine bridge out', [{ kind: 'bridge', domain: 15, token: USDC, amount: 25_000_000n, maxFee: 0n }]],
  ['engine bridge out, maxFee at the cap', [{ kind: 'bridge', domain: 15, token: USDC, amount: 25_000_000n, maxFee: 25_000n }]],
  ['engine vault deposit', [{ kind: 'deposit', vault: VAULT, asset: USDC, assets: 10_000_000n }]],
  ['engine vault redeem', [{ kind: 'redeem', vault: VAULT, shares: 9_000_000n }]],
  ['sibling wrap + swap', [{ kind: 'wrap', amount: 50_000_000_000_000_000n }, swap(WETH, 50_000_000_000_000_000n)]],
  ['unwrap', [{ kind: 'unwrap', amount: 1_000n }]],
  ['registerRemote', [{ kind: 'registerRemote', domain: 15, sessionKey: '0x00000000000000000000000000000000005e55e5' }]],
  ['announceReady (noema-d3)', [{ kind: 'announceReady', safe: A1_FIXTURE_CTX.account, toDomain: 0, sessionKey: '0x0000000000000000000000000000000000000000', permissionId: `0x${'0d'.repeat(32)}` }]],
  ['relay a readiness message', [{ kind: 'relayMessage', message: '0x0102', attestation: '0x0304' }]],
  ['two exits and a swap in one op', [decrease(7n), decrease(8n, { burn: true, positionLiquidity: 123_456_789n }), swap(CBBTC, 1_000n)]],
  ['two swaps of the same token', [swap(USDC, 1_000_000n), swap(USDC, 2_000_000n)]],
  ['mint then bridge (USDT and USDC)', [mint, { kind: 'bridge', domain: 0, token: USDT, amount: 1_000_000n, maxFee: 0n }]],
]

const ctx = A1_FIXTURE_CTX
const V4 = ctx.policy
const x = (target: Address, data: Hex, value = 0n): Execution => ({ target, value, callData: data })
const clock = (t: bigint) => x(V4, encodeFunctionData({ abi: a1Abi, functionName: 'clock', args: [t] }))
const approve = (token: Address, amount: bigint, spender: Address = V4) => x(token, encodeFunctionData({ abi: a1Abi, functionName: 'approve', args: [spender, amount] }))
const assertZero = (token: Address) => x(V4, encodeFunctionData({ abi: a1Abi, functionName: 'assertZero', args: [token] }))
const v4swap = x(V4, encodeFunctionData({ abi: a1Abi, functionName: 'swap', args: [{ pool: POOL, tokenIn: USDC, amountIn: 5n, amountOutMinimum: 1n, sqrtPriceLimitX96: 1n, deadline: DL }] }))
const checkExit = (liq: bigint) => x(V4, encodeFunctionData({ abi: a1Abi, functionName: 'checkExit', args: [7n, liq, 1_000n, 2_000n] }))
const dec = (target: Address = BASE.npm) => x(target, encodeFunctionData({ abi: a1Abi, functionName: 'decreaseLiquidity', args: [{ tokenId: 7n, liquidity: 99n, amount0Min: 1_000n, amount1Min: 2_000n, deadline: DL }] }))
const raw = (mode: Hex, xs: Execution[]) => encodeFunctionData({ abi: parseAbi(['function execute(bytes32,bytes)']), functionName: 'execute', args: [mode, encodeBatchExecution(xs)] })
const BATCH = encodeMode(1, 0)
const WRAP_DATA: Hex = '0xd0e30db0'
/** approve(V4, n) with the spender word's top byte set (Solidity's abi.decode of an address reverts on it). */
const dirtyApprove = (n: bigint): Hex => {
  const d = encodeFunctionData({ abi: a1Abi, functionName: 'approve', args: [V4, n] })
  return `${d.slice(0, 10)}01${d.slice(12)}` as Hex
}
const T = ctx.t

/** Hand-made batches, each with the gas policy's verdict (`shape`) and checkA1Batch's (`check`). */
export const A1_FIXTURE_RAW: readonly { name: string; callData: Hex; shape: boolean; check: boolean }[] = [
  { name: 'no leading clock', callData: raw(BATCH, [approve(USDC, 5n), v4swap, approve(USDC, 0n), assertZero(USDC)]), shape: false, check: false },
  { name: 'clock alone', callData: raw(BATCH, [clock(T)]), shape: false, check: false },
  { name: 'clock with value', callData: raw(BATCH, [{ ...clock(T), value: 1n }, v4swap]), shape: false, check: false },
  { name: 'clock second', callData: raw(BATCH, [v4swap, clock(T)]), shape: false, check: false },
  { name: 'claimed time at the slack (T = S)', callData: raw(BATCH, [clock(300n), v4swap]), shape: false, check: false },
  { name: 'claimed time past uint48 - S', callData: raw(BATCH, [clock((1n << 48n) - 300n), v4swap]), shape: false, check: false },
  { name: 'single mode', callData: encodeFunctionData({ abi: parseAbi(['function execute(bytes32,bytes)']), functionName: 'execute', args: [encodeMode(0, 0), encodeSingleExecution(v4swap)] }), shape: false, check: false },
  { name: 'try exec type', callData: raw(encodeMode(1, 1), [clock(T), v4swap]), shape: false, check: false },
  { name: 'approve never reset', callData: raw(BATCH, [clock(T), approve(USDC, 5n), v4swap]), shape: false, check: false },
  { name: 'reset without assertZero', callData: raw(BATCH, [clock(T), approve(USDC, 5n), v4swap, approve(USDC, 0n)]), shape: false, check: false },
  { name: 'assertZero not right after the reset', callData: raw(BATCH, [clock(T), approve(USDC, 5n), v4swap, approve(USDC, 0n), v4swap, assertZero(USDC)]), shape: false, check: false },
  { name: 'reset before the approve', callData: raw(BATCH, [clock(T), approve(USDC, 0n), assertZero(USDC), approve(USDC, 5n), v4swap]), shape: false, check: false },
  { name: 'reset on another token', callData: raw(BATCH, [clock(T), approve(USDC, 5n), v4swap, approve(USDT, 0n), assertZero(USDC)]), shape: false, check: false },
  { name: 'assertZero of another token', callData: raw(BATCH, [clock(T), approve(USDC, 5n), v4swap, approve(USDC, 0n), assertZero(USDT)]), shape: false, check: false },
  { name: 'reset of another spender', callData: raw(BATCH, [clock(T), approve(USDC, 5n), v4swap, approve(USDC, 0n, CBBTC), assertZero(USDC)]), shape: false, check: false },
  { name: 'decrease without checkExit', callData: raw(BATCH, [clock(T), dec()]), shape: false, check: false },
  { name: 'checkExit with another liquidity', callData: raw(BATCH, [clock(T), checkExit(98n), dec()]), shape: false, check: false },
  { name: 'checkExit not right before the decrease', callData: raw(BATCH, [clock(T), checkExit(99n), v4swap, dec()]), shape: false, check: false },
  { name: 'checkExit differing only in amount0Min', callData: raw(BATCH, [clock(T), x(V4, encodeFunctionData({ abi: a1Abi, functionName: 'checkExit', args: [7n, 99n, 999n, 2_000n] })), dec()]), shape: false, check: false },
  { name: 'checkExit differing only in amount1Min', callData: raw(BATCH, [clock(T), x(V4, encodeFunctionData({ abi: a1Abi, functionName: 'checkExit', args: [7n, 99n, 1_000n, 2_001n] })), dec()]), shape: false, check: false },
  // Review of #247: checkAction's own rules, where the gas policy's shape passes.
  { name: 'wrap with value 0 (checkAction refuses it)', callData: raw(BATCH, [clock(T), x(WETH, WRAP_DATA, 0n)]), shape: true, check: false },
  { name: 'unwrap with value (checkAction refuses it)', callData: raw(BATCH, [clock(T), x(WETH, encodeFunctionData({ abi: a1Abi, functionName: 'withdraw', args: [1n] }), 1n)]), shape: true, check: false },
  { name: 'wrap with value (accepted)', callData: raw(BATCH, [clock(T), x(WETH, WRAP_DATA, 1n)]), shape: true, check: true },
  { name: 'value to a target other than the wrapped native (checkAction refuses it)', callData: raw(BATCH, [clock(T), { ...v4swap, value: 1n }]), shape: true, check: false },
  { name: 'collect to another recipient (checkAction refuses it)', callData: raw(BATCH, [clock(T), x(BASE.npm, encodeFunctionData({ abi: a1Abi, functionName: 'collect', args: [{ tokenId: 7n, recipient: CBBTC, amount0Max: 1n, amount1Max: 1n }] }))]), shape: true, check: false },
  { name: 'approve on the position manager, reset (checkAction refuses it)', callData: raw(BATCH, [clock(T), approve(BASE.npm, 5n), approve(BASE.npm, 0n), x(V4, encodeFunctionData({ abi: a1Abi, functionName: 'assertZero', args: [BASE.npm] }))]), shape: true, check: false },
  { name: 'receiveMessage on another target (checkAction refuses it)', callData: raw(BATCH, [clock(T), x(USDC, encodeFunctionData({ abi: a1Abi, functionName: 'receiveMessage', args: ['0x01', '0x02'] }))]), shape: true, check: false },
  { name: 'approve with a dirty spender word, reset alike (checkAction refuses it)', callData: raw(BATCH, [clock(T), x(USDC, dirtyApprove(5n)), v4swap, x(USDC, dirtyApprove(0n)), assertZero(USDC)]), shape: true, check: false },
  { name: 'collect with a dirty recipient word (checkAction refuses it)', callData: raw(BATCH, [clock(T), x(BASE.npm, `${encodeFunctionData({ abi: a1Abi, functionName: 'collect', args: [{ tokenId: 7n, recipient: ctx.account, amount0Max: 1n, amount1Max: 1n }] }).slice(0, 74)}01${encodeFunctionData({ abi: a1Abi, functionName: 'collect', args: [{ tokenId: 7n, recipient: ctx.account, amount0Max: 1n, amount1Max: 1n }] }).slice(76)}` as Hex)]), shape: true, check: false },
  { name: 'checkExit + decrease by hand', callData: raw(BATCH, [clock(T), checkExit(99n), dec()]), shape: true, check: true },
  // What the gas policy leaves to V4's checkAction: its shape passes, the call itself is refused.
  { name: 'decrease elsewhere than the position manager (checkAction refuses it)', callData: raw(BATCH, [clock(T), dec(USDC)]), shape: true, check: false },
  { name: 'approve to the router, reset (checkAction refuses it)', callData: raw(BATCH, [clock(T), approve(USDC, 5n, CBBTC), v4swap, approve(USDC, 0n, CBBTC), assertZero(USDC)]), shape: true, check: false },
  { name: 'clock on another contract (checkAction refuses it)', callData: raw(BATCH, [{ ...clock(T), target: USDC }, v4swap]), shape: true, check: false },
  { name: 'an empty call (checkAction refuses it)', callData: raw(BATCH, [clock(T), x(USDC, '0x')]), shape: true, check: false },
]

export function a1Fixture() {
  const built = A1_FIXTURE_INTENTS.map(([name, intents]) => ({ name, callData: a1CallData(buildA1Batch(ctx, intents)), shape: true, check: true }))
  const cases = [...built, ...A1_FIXTURE_RAW]
  return {
    note: 'Generated by packages/account/one-auth/a1-batch-fixture.ts (otto/mamoru#348). Do not edit.',
    chainId: ctx.chainId,
    account: ctx.account,
    policy: ctx.policy,
    npm: BASE.npm,
    t: Number(ctx.t),
    count: cases.length,
    // `decodable`: a batch-mode execute; `actions`: V4's checkAction (static mirror, a1CallRefusal) admits every call of it,
    // with tokenIds 7 and 8 admitted for the account (A1CheckActionParityFork.t.sol runs each call through the real V4).
    cases: cases.map((c) => {
      const xs = a1Calls(c.callData)
      return { name: c.name, callData: c.callData, shape: c.shape, check: c.check, decodable: xs !== null, actions: xs !== null && xs.every((x) => a1CallRefusal(x, ctx) === null) }
    }),
  }
}

export function a1FixtureJson(): string {
  return `${JSON.stringify(a1Fixture(), null, 2)}\n`
}

if (import.meta.main && process.argv.includes('--write')) writeFileSync(A1_FIXTURE_PATH, a1FixtureJson())
