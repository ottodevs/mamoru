// otto/mamoru#376 (spec 011 CAP-R5): what a V3 bridge-out grant still lets the engine bridge. The grant signs a per-call
// cap (20 % of the account cap) and a cumulative total over the approval (50 %); UniActionPolicy counts the total on
// chain. The chain's own counter (read by session-usage.ts, every use by anyone holding the key) is the truth; the
// operator's burns journal adds what the chain cannot count yet. Anything that cannot be read or does not add up is
// `unknown`, and the engine then waits instead of asking (fail closed).
import type { BridgeLimit } from '@mamoru/decide'
import type { SessionGrant } from '@mamoru/policy'
import type { BridgeBurn } from './bridge-monad.ts'
import type { ChainUsage } from './session-usage.ts'

export type BridgeLeftInput = {
  /** The account's bridge-out grant, as signed. */
  grant: SessionGrant | undefined
  /** Its usage as the chain counted it, the block it was read at, and when that read was started (ms). */
  chain: ChainUsage | undefined
  chainReadBlock: bigint | undefined
  chainReadAt: number | undefined
  /** The account's burns in the operator's journal. */
  burns: readonly BridgeBurn[]
  /** Now (ms), and the oldest read still used: a refresh that keeps failing leaves an old read in place. */
  now: number
  maxAgeMs: number
}

/** The DepositForBurn amount rule: the one cumulative rule of a bridge-out grant (per-call cap as its ref). */
function amountRuleOf(grant: SessionGrant): { perCall: bigint; total: bigint } | null {
  const rules = grant.actions.flatMap((a) => a.params.filter((r) => r.cumulativeLimit !== undefined))
  if (rules.length !== 1) return null
  const r = rules[0]!
  return { perCall: r.ref, total: r.cumulativeLimit! }
}

export function bridgeLeftOf(input: BridgeLeftInput): BridgeLimit {
  const { grant, chain, chainReadBlock, chainReadAt, burns, now, maxAgeMs } = input
  if (!grant || !chain || chainReadBlock === undefined || chainReadAt === undefined || now - chainReadAt > maxAgeMs) return { kind: 'unknown' }
  const rule = amountRuleOf(grant)
  if (!rule) return { kind: 'unknown' }
  // The chain's limit must be the one the grant was signed with, or the read is not about this grant.
  const onChain = chain.cumulative?.filter((c) => c.limit === rule.total) ?? []
  if (onChain.length !== 1) return { kind: 'unknown' }
  // A send that failed after the last read says the journal and the chain may disagree (a policy denial among the
  // causes): unknown until the chain is read again.
  // A failure with no inclusion block on record, since the read started: the journal and the chain may disagree.
  if (burns.some((b) => b.state === 'failed' && b.failedBlock === undefined && Date.parse(b.updatedAt) >= chainReadAt)) return { kind: 'unknown' }
  // The chain read is pinned to one block: it has counted every userOp included at or before it. Still to count: sends
  // with no receipt yet, and userOps included after that block (or whose block is not known). An included userOp that
  // reverted ('failed') burned nothing but was charged at validation, so it counts like a burn until the read has it.
  // Dropped (never included) spent nothing.
  let pending = 0n
  for (const b of burns) {
    const block = b.state === 'failed' ? b.failedBlock : b.burnBlock
    if (b.state === 'sending') pending += BigInt(b.amount)
    else if ((b.state === 'burned' || b.state === 'minted' || (b.state === 'failed' && b.failedBlock !== undefined)) && (block === undefined || BigInt(block) > chainReadBlock)) pending += BigInt(b.amount)
  }
  const spent = onChain[0]!.used + pending
  const amountLeft = spent >= rule.total ? 0n : rule.total - spent
  return { kind: 'v3', perCall: rule.perCall, amountLeft }
}
