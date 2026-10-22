// otto/mamoru#155: a withdrawal priced under the pool's 30-minute TWAP is never refused. Prepare answers with the
// warning in numbers; submit runs only with that warning's quote accepted, at the minimum the owner saw; a quote the
// price has fallen under answers PRICE_DIVERGENCE_STALE with nothing sent. Without a divergence nothing changes, and
// Stop never asks.
import { describe, expect, test } from 'bun:test'
import { toHex } from 'viem'
import type { OwnerSignature, TransferPlan } from '@mamoru/domain'
import { minOut } from '@mamoru/uniswap-v3/quote'
import { divergenceLeg, divergenceWarning, judgeSwap, staleAcceptance } from '../src/divergence.ts'
import { TO, ctx, quiet, sign, world } from './owner-world.ts'

const CBBTC_FEE = 500
/** What 5 cbBTC units buy at tick 0 after the 0.05% fee: the fair amount of the swap back. */
const IDLE = 5_000_000n
const FAIR = (IDLE - 1n) * BigInt(1_000_000 - CBBTC_FEE) / 1_000_000n
const SLIP = 50

/** A deployed Safe with 1 USDC and idle cbBTC: withdrawing 3 USDC swaps the cbBTC back first. */
function swapBackWorld() {
  const w = world(1_000_000n)
  w.chain.deployed = true
  w.knobs.idle = { cbBTC: IDLE }
  return w
}

/** QuoterV2 answers `pct`% of the fair price on every pool. */
const at = (pct: bigint) => (q: { fee: number; amountIn: bigint }) => (((q.amountIn * BigInt(1_000_000 - q.fee)) / 1_000_000n) * pct) / 100n

const accept = (plan: TransferPlan, quoteId = plan.divergence!.quoteId): OwnerSignature => ({ ...sign(plan.ownerTx), acceptDivergence: { quoteId } })

