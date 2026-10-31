import { describe, expect, test } from 'bun:test'
import { POLICIES } from '@mamoru/policy'
import { assertV4Resolvable, gitShaOnce, resolveNamedPolicy, resolveV4Policy, resolveV5Policy, syncYieldLedgerFlag } from '../src/boot.ts'

function fakeLoop() {
  const calls: string[] = []
  return { calls, start: () => calls.push('start'), stop: () => calls.push('stop') }
}

describe('syncYieldLedgerFlag (otto/mamoru#129): boot.ts starts/stops the snapshot loop on the D1 flag', () => {
  test('off to on: starts the loop, logs the transition once', () => {
    const loop = fakeLoop()
    const lines: string[] = []
    const now = syncYieldLedgerFlag(loop, true, false, (l) => lines.push(l))
    expect(now).toBe(true)
    expect(loop.calls).toEqual(['start'])
    expect(lines).toEqual(['[flags] yield_ledger on'])
  })

  test('on to off: stops the loop, logs the transition once', () => {
    const loop = fakeLoop()
    const lines: string[] = []
    const now = syncYieldLedgerFlag(loop, false, true, (l) => lines.push(l))
    expect(now).toBe(false)
    expect(loop.calls).toEqual(['stop'])
    expect(lines).toEqual(['[flags] yield_ledger off'])
  })

  test('no change: neither started nor stopped, nothing logged, across repeated calls', () => {
    const loop = fakeLoop()
    const lines: string[] = []
    let on = false
    on = syncYieldLedgerFlag(loop, false, on, (l) => lines.push(l))
    on = syncYieldLedgerFlag(loop, false, on, (l) => lines.push(l))
    expect(loop.calls).toEqual([])
    expect(lines).toEqual([])
    expect(on).toBe(false)
  })

  test('a flap (on, off, on) calls start/stop every real transition, in order', () => {
    const loop = fakeLoop()
    let on = false
    on = syncYieldLedgerFlag(loop, true, on, () => {})
    on = syncYieldLedgerFlag(loop, false, on, () => {})
    on = syncYieldLedgerFlag(loop, true, on, () => {})
    expect(loop.calls).toEqual(['start', 'stop', 'start'])
    expect(on).toBe(true)
  })
})

