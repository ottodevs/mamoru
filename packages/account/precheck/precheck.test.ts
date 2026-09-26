import { describe, expect, test } from 'bun:test'
import { concat, encodeFunctionData, erc20Abi, maxUint256, type Hex } from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { conservadorLabV1, instantiateGrant } from '@mamoru/policy'
import { encodeMode, CALLTYPE_DELEGATECALL, EXECTYPE_DEFAULT, type Execution } from '../safe/index.ts'
import { executeCallData, useModeSignature } from '../sessions/index.ts'
import { SessionLedger, precheck } from './index.ts'

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1'
const ATTACKER: Address = '0x00000000000000000000000000000000000000ee'
const PID = `0x${'11'.repeat(32)}` as Hex
const NOW = 1_790_411_347
const caps = {
  usdcSwapPerCall: 2_500_000_000n,
  usdcSwapTotal: 5_000_000_000n,
  usdcMint: 5_000_000_000n,
  cbbtcMint: 3_000_000n,
  cbbtcConvertPerCall: 3_000_000n,
  cbbtcConvertTotal: 3_000_000n,
}
const grantCtx = { account: ACCOUNT, sessionKey: ATTACKER, chainId: 31337, salt: PID, validAfter: NOW - 60, validUntil: NOW + 3600, caps }
const grant = instantiateGrant(conservadorLabV1, 'enter-swap', grantCtx)
const SIG = useModeSignature(PID, `0x${'22'.repeat(65)}`)

function ledger(): SessionLedger {
  const l = new SessionLedger()
  l.activate(PID, grant)
  return l
}
function approve(spender: Address, amount: bigint, value = 0n): Execution {
  return { target: address('USDC'), value, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) }
}
function run(calls: Execution[], over: { signature?: Hex; paymaster?: Address; chainId?: number; now?: number; ledger?: SessionLedger; callData?: Hex } = {}) {
  const r = precheck(
    { sender: ACCOUNT, callData: over.callData ?? executeCallData(calls), signature: over.signature ?? SIG, paymaster: over.paymaster },
    { chainId: over.chainId ?? 31337, now: over.now ?? NOW, ledger: over.ledger ?? ledger() },
  )
  return r.ok ? 'ACCEPT' : r.code
}

describe('session pre-check', () => {
  const router = address('SwapRouter02')
  test('a granted call within caps is accepted', () => expect(run([approve(router, 1_000_000_000n)])).toBe('ACCEPT'))
  test('approval rules', () => {
    expect(run([approve(router, maxUint256)])).toBe('POLICY_DENIED_APPROVAL')
    expect(run([approve(ATTACKER, 1n)])).toBe('POLICY_DENIED_APPROVAL')
  })
  test('native value', () => expect(run([approve(router, 1n, 1n)])).toBe('POLICY_DENIED_VALUE'))
  test('the account itself is never a target', () => expect(run([{ target: ACCOUNT, value: 0n, callData: '0x12345678' }])).toBe('POLICY_DENIED_TARGET'))
  test('a target outside the grant', () => expect(run([{ target: ATTACKER, value: 0n, callData: '0xa9059cbb' }])).toBe('POLICY_DENIED_TARGET'))
  test('session state', () => {
    expect(run([approve(router, 1n)], { signature: useModeSignature(`0x${'33'.repeat(32)}`, '0x00') })).toBe('SESSION_MISSING')
    const revoked = ledger()
    revoked.revoke(PID)
    expect(run([approve(router, 1n)], { ledger: revoked })).toBe('SESSION_REVOKED')
    expect(run([approve(router, 1n)], { chainId: 31338 })).toBe('SIGN_CHAIN_NOT_ALLOWED')
    expect(run([approve(router, 1n)], { now: NOW + 7200 })).toBe('SESSION_EXPIRED')
    const used = ledger()
    for (let i = 0; i < grant.userOp.usageLimit; i++) used.recordIncluded(PID, [])
    expect(run([approve(router, 1n)], { ledger: used })).toBe('SESSION_MISSING')
  })
  test('enable-mode signature and paymaster', () => {
    expect(run([approve(router, 1n)], { signature: concat(['0x01', PID]) })).toBe('POLICY_DENIED_TARGET')
    expect(run([approve(router, 1n)], { paymaster: ATTACKER })).toBe('POLICY_DENIED_TARGET')
  })
  test('delegatecall mode', () => {
    const callData = encodeFunctionData({
      abi: [{ type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{ type: 'bytes32' }, { type: 'bytes' }], outputs: [] }],
      functionName: 'execute',
      args: [encodeMode(CALLTYPE_DELEGATECALL, EXECTYPE_DEFAULT), '0x'],
    })
    expect(run([], { callData })).toBe('POLICY_DENIED_CALLTYPE')
  })
})

describe('grant instantiation', () => {
  test('the lab policy never signs for Base', () => {
    let c = 'NONE'
    try {
      instantiateGrant(conservadorLabV1, 'enter-swap', { ...grantCtx, chainId: 8453 })
    } catch (e) {
      if (e instanceof ReasonError) c = e.code
    }
    expect(c).toBe('SIGN_CHAIN_NOT_ALLOWED')
  })
  test('grants carry no paymaster and no native value', () => {
    expect(grant.permitERC4337Paymaster).toBe(false)
    expect(grant.actions.every((a) => a.nativeValue === 0n)).toBe(true)
  })
  test('manage is per position and only for an admitted mint', () => {
    expect(() => instantiateGrant(conservadorLabV1, 'manage', grantCtx)).toThrow()
    let denied = 'NONE'
    try {
      instantiateGrant(conservadorLabV1, 'manage', { ...grantCtx, tokenId: 42n })
    } catch (e) {
      if (e instanceof ReasonError) denied = e.code
    }
    expect(denied).toBe('POLICY_DENIED_POSITION')
    const m = instantiateGrant(conservadorLabV1, 'manage', { ...grantCtx, tokenId: 42n, admittedTokenIds: [42n] })
    expect(m.actions.filter((a) => a.params.some((p) => p.field === 'tokenId')).every((a) => a.params[0]!.ref === 42n)).toBe(true)
  })
})
