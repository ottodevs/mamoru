import { isAddressEqual, zeroAddress } from 'viem'
import type { PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry, type Registry } from '@mamoru/registry'
import type { GateStep, Observation, PoolObs } from '../types.ts'

/**
 * The registry an observation was read against. An observation without one is a Base observation until the
 * registry default is retired; after that the field is required and this is `obs.registry`.
 */
export function registryOf(obs: Pick<Observation, 'registry'>): Registry {
  return obs.registry ?? baseRegistry
}

/**
 * Purga, identity part: the pool the chain returns is the registry's, with the registry's tokens, fee and spacing.
 * The registry is the observation's: a pool name it lacks is POLICY_TARGET_NOT_IN_REGISTRY, never a Base lookup.
 */
export function purgaIdentity(pool: PoolObs, registry: Registry): GateStep
/** @deprecated Bound to `baseRegistry`. Pass the registry of the observation: `purgaIdentity(pool, registryOf(obs))`. */
export function purgaIdentity(pool: PoolObs): GateStep
export function purgaIdentity(pool: PoolObs, registry?: Registry): GateStep {
  const r = registry ?? baseRegistry
  const e = entry(pool.name, r)
  const id = pool.identity
  if (!e.token0 || !e.token1 || !e.fee || !e.tickSpacing || isAddressEqual(id.factoryPool, zeroAddress)) {
    return { gate: 'purga', verdict: 'NO_GO', reason: 'PURGA_IDENTITY_INCOMPLETE' }
  }
  const same =
    isAddressEqual(id.factoryPool, e.address) &&
    isAddressEqual(id.token0, address(e.token0, r)) &&
    isAddressEqual(id.token1, address(e.token1, r)) &&
    id.fee === e.fee &&
    id.tickSpacing === e.tickSpacing
  return same ? { gate: 'purga', verdict: 'GO', reason: 'PURGA_OK' } : { gate: 'purga', verdict: 'NO_GO', reason: 'PURGA_IDENTITY_MISMATCH' }
}

/**
 * Preliminary Execution Health Gate on the observation (plan §9, step 9):
 * TWAP guard, gas reserve and a live session for the grant.
 */
export function ehgPreliminary(obs: Observation, policy: PolicyVersion, pool: PoolObs, grant: string): GateStep {
  if (pool.twapTick === null) return { gate: 'ehg', verdict: 'NO_GO', reason: 'EHG_TWAP_UNAVAILABLE' }
  if (Math.abs(pool.tick - pool.twapTick) > policy.execution.maxTwapDeviationTicks) return { gate: 'ehg', verdict: 'NO_GO', reason: 'EHG_PRICE_DIVERGENCE' }
  return ehgAccount(obs, policy, grant)
}

/**
 * otto/mamoru#215: the gate of a bridge-out, which touches no pool here (the remote engine checks its own pool's price
 * at its entry), and of a vault op (#210), which prices no pool either: the account's gas reserve and the grant's
 * session, as for any other op.
 */
export function ehgBridge(obs: Observation, policy: PolicyVersion, grant: string): GateStep {
  return ehgAccount(obs, policy, grant)
}

function ehgAccount(obs: Observation, policy: PolicyVersion, grant: string): GateStep {
  if (obs.native < policy.gasReserveWei) return { gate: 'ehg', verdict: 'NO_GO', reason: 'ACCT_GAS_RESERVE_LOW' }
  const session = obs.sessions.find((s) => s.grant === grant && s.active)
  if (!session) return { gate: 'ehg', verdict: 'NO_GO', reason: 'SESSION_MISSING' }
  if (BigInt(session.validUntil) <= obs.block.timestamp) return { gate: 'ehg', verdict: 'NO_GO', reason: 'SESSION_EXPIRED' }
  // #149: the chain would refuse it; the typed reason is what the operator turns into the renewal row.
  if (session.usesLeft !== undefined && session.usesLeft <= 0) return { gate: 'ehg', verdict: 'NO_GO', reason: 'SESSION_USAGE_SPENT' }
  return { gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' }
}
