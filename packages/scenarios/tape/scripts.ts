import type { ScenarioTape, TapeFrame, TapeId } from '@mamoru/domain'
import { TapeSession } from './recorder.ts'

/** Base fee while gas is expensive, and after it drops, in gwei. */
const HIGH_GWEI = 0.4
const LOW_GWEI = 0.1
const MAX_ROUNDS = 25

const usd = (d: string) => `${Number(d).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`
const feesVsBar = (f: TapeFrame) => `Fees ${usd(f.position?.feesValue ?? '0')} against a bar of ${usd(f.cost.threshold)} (${f.cost.factorBps / 10_000}x the ${usd(f.cost.opCost)} cost of one operation).`

async function harvest(s: TapeSession): Promise<ScenarioTape> {
  await s.enterThroughEngine()
  await s.pinBaseFee(HIGH_GWEI)
  const first = s.push(await s.review(), (f) => ({ key: true, title: 'Position is live', note: `The engine entered the pool with a range around the price. ${feesVsBar(f)} Holding.` }), ['DECIDE_HARVEST_BELOW_COST'])
  for (let i = 1; i <= 6; i++) {
    await s.feeRound(first.position!.tickLower)
    await s.warp(900)
    await s.pinBaseFee(HIGH_GWEI)
    s.push(await s.review(), (f) => ({ key: i === 6, title: i === 6 ? 'Fees below cost' : 'Fees accrue', note: `Traders swap through the range; base fee ${f.cost.baseFeeGwei} gwei. ${feesVsBar(f)} Harvesting now would cost more than it earns.` }), ['DECIDE_HARVEST_BELOW_COST'])
  }
  await s.warp(900)
  await s.pinBaseFee(LOW_GWEI)
  let last = s.push(await s.review(), (f) =>
    f.decision.kind === 'harvest'
      ? { key: true, title: 'Harvest pays', note: `Base fee drops to ${f.cost.baseFeeGwei} gwei. ${feesVsBar(f)} Fees clear the bar, so the engine collects them and converts them to USDC in one operation.` }
      : { key: true, title: 'Gas gets cheaper', note: `Base fee drops to ${f.cost.baseFeeGwei} gwei, so the bar falls. ${feesVsBar(f)} Still below. Holding.` },
  )
  for (let i = 0; i < MAX_ROUNDS && !last.tx; i++) {
    await s.feeRound(first.position!.tickLower)
    await s.warp(900)
    await s.pinBaseFee(LOW_GWEI)
    last = s.push(await s.review(), (f) =>
      f.decision.kind === 'harvest'
        ? { key: true, title: 'Harvest pays', note: `${feesVsBar(f)} Fees clear the bar, so the engine collects them and converts them to USDC in one operation.` }
        : { title: 'Fees accrue', note: `${feesVsBar(f)} Still below the bar. Holding.` },
    )
  }
  if (!last.tx?.ok) throw new Error(`no confirmed harvest after ${MAX_ROUNDS} rounds`)
  await s.pinBaseFee(LOW_GWEI)
  s.push(await s.review(), (f) => ({ key: true, title: 'Fees collected', note: `Fees are back to ${usd(f.position?.feesValue ?? '0')}. The position keeps its liquidity; only the fees left it.` }), ['DECIDE_HARVEST_BELOW_COST'])
  for (let i = 0; i < 3; i++) {
    await s.feeRound(first.position!.tickLower)
    await s.warp(900)
    await s.pinBaseFee(LOW_GWEI)
    s.push(await s.review(), (f) => ({ title: 'Fees build again', note: `${feesVsBar(f)} Holding until they pay again.` }), ['DECIDE_HARVEST_BELOW_COST'])
  }
  return s.tape('TAPE-HARVEST', 'Harvest only when it pays', 'Fees build up while gas is expensive and the engine holds. When the base fee drops and fees clear three times the cost, it harvests once on the fork and fees return to zero.')
}

