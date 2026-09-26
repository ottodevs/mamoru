import { isAddressEqual, zeroAddress } from 'viem'
import type { PolicyVersion } from '@mamoru/policy'
import { address, entry } from '@mamoru/registry'
import type { GateStep, Observation, PoolObs } from '../types.ts'

/** Purga, identity part: the pool the chain returns is the registry's, with the registry's tokens, fee and spacing. */
export function purgaIdentity(pool: PoolObs): GateStep {
  const e = entry(pool.name)
  const id = pool.identity
  if (!e.token0 || !e.token1 || !e.fee || !e.tickSpacing || isAddressEqual(id.factoryPool, zeroAddress)) {
    return { gate: 'purga', verdict: 'NO_GO', reason: 'PURGA_IDENTITY_INCOMPLETE' }
  }
  const same =
    isAddressEqual(id.factoryPool, e.address) &&
    isAddressEqual(id.token0, address(e.token0)) &&
    isAddressEqual(id.token1, address(e.token1)) &&
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
  if (obs.native < policy.gasReserveWei) return { gate: 'ehg', verdict: 'NO_GO', reason: 'ACCT_GAS_RESERVE_LOW' }
  const session = obs.sessions.find((s) => s.grant === grant && s.active)
  if (!session) return { gate: 'ehg', verdict: 'NO_GO', reason: 'SESSION_MISSING' }
  if (BigInt(session.validUntil) <= obs.block.timestamp) return { gate: 'ehg', verdict: 'NO_GO', reason: 'SESSION_EXPIRED' }
  return { gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' }
}