describe('otto/mamoru#155: withdrawal under a price divergence', () => {
  test('no divergence: no warning, the usual minimum, and it runs without any acceptance', async () => {
    const w = swapBackWorld()
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' })
    expect(plan.divergence).toBeUndefined()
    expect(plan.ownerTx.summary).toContain(`Swap ${IDLE - 1n} cbBTC units to at least ${fmt(minOut(FAIR, SLIP))} USDC`)
    const { out } = await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))
    expect(out).toMatchObject({ kind: 'transfer', state: 'confirmed' })
    expect(w.sent).toHaveLength(1)
  })

  test('a swap back quoted under the TWAP floor: prepared, never refused, with the loss in numbers', async () => {
    const w = swapBackWorld()
    w.knobs.quote = at(90n)
    const { out: plan } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    const quote = (FAIR * 90n) / 100n
    const min = minOut(quote, SLIP)
    expect(plan.divergence).toMatchObject({ code: 'PRICE_DIVERGENCE', shortfallUsdc: (FAIR - min).toString() })
    expect(plan.divergence!.quoteId).toMatch(/^[0-9a-f]{32}$/)
    expect(plan.divergence!.legs).toEqual([
      {
        kind: 'swap-back',
        token: 'USDC',
        sellToken: 'cbBTC',
        decimals: 6,
        fairAmount: FAIR.toString(),
        quotedAmount: quote.toString(),
        minAmount: min.toString(),
        shortfall: (FAIR - min).toString(),
        shortfallBps: Number(((FAIR - min) * 10_000n + FAIR - 1n) / FAIR),
      },
    ])
    // The minimum shown is the one the batch carries: the usual one on the quote, as without the warning.
    expect(plan.ownerTx.summary).toContain(`Swap ${IDLE - 1n} cbBTC units to at least ${fmt(min)} USDC`)
  })

  test('every prepare mints its own quoteId, even for the same numbers', async () => {
    const w = swapBackWorld()
    w.knobs.quote = at(90n)
    const { out: a } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    const { out: b } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    expect(a.divergence!.legs).toEqual(b.divergence!.legs)
    expect(a.divergence!.quoteId).not.toBe(b.divergence!.quoteId)
  })

  test('submitted without the acceptance: nothing sent, the approval dropped, STALE so the app prepares again', async () => {
    const w = swapBackWorld()
    w.knobs.quote = at(90n)
    const { out: plan } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'PRICE_DIVERGENCE_STALE' })
    expect(await w.op.submit(ctx, 'transfer', { ...sign(plan.ownerTx), acceptDivergence: { quoteId: 42 } } as unknown as OwnerSignature).catch((e: unknown) => e)).toMatchObject({ status: 404, code: 'PREPARE_UNKNOWN' })
    // Even the right acceptance cannot bring a dropped approval back.
    expect(await w.op.submit(ctx, 'transfer', accept(plan)).catch((e: unknown) => e)).toMatchObject({ status: 404, code: 'PREPARE_UNKNOWN' })
    expect(w.sent).toHaveLength(0)
  })

  test('accepted: it runs, at the minimum the owner accepted', async () => {
    const w = swapBackWorld()
    w.knobs.quote = at(90n)
    const { out: plan } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    // The price moves a little against the owner (0.2%), still above the accepted minimum (0.5% under): no new question.
    w.knobs.quote = (q) => (at(90n)(q) * 998n) / 1000n
    const { out } = await quiet(() => w.op.submit(ctx, 'transfer', accept(plan)))
    expect(out).toMatchObject({ kind: 'transfer', state: 'confirmed' })
    expect(w.sent).toHaveLength(1)
    // The Safe tx sent is the one signed: its swap's amountOutMinimum is the accepted minAmount, word for word.
    const min = BigInt(plan.divergence!.legs[0]!.minAmount)
    expect(w.sent[0]!.data!.toLowerCase()).toContain(toHex(min, { size: 32 }).slice(2))
    expect(plan.ownerTx.summary.join('\n')).toContain(`to at least ${fmt(min)} USDC`)
  })

  test('accepted, but the price fell under the accepted minimum: STALE, nothing sent, the approval dropped', async () => {
    const w = swapBackWorld()
    w.knobs.quote = at(90n)
    const { out: plan } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    w.knobs.quote = at(80n)
    const { out } = await quiet(() => w.op.submit(ctx, 'transfer', accept(plan)).catch((e: unknown) => e))
    expect(out).toMatchObject({ status: 409, code: 'PRICE_DIVERGENCE_STALE' })
    expect(w.sent).toHaveLength(0)
    w.knobs.quote = at(90n)
    expect(await w.op.submit(ctx, 'transfer', accept(plan)).catch((e: unknown) => e)).toMatchObject({ status: 404, code: 'PREPARE_UNKNOWN' })
    // The app prepares again and gets a fresh warning with a new quoteId.
    const { out: again } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    expect(again.divergence!.quoteId).not.toBe(plan.divergence!.quoteId)
  })

  test("a quoteId cannot be replayed on another prepare, nor another account's prepare used at all", async () => {
    const w = swapBackWorld()
    w.knobs.quote = at(90n)
    const { out: a } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    const { out: b } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3500000' }))
    expect(await w.op.submit(ctx, 'transfer', accept(b, a.divergence!.quoteId)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'PRICE_DIVERGENCE_STALE' })
    const other = { ...ctx, accountKey: 'j' }
    expect(await w.op.submit(other, 'transfer', accept(a)).catch((e: unknown) => e)).toMatchObject({ status: 404, code: 'PREPARE_UNKNOWN' })
    expect(w.sent).toHaveLength(0)
    // The first approval is untouched by either attempt.
    const { out } = await quiet(() => w.op.submit(ctx, 'transfer', accept(a)))
    expect(out).toMatchObject({ state: 'confirmed' })
  })

  test('spot more than maxTwapDeviationTicks from the TWAP warns even with a quote at the fair price', async () => {
    const w = swapBackWorld()
    w.knobs.spotTick = -500
    const { out: plan } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    expect(plan.divergence!.legs.map((l) => l.kind)).toEqual(['swap-back'])
    expect(plan.divergence!.legs[0]!.minAmount).toBe(minOut(FAIR, SLIP).toString())
  })

  test('a TWAP that cannot be read: priced as before, no warning', async () => {
    const w = swapBackWorld()
    w.knobs.quote = at(90n)
    w.knobs.twapTick = null
    const { out: plan } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000' }))
    expect(plan.divergence).toBeUndefined()
  })

  test('a EURC payout under the TWAP: a payout leg, its shortfall counted in USDC', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.knobs.quote = at(90n)
    w.knobs.payoutGain = 10n ** 12n
    const amount = 3_000_000n
    const { out: plan } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: amount.toString(), asset: 'EURC' }))
    const fair = (amount * 999_500n) / 1_000_000n
    const quote = (fair * 90n) / 100n
    const min = minOut(quote, SLIP)
    expect(plan.receive).toMatchObject({ asset: 'EURC', minimum: min.toString() })
    expect(plan.divergence!.legs).toEqual([
      { kind: 'payout', token: 'EURC', decimals: 6, fairAmount: fair.toString(), quotedAmount: quote.toString(), minAmount: min.toString(), shortfall: (fair - min).toString(), shortfallBps: Number(((fair - min) * 10_000n + fair - 1n) / fair) },
    ])
    expect(plan.divergence!.shortfallUsdc).toBe((((fair - min) * amount + fair - 1n) / fair).toString())
    const { out } = await quiet(() => w.op.submit(ctx, 'transfer', accept(plan)))
    expect(out).toMatchObject({ state: 'confirmed', asset: 'EURC' })
  })

  test('Stop is unchanged: never asks, whatever the price', async () => {
    const w = swapBackWorld()
    w.knobs.quote = at(90n)
    const tx = await w.op.prepareStop(ctx)
    expect(tx).not.toHaveProperty('divergence')
    expect(tx.summary).toContain(`Swap ${IDLE} cbBTC units to at least ${fmt(minOut((IDLE * BigInt(1_000_000 - CBBTC_FEE) / 1_000_000n * 90n) / 100n, SLIP))} USDC`)
    const { out } = await quiet(() => w.op.submit(ctx, 'stop', sign(tx)))
    expect(out).toMatchObject({ kind: 'exit', state: 'confirmed' })
  })
})