async function outOfRange(s: TapeSession): Promise<ScenarioTape> {
  await s.enterThroughEngine()
  await s.pinBaseFee(HIGH_GWEI)
  const first = s.push(await s.review(), (f) => ({ key: true, title: 'In range and earning', note: `The price ${usd(f.pool.price)} sits inside the range ${usd(f.position!.lowerPrice)} to ${usd(f.position!.upperPrice)}. Holding.` }), ['DECIDE_IN_RANGE'])
  const { tickLower } = first.position!
  for (let i = 0; i < 3; i++) {
    await s.feeRound(tickLower)
    await s.warp(900)
    await s.pinBaseFee(HIGH_GWEI)
    s.push(await s.review(), (f) => ({ title: 'Earning fees', note: `Swaps cross the range. Fees ${usd(f.position!.feesValue)} and growing.` }), ['DECIDE_IN_RANGE'])
  }
  let bought = 0n
  for (let i = 0; i < 12; i++) {
    const tick = (await s.slot0()).tick
    bought += (await s.swapToward(Math.max(tickLower - 40, tick - 300))).out
    await s.warp(300)
    await s.pinBaseFee(HIGH_GWEI)
    const out = (await s.slot0()).tick < tickLower
    s.push(
      await s.review(),
      (f) =>
        out
          ? { key: true, title: 'Price leaves the range', note: `Selling pushes the price to ${usd(f.pool.price)}, below the range. The position stops earning and the engine holds: no transaction, principal ${usd(f.position!.principalValue)} intact.` }
          : { title: 'Price falls', note: `Heavy selling moves the price to ${usd(f.pool.price)}, still inside the range. Holding.` },
      [out ? 'OBS_POSITION_OUT_OF_RANGE' : 'DECIDE_IN_RANGE'],
    )
    if (out) break
  }
  if ((await s.slot0()).tick >= tickLower) throw new Error('the pool did not leave the range')
  for (let i = 0; i < 3; i++) {
    await s.warp(1800)
    await s.pinBaseFee(HIGH_GWEI)
    s.push(await s.review(), (f) => ({ key: i === 2, title: i === 2 ? 'Holding out of range' : 'Out of range', note: `Still out of range. Fees stay at ${usd(f.position!.feesValue)}, principal ${usd(f.position!.principalValue)}. Nothing to do.` }), ['OBS_POSITION_OUT_OF_RANGE'])
  }
  await s.swap('cbBTC', bought)
  await s.pinBaseFee(HIGH_GWEI)
  s.push(await s.review(), (f) => ({ key: true, title: 'Back in range', note: `Buyers return and the price recovers to ${usd(f.pool.price)}, inside the range again.` }), ['DECIDE_IN_RANGE'])
  for (let i = 0; i < 3; i++) {
    await s.feeRound(tickLower)
    await s.warp(900)
    await s.pinBaseFee(HIGH_GWEI)
    s.push(await s.review(), (f) => ({ key: i === 2, title: i === 2 ? 'Fees resume' : 'Earning again', note: `Swaps cross the range again. Fees ${usd(f.position!.feesValue)}.` }), ['DECIDE_IN_RANGE'])
  }
  return s.tape('TAPE-OUT-OF-RANGE', 'Price leaves the range', 'A large sale pushes the pool price below the range. The engine holds with no transaction and the principal intact; when the price comes back, the position earns again.')
}

async function poolShock(s: TapeSession): Promise<ScenarioTape> {
  await s.deposit()
  await s.pinBaseFee(LOW_GWEI)
  s.push(await s.observe(), { key: true, title: 'Deposit arrives', note: 'USDC lands in the account. The engine waits until the deposit block is final before acting.' }, ['OBS_DEPOSIT_UNSAFE'])
  await s.mineUntilSafe()
  s.push(await s.observe(), (f) => ({ key: true, title: 'Ready to enter', note: `The deposit is final and the pool looks healthy at ${usd(f.pool.price)}. The engine would enter now.` }), ['DECIDE_ENTER'])
  for (let i = 0; i < 3; i++) {
    await s.warp(120)
    s.push(await s.observe(), { title: 'Would enter', note: 'Price steady against its 30-minute average. Entry still allowed.' }, ['DECIDE_ENTER'])
  }
  const before = (await s.slot0()).tick
  await s.swapToward(before - 400)
  await s.pinBaseFee(LOW_GWEI)
  s.push(
    await s.observe(),
    (f) => ({ key: true, title: 'Pool shock', note: `A sudden sale moves the price ${Math.abs(f.pool.tick - before)} ticks to ${usd(f.pool.price)}, far from its 30-minute average. The health gate refuses the entry: EHG_PRICE_DIVERGENCE.` }),
    ['EHG_PRICE_DIVERGENCE'],
  )
  let refused = true
  for (let i = 0; i < 12 && refused; i++) {
    await s.warp(180)
    const f = s.push(await s.observe(), (f) =>
      f.decision.reason === 'EHG_PRICE_DIVERGENCE'
        ? { title: 'Entry refused', note: 'The 30-minute average has not caught up with the new price yet. No entry, the deposit stays in USDC.' }
        : { key: true, title: 'Price settles', note: `The average has caught up with the new price ${usd(f.pool.price)}. Entry is allowed again.` },
    )
    refused = f.decision.reason === 'EHG_PRICE_DIVERGENCE'
  }
  return s.tape('TAPE-POOL-SHOCK', 'Pool shock, no entry', 'A fresh deposit is ready to enter. A sudden price move takes the pool far from its 30-minute average and the health gate refuses the entry until the price settles.')
}

export const TAPES: Record<string, { id: TapeId; file: string; run: (s: TapeSession) => Promise<ScenarioTape> }> = {
  harvest: { id: 'TAPE-HARVEST', file: 'harvest.json', run: harvest },
  'out-of-range': { id: 'TAPE-OUT-OF-RANGE', file: 'out-of-range.json', run: outOfRange },
  'pool-shock': { id: 'TAPE-POOL-SHOCK', file: 'pool-shock.json', run: poolShock },
}
