import { keccak256, stringToHex, type Hex } from 'viem'
import type { ReasonCode } from '@mamoru/domain'
import { grantKeyFor, hasManageAny, policyHash, type PolicyVersion } from '@mamoru/policy'
import { allocate, type Waiting } from './allocate/index.ts'
import { enterBucket, safeSavings } from './enter/index.ts'
import { ehgBridge, ehgPreliminary, purgaIdentity, registryOf } from './gates/index.ts'
import { fallFreezeOf } from './guard/index.ts'
import { depeggedPool, depegExitOf } from './guard/depeg.ts'
import { estimateFees, harvestOf } from './harvest/index.ts'
import { weightTargets } from './rebalance/weights.ts'
import { anyKey, convertKey, idleConvertOf, isManaged, ratioConvertOf, reduceOf, rerangeOf } from './rerange/index.ts'
import type { Decision, GateStep, GuardNote, Observation, Proposal, ShadowMetric, ShadowNote } from './types.ts'
import { withinCap } from './cap.ts'
import { tvlShadowNotes } from './shadow-tvl.ts'

export type * from './types.ts'
export { capRoomOf, placedOf, withinCap } from './cap.ts'
export { estimateFees } from './harvest/index.ts'
export { safeSavings } from './enter/index.ts'
export { amountsForLiquidity, inSavings, poolTvlInSavings, volatileOf } from './value.ts'
export { PACKAGING_TVL_FLOOR_USDC, tvlShadowNotes } from './shadow-tvl.ts'
export { fallBpsOf, fallFreezeOf, marketOf, type CumulativePoint } from './guard/index.ts'
export { belowShareOf, edgeBpsOf, meanTickAt, rangeFor, realizedVolOf, regimeOf, skewedRange, spiking, volWidthTicks, widenEarly, widthFor, type Regime } from './geometry/index.ts'
export { allocate, reusablePosition, DEFAULT_INCREASE_TOLERANCE_BPS, widthOf, type Allocation, type BucketValue, type Waiting } from './allocate/index.ts'
export { depthOf, twapFloor, type Depth } from './depth/index.ts'
export { MAX_FEE_APR_BPS, outOfRangeSinceOf, rerangeWorth, RERANGE_OPS, withOutOfRangeSince, type RerangeWorth } from './rebalance/lazy.ts'
export { weightTargets } from './rebalance/weights.ts'
export { depegExitOf, depeggedPool, pegDeviationBps, pegStep, PEG_CLEAR, type PegState } from './guard/depeg.ts'
export { fallFromBps, stageStep, thirdsOut, type StageInput, type StageState } from './rebalance/staged.ts'
export { amountsOf, bucketValues, positionValue, rerangeOf, reduceOf, EDGE_BPS, DRIFT_BPS } from './rerange/index.ts'

/** Lab (#101 round 3): drift band of a bucket under a staged exit, so the risk bucket's third (3.3 points) is reduced. */
const STAGED_DRIFT_BPS = 100

