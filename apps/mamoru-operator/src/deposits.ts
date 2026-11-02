import { parseAbiItem, type Address, type Hex, type PublicClient } from 'viem'
import type { OpView } from '@mamoru/domain'
import { nameOf, type Registry } from '@mamoru/registry'

/**
 * otto/mamoru#340: a deposit is USDC sent to the Safe from outside Mamoru. It moves nothing of the account, so no
 * owner op and no engine journal move ever marked it: the funding cache answered without it until it aged out, and
 * the savings history (GET /ops, built from the account's ops) never had a row for it. The operator now reads the
 * Safe's incoming USDC Transfer logs itself, a page at a time from a cursor, keeps each deposit as a row of its own
 * (`AccountState.deposits`, outside `ops`, so nothing that settles or retries ops ever sees one) and serves it in
 * GET /ops as an OpView of kind 'deposit'.
 */

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const ZERO = '0x0000000000000000000000000000000000000000'

/** One deposit as the account state keeps it. `at`: the block's time (ISO), or when it was found if the node gave none. */
export type DepositRow = { txHash: Hex; logIndex: number; block: string; amountUsdc: string; from: Hex; at: string }

/** Blocks per eth_getLogs page (the provider's 2,000-block range, as OWNER_LOG_PAGE_BLOCKS). */
export const DEPOSIT_PAGE_BLOCKS = 2_000n
/** How far back a Safe with no cursor yet is read (about a day of Base blocks): older deposits are not listed. */
export const DEPOSIT_BACKFILL_BLOCKS = 43_200n
/** Rows kept per account, newest last. */
export const DEPOSITS_KEPT = 200

/**
 * The block range to read next: from the cursor (or DEPOSIT_BACKFILL_BLOCKS before the head when there is none) up
 * to the head, at most `pages` pages. Null when the cursor is at the head already. A gap longer than the backfill (a
 * Safe nobody looked at for days) starts over at the backfill window: older deposits are not listed.
 */
export function depositRange(cursor: bigint | undefined, head: bigint, pages: number): { from: bigint; to: bigint } | null {
  const oldest = head >= DEPOSIT_BACKFILL_BLOCKS ? head - DEPOSIT_BACKFILL_BLOCKS + 1n : 0n
  const from = cursor === undefined || cursor + 1n < oldest ? oldest : cursor + 1n
  if (from > head) return null
  const span = DEPOSIT_PAGE_BLOCKS * BigInt(pages)
  return { from, to: from + span - 1n < head ? from + span - 1n : head }
}

type TransferLog = { args?: { from?: Address; to?: Address; value?: bigint }; transactionHash?: Hex | null; logIndex?: number | null; blockNumber?: bigint | null; blockTimestamp?: bigint | number | null }

/**
 * The deposits among USDC Transfer logs to `safe`: anything a contract of the chain's registry sent (a pool, the
 * position manager, a vault, the bridge) is Mamoru's own money coming back, and a mint (from zero, a CCTP leg) is
 * a bridge of the account's own; every other sender (a wallet, an exchange, a bridge relayer) is a deposit.
 */
export function depositsOf(logs: readonly TransferLog[], safe: Address, registry: Registry, foundAt: string): DepositRow[] {
  const out: DepositRow[] = []
  for (const l of logs) {
    const from = l.args?.from
    const value = l.args?.value
    if (!from || typeof value !== 'bigint' || value <= 0n || !l.transactionHash || l.logIndex == null || l.blockNumber == null) continue
    if (l.args?.to && l.args.to.toLowerCase() !== safe.toLowerCase()) continue
    if (from.toLowerCase() === ZERO || nameOf(from, registry) !== undefined) continue
    const ts = l.blockTimestamp == null ? null : Number(l.blockTimestamp)
    out.push({ txHash: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber.toString(), amountUsdc: value.toString(), from: from.toLowerCase() as Hex, at: ts ? new Date(ts * 1000).toISOString() : foundAt })
  }
  return out
}

/** One page of incoming USDC Transfer logs of `safe` in [from, to]. */
export async function readTransfersIn(client: PublicClient, usdc: Address, safe: Address, from: bigint, to: bigint): Promise<TransferLog[]> {
  return (await client.getLogs({ address: usdc, event: TRANSFER, args: { to: safe }, fromBlock: from, toBlock: to })) as unknown as TransferLog[]
}

/** `kept` with the rows of `found` it does not hold yet (by transaction and log index), oldest first, at most `max`. */
export function mergeDeposits(kept: readonly DepositRow[], found: readonly DepositRow[], max = DEPOSITS_KEPT): { rows: DepositRow[]; added: DepositRow[] } {
  const id = (d: DepositRow) => `${d.txHash.toLowerCase()}:${d.logIndex}`
  const have = new Set(kept.map(id))
  const added = found.filter((d) => {
    if (have.has(id(d))) return false
    have.add(id(d))
    return true
  })
  if (!added.length) return { rows: [...kept], added }
  const rows = [...kept, ...added].sort((a, b) => (BigInt(a.block) === BigInt(b.block) ? a.logIndex - b.logIndex : BigInt(a.block) < BigInt(b.block) ? -1 : 1))
  return { rows: rows.slice(-max), added }
}

/** The history row of a deposit. */
export function depositOpView(d: DepositRow): OpView {
  return { opId: `dep-${d.txHash.toLowerCase()}-${d.logIndex}`, kind: 'deposit', state: 'confirmed', txHash: d.txHash, block: Number(d.block), updatedAt: d.at, amountUsdc: d.amountUsdc, asset: 'USDC', from: d.from }
}
