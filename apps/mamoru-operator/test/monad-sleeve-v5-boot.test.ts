// otto/mamoru#214: the Monad operator resolves the sleeve's v5 policy only wired to the two Monad contracts.
import { describe, expect, test } from 'bun:test'
import { baseRegistry, monadRegistry, type Registry } from '@mamoru/registry'
import { labWmonUsdcMonadV5, liveWmonUsdcMonadV1, liveWmonUsdcMonadV5, MONAD_GAS_CAPS, V4_POOLS_MONAD } from '@mamoru/policy'
import { assertActionPolicyOnRegistry, assertMonadV5Resolvable, assertBaseOnlyFeatures, assertWritePolicy, resolveNamedPolicy, resolveV4Policy, resolveV5Policy } from '../src/boot.ts'

const V2 = '0x00000000000000000000000000000000000000fe'
const GAS = '0x00000000000000000000000000000000000000fd'
const env = { MAMORU_ACTION_POLICY_V2_ADDRESS: V2, MAMORU_GAS_POLICY_ADDRESS: GAS }
const ID = liveWmonUsdcMonadV5.policyId

describe('live-wmon-usdc-monad-v5 at boot', () => {
  test('wired to the Monad V2 and gas policy, contractVersion 2, Monad pool and gas caps', () => {
    const p = resolveNamedPolicy(ID, env, { chainWrites: true })!
    expect(p.policyId).toBe(ID)
    expect(p.actionPolicy!.address).toBe(V2)
    expect(p.actionPolicy!.contractVersion).toBe(2)
    expect(p.actionPolicy!.gasPolicy).toEqual({ address: GAS, caps: MONAD_GAS_CAPS })
    expect(Object.keys(p.actionPolicy!.bandTicksByPool)).toEqual([V4_POOLS_MONAD.growth.pool])
  })

  test('fails closed: unset or bad addresses throw, never a policy without the contracts', () => {
    expect(() => resolveNamedPolicy(ID, {}, { chainWrites: true })).toThrow('MAMORU_ACTION_POLICY_V2_ADDRESS')
    expect(() => resolveNamedPolicy(ID, { MAMORU_ACTION_POLICY_V2_ADDRESS: V2 }, { chainWrites: true })).toThrow('MAMORU_GAS_POLICY_ADDRESS')
    expect(() => resolveNamedPolicy(ID, { ...env, MAMORU_GAS_POLICY_ADDRESS: V2 }, { chainWrites: true })).toThrow('same')
    expect(() => resolveNamedPolicy(ID, { ...env, MAMORU_GAS_POLICY_ADDRESS: '0x' + '0'.repeat(40) }, { chainWrites: true })).toThrow('not a contract')
  })

  test('the live policy needs the chain-writes opt-in; the lab twin does not', () => {
    expect(resolveNamedPolicy(ID, env)).toBeUndefined()
    expect(resolveNamedPolicy(labWmonUsdcMonadV5.policyId, env)!.chain).toBe('fork')
  })

  test('v1 stays resolvable for the sleeves already activated', () => {
    expect(resolveNamedPolicy('live-wmon-usdc-monad-v1', {}, { chainWrites: true })).toBe(liveWmonUsdcMonadV1)
  })

  test('a Monad operator never offers the Base v4/v5 migration', () => {
    expect(resolveV5Policy('monad', { ...env, MAMORU_ONCHAIN_POLICY_V4: '1' })).toBeUndefined()
    expect(resolveV4Policy('monad', { ...env, MAMORU_ONCHAIN_POLICY_V4: '1' })).toBeUndefined()
  })

  test('the V2 address is accepted off Base only for an operator opted into that chain', () => {
    expect(() => assertBaseOnlyFeatures(monadRegistry, { MAMORU_ACTION_POLICY_V2_ADDRESS: V2 }, {})).toThrow('Base only')
    expect(() => assertBaseOnlyFeatures(monadRegistry, { MAMORU_ACTION_POLICY_V2_ADDRESS: V2, MAMORU_CHAIN_WRITES: '143' }, {})).not.toThrow()
    expect(() => assertBaseOnlyFeatures(monadRegistry, { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_CHAIN_WRITES: '143' }, {})).toThrow('Base only')
  })

  test('signs on 143 only and resolves its names on the Monad registry', () => {
    const p = resolveNamedPolicy(ID, env, { chainWrites: true })!
    expect(() => assertWritePolicy(p, monadRegistry, 143)).not.toThrow()
    expect(() => assertWritePolicy(p, monadRegistry, 31337)).toThrow()
  })
})

describe('the two contract names in monad.json', () => {
  const p = () => resolveNamedPolicy(ID, env, { chainWrites: true })!
  // The pinned registry has both since 2026-10-27; these tests build the states around that from the rest of it.
  const bare: Registry = { ...monadRegistry, entries: monadRegistry.entries.filter((e) => e.name !== 'MamoruActionPolicyV2' && e.name !== 'MamoruGasPolicy') }
  const withEntries = (addr2: string, addrGas: string): Registry => ({
    ...bare,
    entries: [...bare.entries, { name: 'MamoruActionPolicyV2', kind: 'smart-sessions-policy', role: 'x', address: addr2 as never, codeHash: null }, { name: 'MamoruGasPolicy', kind: 'smart-sessions-policy', role: 'x', address: addrGas as never, codeHash: null }],
  })

  test('undeployed or absent: refused (fail closed, peer review of #137 P1)', () => {
    expect(() => assertActionPolicyOnRegistry(p(), bare)).toThrow('not pinned')
    expect(() => assertActionPolicyOnRegistry(p(), { ...bare, undeployed: ['MamoruActionPolicyV2', 'MamoruGasPolicy'] })).toThrow('not pinned')
  })

  test('once entries, the environment must name them', () => {
    expect(() => assertActionPolicyOnRegistry(p(), withEntries(V2, GAS))).not.toThrow()
    expect(() => assertActionPolicyOnRegistry(p(), withEntries(GAS, GAS))).toThrow('registry')
    expect(() => assertActionPolicyOnRegistry(p(), withEntries(V2, V2))).toThrow('registry')
  })

  test('Base is never checked', () => {
    expect(() => assertActionPolicyOnRegistry(p(), baseRegistry)).not.toThrow()
  })
})

describe('review of #137', () => {
  const acc = (policyId: string) => [{ accountKey: 'abcdef012345', policyId }]
  test('an account on the v5 sleeve policy refuses a restart on v1 (rollback), naming it', () => {
    expect(() => assertMonadV5Resolvable(acc(ID), liveWmonUsdcMonadV1)).toThrow('abcdef01')
    expect(() => assertMonadV5Resolvable(acc(ID), resolveNamedPolicy(ID, env, { chainWrites: true })!)).not.toThrow()
    expect(() => assertMonadV5Resolvable(acc('live-wmon-usdc-monad-v1'), liveWmonUsdcMonadV1)).not.toThrow()
  })

  test('the lab twin holds the V2 address on a fork rpc without chain writes; a real chain still needs the opt-in', () => {
    expect(() => assertBaseOnlyFeatures(monadRegistry, { MAMORU_ACTION_POLICY_V2_ADDRESS: V2 }, {}, 31337)).not.toThrow()
    expect(() => assertBaseOnlyFeatures(monadRegistry, { MAMORU_ACTION_POLICY_V2_ADDRESS: V2 }, {}, 143)).toThrow('Base only')
  })
})
