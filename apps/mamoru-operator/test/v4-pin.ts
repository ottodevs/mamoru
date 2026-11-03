// otto/mamoru#348: A1 is undeployed until T8 (and T7 is retired), so no registry file pins V4. Tests of the V4 paths pin a
// test A1 stack in memory, as the T8 pin PR will in the files, and restore the registry after (bun shares modules
// between test files).
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
