// otto/mamoru#15: a Safe with enough USDC buys its own gas reserve inside the activation the owner signs. The relayer
// then sends no top-up and reserves only the deploy and exec gas against the daily activation budget (sponsorship.ts);
// its top-up stays, within that budget, for the starts that cannot buy their own reserve.
import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, type Hex, type TransactionReceipt } from 'viem'
import { baseRegistry, address, swapRouter02Abi } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import type { OpView } from '@mamoru/domain'
import type { Operator } from '../src/operator.ts'
import { DEFAULT_SPONSOR } from '../src/sponsorship.ts'
import type { AccountState } from '../src/state.ts'
import { SAFE, ctx, quiet, sign, world } from './owner-world.ts'

type Privates = { fireArmed(a: AccountState, usdc: bigint): Promise<void>; reconcileOwner(a: AccountState): Promise<void>; relayerBalanceCache: null; startLoop(a: AccountState): void }
const priv = (op: Operator) => op as unknown as Privates

/** Policy reserve 0.0003 ETH + operator margin 0.0002 ETH. */
const TARGET = POLICIES['conservador-live-v2']!.gasReserveWei + 200_000_000_000_000n
/** Spot 2,700 USD/ETH: wei for one USDC. */
const RATE = 370_370_370_370_370n
/** pool:WETH/USDC/500 (WETH token0) at ~2,699.73 USD/ETH. */
const TICK = -197_311
/** The activation's exec and deploy gas the relayer reserves (operator.ts ACTIVATE_TX_GAS + DEPLOY_GAS), at the world's gas price. */
const GAS_WEI = (16_777_216n + 500_000n) * 10_000_000n
const WETH = address('WETH', baseRegistry).toLowerCase()

function selfWorld(usdc: bigint, cfg: Parameters<typeof world>[1] = {}) {
  const w = world(usdc, cfg)
  priv(w.op).startLoop = () => {}
  // The chain's clock is now; USDC -> WETH quotes at RATE, every other quote as the world's default; the WETH/USDC
  // pools' TWAP at TICK, every other pool's at tick 0.
  w.knobs.blockTime = BigInt(Math.floor(Date.now() / 1000))
  w.knobs.quote = (q) => (q.tokenOut.toLowerCase() === WETH ? (q.amountIn * RATE) / 1_000_000n : (q.amountIn * BigInt(1_000_000 - q.fee)) / 1_000_000n)
  for (const pool of ['pool:WETH/USDC/500', 'pool:WETH/USDC/3000'] as const) w.knobs.twapByPool.set(address(pool, baseRegistry).toLowerCase(), TICK)
  return w
}
type W = ReturnType<typeof selfWorld>

const topUps = (w: W) => w.sent.filter((t) => t.to.toLowerCase() === SAFE.toLowerCase() && !t.data)
const execs = (w: W) => w.sent.filter((t) => t.to.toLowerCase() === SAFE.toLowerCase() && t.data)
/** The Safe's execTransaction carries SwapRouter02.unwrapWETH9(reserve, Safe): the ETH of the swap is paid to the Safe. */
const unwrapToSafe = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'unwrapWETH9', args: [TARGET, SAFE] }).slice(2).toLowerCase()
const swaps = (data?: Hex) => !!data && data.toLowerCase().includes(unwrapToSafe)
const activationSpend = (w: W) => (w.state.accounts.k!.sponsored ?? []).filter((e) => e.kind === 'activation').map((e) => BigInt(e.wei))
const last = (w: W) => w.op.ops(ctx, null).ops.at(-1) as OpView
/** The reverted receipt of an op's own copy, served as a node would (a revert: no ExecutionSuccess). */
const revertedReceipt = (w: W, op: OpView) => w.knobs.receipts.set(op.txHash!.toLowerCase(), { transactionHash: op.txHash, status: 'success', blockNumber: 101n, logs: [] } as unknown as TransactionReceipt)
const start = async (w: W) => (await quiet(async () => w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx))))).out

