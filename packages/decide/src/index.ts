import { keccak256, stringToHex, type Hex } from 'viem'
import type { ReasonCode } from '@mamoru/domain'
import { grantKeyFor, hasManageAny, policyHash, type PolicyVersion } from '@mamoru/policy'
import { allocate } from './allocate/index.ts'
import { enterBucket, safeSavings } from './enter/index.ts'
import { ehgPreliminary, purgaIdentity } from './gates/index.ts'
import { estimateFees, harvestOf } from './harvest/index.ts'
import { anyKey, idleConvertOf, isManaged, ratioConvertOf, reduceOf, rerangeOf } from './rerange/index.ts'
import type { Decision, GateStep, Observation, Proposal, ShadowNote } from './types.ts'

export type * from './types.ts'
export { estimateFees } from './harvest/index.ts'
export { safeSavings } from './enter/index.ts'
export { amountsForLiquidity, inSavings, volatileOf } from './value.ts'
export { allocate, widthOf, type Allocation, type BucketValue } from './allocate/index.ts'
export { amountsOf, bucketValues, positionValue, rerangeOf, reduceOf, EDGE_BPS, DRIFT_BPS } from './rerange/index.ts'

const PROPOSAL_CODE = {
  enter_swap: 'DECIDE_ENTER',
  enter_mint: 'DECIDE_ENTER',
  harvest: 'DECIDE_HARVEST',
  rerange: 'DECIDE_RANGE_ADJUST',
  reduce: 'STRATEGY_PREFERENCE_DEVIATION',
} as const

/** Deterministic JSON: sorted keys, bigints as decimal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return v.toString()
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    return v
  })
}

function hashOf(value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(value)))
}

function inRange(tick: number, lower: number, upper: number): boolean {
  return tick >= lower && tick < upper
}

/**
 * FR-DEC-001: pure and deterministic. The same observation and policy give
 * the same decision, codes and trail, byte for byte.
 */
