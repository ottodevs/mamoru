// otto/mamoru#293: precheck of a MamoruActionPolicyV4 session mirrors V4's checkAction (I1): V4's own entry points,
// approvals whose spender is V4 (never on the position manager), the manager's exits; anything else is refused.
import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, erc20Abi, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import type { SessionGrant } from '@mamoru/policy'
import { mamoruActionPolicyV4Abi } from '../one-auth/index.ts'
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

describe('V4 session precheck', () => {
  test('approve(V4) + V4.swap, approve(V4) + V4.bridge, and the manager exits are accepted', () => {
    expect(run([approve(USDC, V4), swap])).toBe('ACCEPT')
    expect(run([approve(USDC, V4), bridge])).toBe('ACCEPT')
    expect(run([collect])).toBe('ACCEPT')
  })

  test('approval to anyone but V4, approval on the manager, a direct router call, value, a V4 view: refused', () => {
    expect(run([approve(USDC, address('SwapRouter02', baseRegistry)), swap])).toBe('POLICY_DENIED_TARGET')
    expect(run([approve(NPM, V4)])).toBe('POLICY_DENIED_TARGET')
    expect(run([{ target: address('SwapRouter02', baseRegistry), value: 0n, callData: '0x04e45aaf' }])).toBe('POLICY_DENIED_TARGET')
    expect(run([{ ...swap, value: 1n }])).toBe('POLICY_DENIED_VALUE')
    expect(run([{ target: V4, value: 0n, callData: encodeFunctionData({ abi: mamoruActionPolicyV4Abi, functionName: 'readyOf', args: [ACCOUNT, 15] }) }])).toBe('POLICY_DENIED_TARGET')
    expect(run([{ target: ACCOUNT, value: 0n, callData: '0x12345678' }])).toBe('POLICY_DENIED_TARGET')
  })
})
