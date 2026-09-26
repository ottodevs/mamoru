import type {
  AccountOpView,
  AccountSwapView,
  DashboardPayload,
  Figure,
  GateStep,
  Hex0x,
  PoolRef,
  PoolView,
  PositionEventView,
  PositionView,
  Provenance,
  ReasonCode,
  ShadowNote,
  TokenHolding,
} from '@mamoru/domain'
import { entry, type RegistryName } from '@mamoru/registry'
import { ledgerTotal, savingsRowView, type Pair, type SavingsLogRow } from './index.ts'

/** Where a log sits on the fork, and the time of its block. */
export type LogRef = { block: number; blockHash: Hex0x; txHash: Hex0x; logIndex: number; at: string }

export type LabPositionEvent = LogRef & { kind: PositionEventView['kind']; liquidity: bigint; amount0: bigint; amount1: bigint; opId?: string }

export type LabPosition = {
  tokenId: bigint
  /** Registry name of the pool, or null when the pool is not in the registry. */
  pool: RegistryName | null
  managed: boolean
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** Token amounts the liquidity holds at slot0 of H. */
  inLiquidity: Pair
  /** What a static `collect` returns at H. */
  collectable: Pair
  principalOwed: Pair
  /** Mint block and the pool tick at its end, when the mint happened on the fork. */
  mint: { block: number; tick: number } | null
  /** NonfungiblePositionManager events of the tokenId since the fork block, in log order. */
  events: LabPositionEvent[]
}

export type LabPoolSwap = LogRef & { amount0: bigint; amount1: bigint; tick: number }
export type LabPoolLiquidity = LogRef & { kind: 'mint' | 'burn'; amount: bigint; amount0: bigint; amount1: bigint; tickLower: number; tickUpper: number }

export type LabPool = {
  name: RegistryName
  sqrtPriceX96: bigint
  tick: number
  twapTick: number | null
  liquidity: bigint
  balance0: bigint
  balance1: bigint
  /** Pool logs on the fork only: [fork block + 1, H]. */
  window: { fromBlock: number; toBlock: number }
  swaps: LabPoolSwap[]
  liquidityEvents: LabPoolLiquidity[]
}

export type LabOp = {
  opId: string
  kind: string
  state: string
  code: ReasonCode
  updatedAt: string
  txHash?: Hex0x
  /** The UserOperationEvent, for included operations. */
  userOpEvent?: LogRef
  /** The Swap of an entry swap or of a harvest conversion. */
  swap?: LogRef & { tokenIn: RegistryName; tokenOut: RegistryName; amountIn: bigint; amountOut: bigint }
}

export type LabDecision = {
  decisionId: string
  kind: string
  code: ReasonCode
  block: number
  at: string
  observationCodes: ReasonCode[]
  trail: GateStep[]
  shadow: ShadowNote[]
  buckets: { bucket: string; code: ReasonCode }[]
  positions: { tokenId: string; codes: ReasonCode[] }[]
}

/** What one lab run produced: the engine journal, its last observation (H) and fork reads at H. */
export type LabRun = {
  chainId: number
  block: { number: number; hash: Hex0x; at: string }
  safeBlock: number
  account: { address: Hex0x; deployed: boolean }
  policy: {
    version: string
    buckets: { id: string; preference: number; pools: RegistryName[] }[]
    maxTwapDeviationTicks: number
    renewalWindowSeconds: number
  }
  balances: { USDC: bigint; cbBTC: bigint; WETH: bigint; ETH: bigint }
  /** slot0 of the registry's price pools at H. */
  priceSlots: { pool: RegistryName; sqrtPriceX96: bigint }[]
  positions: LabPosition[]
  pools: LabPool[]
  sessions: { name: string; validUntil: number; active: boolean }[]
  paused: boolean
  ops: LabOp[]
  decisions: LabDecision[]
  savingsLog: SavingsLogRow[]
  /** QuoterV2 quote of the idle cbBTC to USDC at H, or null when not quoted. */
  convertQuote: bigint | null
}

const QUOTE = 'USDC'
const Q192 = 1n << 192n
const RECENT = 10

type Rate = { num: bigint; den: bigint }

function fig<T>(value: T | null, provenance: Provenance, unit?: string): Figure<T> {
  return unit ? { value, unit, provenance } : { value, provenance }
}