const PROPOSAL_CODE = {
  enter_swap: 'DECIDE_ENTER',
  enter_mint: 'DECIDE_ENTER',
  increase_liquidity: 'DECIDE_ENTER',
  harvest: 'DECIDE_HARVEST',
  rerange: 'DECIDE_RANGE_ADJUST',
  reduce: 'STRATEGY_PREFERENCE_DEVIATION',
  bridge_out: 'DECIDE_BRIDGE_OUT',
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
export function decide(obs: Observation, given: PolicyVersion): Decision {
  // otto/mamoru#212: for the sizing of new money only (the entries below), savings above the account's room under its
  // cap are not there to place. Re-range, harvest, reduce and idle sales read the observation as it is.
  const entryObs = withinCap(obs, given)
  // Lab (#101 experiment 6): every step reads the scaled preferences; the decision still names the policy as given.
  const targets = weightTargets(obs, given)
  const policy: PolicyVersion = targets ? { ...given, buckets: targets } : given
  const observationCodes: ReasonCode[] = ['OBS_OK']
  const unsafeDeposit = obs.deposits.some((d) => !d.safe)
  if (obs.deposits.some((d) => d.safe)) observationCodes.push('OBS_DEPOSIT_DETECTED')
  if (unsafeDeposit) observationCodes.push('OBS_DEPOSIT_UNSAFE')

  const trail: GateStep[] = [{ gate: 'observation', verdict: 'GO', reason: 'OBS_OK' }]
  const shadow: ShadowNote[] = []
  const buckets: Decision['buckets'] = []
  const positions: Decision['positions'] = []
  const policyPools = new Set(policy.buckets.flatMap((b) => b.pools))
  // Lab (#101 round 3): the stables pool while the depeg guard is tripped, and the buckets under a staged exit.
  const depegged = depeggedPool(obs, policy)
  const labGuards: NonNullable<Decision['labGuards']> = []
  if (depegged) labGuards.push({ bucket: 'stables', code: 'RISK_DEPEG_PAIRED', value: obs.guard?.peg?.deviationBps ?? 0 })
  const stagedDrift: Partial<Record<string, number>> = {}
  if (policy.stagedExit) for (const b of policy.buckets) {
    const out = obs.guard?.stages?.[b.id] ?? 0
    if (out <= 0) continue
    labGuards.push({ bucket: b.id, code: 'RISK_STAGED_EXIT', value: out })
    stagedDrift[b.id] = STAGED_DRIFT_BPS
  }

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
      if (managed && depegged && pool.name === depegged.name) {
        // Nothing moves in a depegged pool but the guard's own exit.
        codes.push('RISK_DEPEG_PAIRED')
        if (within) managedInRange++
        else managedOutOfRange++
      } else if (managed) {
        if (within) managedInRange++
        else managedOutOfRange++
        const r = rerangeOf(obs, policy, p, pool)
        if (r.code) codes.push(r.code)
        if (r.proposal) reranges.push(r.proposal)
        const h = harvestOf(p, pool, policy, est)
        codes.push(h.code)
        if (h.proposal) harvests.push(manageAny ? { ...h.proposal, grant: convertKey(policy, pool.name) } : h.proposal)
      }
    }
    positions.push({ tokenId: p.tokenId, codes })
  }

  // Spec 004 (#101): buckets frozen by a fast fall get no entry this review.
  const guards: GuardNote[] = policy.guards ? fallFreezeOf(obs, policy) : []
  const frozen = new Set(guards.filter((g) => g.code === 'DECIDE_ENTRY_PAUSED_FALL').map((g) => g.bucket))
  if (depegged) frozen.add('stables')

  // Plan §9, step 7: entry, bucket by bucket.
  const entries: Proposal[] = []
  let enterEvaluated = false
  // Target weights: pools whose idle volatile the allocation is about to mint.
  let pendingMint: ReadonlySet<string> | undefined
  let waiting: Waiting[] = []
  // otto/mamoru#215: the local entry a bridge took the review from, used when the bridge cannot go.
  let displaced: Proposal | undefined
  if (policy.allocation === 'target-weights') {
    const a = allocate(entryObs, policy, unsafeDeposit, frozen)
    // Only where the next step has a live session: without one it never goes and the token would wait for ever.
    // A mint after a re-range runs under manage-any, as below.
    const live = (grant: string) => obs.sessions.some((s) => s.grant === grant && s.active && BigInt(s.validUntil) > obs.block.timestamp && (s.usesLeft ?? 1) > 0)
    const needs = (p: { pool: string; grant: string }) => (remint && p.grant.startsWith('enter-mint') ? anyKey(policy, 'manage-any', p.pool) : p.grant)
    pendingMint = new Set(a.pendingMint.filter((p) => live(needs(p))).map((p) => p.pool))
    // Lab (#101 round 3): a bucket frozen by the depeg guard says so, not that it waits for a fall.
    for (const b of a.buckets) buckets.push({ bucket: b.bucket, code: depegged && b.bucket === 'stables' && b.code === 'DECIDE_ENTRY_PAUSED_FALL' ? 'RISK_DEPEG_PAIRED' : b.code })
    waiting = a.waiting
    trail.push(...a.trail)
    if (a.proposal) {
      enterEvaluated = true
      // otto/mamoru#215: a bridge has no pool here (its remote pool is checked by that chain's engine); every other
      // proposal's pool is looked up exactly as before, so a missing one still fails closed.
      if (a.proposal.kind !== 'bridge_out') trail.push(purgaIdentity(obs.pools.find((x) => x.name === a.proposal!.pool)!, registryOf(obs)))
      trail.push({ gate: 'strategy', verdict: 'GO', reason: 'STRATEGY_PREFERENCE_DEVIATION' }, { gate: 'eny', verdict: 'SKIP', reason: 'ENY_SHADOW' })
      entries.push(remint && a.proposal.kind === 'enter_mint' ? { ...a.proposal, grant: anyKey(policy, 'manage-any', a.proposal.pool) } : a.proposal)
      displaced = a.displaced
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
    if (frozen.has(b.id)) {
      buckets.push({ bucket: b.id, code: 'DECIDE_ENTRY_PAUSED_FALL' })
      continue
    }
    const purga = purgaIdentity(pool, registryOf(obs))
    if (purga.verdict !== 'GO') {
      trail.push(purga)
      buckets.push({ bucket: b.id, code: purga.reason })
      continue
    }
    if (unsafeDeposit) {
      buckets.push({ bucket: b.id, code: 'OBS_DEPOSIT_UNSAFE' })
      continue
    }
    const convert = ratioConvertOf(entryObs, policy, b.preference, pool, safeSavings(entryObs, policy))
    const e = convert ? { code: 'DECIDE_CONVERT' as const, proposal: convert } : enterBucket(entryObs, policy, b.preference, pool)
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
  // otto/mamoru#101 phase 1: Packaging's pool TVL floor, shadow only. Notes are all it adds; nothing below reads them.
  const shadowMetrics: ShadowMetric[] = []
  if (policy.shadow.includes('packaging:tvl')) {
    const t = tvlShadowNotes(obs, policy, policyPools)
    shadow.push(...t.notes)
    shadowMetrics.push(...t.metrics)
  }

  // Plan §9, steps 2, 4 and 8: slot, pause, then one proposal in FR-DEC-011 order.
  let proposal: Proposal | null = null
  let reason: ReasonCode
  if (obs.slot) {
    reason = 'DECIDE_SLOT_BUSY'
  } else if (obs.intents.paused) {
    reason = 'DECIDE_PAUSED'
  } else {
    // Lab (#101 round 3): the depeg exit goes before anything else.
    const exit = depegged ? depegExitOf(obs, policy, depegged) : null
    const lab = depegged || policy.stagedExit ? { ...(depegged ? { skip: new Set([depegged.name]) } : {}), driftBps: stagedDrift } : undefined
    const reduce = exit || reranges.length || harvests.length ? null : reduceOf(obs, policy, policyPools, lab)
    // A frozen bucket's idle token waits where it is: the guard never turns a pause into a sell-back.
    const frozenPools = guards.filter((g) => frozen.has(g.bucket)).map((g) => g.pool)
    if (depegged) frozenPools.push(depegged.name)
    const keep = frozenPools.length ? new Set([...(pendingMint ?? []), ...frozenPools]) : pendingMint
    const idle = exit || reranges.length || harvests.length || reduce?.proposal ? null : idleConvertOf(obs, policy, policyPools, keep)
    proposal = exit ?? reranges[0] ?? harvests[0] ?? reduce?.proposal ?? idle ?? entries[0] ?? null
    reason = proposal ? PROPOSAL_CODE[proposal.kind] : holdReason()
  }

  // Plan §9, step 9: a preliminary NO GO drops the proposal with its code.
  if (proposal) {
    const gateOf = (p: Proposal) => (p.kind === 'bridge_out' ? ehgBridge(obs, policy, p.grant) : ehgPreliminary(obs, policy, obs.pools.find((x) => x.name === p.pool)!, p.grant))
    let gate = gateOf(proposal)
    trail.push(gate)
    // otto/mamoru#215: a bridge that cannot go now never starves the Base buckets: the entry it displaced goes instead.
    if (gate.verdict !== 'GO' && proposal.kind === 'bridge_out' && displaced) {
      proposal = displaced
      reason = PROPOSAL_CODE[proposal.kind]
      gate = gateOf(proposal)
      trail.push(gate)
    }
    if (gate.verdict !== 'GO') {
      proposal = null
      reason = gate.reason
    }
  }

  function holdReason(): ReasonCode {
    if (unsafeDeposit) return 'OBS_DEPOSIT_UNSAFE'
    if (depegged) return 'RISK_DEPEG_PAIRED'
    if (managedOutOfRange > 0) return 'OBS_POSITION_OUT_OF_RANGE'
    // Spec 004: the app and /ops show that money waits because of a fall, not that nothing is to do.
    if (frozen.size > 0) return 'DECIDE_ENTRY_PAUSED_FALL'
    if (managedInRange > 0) return 'DECIDE_IN_RANGE'
    const blocking = buckets.find((b) => b.code !== 'PLAN_BUCKET_NO_EXECUTABLE_POOL')
    return blocking?.code ?? 'PLAN_BUCKET_NO_EXECUTABLE_POOL'
  }

  const kind = proposal?.kind ?? 'hold'
  const code = kind === 'hold' ? 'DECIDE_HOLD' : PROPOSAL_CODE[kind]
  const policyRef = { policyId: given.policyId, version: given.version, hash: policyHash(given) }
  // FR-LC-001: without `policy.guards` the body, and so every hash, is the one of today.
  const body = { policyRef, observationCodes, kind, code, reason, trail, proposal, shadow, buckets, positions, ...(policy.guards ? { guards } : {}), ...(targets ? { targets: targets.map((b) => ({ bucket: b.id, preference: b.preference })) } : {}), ...(labGuards.length ? { labGuards } : {}) } as const
  const observationRef = { block: obs.block.number, hash: obs.block.hash }
  const premiseHash = hashOf(body)
  // `waiting` moves with every price, so it is reported beside the decision and never part of its premise or id.
  return { decisionId: hashOf({ observationRef, premiseHash }), premiseHash, observationRef, ...body, ...(waiting.length ? { waiting } : {}), ...(shadowMetrics.length ? { shadowMetrics } : {}) } as Decision
}