describe('resolveNamedPolicy (otto/mamoru#151 T7): conservadorLiveV4 is only reachable behind an explicit, env-read opt-in', () => {
  const ADDR = '0x00000000000000000000000000000000000000Fe'
  const GAS = '0x00000000000000000000000000000000000000Fd'

  test('a v2/v3 policyId resolves exactly as POLICIES[id] always has, whatever the env says', () => {
    expect(resolveNamedPolicy('conservador-live-v2', {})).toBe(POLICIES['conservador-live-v2'])
    expect(resolveNamedPolicy('conservador-live-v2', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR, MAMORU_GAS_POLICY_ADDRESS: GAS })).toBe(POLICIES['conservador-live-v2'])
  })

  test('an unknown policyId with the flag off (default): undefined, same as POLICIES[id] on any unknown name — nothing changes while off', () => {
    expect(resolveNamedPolicy('conservador-live-v4', {})).toBeUndefined()
    expect(resolveNamedPolicy('nonsense', {})).toBeUndefined()
  })

  test('conservador-live-v4 with the flag off: still undefined (not reachable without the opt-in)', () => {
    expect(resolveNamedPolicy('conservador-live-v4', { MAMORU_ACTION_POLICY_ADDRESS: ADDR, MAMORU_GAS_POLICY_ADDRESS: GAS })).toBeUndefined()
  })

  test('conservador-live-v4 with the flag on but no deployed address: throws (never silently unset)', () => {
    expect(() => resolveNamedPolicy('conservador-live-v4', { MAMORU_ONCHAIN_POLICY_V4: '1' })).toThrow('MAMORU_ACTION_POLICY_ADDRESS')
  })

  test('conservador-live-v4 with the flag on and a deployed address: resolves with actionPolicy wired to that address, bands only (no per-account budgets yet)', () => {
    const policy = resolveNamedPolicy('conservador-live-v4', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR, MAMORU_GAS_POLICY_ADDRESS: GAS })
    expect(policy?.policyId).toBe('conservador-live-v4')
    expect(policy?.actionPolicy?.address.toLowerCase()).toBe(ADDR.toLowerCase())
    expect(Object.keys(policy?.actionPolicy?.bandTicksByPool ?? {}).length).toBeGreaterThan(0)
    expect(policy?.actionPolicy?.budgetsByPool).toBeUndefined()
    expect(policy?.actionPolicy?.gasPolicy?.address.toLowerCase()).toBe(GAS.toLowerCase())
    expect(policy?.actionPolicy?.gasPolicy?.caps.maxFeePerGas).toBeGreaterThan(0n)
  })

  test('T7 (P1 2): the flag on without the gas policy address throws, as does a zero or repeated address', () => {
    expect(() => resolveNamedPolicy('conservador-live-v4', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR })).toThrow('MAMORU_GAS_POLICY_ADDRESS')
    expect(() => resolveNamedPolicy('conservador-live-v4', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR, MAMORU_GAS_POLICY_ADDRESS: ADDR })).toThrow('the same')
    expect(() => resolveNamedPolicy('conservador-live-v4', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR, MAMORU_GAS_POLICY_ADDRESS: `0x${'0'.repeat(40)}` })).toThrow('not a contract address')
  })

  test('resolveV4Policy: off without the opt-in; on, the chain twin wired to both addresses', () => {
    expect(resolveV4Policy('base', {})).toBeUndefined()
    expect(resolveV4Policy('base', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR, MAMORU_GAS_POLICY_ADDRESS: GAS })?.policyId).toBe('conservador-live-v4')
    expect(resolveV4Policy('fork', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR, MAMORU_GAS_POLICY_ADDRESS: GAS })?.policyId).toBe('conservador-lab-v4')
  })

  test('conservador-lab-v4 behind the same gate', () => {
    expect(resolveNamedPolicy('conservador-lab-v4', {})).toBeUndefined()
    const policy = resolveNamedPolicy('conservador-lab-v4', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR, MAMORU_GAS_POLICY_ADDRESS: GAS })
    expect(policy?.policyId).toBe('conservador-lab-v4')
  })
})

// otto/mamoru#151 review round 2: an account already on the on-chain action policy must resolve after a restart.
describe('assertV4Resolvable', () => {
  const v4 = { accountKey: 'aaaaaaaa-0000', policyId: 'conservador-live-v4' }
  const v2 = { accountKey: 'bbbbbbbb-0000', policyId: 'conservador-live-v2' }
  const ok = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: `0x${'11'.repeat(20)}`, MAMORU_GAS_POLICY_ADDRESS: `0x${'22'.repeat(20)}` }
  test('no account on v4: boots whatever the env says', () => {
    expect(() => assertV4Resolvable([v2], {})).not.toThrow()
  })
  test('an account on v4 with the opt-in and both addresses: boots', () => {
    expect(() => assertV4Resolvable([v2, v4], ok)).not.toThrow()
  })
  test('an account on v4 without the opt-in or an address: refused at boot, the account named', () => {
    expect(() => assertV4Resolvable([v4], {})).toThrow(/aaaaaaaa/)
    expect(() => assertV4Resolvable([v4], { ...ok, MAMORU_ONCHAIN_POLICY_V4: '0' })).toThrow(/MAMORU_ONCHAIN_POLICY_V4/)
    expect(() => assertV4Resolvable([v4], { ...ok, MAMORU_GAS_POLICY_ADDRESS: undefined })).toThrow(/aaaaaaaa/)
  })
})

