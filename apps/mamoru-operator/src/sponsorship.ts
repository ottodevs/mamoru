/**
 * otto/mamoru#140 (part2 #6): how much of the owner's transfers, stops and renewals the relayer pays for. A valid
 * owner signature is not a reason to pay without end: an account that signs one-unit transfers in a loop would
 * drain the relayer's ETH and stop everyone else's exits. Within the limits the relayer pays, as before; past them
 * the Safe pays its own network fee (a SafeTx refund to the relayer, see SafeTx.refund), so a proven owner is never
 * locked out. A part of the daily budget is held back for stops, so revoking the engine stays sponsored after
 * transfers have used up the rest.
 *
 * Activations are counted apart (Sol review round 2, #1): what the relayer spends on them (deploy, top-up of the
 * Safe's gas reserve, exec) is reserved against activationWeiPerDay across all accounts before anything is sent
 * (activationRefusal), so a stream of fresh Safes cannot drain the relayer either. Their per-Safe count is the
 * `activate` entries (ACTIVATIONS_PER_DAY); the spend is the `activation` entries.
 */

/**
 * `revoke`: a revoke-only Stop sponsored past the limits, when the Safe cannot pay its own fee: the owner can always
 * revoke the engine, at most EMERGENCY_REVOKES_PER_DAY times per account (a revocation does no other work).
 */
export type SponsoredKind = 'transfer' | 'stop' | 'renew' | 'revoke'
/**
 * `activate`: recorded when an activation lands, for its per-Safe count. `activation`: the relayer's spend on one
 * activation (deploy, top-up, exec), reserved before it is sent, under activationWeiPerDay only.
 */
export type SponsorEntryKind = SponsoredKind | 'activate' | 'activation'

/** Emergency revocations per account in any 24 h, outside every other limit. */
export const EMERGENCY_REVOKES_PER_DAY = 2

export type SponsorPolicy = {
  /** Sponsored transfers and renewals per account in any 24 h. */
  perAccount: number
  /** Sponsored stops per account in any 24 h, counted apart from the rest. */
  stopsPerAccount: number
  /** Wei the relayer pays for owner transactions across all accounts in any 24 h. 0n: none, every one is Safe-paid. */
  weiPerDay: bigint
  /** Share of weiPerDay (basis points) only stops may use. */
  reserveBps: number
  /** Wei the relayer spends on activations (deploy, gas-reserve top-up, exec) across all accounts in any 24 h. */
  activationWeiPerDay?: bigint
}

/** activationWeiPerDay 0.02 ETH: ~30 activations a day at the live policy's 0.0003 ETH reserve plus margin and gas. */
export const DEFAULT_SPONSOR: SponsorPolicy = { perAccount: 6, stopsPerAccount: 3, weiPerDay: 10_000_000_000_000_000n, reserveBps: 2_500, activationWeiPerDay: 20_000_000_000_000_000n }

/** `opId`: on an `activation` entry, the op it was reserved for (its retries reuse it). */
export type SponsorEntry = { at: string; wei: string; kind: SponsorEntryKind; opId?: string }

export type SponsorRefusal = { code: 'SPONSOR_ACCOUNT_LIMIT' | 'SPONSOR_DAILY_BUDGET'; until: number }

export const SPONSOR_WINDOW_MS = 24 * 3_600_000

/**
 * Code bounds on a sponsorship policy (otto/mamoru#147 phase 2 will pull it as engine settings, validated against
 * these). No env knob: a product limit lives in versioned settings, not in the operator's environment.
 */
export const SPONSOR_BOUNDS = { perAccount: [0, 50], stopsPerAccount: [0, 20], weiPerDay: [0n, 100_000_000_000_000_000n], reserveBps: [0, 10_000], activationWeiPerDay: [0n, 200_000_000_000_000_000n] } as const