describe('otto/mamoru#155: the divergence arithmetic', () => {
  const base = { amountIn: 1_000_000n, fee: 500, tokenInIsToken0: true, twapTick: 0, maxTwapDeviationTicks: 100, slippageBps: 50 }

  test('a quote at the fair price within the spot tolerance is not a divergence', () => {
    const fair = 999_500n
    expect(judgeSwap({ ...base, quote: fair, minimum: minOut(fair, 50), spotTick: 100 })).toEqual({ fair, divergent: false })
  })

  test('a minimum at or above the fair price costs nothing and is not a divergence, whatever the spot', () => {
    expect(judgeSwap({ ...base, quote: 999_500n, minimum: 999_500n, spotTick: 5_000 }).divergent).toBe(false)
  })

  test('the percentage is rounded up, never down to 0', () => {
    expect(divergenceLeg({ kind: 'swap-back', token: 'USDC', sellToken: 'cbBTC', decimals: 6, fair: 1_000_000n, quote: 1_000_000n, minimum: 999_999n }).shortfallBps).toBe(1)
  })

  test('no leg, no warning', () => {
    expect(divergenceWarning([])).toBeUndefined()
  })

  test('a quote that cannot be read at submit does not make the acceptance stale', () => {
    const s = { pool: 'pool:USDC/cbBTC/500', tokenIn: 'cbBTC', tokenOut: 'USDC', fee: 500, amountIn: 1n, minimum: 10n }
    expect(staleAcceptance([s], [null])).toBe(false)
    expect(staleAcceptance([s], [10n])).toBe(false)
    expect(staleAcceptance([s], [9n])).toBe(true)
  })
})

function fmt(v: bigint): string {
  const s = v.toString().padStart(7, '0')
  return `${s.slice(0, -6)}.${s.slice(-6, -4)}`
}