// otto/mamoru#151: conservador-live-v5 on MamoruActionPolicyV2, a new address next to V1's.
describe('v5 (MamoruActionPolicyV2): resolved only with the v4 opt-in and MAMORU_ACTION_POLICY_V2_ADDRESS', () => {
  const V1 = `0x${'11'.repeat(20)}`
  const GAS = `0x${'22'.repeat(20)}`
  const V2 = `0x${'33'.repeat(20)}`
  const ok = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: V1, MAMORU_GAS_POLICY_ADDRESS: GAS, MAMORU_ACTION_POLICY_V2_ADDRESS: V2 }

  test('off without the opt-in or the V2 address: v5 does not exist, v4 resolves as before', () => {
    expect(resolveNamedPolicy('conservador-live-v5', {})).toBeUndefined()
    expect(resolveNamedPolicy('conservador-live-v5', { ...ok, MAMORU_ONCHAIN_POLICY_V4: '0' })).toBeUndefined()
    expect(resolveNamedPolicy('conservador-live-v5', { ...ok, MAMORU_ACTION_POLICY_V2_ADDRESS: undefined })).toBeUndefined()
    expect(resolveV5Policy('base', { ...ok, MAMORU_ACTION_POLICY_V2_ADDRESS: undefined })).toBeUndefined()
    const v4 = resolveNamedPolicy('conservador-live-v4', ok)!
    expect(v4.actionPolicy?.address.toLowerCase()).toBe(V1)
    expect(v4.actionPolicy?.contractVersion).toBeUndefined()
  })

  test('on: wired to V2 (contractVersion 2) and the same gas policy, for each chain twin', () => {
    const v5 = resolveNamedPolicy('conservador-live-v5', ok)!
    expect(v5.policyId).toBe('conservador-live-v5')
    expect(v5.actionPolicy?.address.toLowerCase()).toBe(V2)
    expect(v5.actionPolicy?.contractVersion).toBe(2)
    expect(v5.actionPolicy?.gasPolicy?.address.toLowerCase()).toBe(GAS)
    expect(resolveV5Policy('base', ok)?.policyId).toBe('conservador-live-v5')
    expect(resolveV5Policy('fork', ok)?.policyId).toBe('conservador-lab-v5')
    expect(resolveNamedPolicy('conservador-lab-v5', ok)?.chain).toBe('fork')
  })

  test('the V1 address, the gas policy, zero or a malformed one can never stand in for V2', () => {
    expect(() => resolveNamedPolicy('conservador-live-v5', { ...ok, MAMORU_ACTION_POLICY_V2_ADDRESS: V1 })).toThrow('is the V1 address')
    expect(() => resolveNamedPolicy('conservador-live-v5', { ...ok, MAMORU_ACTION_POLICY_V2_ADDRESS: GAS })).toThrow('are the same')
    expect(() => resolveNamedPolicy('conservador-live-v5', { ...ok, MAMORU_ACTION_POLICY_V2_ADDRESS: `0x${'00'.repeat(20)}` })).toThrow('not a contract address')
    expect(() => resolveNamedPolicy('conservador-live-v5', { ...ok, MAMORU_ACTION_POLICY_V2_ADDRESS: '0x1234' })).toThrow('not a contract address')
    expect(() => resolveNamedPolicy('conservador-live-v5', { ...ok, MAMORU_GAS_POLICY_ADDRESS: undefined })).toThrow('MAMORU_GAS_POLICY_ADDRESS')
  })

  test('assertV4Resolvable: an account on v5 needs V2 configured, or boot refuses naming it', () => {
    const v5 = { accountKey: 'cccccccc-0000', policyId: 'conservador-live-v5' }
    expect(() => assertV4Resolvable([v5], ok)).not.toThrow()
    expect(() => assertV4Resolvable([v5], { ...ok, MAMORU_ACTION_POLICY_V2_ADDRESS: undefined })).toThrow(/cccccccc.*MAMORU_ACTION_POLICY_V2_ADDRESS/)
    expect(() => assertV4Resolvable([v5], { ...ok, MAMORU_ACTION_POLICY_V2_ADDRESS: V1 })).toThrow(/cccccccc/)
  })
})


describe('gitShaOnce (otto/mamoru#249): the standby VPS runs a code archive, not a git checkout', () => {
  const sha = 'dafdc83c27e7ff9aeb0fc4b668e547b1d8ecf07c'
  test('MAMORU_GIT_SHA wins, cut to the short form lady reports', async () => {
    expect(await gitShaOnce('/', sha)).toBe('dafdc83c')
  })
  test('outside a checkout and without the variable: unknown', async () => {
    expect(await gitShaOnce('/', undefined)).toBe('unknown')
  })
  test('a value that is not a sha is ignored', async () => {
    expect(await gitShaOnce('/', 'main; rm -rf /')).toBe('unknown')
  })
})
