/**
 * otto/mamoru#225: the signed lines of an approval, read into blocks the dialog can lay out by meaning: what changes,
 * the limits per pool, the bridge, the network fee, the promises. Every line lands in exactly one block, in its order;
 * a line no reader knows is kept as `text`, word for word, and is shown as such. A reader that half-matches a line
 * never guesses: the line falls through to `text`. The passkey still signs the lines themselves (#41), which the dialog
 * keeps one tap away.
 */

export type ChangeKind = 'new' | 'safer' | 'wound' | 'replaced' | 'cap' | 'paused'

/** A change a known line states; `key` names the sentence, so the dialog can say it in the reader's language. */
export type Change =
  | { kind: ChangeKind; key: 'onchain' | 'guardian' | 'add' | 'revoked' | 'paused'; line: number }
  | { kind: 'wound'; key: 'wound'; pool: string; line: number }
  | { kind: 'new'; key: 'remote'; share: string; bucket: string; chain: string; safe: string; line: number }
  | { kind: 'cap'; key: 'capChange'; from: string; to: string; line: number }

export type PoolLimits = {
  pool: string
  line: number
  /** The band around the 30- and 5-minute average price, e.g. "1.00%". */
  band: string
  /** Stable pools only: the band around 1:1. */
  peg: string | null
  dayUsdc: string
  totalUsdc: string
}

export type Promise_ = { key: 'nothingMoves' | 'paidToSafe' | 'noAsking' | 'positionsStay'; count?: number; line: number }

export type ApprovalRead = {
  /** The first line ("Renew Mamoru's approval on your Safe 0x…"): `move` when it also moves to another policy. */
  head: { line: number; move: boolean; safe: string | null } | null
  /**
   * The engine key's line. `form` names the sentence when it is one of the two short known ones (a renewal: the same
   * kinds of actions under new limits; the rest of a split approval); any other form (an activation's own list of
   * actions) is also kept in `text`, word for word, and only lends its days and cap to the facts.
   */
  engine: { line: number; key: string; days: number | null; capUsdc: string | null; form: 'renew' | 'finish' | null } | null
  changes: Change[]
  pools: PoolLimits[]
  remote: { lines: number[]; chain: string | null; pools: string | null; until: string | null; crosses: boolean } | null
  bridge: { line: number; chain: string; perTxUsdc: string; totalUsdc: string; pause: boolean } | null
  gas: { line: number; perTxEth: string; gwei: string; txs: string } | null
  steps: { line: number; text: string } | null
  promises: Promise_[]
  /** Lines no reader knows, word for word. */
  text: { line: number; text: string }[]
}

const ADDR = '(0x[0-9a-fA-F]{40})'
const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)'

const HEAD = new RegExp(`^(?:Renew|Finish) Mamoru's approval on your Safe ${ADDR}( and move it to on-chain limits)?`)
const ENGINE = new RegExp(`^Engine key ${ADDR} may\\b`)
const ENGINE_DAYS = /for (\d+) (?:more )?days/
const ENGINE_CAP = new RegExp(`deposits up to ${NUM} USDC`)
const ENGINE_RENEW = new RegExp(`^Engine key ${ADDR} may keep doing the same kinds of actions for \\d+ more days, within new limits counted from zero, sized for deposits up to ${NUM} USDC \\((?:your cap|the cap you signed)\\):$`)
const ENGINE_FINISH = new RegExp(`^Engine key ${ADDR} may, for the rest of this approval and within limits sized for deposits up to ${NUM} USDC:$`)
const POOL = new RegExp(`^In (.+?): swaps, new positions and withdrawals only within ${NUM}% of the 30- and 5-minute average price(?: and within ${NUM}% of 1:1)?; swaps and new positions worth at most ${NUM} USDC a day and ${NUM} USDC in total on this approval$`)
const REMOTE = new RegExp(`^${NUM}% of your savings \\((\\w+)\\) goes to your own Safe on (\\w+), ${ADDR}: same owner \\(your passkey\\), created by Mamoru with no other signature$`)
const REMOTE_POOLS = /^On (\w+) Mamoru may only swap and provide liquidity in (.+?), near the market price, paid only to that Safe, until (\d{4}-\d{2}-\d{2})$/
const REMOTE_BRIDGE = /^USDC crosses only to that Safe, through Circle's bridge \(CCTP\), at no fee$/
const BRIDGE = new RegExp(`^Bridge: it may burn USDC with Circle's CCTP only to your own address on (\\w+) \\(never to another address, never any fee\\), at most ${NUM} USDC a time and ${NUM} USDC in total on this approval(; a guardian pause stops it)?$`)
const GAS = new RegExp(`^Each engine transaction pays at most ${NUM} ETH of network fee \\(at most ${NUM} gwei per gas\\), from your Safe's ETH; these grants allow ${NUM} transactions in all$`)
const WOUND = /^(.+?) is only wound down, nothing new goes into it$/
const CAP_CHANGE = new RegExp(`^Your cap changes from ${NUM} to ${NUM} USDC: the limits above are sized for the new one$`)
const POSITIONS = /^Your (\d+) open positions? (?:there )?stays? under Mamoru's management$/

