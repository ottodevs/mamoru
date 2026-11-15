import type { PolicyVersion } from '@mamoru/policy'
import type { Observation } from '../types.ts'

const NONE: ReadonlySet<string> = new Set()

/**
 * otto/mamoru#415: buckets ops paused for new money until a set time (`policy.entryPauseUntil`), still in force at this
 * observation's block. Read from the block timestamp, so a replay of the same observation decides the same; the
 * pause lifts by itself at the first block at or past its end.
 */
export function pausedBuckets(obs: Observation, policy: PolicyVersion): ReadonlySet<string> {
  const until = policy.entryPauseUntil
  if (!until) return NONE
  const out = new Set<string>()
  for (const [bucket, end] of Object.entries(until)) if (end !== undefined && obs.block.timestamp < BigInt(end)) out.add(bucket)
  return out.size ? out : NONE
}
