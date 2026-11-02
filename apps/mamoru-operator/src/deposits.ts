import { parseAbiItem, type Address, type Hex, type PublicClient } from 'viem'
import type { OpView } from '@mamoru/domain'
import { nameOf, type Registry } from '@mamoru/registry'

/**
 * otto/mamoru#340: a deposit is USDC sent to the Safe from outside Mamoru. It moves nothing of the account, so no
 * owner op and no engine journal move ever marked it: the funding cache answered without it until it aged out, and
 * the savings history (GET /ops, built from the account's ops) never had a row for it. The operator now reads the
 * Safe's incoming USDC Transfer logs itself, from a cursor that never passes head minus DEPOSIT_CONFIRM_BLOCKS,
 * keeps each deposit at or below it as a row of its own (`AccountState.deposits`, outside `ops`, so nothing that
 * settles or retries ops ever sees one) and serves it in GET /ops as an OpView of kind 'deposit'. A deposit above it
 * is re-read on every look and served as arriving ('submitted') until it is that deep.
 */

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const ZERO = '0x0000000000000000000000000000000000000000'

/** One deposit as the account state keeps it. `at`: the block's time (ISO), or when it was found if the node gave none. */
export type DepositRow = { txHash: Hex; logIndex: number; block: string; amountUsdc: string; from: Hex; at: string }

/**
 * Smallest transfer that is a deposit row or moves the balance shown (0.01 USDC, as POSITION_DUST_USDC): anyone can
 * send a Safe dust, and dust must neither fill the history, push a real row out, nor cost a write or a chain read.
 */
export const DEPOSIT_MIN_USDC = 10_000n

/**
 * Blocks under the head a deposit's block must be to be final (about 10 minutes of Base blocks): above it a block may
 * still reorg, or a node behind may not have served its logs yet, so the cursor never passes head minus this, and a
 * deposit above it is read again on every look and shown as arriving. A fixed depth, not the 'safe' tag: one call
 * fewer per look, and the same rule on every chain whatever tags its nodes answer.
 */
export const DEPOSIT_CONFIRM_BLOCKS = 300n

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
 * The deposits among USDC Transfer logs to `safe`. Not a deposit: anything a contract of the chain's registry sent
 * (a pool, the position manager, a vault, the bridge), a mint (from zero, a CCTP leg of the account's own), the Safe
 * itself, and any transfer in a transaction of the account's own ops (`ownTx`, lowercase hashes): a vault redeem pays
 * from the vault's underlying token (aBasUSDC for waBasUSDC), which no registry names. Every other sender (a wallet,
 * an exchange, a bridge relayer bringing the owner's own money from another chain) is a deposit.
 */
export function depositsOf(logs: readonly TransferLog[], safe: Address, registry: Registry, foundAt: string, ownTx: ReadonlySet<string> = new Set()): DepositRow[] {
  const out: DepositRow[] = []
  for (const l of logs) {
    const from = l.args?.from
    const value = l.args?.value
    if (!from || typeof value !== 'bigint' || value < DEPOSIT_MIN_USDC || !l.transactionHash || l.logIndex == null || l.blockNumber == null) continue
    if (l.args?.to && l.args.to.toLowerCase() !== safe.toLowerCase()) continue
    if (from.toLowerCase() === ZERO || from.toLowerCase() === safe.toLowerCase() || nameOf(from, registry) !== undefined || ownTx.has(l.transactionHash.toLowerCase())) continue
    const ts = l.blockTimestamp == null ? null : Number(l.blockTimestamp)
    out.push({ txHash: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber.toString(), amountUsdc: value.toString(), from: from.toLowerCase() as Hex, at: ts ? new Date(ts * 1000).toISOString() : foundAt })
  }
  return out
}

/**
 * The transfers to `safe` that move the balance shown, by `tx:logIndex`: a deposit, and also Mamoru's own money coming
 * back with no op of this chain behind it (a CCTP mint, a registry contract). Dust is left out.
 */
export function balanceMoves(logs: readonly TransferLog[], safe: Address): string[] {
  return logs
    .filter((l) => typeof l.args?.value === 'bigint' && l.args.value >= DEPOSIT_MIN_USDC && l.transactionHash && l.logIndex != null && (!l.args.to || l.args.to.toLowerCase() === safe.toLowerCase()))
    .map((l) => `${l.transactionHash!.toLowerCase()}:${l.logIndex}`)
}

/** A row's id, as balanceMoves names its transfer. */
export const depositId = (d: Pick<DepositRow, 'txHash' | 'logIndex'>) => `${d.txHash.toLowerCase()}:${d.logIndex}`

/** One page of incoming USDC Transfer logs of `safe` in [from, to]. */
export async function readTransfersIn(client: PublicClient, usdc: Address, safe: Address, from: bigint, to: bigint): Promise<TransferLog[]> {
  return (await client.getLogs({ address: usdc, event: TRANSFER, args: { to: safe }, fromBlock: from, toBlock: to })) as unknown as TransferLog[]
}

/**
 * `kept` with the rows of `found` it does not hold yet (by transaction and log index), in chain order, at most `max`.
 * Over `max`, the smallest rows go first (the oldest among equals): rows of a smaller amount never push a larger one
 * out, so a run of small transfers cannot erase a real deposit from the history.
 */
export function mergeDeposits(kept: readonly DepositRow[], found: readonly DepositRow[], max = DEPOSITS_KEPT): { rows: DepositRow[]; added: DepositRow[] } {
  const id = depositId
  const have = new Set(kept.map(id))
  const added = found.filter((d) => {
    if (have.has(id(d))) return false
    have.add(id(d))
    return true
  })
  if (!added.length) return { rows: [...kept], added }
  const order = (a: DepositRow, b: DepositRow) => (BigInt(a.block) === BigInt(b.block) ? a.logIndex - b.logIndex : BigInt(a.block) < BigInt(b.block) ? -1 : 1)
  const all = [...kept, ...added].sort(order)
  if (all.length <= max) return { rows: all, added }
  const dropped = new Set([...all].sort((a, b) => (BigInt(a.amountUsdc) === BigInt(b.amountUsdc) ? order(a, b) : BigInt(a.amountUsdc) < BigInt(b.amountUsdc) ? -1 : 1)).slice(0, all.length - max))
  return { rows: all.filter((d) => !dropped.has(d)), added: added.filter((d) => !dropped.has(d)) }
}

/** The history row of a deposit: confirmed once DEPOSIT_CONFIRM_BLOCKS deep, 'submitted' (arriving) until then. */
export function depositOpView(d: DepositRow, arriving = false): OpView {
  return { opId: `dep-${d.txHash.toLowerCase()}-${d.logIndex}`, kind: 'deposit', state: arriving ? 'submitted' : 'confirmed', txHash: d.txHash, block: Number(d.block), updatedAt: d.at, amountUsdc: d.amountUsdc, asset: 'USDC', from: d.from }
}