const FIXED: Record<string, { change: Extract<Change, { key: 'onchain' | 'guardian' | 'add' | 'revoked' | 'paused' }>['key']; kind: ChangeKind } | { promise: Promise_['key'] }> = {
  'Mamoru can now trade only near the market price, and only the positions it opened': { change: 'onchain', kind: 'safer' },
  'A guardian key can pause it at any time; that key can never move your funds, and your next renewal ends a pause': { change: 'guardian', kind: 'safer' },
  'It can add to a position it already holds instead of opening another one': { change: 'add', kind: 'new' },
  'The approval it replaces is revoked in the same transaction': { change: 'revoked', kind: 'replaced' },
  'A guardian key has paused Mamoru on this Safe. This renewal ends that pause: approve it only if you know why it was paused': { change: 'paused', kind: 'paused' },
  'Nothing is moved: your positions stay as they are': { promise: 'nothingMoves' },
  'Nothing is moved now: your positions stay as they are': { promise: 'nothingMoves' },
  'Whatever it collects, mints or swaps is paid to your Safe, never to anyone else': { promise: 'paidToSafe' },
  'It does this without asking you again, only within these limits, and whatever it collects, mints or swaps is paid to your Safe, never to anyone else': { promise: 'noAsking' },
}

export function readApproval(lines: readonly string[]): ApprovalRead {
  const r: ApprovalRead = { head: null, engine: null, changes: [], pools: [], remote: null, bridge: null, gas: null, steps: null, promises: [], text: [] }
  const remote = () => (r.remote ??= { lines: [], chain: null, pools: null, until: null, crosses: false })
  lines.forEach((l, line) => {
    const fixed = FIXED[l]
    if (fixed) {
      if ('promise' in fixed) r.promises.push({ key: fixed.promise, line })
      else r.changes.push({ kind: fixed.kind, key: fixed.change, line })
      return
    }
    let m: RegExpMatchArray | null
    if (line === 0 && (m = l.match(HEAD))) {
      r.head = { line, move: !!m[2], safe: m[1]! }
      return
    }
    if (!r.engine && (m = l.match(ENGINE))) {
      const form = ENGINE_RENEW.test(l) ? 'renew' : ENGINE_FINISH.test(l) ? 'finish' : null
      r.engine = { line, key: m[1]!, days: Number(l.match(ENGINE_DAYS)?.[1] ?? NaN) || null, capUsdc: l.match(ENGINE_CAP)?.[1] ?? null, form }
      if (!form) r.text.push({ line, text: l })
      return
    }
    if ((m = l.match(POOL))) {
      r.pools.push({ pool: m[1]!, line, band: `${m[2]}%`, peg: m[3] ? `${m[3]}%` : null, dayUsdc: m[4]!, totalUsdc: m[5]! })
      return
    }
    if ((m = l.match(REMOTE))) {
      r.changes.push({ kind: 'new', key: 'remote', share: `${m[1]}%`, bucket: m[2]!, chain: m[3]!, safe: m[4]!, line })
      remote().lines.push(line)
      return
    }
    if ((m = l.match(REMOTE_POOLS))) {
      Object.assign(remote(), { chain: m[1]!, pools: m[2]!, until: m[3]! })
      remote().lines.push(line)
      return
    }
    if (REMOTE_BRIDGE.test(l)) {
      remote().crosses = true
      remote().lines.push(line)
      return
    }
    if (!r.bridge && (m = l.match(BRIDGE))) {
      r.bridge = { line, chain: m[1]!, perTxUsdc: m[2]!, totalUsdc: m[3]!, pause: !!m[4] }
      return
    }
    if (!r.gas && (m = l.match(GAS))) {
      r.gas = { line, perTxEth: m[1]!, gwei: m[2]!, txs: m[3]! }
      return
    }
    if ((m = l.match(WOUND))) {
      r.changes.push({ kind: 'wound', key: 'wound', pool: m[1]!, line })
      return
    }
    if ((m = l.match(CAP_CHANGE))) {
      r.changes.push({ kind: 'cap', key: 'capChange', from: m[1]!, to: m[2]!, line })
      return
    }
    if ((m = l.match(POSITIONS))) {
      r.promises.push({ key: 'positionsStay', count: Number(m[1]), line })
      return
    }
    if (!r.steps && l.startsWith('Base limits how much one transaction can carry')) {
      r.steps = { line, text: l }
      return
    }
    r.text.push({ line, text: l })
  })
  return r
}

/** Every line index the read accounts for, once each: the dialog's tests hold it to `lines.length`. */
export function linesOf(r: ApprovalRead): number[] {
  return [
    ...(r.head ? [r.head.line] : []),
    ...(r.engine?.form ? [r.engine.line] : []),
    ...r.changes.filter((c) => c.key !== 'remote').map((c) => c.line),
    ...r.pools.map((p) => p.line),
    ...(r.remote?.lines ?? []),
    ...(r.bridge ? [r.bridge.line] : []),
    ...(r.gas ? [r.gas.line] : []),
    ...(r.steps ? [r.steps.line] : []),
    ...r.promises.map((p) => p.line),
    ...r.text.map((t) => t.line),
  ].sort((a, b) => a - b)
}
