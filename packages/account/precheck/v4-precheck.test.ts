// otto/mamoru#293: precheck of a MamoruActionPolicyV4 session mirrors V4's checkAction (I1): V4's own entry points,
// approvals whose spender is V4 (never on the position manager), the manager's exits; anything else is refused.
// otto/mamoru#348: and the whole batch has MamoruGasPolicyV2's A1 shape (checkA1Batch, the builder's own check).
import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import type { SessionGrant } from '@mamoru/policy'
import { buildA1Batch, mamoruActionPolicyV4Abi } from '../one-auth/index.ts'
import type { Execution } from '../safe/index.ts'
import { executeCallData, useModeSignature } from '../sessions/index.ts'
import { SessionLedger, precheck } from './index.ts'

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1'
const V4: Address = '0x00000000000000000000000000000000000000a2'
const NPM = address('NonfungiblePositionManager', baseRegistry)
const USDC = address('USDC', baseRegistry)
const PID = `0x${'11'.repeat(32)}` as Hex
const grant = { policyId: 'one-auth-v4', name: 'manage-any', chainId: 8453, account: ACCOUNT, userOp: { validAfter: 0, validUntil: 2 ** 32 - 1, usageLimit: 2 ** 31 - 1 }, actions: [], oneAuthV4: { policy: V4, npm: NPM } } as unknown as SessionGrant

function run(calls: Execution[]): string {
  const l = new SessionLedger()
  l.activate(PID, grant)
  const r = precheck({ sender: ACCOUNT, callData: executeCallData(calls), signature: useModeSignature(PID, `0x${'22'.repeat(65)}`) }, { chainId: 8453, now: 1_800_000_000, ledger: l })
  return r.ok ? 'ACCEPT' : r.code
}
const approve = (token: Address, spender: Address): Execution => ({ target: token, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 5n] }) })
const swap: Execution = { target: V4, value: 0n, callData: encodeFunctionData({ abi: mamoruActionPolicyV4Abi, functionName: 'swap', args: [{ pool: USDC, tokenIn: USDC, amountIn: 5n, amountOutMinimum: 1n, sqrtPriceLimitX96: 1n, deadline: 1n }] }) }
const bridge: Execution = { target: V4, value: 0n, callData: encodeFunctionData({ abi: mamoruActionPolicyV4Abi, functionName: 'bridge', args: [15, USDC, 5n, 0n] }) }
const collect: Execution = { target: NPM, value: 0n, callData: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', args: [{ tokenId: 1n, recipient: ACCOUNT, amount0Max: 1n, amount1Max: 1n }] }) }

const T = 1_800_000_000n
const clock: Execution = { target: V4, value: 0n, callData: encodeFunctionData({ abi: parseAbi(['function clock(uint256)']), functionName: 'clock', args: [T] }) }
const reset = (token: Address): Execution[] => [approveN(token, V4, 0n), { target: V4, value: 0n, callData: encodeFunctionData({ abi: parseAbi(['function assertZero(address)']), functionName: 'assertZero', args: [token] }) }]
const approveN = (token: Address, spender: Address, n: bigint): Execution => ({ target: token, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, n] }) })
const ctx = { chainId: 8453, account: ACCOUNT, policy: V4, t: T }

describe('V4 session precheck', () => {
  test('swaps, bridges and exits from the builder are accepted', () => {
    expect(run(buildA1Batch(ctx, [{ kind: 'swap', params: { pool: USDC, tokenIn: USDC, amountIn: 5n, amountOutMinimum: 1n, sqrtPriceLimitX96: 1n, deadline: T + 300n } }]))).toBe('ACCEPT')
    expect(run(buildA1Batch(ctx, [{ kind: 'bridge', domain: 15, token: USDC, amount: 5n, maxFee: 0n }]))).toBe('ACCEPT')
    expect(run(buildA1Batch(ctx, [{ kind: 'decrease', tokenId: 1n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: T + 300n, burn: true, positionLiquidity: 1n }]))).toBe('ACCEPT')
    expect(run([clock, approve(USDC, V4), swap, ...reset(USDC)])).toBe('ACCEPT')
    expect(run([clock, collect])).toBe('ACCEPT')
  })

  test('approval to anyone but V4, approval on the manager, a direct router call, value, a V4 view: refused', () => {
    expect(run([clock, approve(USDC, address('SwapRouter02', baseRegistry)), swap, ...reset(USDC)])).toBe('POLICY_DENIED_TARGET')
    expect(run([clock, approve(NPM, V4)])).toBe('POLICY_DENIED_TARGET')
    expect(run([clock, { target: address('SwapRouter02', baseRegistry), value: 0n, callData: '0x04e45aaf' }])).toBe('POLICY_DENIED_TARGET')
    expect(run([clock, { ...swap, value: 1n }])).toBe('POLICY_DENIED_VALUE')
    expect(run([clock, { target: V4, value: 0n, callData: encodeFunctionData({ abi: mamoruActionPolicyV4Abi, functionName: 'readyOf', args: [ACCOUNT, 15] }) }])).toBe('POLICY_DENIED_TARGET')
    expect(run([clock, { target: ACCOUNT, value: 0n, callData: '0x12345678' }])).toBe('POLICY_DENIED_TARGET')
  })

  test('#348: the T7 shape (no clock, approval never reset, a bare exit) is refused before signing', () => {
    expect(run([approve(USDC, V4), swap])).toBe('POLICY_DENIED_CALLTYPE')
    expect(run([clock, approve(USDC, V4), swap])).toBe('POLICY_DENIED_CALLTYPE')
    expect(run([collect])).toBe('POLICY_DENIED_CALLTYPE')
    const dec: Execution = { target: NPM, value: 0n, callData: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'decreaseLiquidity', args: [{ tokenId: 1n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: T }] }) }
    expect(run([clock, dec, collect])).toBe('POLICY_DENIED_CALLTYPE')
  })

  test('review of #247: a claimed time the EntryPoint would refuse now is refused before signing', () => {
    const at = (t: bigint): Execution => ({ target: V4, value: 0n, callData: encodeFunctionData({ abi: parseAbi(['function clock(uint256)']), functionName: 'clock', args: [t] }) })
    expect(run([at(T + 300n), collect])).toBe('POLICY_DENIED_CALLTYPE') // now == T - S: validAfter is strict
    expect(run([at(T + 299n), collect])).toBe('ACCEPT')
    expect(run([at(T - 300n), collect])).toBe('ACCEPT') // now == T + S: validUntil inclusive
    expect(run([at(T - 301n), collect])).toBe('POLICY_DENIED_CALLTYPE')
  })
})
