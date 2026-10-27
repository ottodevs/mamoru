// otto/mamoru#214: conservador-live-v6 at boot: MAMORU_PAUSE_GATE_ADDRESS is required, validated like the V2 and gas
// addresses, pinned against the registry once MamoruPauseGate is deployed, and Base only.
import { describe, expect, test } from 'bun:test'
import { baseRegistry, monadRegistry, type Registry } from '@mamoru/registry'
import { assertBaseOnlyFeatures, assertBootPolicies, assertPauseGateOnRegistry, assertV4Resolvable, resolveNamedPolicy, resolveV5Policy, resolveV6Policy } from '../src/boot.ts'

const V1 = '0x00000000000000000000000000000000000000f1'
const V2 = '0x00000000000000000000000000000000000000fe'
const GAS = '0x00000000000000000000000000000000000000fd'
const GATE = '0x00000000000000000000000000000000000000fc'
const env = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_V2_ADDRESS: V2, MAMORU_GAS_POLICY_ADDRESS: GAS, MAMORU_PAUSE_GATE_ADDRESS: GATE }
const ID = 'conservador-live-v6'

const pinnedGate = (address: string): Registry => ({ ...baseRegistry, entries: [...baseRegistry.entries, { name: 'MamoruPauseGate', kind: 'policy', role: 'test', address, codeHash: `0x${'00'.repeat(32)}` } as never], undeployed: [] })

