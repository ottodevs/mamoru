import type { ReasonCode } from '@mamoru/domain'
import type { PolicyVersion } from '@mamoru/policy'
import type { HarvestProposal, Observation, PoolObs, PositionObs } from '../types.ts'
import { inSavings, opCostInSavings } from '../value.ts'

export type FeeEstimate = { fees0: bigint; fees1: bigint; feesValue: bigint; costValue: bigint; aboveCost: boolean }

function sub0(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n
}

/** FR-DEC-009 and FR-DEC-015: fees are what is collectable above the principal owed, compared with the op cost times the policy factor. */
export function estimateFees(obs: Observation, policy: PolicyVersion, position: PositionObs, pool: PoolObs): FeeEstimate {
  const savings = policy.savingsAsset
  const fees0 = sub0(position.collectable0, position.principalOwed0)
  const fees1 = sub0(position.collectable1, position.principalOwed1)
  const feesValue = inSavings(pool, pool.token0, fees0, savings) + inSavings(pool, pool.token1, fees1, savings)
  const costValue = opCostInSavings(obs, savings)
  const aboveCost = feesValue > 0n && feesValue * 10_000n > costValue * BigInt(policy.harvest.costFactorBps)
  return { fees0, fees1, feesValue, costValue, aboveCost }
}

/**
 * A managed position whose fees beat the cost gets a harvest proposal. It only collects (otto/mamoru#140): a
 * conversion in the same batch swapped an amount fixed before inclusion, which could be principal if the fees were
 * collected elsewhere first (FR-UNI-005). The volatile fees stay in the account for a later sell-back or entry.
 */
export function harvestOf(position: PositionObs, pool: PoolObs, policy: PolicyVersion, est: FeeEstimate): { code: ReasonCode; proposal: HarvestProposal | null } {
  if (!est.aboveCost) return { code: 'DECIDE_HARVEST_BELOW_COST', proposal: null }
  return {
    code: 'DECIDE_HARVEST',
    proposal: {
      kind: 'harvest',
      grant: `manage:${position.tokenId}`,
      pool: pool.name,
      tokenId: position.tokenId,
      fees0: est.fees0,
      fees1: est.fees1,
      convert: null,
    },
  }
}
