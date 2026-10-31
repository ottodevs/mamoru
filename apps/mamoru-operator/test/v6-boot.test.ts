// otto/mamoru#251: conservador-live-v6 at boot. It runs on MamoruActionPolicyV3 alone: V3 and its MamoruPauseGate come from
// the Base REGISTRY (not from env), only the gas policy is an env address (MAMORU_GAS_POLICY_ADDRESS). V3 not pinned or
// no gas policy: v6 is not offered. The retired MAMORU_PAUSE_GATE_ADDRESS is refused off Base and not read on Base.
import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { baseRegistry, isDeployed, monadRegistry, type Registry } from '@mamoru/registry'
import { assertBaseOnlyFeatures, assertBootPolicies, assertPauseGateOnRegistry, assertV4Resolvable, assertV6Gate, resolveNamedPolicy, resolveV5Policy, resolveV6Policy } from '../src/boot.ts'
import { GATE_V3_BASE_PINNED, V3_BASE_PINNED, withPinnedV6Base } from '../../../packages/account/remote/fixture.ts'

const V1 = '0x00000000000000000000000000000000000000f1'
const V2 = '0x00000000000000000000000000000000000000fe'
const GAS = '0x00000000000000000000000000000000000000fd'
const env = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_V2_ADDRESS: V2, MAMORU_GAS_POLICY_ADDRESS: GAS }
const ID = 'conservador-live-v6'

// V3 and the gate at their predicted addresses (base.json pins them after the deploys).
const reg = withPinnedV6Base()
const without = (registry: Registry, ...names: string[]): Registry => ({ ...registry, entries: registry.entries.filter((e) => !names.includes(e.name)), undeployed: [...registry.undeployed, ...names] })
const opts = { registry: reg }