/** `p` held inside SPONSOR_BOUNDS; a value outside them is the default's, never a clamp toward something unvetted. */
export function boundedSponsor(p: SponsorPolicy): SponsorPolicy {
  const n = (v: number, [lo, hi]: readonly [number, number], d: number) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d)
  const [wlo, whi] = SPONSOR_BOUNDS.weiPerDay
  const [alo, ahi] = SPONSOR_BOUNDS.activationWeiPerDay
  const a = p.activationWeiPerDay
  return {
    perAccount: n(p.perAccount, SPONSOR_BOUNDS.perAccount, DEFAULT_SPONSOR.perAccount),
    stopsPerAccount: n(p.stopsPerAccount, SPONSOR_BOUNDS.stopsPerAccount, DEFAULT_SPONSOR.stopsPerAccount),
    weiPerDay: p.weiPerDay >= wlo && p.weiPerDay <= whi ? p.weiPerDay : DEFAULT_SPONSOR.weiPerDay,
    reserveBps: n(p.reserveBps, SPONSOR_BOUNDS.reserveBps, DEFAULT_SPONSOR.reserveBps),
    activationWeiPerDay: a !== undefined && a >= alo && a <= ahi ? a : DEFAULT_SPONSOR.activationWeiPerDay!,
  }
}

/** The entries of the last 24 h. */
export function recentSponsored(entries: readonly SponsorEntry[] | undefined, now: number): SponsorEntry[] {
  return (entries ?? []).filter((e) => now - (Date.parse(e.at) || 0) < SPONSOR_WINDOW_MS)
}

/**
 * Whether the relayer may pay one more `kind` of this account, costing about `estimateWei`. `own`: the account's
 * entries, `all`: every account's (own included), both of the last 24 h. Null: it may. A refusal says until when.
 */
export function sponsorRefusal(policy: SponsorPolicy, own: readonly SponsorEntry[], all: readonly SponsorEntry[], kind: SponsoredKind, estimateWei: bigint, now: number): SponsorRefusal | null {
  const freesAt = (es: readonly SponsorEntry[]) => Math.min(...es.map((e) => (Date.parse(e.at) || 0) + SPONSOR_WINDOW_MS), now + SPONSOR_WINDOW_MS)
  if (kind === 'revoke') {
    const revokes = own.filter((e) => e.kind === 'revoke')
    return revokes.length >= EMERGENCY_REVOKES_PER_DAY ? { code: 'SPONSOR_ACCOUNT_LIMIT', until: freesAt(revokes) } : null
  }
  const stop = kind === 'stop'
  const mine = own.filter((e) => e.kind !== 'revoke' && e.kind !== 'activate' && e.kind !== 'activation' && (e.kind === 'stop') === stop)
  if (mine.length >= (stop ? policy.stopsPerAccount : policy.perAccount)) return { code: 'SPONSOR_ACCOUNT_LIMIT', until: freesAt(mine) }
  const spent = all.filter((e) => e.kind !== 'activate' && e.kind !== 'activation').reduce((n, e) => n + BigInt(e.wei), 0n)
  const ceiling = stop ? policy.weiPerDay : (policy.weiPerDay * BigInt(10_000 - policy.reserveBps)) / 10_000n
  if (spent + estimateWei > ceiling) return { code: 'SPONSOR_DAILY_BUDGET', until: freesAt(all) }
  return null
}

/**
 * Whether the relayer may spend about `estimateWei` more on one activation, given every account's `activation`
 * entries of the last 24 h (`all`). Null: it may. A refusal says until when.
 */
export function activationRefusal(policy: SponsorPolicy, all: readonly SponsorEntry[], estimateWei: bigint, now: number): SponsorRefusal | null {
  const mine = all.filter((e) => e.kind === 'activation')
  const spent = mine.reduce((n, e) => n + BigInt(e.wei), 0n)
  const ceiling = policy.activationWeiPerDay ?? DEFAULT_SPONSOR.activationWeiPerDay!
  if (spent + estimateWei <= ceiling) return null
  const until = Math.min(...mine.map((e) => (Date.parse(e.at) || 0) + SPONSOR_WINDOW_MS), now + SPONSOR_WINDOW_MS)
  return { code: 'SPONSOR_DAILY_BUDGET', until }
}