/**
 * The dashboard of dashboard.md §9 in mode `lab`, from a lab run (§10).
 * Every chain figure is `fork_rpc` at H, every value an estimate at H, and
 * anything the run did not produce is null with `not_observed`. Pure.
 */
export function labPayload(run: LabRun): DashboardPayload {
  const H = run.block
  const chainId = run.chainId
  const fork: Provenance = { source: 'fork_rpc', chainId, blockNumber: H.number, blockHash: H.hash, observedAt: H.at, status: 'fresh' }
  const estimate: Provenance = { ...fork, source: 'estimate' }
  const journal: Provenance = { source: 'journal', chainId, observedAt: H.at, status: 'fresh' }
  const missing = (source: Provenance['source'], detail?: ReasonCode): Provenance => ({ source, chainId, observedAt: H.at, status: 'not_observed', ...(detail ? { detail } : {}) })
  const rowProv = (r: LogRef): Provenance => ({ source: 'fork_rpc', chainId, blockNumber: r.block, blockHash: r.blockHash, observedAt: H.at, status: 'fresh' })

  const rates = new Map<string, Rate>([[QUOTE, { num: 1n, den: 1n }]])
  for (const s of run.priceSlots) {
    const e = entry(s.pool)
    const sq = s.sqrtPriceX96 * s.sqrtPriceX96
    if (e.token0 === QUOTE) rates.set(e.token1!, { num: Q192, den: sq })
    else if (e.token1 === QUOTE) rates.set(e.token0!, { num: sq, den: Q192 })
  }
  if (rates.has('WETH')) rates.set('ETH', rates.get('WETH')!)
  const valueOf = (parts: [string, bigint][]): bigint | null => {
    let total = 0n
    for (const [token, amount] of parts) {
      if (amount === 0n) continue
      const r = rates.get(token)
      if (!r) return null
      total += (amount * r.num) / r.den
    }
    return total
  }
  const valueFig = (v: bigint | null): Figure<string> => (v === null ? fig<string>(null, missing('estimate'), QUOTE) : fig(v.toString(), estimate, QUOTE))
  const sum = (vs: (bigint | null)[]): bigint | null => (vs.some((v) => v === null) ? null : vs.reduce<bigint>((a, v) => a + v!, 0n))

  const last = run.decisions.at(-1)
  const lastOp = run.ops.at(-1)

  // Pools and positions (§7.6).
  const poolRef = (name: RegistryName): PoolRef => {
    const e = entry(name)
    return { address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!, tickSpacing: e.tickSpacing!, name }
  }
  const poolByName = new Map(run.pools.map((p) => [p.name, p]))
  // A position on a pool outside the registry has no PoolRef: it is listed as unmanaged, with no value.
  const foreign = run.positions.filter((p) => p.pool === null)
  const positions: PositionView[] = run.positions
    .filter((p) => p.pool !== null)
    .map((p) => {
      const ref = poolRef(p.pool!)
      const [u0, u1] = [ref.token0, ref.token1]
      const pool = poolByName.get(p.pool!)
      const inRange = pool ? p.tickLower <= pool.tick && pool.tick < p.tickUpper : null
      const principal: Pair = [p.inLiquidity[0] + p.principalOwed[0], p.inLiquidity[1] + p.principalOwed[1]]
      const pos = (a: bigint, b: bigint) => (a > b ? a - b : 0n)
      const fees: Pair = [pos(p.collectable[0], p.principalOwed[0]), pos(p.collectable[1], p.principalOwed[1])]
      const rows = run.savingsLog.filter((r) => r.tokenId === p.tokenId)
      const collected: Pair = [rows.reduce((a, r) => a + r.fees[0], 0n), rows.reduce((a, r) => a + r.fees[1], 0n)]
      const principalValue = valueOf([[u0, principal[0]], [u1, principal[1]]])
      const feesValue = valueOf([[u0, fees[0]], [u1, fees[1]]])
      const fromEvents = p.events.reduce((a, e) => (e.kind === 'decrease' ? a - e.liquidity : e.kind === 'mint' || e.kind === 'increase' ? a + e.liquidity : a), 0n)
      const hasMint = p.events.some((e) => e.kind === 'mint')
      const movement: Pair = [fees[0] + collected[0], fees[1] + collected[1]]
      const inRangeFraction = p.mint && pool ? timeInRange(p, p.mint, pool, H.number) : null
      return {
        tokenId: p.tokenId.toString(),
        pool: ref,
        managed: p.managed,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        rangeState: inRange === null ? fig<'in_range' | 'out_of_range'>(null, missing('fork_rpc')) : fig(inRange ? 'in_range' : 'out_of_range', fork),
        timeInRange: inRangeFraction === null ? fig<string>(null, missing('fork_rpc')) : fig(inRangeFraction, fork),
        liquidity: fig(p.liquidity.toString(), fork),
        liquidityFromEvents: hasMint ? fig(fromEvents.toString(), fork) : fig<string>(null, missing('fork_rpc')),
        historyComplete: hasMint && fromEvents === p.liquidity,
        principal: { amount0: fig(principal[0].toString(), fork, u0), amount1: fig(principal[1].toString(), fork, u1), value: valueFig(principalValue) },
        uncollectedFees: { amount0: fig(fees[0].toString(), fork, u0), amount1: fig(fees[1].toString(), fork, u1), value: valueFig(feesValue) },
        collectedFees: { amount0: fig(collected[0].toString(), journal, u0), amount1: fig(collected[1].toString(), journal, u1) },
        // A position minted on the fork starts with no fees, so its movement since the mint is uncollected plus collected.
        feeMovement: p.mint
          ? { amount0: fig(movement[0].toString(), fork, u0), amount1: fig(movement[1].toString(), fork, u1), value: valueFig(valueOf([[u0, movement[0]], [u1, movement[1]]])), fromBlock: p.mint.block }
          : { amount0: fig<string>(null, missing('fork_rpc'), u0), amount1: fig<string>(null, missing('fork_rpc'), u1), value: valueFig(null), fromBlock: H.number },
        value: valueFig(sum([principalValue, feesValue])),
        codes: last?.positions.find((x) => x.tokenId === p.tokenId.toString())?.codes ?? [],
        events: [...p.events].reverse().map((e) => ({
          block: e.block, blockHash: e.blockHash, txHash: e.txHash, logIndex: e.logIndex, at: e.at, ...(e.opId ? { opId: e.opId } : {}), provenance: rowProv(e),
          kind: e.kind,
          amount0: fig(e.amount0.toString(), rowProv(e), u0),
          amount1: fig(e.amount1.toString(), rowProv(e), u1),
        })),
      }
    })

  const planPools = run.policy.buckets.flatMap((b) => b.pools)
  const plan: PoolView[] = run.pools.filter((p) => planPools.includes(p.name)).map((p) => poolView(p, poolRef(p.name), positions))

  function poolView(p: LabPool, ref: PoolRef, views: PositionView[]): PoolView {
    const [u0, u1] = [ref.token0, ref.token1]
    const w: Provenance = { ...fork, blockNumber: p.window.toBlock }
    const priced = u0 === QUOTE ? u1 : u0
    const rate = rates.get(priced)
    const price = rate ? (10n ** BigInt(entry(priced).decimals!) * rate.num) / rate.den : null
    let vol0 = 0n
    let vol1 = 0n
    for (const s of p.swaps) {
      if (s.amount0 > 0n) vol0 += s.amount0
      if (s.amount1 > 0n) vol1 += s.amount1
    }
    const fee0 = (vol0 * BigInt(ref.fee)) / 1_000_000n
    const fee1 = (vol1 * BigInt(ref.fee)) / 1_000_000n
    const ticks = p.swaps.map((s) => s.tick)
    const liq = p.liquidityEvents.filter((e) => e.amount > 0n)
    const side = (kind: 'mint' | 'burn') => {
      const rows = liq.filter((e) => e.kind === kind)
      return { count: fig(rows.length, w), amount0: fig(rows.reduce((a, e) => a + e.amount0, 0n).toString(), w, u0), amount1: fig(rows.reduce((a, e) => a + e.amount1, 0n).toString(), w, u1) }
    }
    const twap = p.twapTick === null ? fig<number>(null, missing('fork_rpc', 'EHG_TWAP_UNAVAILABLE')) : fig(p.twapTick, fork)
    return {
      pool: ref,
      block: H.number,
      price: price === null ? fig<string>(null, missing('fork_rpc'), QUOTE) : fig(price.toString(), fork, QUOTE),
      tick: fig(p.tick, fork),
      twapTick: twap,
      twapGuard: p.twapTick === null ? fig<'ok' | 'above_guard'>(null, missing('fork_rpc', 'EHG_TWAP_UNAVAILABLE')) : fig(Math.abs(p.tick - p.twapTick) <= run.policy.maxTwapDeviationTicks ? 'ok' : 'above_guard', fork),
      liquidity: fig(p.liquidity.toString(), fork),
      balances: { amount0: fig(p.balance0.toString(), fork, u0), amount1: fig(p.balance1.toString(), fork, u1), value: valueFig(valueOf([[u0, p.balance0], [u1, p.balance1]])) },
      window: p.window,
      stats: {
        swaps: fig(p.swaps.length, w),
        volume0: fig(vol0.toString(), w, u0),
        volume1: fig(vol1.toString(), w, u1),
        volumeValue: valueFig(valueOf([[u0, vol0], [u1, vol1]])),
        fees0: fig(fee0.toString(), estimate, u0),
        fees1: fig(fee1.toString(), estimate, u1),
        feesValue: valueFig(valueOf([[u0, fee0], [u1, fee1]])),
        tickMin: ticks.length ? fig(Math.min(...ticks), w) : fig<number>(null, missing('fork_rpc')),
        tickMax: ticks.length ? fig(Math.max(...ticks), w) : fig<number>(null, missing('fork_rpc')),
        added: side('mint'),
        removed: side('burn'),
      },
      recentSwaps: [...p.swaps].reverse().slice(0, RECENT).map((s) => ({
        block: s.block, blockHash: s.blockHash, txHash: s.txHash, logIndex: s.logIndex, at: s.at, provenance: rowProv(s),
        amount0: fig(s.amount0.toString(), rowProv(s), u0),
        amount1: fig(s.amount1.toString(), rowProv(s), u1),
        tick: s.tick,
      })),
      recentLiquidity: [...liq].reverse().slice(0, RECENT).map((e) => ({
        block: e.block, blockHash: e.blockHash, txHash: e.txHash, logIndex: e.logIndex, at: e.at, provenance: rowProv(e),
        kind: e.kind,
        amount0: fig(e.amount0.toString(), rowProv(e), u0),
        amount1: fig(e.amount1.toString(), rowProv(e), u1),
        tickLower: e.tickLower,
        tickUpper: e.tickUpper,
      })),
      accountPositions: views.filter((v) => v.pool.name === ref.name).map((v) => ({ tokenId: v.tokenId, rangeState: v.rangeState })),
    }
  }

  // Savings (§7.7) and Savings Log (§7.8).
  const ledger = ledgerTotal(run.savingsLog)
  const usdc = run.balances.USDC
  const available = ledger < usdc ? ledger : usdc
  const lastRow = run.savingsLog.at(-1)

  // Portfolio (§7.4) and Treasury (§7.5).
  const b = run.balances
  const holding = (token: TokenHolding['token'], role: TokenHolding['role'], amount: bigint, code?: ReasonCode): TokenHolding => ({
    token,
    role,
    amount: fig(amount.toString(), fork, token),
    value: valueFig(valueOf([[token, amount]])),
    ...(code ? { code } : {}),
  })
  const obsCodes = new Set(last?.observationCodes ?? [])
  const tokens: TokenHolding[] = [
    holding('USDC', 'plan', b.USDC),
    holding('cbBTC', 'plan', b.cbBTC),
    holding('WETH', 'outside_plan', b.WETH, 'OBS_UNMANAGED_ASSET'),
    holding('ETH', 'gas', b.ETH, obsCodes.has('OBS_ETH_NOT_INVESTED') ? 'OBS_ETH_NOT_INVESTED' : undefined),
  ]
  const managed = positions.filter((p) => p.managed)
  const unmanaged = positions.filter((p) => !p.managed)
  const positionsValue = foreign.length ? null : sum(positions.map((p) => p.value.value).map((v) => (v === null ? null : BigInt(v))))
  const tokenValues = tokens.map((t) => (t.value.value === null ? null : BigInt(t.value.value)))
  const total = sum([...tokenValues, positionsValue])
  const totalMissing = [...tokens.filter((t) => t.value.value === null).map((t) => `${t.token} price`), ...(positionsValue === null ? ['position value'] : [])]
  const principalOf = (p: PositionView) => (p.principal.value.value === null ? null : BigInt(p.principal.value.value))
  const bucketCodes = new Map((last?.buckets ?? []).map((x) => [x.bucket, x.code]))
  const noPool = [...bucketCodes.values()].includes('PLAN_BUCKET_NO_EXECUTABLE_POOL')
  const idleUsdc = usdc - available
  const convertPool = planPools.find((n) => [entry(n).token0, entry(n).token1].includes('cbBTC')) ?? 'pool:USDC/cbBTC/500'

  const swaps: AccountSwapView[] = run.ops.flatMap((o) =>
    o.swap
      ? [{
          block: o.swap.block, blockHash: o.swap.blockHash, txHash: o.swap.txHash, logIndex: o.swap.logIndex, at: o.swap.at, opId: o.opId, provenance: rowProv(o.swap),
          tokenIn: o.swap.tokenIn,
          tokenOut: o.swap.tokenOut,
          amountIn: fig(o.swap.amountIn.toString(), rowProv(o.swap), o.swap.tokenIn),
          amountOut: fig(o.swap.amountOut.toString(), rowProv(o.swap), o.swap.tokenOut),
        }]
      : [],
  ).reverse()

  const chainOps: AccountOpView[] = run.ops.flatMap((o) =>
    o.userOpEvent
      ? [{ block: o.userOpEvent.block, blockHash: o.userOpEvent.blockHash, txHash: o.userOpEvent.txHash, logIndex: o.userOpEvent.logIndex, at: o.userOpEvent.at, opId: o.opId, provenance: rowProv(o.userOpEvent), kind: o.kind, state: o.state, code: o.code }]
      : [],
  ).reverse()

  // Session (§7.3): the earliest end among the active grants, read from the engine's session ledger.
  const active = run.sessions.filter((s) => s.active)
  const Hs = Math.floor(Date.parse(H.at) / 1000)
  const until = active.length ? Math.min(...active.map((s) => s.validUntil)) : null
  const session: Figure<'active' | 'renewal_due' | 'expired' | 'revoked' | 'missing'> = fig(
    until === null ? (run.sessions.length ? 'revoked' : 'missing') : until <= Hs ? 'expired' : until - Hs <= run.policy.renewalWindowSeconds ? 'renewal_due' : 'active',
    journal,
  )

  const payload: DashboardPayload = {
    mode: 'lab',
    chainId,
    chains: [{ chainId, name: 'Base fork', observed: true }],
    sources: {
      rpc: { status: 'ok', block: H.number, safeBlock: run.safeBlock, observedAt: H.at },
      index: { provider: 'fork_index', status: 'indexing', indexedBlock: H.number, checkedAt: H.at },
    },
    banner: { kind: 'lab', text: `Simulation · Base fork · Block ${H.number} · Not capital`, block: H.number },
    account: {
      key: `lab:${run.account.address.toLowerCase()}`,
      address: fig(run.account.address, fork),
      deployed: fig(run.account.deployed, fork),
      preset: 'conservador',
      policyVersion: run.policy.version,
      fundsGate: 'lab',
      totalValue: valueFig(total),
      totalMissing,
    },
    // The lab replay does not run the Actions derivation of §7.2, so the list is not complete.
    actions: { items: [], complete: false, notObserved: ['actions derivation'] },
    currentAction: {
      ...(lastOp ? { op: { opId: lastOp.opId, kind: lastOp.kind, state: lastOp.state, code: lastOp.code, updatedAt: lastOp.updatedAt, ...(lastOp.txHash ? { txHash: lastOp.txHash } : {}) } } : {}),
      ...(last ? { decision: { decisionId: last.decisionId, kind: last.kind, code: last.code, block: last.block, trail: last.trail, shadow: last.shadow, positions: last.positions } } : {}),
      recentDecisions: [...run.decisions].reverse().slice(0, RECENT).map((d) => ({ decisionId: d.decisionId, kind: d.kind, code: d.code, block: d.block, at: d.at })),
      chainOps,
      session,
      ...(until !== null ? { sessionValidUntil: fig(new Date(until * 1000).toISOString(), journal) } : {}),
      paused: fig(run.paused, journal),
      nextReviewAt: fig<string>(null, missing('journal')),
      notes: lastOp && (lastOp.code === 'BUNDLER_UNAVAILABLE' || lastOp.code === 'RECON_TIMEOUT') ? [lastOp.code] : [],
    },
    portfolio: {
      tokens,
      positions: { managed: fig(managed.length, fork), unmanaged: fig(unmanaged.length + foreign.length, fork), value: valueFig(positionsValue) },
      allocation: run.policy.buckets.flatMap((x) => {
        const code = bucketCodes.get(x.id)
        return code ? [{ bucket: x.id, preference: x.preference, actual: fig<number>(null, missing('estimate')), code }] : []
      }),
      unmanaged: [
        ...(b.WETH > 0n ? [{ kind: 'token' as const, ref: 'WETH', code: 'OBS_UNMANAGED_ASSET' as const }] : []),
        ...unmanaged.map((p) => ({ kind: 'position' as const, ref: p.tokenId, code: 'OBS_UNMANAGED_ASSET' as const })),
        ...foreign.map((p) => ({ kind: 'position' as const, ref: p.tokenId.toString(), code: 'OBS_UNMANAGED_ASSET' as const })),
      ],
      total: valueFig(total),
    },
    treasury: {
      idle: {
        usdc: fig(idleUsdc.toString(), fork, 'USDC'),
        cbBTC: fig(b.cbBTC.toString(), fork, 'cbBTC'),
        value: valueFig(valueOf([['USDC', idleUsdc], ['cbBTC', b.cbBTC]])),
        ...(noPool ? { code: 'PLAN_BUCKET_NO_EXECUTABLE_POOL' as const } : {}),
      },
      lp: valueFig(sum(managed.map(principalOf))),
      savings: fig(available.toString(), journal, 'USDC'),
      gasReserve: fig(b.ETH.toString(), fork, 'ETH'),
      outsidePlan: valueFig(foreign.length ? null : sum([valueOf([['WETH', b.WETH]]), ...unmanaged.map((p) => (p.value.value === null ? null : BigInt(p.value.value)))])),
      convert: {
        route: { protocol: 'uniswap-v3', pool: poolRef(convertPool), router: 'SwapRouter02', method: 'exactInputSingle', quoter: 'QuoterV2' },
        pending: fig(b.cbBTC.toString(), fork, 'cbBTC'),
        quote: run.convertQuote === null ? fig<string>(null, missing('estimate'), QUOTE) : fig(run.convertQuote.toString(), estimate, QUOTE),
        state: b.cbBTC > 0n ? 'held_for_entry' : 'nothing_to_convert',
      },
      swaps,
    },
    pools: { positions, plan },
    savings: {
      ledgerTotal: fig(ledger.toString(), journal, 'USDC'),
      usdcBalance: fig(usdc.toString(), fork, 'USDC'),
      available: fig(available.toString(), journal, 'USDC'),
      pending: fig('0', journal, 'USDC'),
      ...(lastRow ? { lastHarvest: fig(lastRow.at, journal) } : {}),
    },
    savingsLog: { rows: [...run.savingsLog].reverse().map(savingsRowView) },
    provenanceComplete: false,
  }
  return { ...payload, provenanceComplete: everyFigureObserved(payload) }
}

/**
 * Share of the blocks after the mint up to H in which the pool tick, at the
 * end of each block, sat inside the range. Swaps are the only tick moves.
 */
function timeInRange(p: LabPosition, mint: { block: number; tick: number }, pool: LabPool, h: number): string | null {
  const total = h - mint.block
  if (total <= 0) return null
  const endTick = new Map<number, number>()
  for (const s of pool.swaps) if (s.block > mint.block) endTick.set(s.block, s.tick)
  let tick = mint.tick
  let inRange = 0
  for (let block = mint.block + 1; block <= h; block++) {
    tick = endTick.get(block) ?? tick
    if (p.tickLower <= tick && tick < p.tickUpper) inRange++
  }
  return (inRange / total).toString()
}

/** True when no Figure in the payload is `not_observed`. */
export function everyFigureObserved(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(everyFigureObserved)
  if (value === null || typeof value !== 'object') return true
  const o = value as Record<string, unknown>
  if ('provenance' in o && 'value' in o) {
    const p = o.provenance as Provenance
    if (p.status === 'not_observed') return false
  }
  return Object.values(o).every(everyFigureObserved)
}