describe('conservador-live-v6 at boot', () => {
  test('wired to V3 and the gate of the registry, plus the gas policy; resolves by name and as the renew target', () => {
    const p = resolveNamedPolicy(ID, env, opts)!
    expect(p.actionPolicy).toMatchObject({ address: V3_BASE_PINNED, contractVersion: 3, pauseGate: GATE_V3_BASE_PINNED, gasPolicy: { address: GAS } })
    expect(resolveV6Policy('base', env, reg)!.policyId).toBe(ID)
    expect(resolveV6Policy('fork', env, reg)!.policyId).toBe('conservador-lab-v6')
    expect(resolveNamedPolicy('conservador-lab-v6', env, opts)!.actionPolicy!.pauseGate).toBe(GATE_V3_BASE_PINNED)
  })

  test('MAMORU_PAUSE_GATE_ADDRESS and the V2 address are not read for v6: the registry decides', () => {
    const p = resolveV6Policy('base', { ...env, MAMORU_PAUSE_GATE_ADDRESS: V1, MAMORU_ACTION_POLICY_V2_ADDRESS: undefined }, reg)!
    expect(p.actionPolicy).toMatchObject({ address: V3_BASE_PINNED, pauseGate: GATE_V3_BASE_PINNED })
  })

  test('fails closed: V3 or the gate not pinned, no gas policy, or no opt-in means v6 is not offered', () => {
    expect(resolveNamedPolicy(ID, env, { registry: without(reg, 'MamoruActionPolicyV3') })).toBeUndefined()
    expect(resolveNamedPolicy(ID, env, { registry: without(reg, 'MamoruPauseGate') })).toBeUndefined()
    expect(resolveV6Policy('base', { ...env, MAMORU_GAS_POLICY_ADDRESS: undefined }, reg)).toBeUndefined()
    expect(resolveV6Policy('base', { ...env, MAMORU_ONCHAIN_POLICY_V4: undefined }, reg)).toBeUndefined()
    expect(resolveV6Policy('monad', env, reg)).toBeUndefined()
  })

  test('bad gas policy addresses throw: malformed, zero, or equal to V3 or the gate', () => {
    expect(() => resolveV6Policy('base', { ...env, MAMORU_GAS_POLICY_ADDRESS: '0x123' }, reg)).toThrow('not a contract address')
    expect(() => resolveV6Policy('base', { ...env, MAMORU_GAS_POLICY_ADDRESS: '0x' + '0'.repeat(40) }, reg)).toThrow('not a contract address')
    expect(() => resolveV6Policy('base', { ...env, MAMORU_GAS_POLICY_ADDRESS: V3_BASE_PINNED }, reg)).toThrow('three contracts')
    expect(() => resolveV6Policy('base', { ...env, MAMORU_GAS_POLICY_ADDRESS: GATE_V3_BASE_PINNED }, reg)).toThrow('three contracts')
  })

  test('a stored v6 account refuses a boot that cannot resolve v6', () => {
    const accounts = [{ accountKey: 'abcdef012345', policyId: ID }]
    expect(() => assertV4Resolvable(accounts, { ...env, MAMORU_GAS_POLICY_ADDRESS: undefined })).toThrow('MAMORU_GAS_POLICY_ADDRESS')
    expect(() => assertV4Resolvable(accounts, { ...env, MAMORU_ONCHAIN_POLICY_V4: undefined })).toThrow('MAMORU_ONCHAIN_POLICY_V4')
    // The check reads the shipped base.json: while it does not pin V3, v6 cannot resolve and the boot is refused.
    if (isDeployed('MamoruActionPolicyV3', baseRegistry) && isDeployed('MamoruPauseGate', baseRegistry)) expect(() => assertV4Resolvable(accounts, env)).not.toThrow()
    else expect(() => assertV4Resolvable(accounts, env)).toThrow('MamoruActionPolicyV3')
  })

  test('the gate is read on chain: it must be bound to the policy V3 the registry names', async () => {
    const v6 = resolveV6Policy('base', env, reg)!
    const answers = (bound: string) => ({ readContract: async () => bound }) as unknown as PublicClient
    await expect(assertV6Gate(answers(V3_BASE_PINNED), v6)).resolves.toBeUndefined()
    await expect(assertV6Gate(answers(V3_BASE_PINNED.toLowerCase()), v6)).resolves.toBeUndefined()
    await expect(assertV6Gate(answers(V2), v6)).rejects.toThrow('not MamoruActionPolicyV3')
    await expect(assertV6Gate(answers(V3_BASE_PINNED), { ...v6, actionPolicy: { ...v6.actionPolicy!, pauseGate: undefined } })).rejects.toThrow('has no MamoruPauseGate')
  })

  test('registry pin: a gate wired from another registry than the boot one is refused', () => {
    const p = resolveNamedPolicy(ID, env, opts)!
    expect(() => assertPauseGateOnRegistry(p, reg)).not.toThrow()
    expect(() => assertPauseGateOnRegistry(p, without(reg, 'MamoruPauseGate'))).not.toThrow()
    const moved: Registry = { ...reg, entries: reg.entries.map((e) => (e.name === 'MamoruPauseGate' ? { ...e, address: V1 } : e)) as never }
    expect(() => assertPauseGateOnRegistry(p, moved)).toThrow('registry')
  })

  test('review of PR #141 (P1 2): v6 (a bucket on another chain) is refused as the default policy at boot', () => {
    expect(() => assertBootPolicies(resolveNamedPolicy(ID, env, opts)!, resolveV6Policy('base', env, reg), reg)).toThrow('renewal target only')
    expect(() => assertBootPolicies(resolveNamedPolicy('conservador-lab-v6', env, opts)!, undefined, reg)).toThrow('renewal target only')
    expect(() => assertBootPolicies(resolveV5Policy('base', env)!, resolveV6Policy('base', env, reg), reg)).not.toThrow()
  })

  test('a signing operator refuses a v6 target whose gate the boot registry has not pinned', () => {
    const v5 = resolveV5Policy('base', env)!
    const v6 = resolveV6Policy('base', env, reg)!
    const unpinned = without(reg, 'MamoruPauseGate')
    for (const mode of [{ live: true }, { writes: true }]) {
      expect(() => assertBootPolicies(v5, v6, unpinned, mode)).toThrow('has not pinned')
      expect(() => assertBootPolicies(v5, v6, reg, mode)).not.toThrow()
      // No v6 offered: nothing names the gate, nothing to refuse.
      expect(() => assertBootPolicies(v5, undefined, unpinned, mode)).not.toThrow()
    }
    // A read-only operator signs nothing.
    expect(() => assertBootPolicies(v5, v6, unpinned)).not.toThrow()
  })

  test('review of PR #141 (P1 3): the v6 renew target is checked against the registry even when the default policy is v5', () => {
    const v5 = resolveV5Policy('base', env)!
    const v6 = resolveV6Policy('base', env, reg)!
    const moved: Registry = { ...reg, entries: reg.entries.map((e) => (e.name === 'MamoruPauseGate' ? { ...e, address: V1 } : e)) as never }
    expect(() => assertBootPolicies(v5, v6, reg)).not.toThrow()
    expect(() => assertBootPolicies(v5, v6, moved)).toThrow('MamoruPauseGate')
    expect(() => assertBootPolicies(v5, undefined, moved)).not.toThrow()
  })

  test('Base only: the retired pause gate address is refused on a Monad operator, and the V2 address stays Base only', () => {
    expect(() => assertBaseOnlyFeatures(monadRegistry, { MAMORU_PAUSE_GATE_ADDRESS: V1 }, {})).toThrow('retired')
    expect(() => assertBaseOnlyFeatures(monadRegistry, { MAMORU_ACTION_POLICY_V2_ADDRESS: V2 }, {})).toThrow('Base only')
    expect(() => assertBaseOnlyFeatures(reg, { MAMORU_PAUSE_GATE_ADDRESS: V1 }, {})).not.toThrow()
  })
})
