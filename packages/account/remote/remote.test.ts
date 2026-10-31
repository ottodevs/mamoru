import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { decodeAbiParameters, slice } from 'viem'
import { ReasonError } from '@mamoru/domain'
import { address, monadRegistry } from '@mamoru/registry'
import { decodeMamoruInitAny, liveWmonUsdcMonadV5, MONAD_GAS_CAPS, V4_POOLS_MONAD, withActionPolicy } from '@mamoru/policy'
import { accountSetup, counterfactualAddress, smartSessionInstallData } from '../recovery/index.ts'
import { toSmartSession, v4PoliciesFor, v4DeploymentOf } from '../sessions/index.ts'
import { assertRemoteSafe, monadV6Deployed, remoteSafe } from './index.ts'
import { FIXTURE_PATH, fixtureInput, fixtureJson, V3_MONAD_PINNED, withPinnedV3 } from './fixture.ts'

const code = (f: () => unknown): string | undefined => {
  try {
    f()
  } catch (e) {
    return e instanceof ReasonError ? e.code : (e as Error).message
  }
  return undefined
}

describe('remoteSafe (otto/mamoru#251)', () => {
  const input = fixtureInput()
  const r = remoteSafe(input)

  test('the committed fixture is what this code builds (RemoteSafeFork.t.sol deploys it on a Monad fork)', () => {
    expect(readFileSync(FIXTURE_PATH, 'utf8')).toBe(fixtureJson())
  })

  test('pure: the same keys, sessions and cap give the same address; any change gives another', () => {
    expect(remoteSafe(fixtureInput()).address).toBe(r.address)
    expect(r.chainId).toBe(143)
    for (const over of [{ sessionKey: '0x00000000000000000000000000000000005e5511' as const }, { validUntil: input.validUntil + 1 }, { capUsdc: input.capUsdc + 1n }, { saltNonce: input.saltNonce + 1n }, { owners: [input.owners[0]!] }]) {
      const other = over.owners ? { ...input, ...over } : { ...input, ...over }
      expect(remoteSafe(other).address).not.toBe(r.address)
    }
    // Not the Base account's address on Monad (no sessions in its setup): a different Safe, its own address.
    expect(counterfactualAddress(accountSetup(input.owners, input.saltNonce, input.webauthn, monadRegistry), monadRegistry)).not.toBe(r.address)
  })

  test('SmartSession is installed with UNSAFE_ENABLE and every session of the policy', () => {
    const v = r.setup.validators
    expect(v).toHaveLength(1)
    expect(v[0]!.module).toBe(address('SmartSession', monadRegistry))
    expect(slice(v[0]!.initData, 0, 1)).toBe('0x02')
    expect(v[0]!.initData).toBe(smartSessionInstallData(r.sessions))
    expect(smartSessionInstallData([])).toBe('0x')
    expect(r.grants.map((g) => g.name)).toEqual(['enter-swap', 'enter-mint', 'manage-any'])
    expect(r.grants.every((g) => g.account === r.address && g.chainId === 143)).toBe(true)
    expect(new Set(r.permissionIds).size).toBe(3)
  })

  test('every action: MamoruActionPolicyV3 alone, in setup mode at generation 1; userOps under TimeFrame, UsageLimit and MamoruGasPolicy', () => {
    for (const s of r.sessions) {
      expect(s.userOpPolicies.map((p) => p.policy)).toEqual([address('TimeFramePolicy', monadRegistry), address('UsageLimitPolicy', monadRegistry), address('MamoruGasPolicy', monadRegistry)])
      for (const a of s.actions) {
        expect(a.actionPolicies).toHaveLength(1)
        expect(a.actionPolicies[0]!.policy).toBe(V3_MONAD_PINNED)
        const { init, atSetup } = decodeMamoruInitAny(a.actionPolicies[0]!.initData)
        expect(atSetup).toBe(true)
        expect(init.generation).toBe(1n)
        expect(init.pool).toBe(address(V4_POOLS_MONAD.growth.pool, monadRegistry))
        expect(init.perWindow).toBe(input.capUsdc * 3n)
        expect(init.total).toBe(input.capUsdc * 10n)
        expect(init.admit).toEqual([])
      }
    }
    // Mint and increase target V3 itself (retargeted), never the position manager.
    const targets = r.grants.flatMap((g) => g.actions.filter((a) => a.signature.startsWith('mint(') || a.signature.startsWith('increase(')).map((a) => a.targetAddress))
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.every((t) => t === V3_MONAD_PINNED)).toBe(true)
  })

  test('assertRemoteSafe: the app refuses an offered address its own keys do not give', () => {
    expect(assertRemoteSafe(input, r.address).address).toBe(r.address)
    expect(code(() => assertRemoteSafe(input, '0x00000000000000000000000000000000000000aa'))).toBe('REMOTE_SAFE_MISMATCH')
  })

  test('refuses a policy that is not V3-only, a non-positive cap, and an unpinned V3', () => {
    const v5 = withActionPolicy(liveWmonUsdcMonadV5, V3_MONAD_PINNED, [V4_POOLS_MONAD.growth], { gasPolicy: { address: address('MamoruGasPolicy', monadRegistry), caps: MONAD_GAS_CAPS }, contractVersion: 3 })
    expect(code(() => remoteSafe({ ...input, policy: v5 }))).toBe('SESSION_ACTION_POLICY_MISMATCH')
    const v2 = withActionPolicy(input.policy, V3_MONAD_PINNED, [V4_POOLS_MONAD.growth], { gasPolicy: { address: address('MamoruGasPolicy', monadRegistry), caps: MONAD_GAS_CAPS }, contractVersion: 2 })
    expect(code(() => remoteSafe({ ...input, policy: v2 }))).toBe('SESSION_ACTION_POLICY_MISSING')
    expect(code(() => remoteSafe({ ...input, capUsdc: 0n }))).toContain('capUsdc')
    expect(code(() => monadV6Deployed(monadRegistry))).toBe('POLICY_TARGET_NOT_IN_REGISTRY')
    expect(monadV6Deployed(withPinnedV3()).actionPolicy?.address).toBe(V3_MONAD_PINNED)
  })
})