describe('the activation buys its own gas reserve', () => {
  test('20 USDC: the summary names the USDC converted, the signed batch swaps it, the relayer sends no top-up and reserves only gas', async () => {
    const w = selfWorld(20_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    // 1.349866 USDC at the TWAP, +1% tolerance and the 0.05% fee: 1.364039, shown to the unit.
    expect(tx.summary).toContain('Convert 1.364039 USDC to at least 0.0005 ETH on Uniswap v3 USDC/WETH 0.05% + unwrap, kept in your Safe as its gas reserve')
    expect(tx.summary.some((l) => l.includes('your 18.63 USDC'))).toBe(true)
    expect((await quiet(() => w.op.submit(ctx, 'activate', sign(tx)))).out).toMatchObject({ state: 'confirmed' })
    expect(topUps(w)).toHaveLength(0)
    expect(execs(w)).toHaveLength(1)
    expect(swaps(execs(w)[0]!.data)).toBe(true)
    expect(activationSpend(w)).toEqual([GAS_WEI])
  })

  test('the same start on the relayer path reserves the top-up too: the difference is the reserve', async () => {
    const w = selfWorld(20_000_000n)
    // A spot 1.1% dearer than the TWAP: no swap, so the relayer tops the reserve up.
    w.knobs.quote = (q) => (q.tokenOut.toLowerCase() === WETH ? (q.amountIn * (10n ** 18n / 2730n)) / 1_000_000n : (q.amountIn * BigInt(1_000_000 - q.fee)) / 1_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    expect(tx.summary.some((l) => l.startsWith('Convert'))).toBe(false)
    expect((await quiet(() => w.op.submit(ctx, 'activate', sign(tx)))).out).toMatchObject({ state: 'confirmed' })
    expect(topUps(w)).toMatchObject([{ value: TARGET }])
    expect(swaps(execs(w)[0]!.data)).toBe(false)
    expect(activationSpend(w)).toEqual([GAS_WEI + TARGET])
  })

  test('an activation budget that covers the gas but not a top-up: a self-funded start runs, a relayer-paid one is refused', async () => {
    const budget = { sponsor: { ...DEFAULT_SPONSOR, activationWeiPerDay: GAS_WEI } }
    const w = selfWorld(20_000_000n, budget)
    expect(await start(w)).toMatchObject({ state: 'confirmed' })
    const v = selfWorld(5_000_000n, budget)
    expect(await start(v)).toMatchObject({ state: 'failed', code: 'SPONSOR_DAILY_BUDGET' })
    expect(v.sent).toHaveLength(0)
  })

  test('a relayer holding only the activation gas starts a self-funded account instead of arming it', async () => {
    const w = selfWorld(20_000_000n)
    w.knobs.relayerWei = 200_000_000_000_000n
    expect(await start(w)).toMatchObject({ state: 'confirmed' })
    // The same relayer cannot pay a reserve: a start that needs one waits armed.
    const v = selfWorld(5_000_000n)
    v.knobs.relayerWei = 200_000_000_000_000n
    expect(await start(v)).toMatchObject({ code: 'ARMED' })
  })

  test('a self-funded approval that waits armed keeps its reserve, and runs with no top-up', async () => {
    const w = selfWorld(20_000_000n)
    w.knobs.relayerWei = 0n
    expect(await start(w)).toMatchObject({ code: 'ARMED' })
    const acc = w.state.accounts.k!
    expect(acc.armed?.reserveWei).toBe(TARGET.toString())
    expect(BigInt(acc.armed!.reserveDeadline!)).toBe(w.knobs.blockTime + 3_600n)
    w.knobs.relayerWei = 10n ** 18n
    priv(w.op).relayerBalanceCache = null
    await quiet(() => priv(w.op).fireArmed(acc, 20_000_000n))
    expect(acc.active).toBe(true)
    expect(topUps(w)).toHaveLength(0)
    expect(swaps(execs(w)[0]!.data)).toBe(true)
    expect(activationSpend(w)).toEqual([GAS_WEI])
  })

  test('kept on the relayer path: under 10 USDC, no quote, a Safe that holds its reserve, an approval signed before the deposit', async () => {
    const small = selfWorld(5_000_000n)
    expect(await start(small)).toMatchObject({ state: 'confirmed' })
    expect(topUps(small)).toMatchObject([{ value: TARGET }])

    const noQuote = selfWorld(20_000_000n)
    const q = noQuote.knobs.quote!
    noQuote.knobs.quote = (x) => {
      if (x.tokenOut.toLowerCase() === WETH) throw new Error('execution reverted')
      return q(x)
    }
    const t1 = await noQuote.op.prepareActivate(ctx)
    expect(t1.summary.some((l) => l.startsWith('Convert'))).toBe(false)
    await quiet(() => noQuote.op.submit(ctx, 'activate', sign(t1)))
    expect(topUps(noQuote)).toMatchObject([{ value: TARGET }])

    const funded = selfWorld(20_000_000n)
    funded.chain.safeEth = TARGET
    const t2 = await funded.op.prepareActivate(ctx)
    expect(t2.summary.some((l) => l.startsWith('Convert'))).toBe(false)
    await quiet(() => funded.op.submit(ctx, 'activate', sign(t2)))
    expect(topUps(funded)).toHaveLength(0)
    expect(swaps(execs(funded)[0]!.data)).toBe(false)

    const early = selfWorld(0n)
    const t3 = await early.op.prepareActivate(ctx)
    expect(t3.summary.some((l) => l.startsWith('Convert'))).toBe(false)
    expect((await quiet(() => early.op.submit(ctx, 'activate', sign(t3)))).out).toMatchObject({ code: 'ARMED' })
    early.chain.usdc = 20_000_000n
    await quiet(() => priv(early.op).fireArmed(early.state.accounts.k!, 20_000_000n))
    expect(topUps(early)).toMatchObject([{ value: TARGET }])
  })

  test('a spot dearer than the TWAP by more than 1%: no swap, the relayer path', async () => {
    const w = selfWorld(20_000_000n)
    // 2,730 USD/ETH on the spot against ~2,700 at the TWAP: the reserve would cost 1.1% more.
    w.knobs.quote = (q) => (q.tokenOut.toLowerCase() === WETH ? (q.amountIn * (10n ** 18n / 2730n)) / 1_000_000n : (q.amountIn * BigInt(1_000_000 - q.fee)) / 1_000_000n)
    const t = await w.op.prepareActivate(ctx)
    expect(t.summary.some((l) => l.startsWith('Convert'))).toBe(false)
    await quiet(() => w.op.submit(ctx, 'activate', sign(t)))
    expect(topUps(w)).toMatchObject([{ value: TARGET }])
    expect(swaps(execs(w)[0]!.data)).toBe(false)
  })
})

describe('the reserve swap deadline', () => {
  test('an armed self-funded approval near its deadline is never sent: dropped, the owner approves again', async () => {
    const w = selfWorld(20_000_000n)
    w.knobs.relayerWei = 0n
    await start(w)
    const acc = w.state.accounts.k!
    acc.armed!.reserveDeadline = String(Math.floor(Date.now() / 1000) + 300)
    w.knobs.relayerWei = 10n ** 18n
    priv(w.op).relayerBalanceCache = null
    await quiet(() => priv(w.op).fireArmed(acc, 20_000_000n))
    expect(w.sent).toHaveLength(0)
    expect(acc.armed).toBeUndefined()
    expect(acc.active).toBe(false)
    expect(last(w)).toMatchObject({ kind: 'activate', state: 'failed', code: 'RESERVE_SWAP_EXPIRED' })
    expect(activationSpend(w)).toEqual([])
  })

  test('one already handed to a provider is not sent again past its deadline: the chain settles it', async () => {
    const w = selfWorld(20_000_000n)
    w.knobs.relayerWei = 0n
    await start(w)
    const acc = w.state.accounts.k!
    acc.armed = { ...acc.armed!, execSent: true, sentAt: Date.now() - 2 * 3_600_000, reserveDeadline: String(Math.floor(Date.now() / 1000) - 60) }
    w.knobs.relayerWei = 10n ** 18n
    priv(w.op).relayerBalanceCache = null
    await quiet(() => priv(w.op).fireArmed(acc, 20_000_000n))
    expect(w.sent).toHaveLength(0)
    expect(last(w)).toMatchObject({ kind: 'activate', state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('a direct start whose deadline is near by the provider head is refused before anything is reserved or sent', async () => {
    const w = selfWorld(20_000_000n)
    const t = await w.op.prepareActivate(ctx)
    // The provider's head runs ahead of the clock: the later of the two counts.
    w.knobs.blockTime += 3_600n
    expect((await quiet(() => w.op.submit(ctx, 'activate', sign(t)))).out).toMatchObject({ state: 'failed', code: 'RESERVE_SWAP_EXPIRED' })
    expect(w.sent).toHaveLength(0)
    expect(activationSpend(w)).toEqual([])
  })

  test('a reverted self-funded start stays open while it can run, and closes once a final block past its deadline shows the nonce unspent', async () => {
    const w = selfWorld(20_000_000n)
    w.knobs.execOk = false
    const out = await start(w)
    expect(out).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    revertedReceipt(w, out as OpView)
    const acc = w.state.accounts.k!
    const opId = (out as OpView).opId
    const stored = acc.ops.find((o) => o.opId === opId) as OpView & { reserveDeadline?: string }
    expect(BigInt(stored.reserveDeadline!)).toBe(w.knobs.blockTime + 3_600n)
    w.knobs.blockHead = 200n
    // Before the deadline: nothing is concluded from the revert, the signature can still be relayed.
    await quiet(() => priv(w.op).reconcileOwner(acc))
    expect(acc.ops.find((o) => o.opId === opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    // Past it at the final block, Safe nonce unspent: it never ran and never can.
    w.knobs.blockTime = BigInt(stored.reserveDeadline!) + 1n
    await quiet(() => priv(w.op).reconcileOwner(acc))
    expect(acc.ops.find((o) => o.opId === opId)).toMatchObject({ state: 'failed', code: 'RESERVE_SWAP_EXPIRED', block: 188 })
    expect(acc.active).toBe(false)
    // An ordinary new Start again, signed for that same Safe nonce.
    w.knobs.execOk = true
    w.knobs.blockTime = BigInt(Math.floor(Date.now() / 1000))
    expect(await start(w)).toMatchObject({ state: 'confirmed' })
    expect(acc.active).toBe(true)
  })

  test('no proof, no close: a final block not past the deadline yet, or one whose state cannot be read', async () => {
    const w = selfWorld(20_000_000n)
    w.knobs.execOk = false
    const out = (await start(w)) as OpView
    revertedReceipt(w, out)
    const acc = w.state.accounts.k!
    const deadline = BigInt((acc.ops.find((o) => o.opId === out.opId) as OpView & { reserveDeadline: string }).reserveDeadline)
    w.knobs.blockHead = 200n
    // The block SETTLE_CONFIRMATIONS below the head is still at the deadline: no proof yet.
    w.knobs.blockTime = deadline
    await quiet(() => priv(w.op).reconcileOwner(acc))
    expect(acc.ops.find((o) => o.opId === out.opId)).toMatchObject({ code: 'OWNER_TX_ERROR' })
    // Past it, but the node answers that block with a hash whose state it cannot serve: no conclusion.
    w.knobs.blockTime = deadline + 1n
    w.knobs.blockHashes.set(188n, `0x${'ee'.repeat(32)}`)
    await quiet(() => priv(w.op).reconcileOwner(acc))
    expect(acc.ops.find((o) => o.opId === out.opId)).toMatchObject({ code: 'OWNER_TX_ERROR' })
  })
})
