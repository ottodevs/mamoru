// otto/mamoru#348: the registry files pin A1 as T8 (deployed 3 Nov; T7 is retired). Tests of the V4 paths pin a test A1
// stack in memory over it (or take V4 out, for the paths that must stay off without it) and restore the registry after
// (bun shares modules between test files).
import type { Address } from '@mamoru/domain'
import { ONE_AUTH_V4_CONTRACTS, type OneAuthV4Deployment } from '@mamoru/policy'
import type { Registry } from '@mamoru/registry'

export const TEST_A1: OneAuthV4Deployment = {
  policy: '0x00000000000000000000000000000000000a1a01',
  gasPolicy: '0x00000000000000000000000000000000000a1a02',
  migrationCheck: '0x00000000000000000000000000000000000a1a03',
  table: '0x00000000000000000000000000000000000a1a04',
}

const AT: Record<(typeof ONE_AUTH_V4_CONTRACTS)[number], Address> = {
  MamoruActionPolicyV4: TEST_A1.policy,
  MamoruGasPolicyV2: TEST_A1.gasPolicy,
  MamoruMigrationCheck: TEST_A1.migrationCheck,
  MamoruV4Table: TEST_A1.table,
}

/** Pins TEST_A1 into `registry` in place (the V4 names leave `undeployed`); returns the restore. */
export function pinTestA1(registry: Registry): () => void {
  const entries = [...registry.entries]
  const undeployed = [...registry.undeployed]
  registry.entries = [...registry.entries.filter((e) => !(ONE_AUTH_V4_CONTRACTS as readonly string[]).includes(e.name)), ...ONE_AUTH_V4_CONTRACTS.map((name) => ({ name, kind: 'smart-sessions-policy' as const, role: 'test A1 pin (#348)', address: AT[name], codeHash: null }))]
  registry.undeployed = registry.undeployed.filter((n) => !(ONE_AUTH_V4_CONTRACTS as readonly string[]).includes(n))
  return () => {
    registry.entries = entries
    registry.undeployed = undeployed
  }
}

/** Takes the V4 stack out of `registry` in place (the names go to `undeployed`), as before T8; returns the restore. */
export function unpinA1(registry: Registry): () => void {
  const entries = [...registry.entries]
  const undeployed = [...registry.undeployed]
  const v4 = ONE_AUTH_V4_CONTRACTS.filter((n) => n !== 'MamoruMigrationCheck') as readonly string[]
  registry.entries = registry.entries.filter((e) => !v4.includes(e.name))
  registry.undeployed = [...registry.undeployed.filter((n) => !v4.includes(n)), ...v4]
  return () => {
    registry.entries = entries
    registry.undeployed = undeployed
  }
}