describe('toSmartSession guards for V3-only grants (otto/mamoru#251)', () => {
  const input = fixtureInput()
  const r = remoteSafe(input)
  const d = v4DeploymentOf(input.policy)!

  test('a V3-only grant with a param rule is refused', () => {
    const g = { ...r.grants[0]!, actions: r.grants[0]!.actions.map((a, i) => (i ? a : { ...a, params: [{ field: 'x', index: 0, condition: 'EQUAL' as const, ref: 1n, denial: 'POLICY_DENIED_TARGET' as const }] })) }
    expect(code(() => toSmartSession(g, v4PoliciesFor([g], d, 1n, { growthBudgetWindow: 1n, growthBudgetTotal: 1n }, {}, monadRegistry, { atSetup: true })(g, 0), monadRegistry))).toBe('SESSION_ACTION_POLICY_MISMATCH')
  })

  test('a setup-mode Init on a grant that also carries UniActionPolicy is refused (V2 would reject it)', () => {
    const g = { ...r.grants[0]!, actionPolicyOnly: undefined }
    expect(code(() => toSmartSession(g, v4PoliciesFor([g], d, 1n, { growthBudgetWindow: 1n, growthBudgetTotal: 1n }, {}, monadRegistry, { atSetup: true })(g, 0), monadRegistry))).toBe('SESSION_ACTION_POLICY_MISMATCH')
  })

  test('setup-mode init data decodes to the Init the contract reads', () => {
    const data = r.sessions[0]!.actions[0]!.actionPolicies[0]!.initData
    const [family] = decodeAbiParameters([{ type: 'uint256' }], slice(data, 0, 32))
    expect(family).toBe(3n)
  })
})