describe('conservador-live-v6 at boot', () => {
  test('wired to V2, the gas policy and the pause gate; resolves by name and as the renew target', () => {
    const p = resolveNamedPolicy(ID, env)!
    expect(p.actionPolicy).toMatchObject({ address: V2, contractVersion: 2, pauseGate: GATE, gasPolicy: { address: GAS } })
    expect(resolveV6Policy('base', env)!.policyId).toBe(ID)
    expect(resolveV6Policy('fork', env)!.policyId).toBe('conservador-lab-v6')
    expect(resolveNamedPolicy('conservador-lab-v6', env)!.actionPolicy!.pauseGate).toBe(GATE)
  })

  test('fails closed: no gate (or V2, or the opt-in) means v6 is not offered and not a default', () => {
    expect(resolveNamedPolicy(ID, { ...env, MAMORU_PAUSE_GATE_ADDRESS: undefined })).toBeUndefined()
    expect(resolveV6Policy('base', { ...env, MAMORU_PAUSE_GATE_ADDRESS: undefined })).toBeUndefined()
    expect(resolveV6Policy('base', { ...env, MAMORU_ACTION_POLICY_V2_ADDRESS: undefined })).toBeUndefined()
    expect(resolveV6Policy('base', { ...env, MAMORU_ONCHAIN_POLICY_V4: undefined })).toBeUndefined()
    expect(resolveV6Policy('monad', env)).toBeUndefined()
  })

  test('bad gate addresses throw: malformed, zero, or equal to V2, the gas policy or V1', () => {
    expect(() => resolveV6Policy('base', { ...env, MAMORU_PAUSE_GATE_ADDRESS: '0x123' })).toThrow('not a contract address')
    expect(() => resolveV6Policy('base', { ...env, MAMORU_PAUSE_GATE_ADDRESS: '0x' + '0'.repeat(40) })).toThrow('not a contract address')
    expect(() => resolveV6Policy('base', { ...env, MAMORU_PAUSE_GATE_ADDRESS: V2 })).toThrow('same')
    expect(() => resolveV6Policy('base', { ...env, MAMORU_PAUSE_GATE_ADDRESS: GAS })).toThrow('same')
    expect(() => resolveV6Policy('base', { ...env, MAMORU_ACTION_POLICY_ADDRESS: V1, MAMORU_PAUSE_GATE_ADDRESS: V1 })).toThrow('same')
  })

  test('a stored v6 account refuses a boot that cannot resolve v6', () => {
    const accounts = [{ accountKey: 'abcdef012345', policyId: ID }]
    expect(() => assertV4Resolvable(accounts, { ...env, MAMORU_PAUSE_GATE_ADDRESS: undefined })).toThrow('MAMORU_PAUSE_GATE_ADDRESS')
    expect(() => assertV4Resolvable(accounts, env)).not.toThrow()
  })

  test('registry pin: while MamoruPauseGate is undeployed the env address stands; once pinned it must equal it', () => {
    const p = resolveNamedPolicy(ID, env)!
    expect(() => assertPauseGateOnRegistry(p, baseRegistry)).not.toThrow()
    const pinned = (address: string): Registry => ({ ...baseRegistry, entries: [...baseRegistry.entries, { name: 'MamoruPauseGate', kind: 'policy', role: 'test', address, codeHash: `0x${'00'.repeat(32)}` } as never], undeployed: [] })
    expect(() => assertPauseGateOnRegistry(p, pinned(GATE))).not.toThrow()
    expect(() => assertPauseGateOnRegistry(p, pinned(V1))).toThrow('registry')
  })

  test('review of PR #141 (P1 2): v6 (a bucket on another chain) is refused as the default policy at boot', () => {
    expect(() => assertBootPolicies(resolveNamedPolicy(ID, env)!, resolveV6Policy('base', env), baseRegistry)).toThrow('renewal target only')
    expect(() => assertBootPolicies(resolveNamedPolicy('conservador-lab-v6', env)!, undefined, baseRegistry)).toThrow('renewal target only')
    expect(() => assertBootPolicies(resolveV5Policy('base', env)!, resolveV6Policy('base', env), pinnedGate(GATE))).not.toThrow()
  })

  test('round 2 of PR #141 (GPT-6 Sol P1): a signing operator refuses a v6 target whose gate the registry has not pinned', () => {
    const v5 = resolveV5Policy('base', env)!
    const v6 = resolveV6Policy('base', env)!
    // baseRegistry lists MamoruPauseGate as undeployed today.
    for (const mode of [{ live: true }, { writes: true }]) {
      expect(() => assertBootPolicies(v5, v6, baseRegistry, mode)).toThrow('has not pinned')
      expect(() => assertBootPolicies(v5, v6, pinnedGate(GATE), mode)).not.toThrow()
      // No v6 offered: nothing names the gate, nothing to refuse.
      expect(() => assertBootPolicies(v5, undefined, baseRegistry, mode)).not.toThrow()
    }
    // A read-only operator signs nothing: the env address may stand until the pin.
    expect(() => assertBootPolicies(v5, v6, baseRegistry)).not.toThrow()
  })

  test('review of PR #141 (P1 3): the v6 renew target is pinned to the registry even when the default policy is v5', () => {
    const pinned = (address: string): Registry => ({ ...baseRegistry, entries: [...baseRegistry.entries, { name: 'MamoruPauseGate', kind: 'policy', role: 'test', address, codeHash: `0x${'00'.repeat(32)}` } as never], undeployed: [] })
    const v5 = resolveV5Policy('base', env)!
    const v6 = resolveV6Policy('base', env)!
    expect(() => assertBootPolicies(v5, v6, pinned(GATE))).not.toThrow()
    expect(() => assertBootPolicies(v5, v6, pinned('0x00000000000000000000000000000000000000f1'))).toThrow('MamoruPauseGate')
    expect(() => assertBootPolicies(v5, undefined, pinned('0x00000000000000000000000000000000000000f1'))).not.toThrow()
  })

  test('Base only: the pause gate address is refused on a Monad operator', () => {
    expect(() => assertBaseOnlyFeatures(monadRegistry, { MAMORU_PAUSE_GATE_ADDRESS: GATE }, {})).toThrow('Base only')
    expect(() => assertBaseOnlyFeatures(baseRegistry, { MAMORU_PAUSE_GATE_ADDRESS: GATE }, {})).not.toThrow()
  })
})