export function decide(obs: Observation, policy: PolicyVersion): Decision {
  const observationCodes: ReasonCode[] = ['OBS_OK']
  const unsafeDeposit = obs.deposits.some((d) => !d.safe)
  if (obs.deposits.some((d) => d.safe)) observationCodes.push('OBS_DEPOSIT_DETECTED')
  if (unsafeDeposit) observationCodes.push('OBS_DEPOSIT_UNSAFE')

  const trail: GateStep[] = [{ gate: 'observation', verdict: 'GO', reason: 'OBS_OK' }]
  const shadow: ShadowNote[] = []
  const buckets: Decision['buckets'] = []
  const positions: Decision['positions'] = []
  const policyPools = new Set(policy.buckets.flatMap((b) => b.pools))

  // Plan §9, step 10 and FR-DEC-009: annotations for every position, harvest only for managed ones.
  const harvests: Proposal[] = []
  const reranges: Proposal[] = []
  const manageAny = hasManageAny(policy)
  // After a re-range, re-mints go through manage-any: enter-mint's cumulative cap covers the first entry only.
  const remint = manageAny && (obs.lastRerangeAt ?? null) !== null
  let managedInRange = 0
  let managedOutOfRange = 0
  for (const p of obs.positions) {
    const codes: ReasonCode[] = []
    const pool = p.pool ? obs.pools.find((x) => x.name === p.pool) : undefined
    const managed = !!pool && isManaged(p, policy, policyPools)
    if (!managed) codes.push('OBS_UNMANAGED_ASSET')
    if (pool) {
      const within = inRange(pool.tick, p.tickLower, p.tickUpper)
      if (!within) codes.push('OBS_POSITION_OUT_OF_RANGE')
      const est = estimateFees(obs, policy, p, pool)
      if (est.aboveCost) codes.push('OBS_FEES_ABOVE_COST')
      if (managed) {
        if (within) managedInRange++
        else managedOutOfRange++
        const r = rerangeOf(obs, policy, p, pool)
        if (r.code) codes.push(r.code)
        if (r.proposal) reranges.push(r.proposal)
        const h = harvestOf(p, pool, policy, est)
        codes.push(h.code)
        if (h.proposal) harvests.push(manageAny ? { ...h.proposal, grant: anyKey(policy, 'convert-any', pool.name) } : h.proposal)
      }
    }
    positions.push({ tokenId: p.tokenId, codes })
  }

  // Plan §9, step 7: entry, bucket by bucket.
  const entries: Proposal[] = []
  let enterEvaluated = false
  // Target weights: pools whose idle volatile the allocation is about to mint.
  let pendingMint: ReadonlySet<string> | undefined
  if (policy.allocation === 'target-weights') {
    const a = allocate(obs, policy, unsafeDeposit)
    // Only where the mint has a live session: without one the mint never goes and the token would wait for ever.
    const live = (grant: string) => obs.sessions.some((s) => s.grant === grant && s.active && BigInt(s.validUntil) > obs.block.timestamp)
    pendingMint = new Set(a.pendingMint.filter((pool) => live(remint ? anyKey(policy, 'manage-any', pool) : grantKeyFor(policy, 'enter-mint', pool))))
    for (const b of a.buckets) buckets.push({ bucket: b.bucket, code: b.code })
    trail.push(...a.trail)
    if (a.proposal) {
      enterEvaluated = true
      const pool = obs.pools.find((x) => x.name === a.proposal!.pool)!
      trail.push(purgaIdentity(pool), { gate: 'strategy', verdict: 'GO', reason: 'STRATEGY_PREFERENCE_DEVIATION' }, { gate: 'eny', verdict: 'SKIP', reason: 'ENY_SHADOW' })
      entries.push(remint && a.proposal.kind === 'enter_mint' ? { ...a.proposal, grant: anyKey(policy, 'manage-any', a.proposal.pool) } : a.proposal)
    }
  } else for (const b of policy.buckets) {
    const poolName = b.pools[0]
    const pool = poolName ? obs.pools.find((x) => x.name === poolName) : undefined
    if (!pool) {
      buckets.push({ bucket: b.id, code: 'PLAN_BUCKET_NO_EXECUTABLE_POOL' })
      continue
    }
    const entered = obs.positions.some((p) => p.pool === pool.name && isManaged(p, policy, policyPools))
    if (entered) {
      buckets.push({ bucket: b.id, code: 'STRATEGY_PREFERENCE' })
      continue
    }
    const purga = purgaIdentity(pool)
    if (purga.verdict !== 'GO') {
      trail.push(purga)
      buckets.push({ bucket: b.id, code: purga.reason })
      continue
    }
    if (unsafeDeposit) {
      buckets.push({ bucket: b.id, code: 'OBS_DEPOSIT_UNSAFE' })
      continue
    }
    const convert = ratioConvertOf(obs, policy, b.preference, pool, safeSavings(obs, policy))
    const e = convert ? { code: 'DECIDE_CONVERT' as const, proposal: convert } : enterBucket(obs, policy, b.preference, pool)
    if (remint && e.proposal?.kind === 'enter_mint') e.proposal = { ...e.proposal, grant: anyKey(policy, 'manage-any', pool.name) }
    buckets.push({ bucket: b.id, code: e.code })
    if (e.proposal) {
      enterEvaluated = true
      trail.push(purga, { gate: 'strategy', verdict: 'GO', reason: 'STRATEGY_PREFERENCE' }, { gate: 'eny', verdict: 'SKIP', reason: 'ENY_SHADOW' })
      entries.push(e.proposal)
    }
  }
  if (enterEvaluated && policy.shadow.includes('packaging:eny')) {
    shadow.push({ code: 'ENY_SHADOW', note: 'packaging:eny is not evaluated in v1 and has no effect on the decision' })
  }

  // Plan §9, steps 2, 4 and 8: slot, pause, then one proposal in FR-DEC-011 order.
  let proposal: Proposal | null = null
  let reason: ReasonCode
  if (obs.slot) {
    reason = 'DECIDE_SLOT_BUSY'
  } else if (obs.intents.paused) {
    reason = 'DECIDE_PAUSED'
  } else {
    const reduce = reranges.length || harvests.length ? null : reduceOf(obs, policy, policyPools)
    const idle = reranges.length || harvests.length || reduce?.proposal ? null : idleConvertOf(obs, policy, policyPools, pendingMint)
    proposal = reranges[0] ?? harvests[0] ?? reduce?.proposal ?? idle ?? entries[0] ?? null
    reason = proposal ? PROPOSAL_CODE[proposal.kind] : holdReason()
  }

  // Plan §9, step 9: a preliminary NO GO drops the proposal with its code.
  if (proposal) {
    const pool = obs.pools.find((x) => x.name === proposal!.pool)!
    const gate = ehgPreliminary(obs, policy, pool, proposal.grant)
    trail.push(gate)
    if (gate.verdict !== 'GO') {
      proposal = null
      reason = gate.reason
    }
  }

  function holdReason(): ReasonCode {
    if (unsafeDeposit) return 'OBS_DEPOSIT_UNSAFE'
    if (managedOutOfRange > 0) return 'OBS_POSITION_OUT_OF_RANGE'
    if (managedInRange > 0) return 'DECIDE_IN_RANGE'
    const blocking = buckets.find((b) => b.code !== 'PLAN_BUCKET_NO_EXECUTABLE_POOL')
    return blocking?.code ?? 'PLAN_BUCKET_NO_EXECUTABLE_POOL'
  }

  const kind = proposal?.kind ?? 'hold'
  const code = kind === 'hold' ? 'DECIDE_HOLD' : PROPOSAL_CODE[kind]
  const policyRef = { policyId: policy.policyId, version: policy.version, hash: policyHash(policy) }
  const body = { policyRef, observationCodes, kind, code, reason, trail, proposal, shadow, buckets, positions } as const
  const observationRef = { block: obs.block.number, hash: obs.block.hash }
  const premiseHash = hashOf(body)
  return { decisionId: hashOf({ observationRef, premiseHash }), premiseHash, observationRef, ...body } as Decision
}
