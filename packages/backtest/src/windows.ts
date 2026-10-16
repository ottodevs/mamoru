// The Lab's fixed set of history windows (spec 004, #101). A sweep replays a policy over every window; experiments are
// tuned on TRAIN and judged on TEST, which no threshold may be fitted to. The split is fixed here, in the code that
// reads it, so it cannot drift between two runs. Adding a window is fine; moving one between TRAIN and TEST is not.

/** Base genesis: block 0 at this Unix time, one block every two seconds since. */
export const BASE_GENESIS_TIME = 1_686_789_347
export const BASE_BLOCK_SECONDS = 2

export type Split = 'train' | 'test'
export type Regime = 'calm' | 'crash' | 'rally' | 'stable-stress'

export type LabWindow = {
  id: string
  /** File under the datasets directory (`MAMORU_LAB_DATASETS`, default `~/.local/share/mamoru-lab/datasets`). */
  file: string
  split: Split
  regime: Regime
  /** Why the window is in the set, in one line. */
  label: string
  /** UTC, inclusive start and end. Backfilled windows start and end at 00:00 UTC. */
  from: string
  to: string
  /** Blocks between samples: 150 = 5 min, 300 = 10 min. */
  step: number
}

/**
 * TRAIN holds the three windows the spec 004 thresholds were first read from (they are in-sample by construction)
 * plus one window of each regime. TEST holds windows no rule has been looked at on: a crash, a rally, two calm
 * months and a stable-pair stress week.
 *
 * Calm months were drawn, not picked: the candidates are the full months 2024-10..2026-08 that overlap no other
 * window, in the order of sha256("mamoru-lab-calm-v1:" + month). A draw is kept when, on the hourly pool scan of
 * 16 Oct 2026, both cbBTC and WETH moved less than 15% over the month and realized volatility stayed under 45% (cbBTC)
 * and 60% (WETH). Draws in order: 2026-03 no (cbBTC vol 50%), 2025-09 kept, 2026-04 kept, 2024-11 no (+37% rally),
 * 2026-08 no (+25%), 2025-07 no (WETH +49%), 2026-07 no (WETH +18%), 2026-06 no (-17%), 2026-05 kept. The first two
 * kept go to TRAIN, the third to TEST.
 *
 * Stable-pair stress: on the hourly scan of USDC/USDT 0.01%, the largest hourly mean off peg after cbBTC reached
 * Base is on 6 Feb 2026 (USDT 84 bps below USDC, inside the February 2026 fall). Earlier, larger readings
 * (August 2024, up to 100 bps) are a young, thin pool, and that window has no cbBTC.
 */
export const LAB_WINDOWS: readonly LabWindow[] = [
  // TRAIN
  { id: 'sep2026', file: 'base-30d-5m.json', split: 'train', regime: 'calm', label: 'Sep 2026, the month before live (recorded)', from: '2026-09-01T23:15:47Z', to: '2026-10-01T23:15:47Z', step: 150 },
  { id: 'oct2025', file: 'base-2025-10-crash-10m.json', split: 'train', regime: 'crash', label: 'Oct 2025, 10 Oct liquidation cascade', from: '2025-10-06T23:55:47Z', to: '2025-10-13T23:55:47Z', step: 300 },
  { id: 'feb2025', file: 'base-2025-02-crash-10m.json', split: 'train', regime: 'crash', label: 'Feb 2025, 2-3 Feb tariff headline crash (ETH -25%)', from: '2025-01-29T23:55:47Z', to: '2025-02-05T23:55:47Z', step: 300 },
  { id: 'mar2025', file: 'base-2025-03-crash-10m.json', split: 'train', regime: 'crash', label: 'Mar 2025, the fall after the reserve pump', from: '2025-03-03T00:00:00Z', to: '2025-03-10T00:00:00Z', step: 300 },
  { id: 'dec2024', file: 'base-2024-12-rally-10m.json', split: 'train', regime: 'rally', label: 'Dec 2024, BTC through 100k to its high', from: '2024-12-02T00:00:00Z', to: '2024-12-16T00:00:00Z', step: 300 },
  { id: 'aug2024', file: 'base-2024-08-crash-10m.json', split: 'train', regime: 'crash', label: 'Aug 2024, yen carry-trade unwind (5 Aug); no cbBTC on Base yet', from: '2024-08-01T00:00:00Z', to: '2024-08-08T00:00:00Z', step: 300 },
  { id: 'calm-2025-09', file: 'base-2025-09-calm-10m.json', split: 'train', regime: 'calm', label: 'Sep 2025, drawn calm month', from: '2025-09-01T00:00:00Z', to: '2025-10-01T00:00:00Z', step: 300 },
  { id: 'calm-2026-04', file: 'base-2026-04-calm-10m.json', split: 'train', regime: 'calm', label: 'Apr 2026, drawn calm month', from: '2026-04-01T00:00:00Z', to: '2026-05-01T00:00:00Z', step: 300 },
  // TEST
  { id: 'apr2025', file: 'base-2025-04-crash-10m.json', split: 'test', regime: 'crash', label: 'Apr 2025, Liberation Day tariff crash', from: '2025-04-02T00:00:00Z', to: '2025-04-09T00:00:00Z', step: 300 },
  { id: 'may2025', file: 'base-2025-05-rally-10m.json', split: 'test', regime: 'rally', label: 'May 2025, ETH +40% week after Pectra', from: '2025-05-06T00:00:00Z', to: '2025-05-13T00:00:00Z', step: 300 },
  { id: 'jun2025', file: 'base-2025-06-calm-10m.json', split: 'test', regime: 'calm', label: 'Jun 2025, BTC range-bound; WETH dips 25% on 22 Jun and recovers', from: '2025-06-01T00:00:00Z', to: '2025-07-01T00:00:00Z', step: 300 },
  { id: 'calm-2026-05', file: 'base-2026-05-calm-10m.json', split: 'test', regime: 'calm', label: 'May 2026, drawn calm month', from: '2026-05-01T00:00:00Z', to: '2026-06-01T00:00:00Z', step: 300 },
  { id: 'feb2026', file: 'base-2026-02-usdt-10m.json', split: 'test', regime: 'stable-stress', label: 'Feb 2026, USDT 84 bps under USDC on 6 Feb, inside a crypto fall', from: '2026-02-02T00:00:00Z', to: '2026-02-09T00:00:00Z', step: 300 },
]

export function datasetsDir(): string {
  return process.env.MAMORU_LAB_DATASETS ?? `${process.env.HOME}/.local/share/mamoru-lab/datasets`
}

export function blockAt(iso: string): number {
  return Math.floor((Date.parse(iso) / 1000 - BASE_GENESIS_TIME) / BASE_BLOCK_SECONDS)
}

export function windowBlocks(w: LabWindow): { fromBlock: number; toBlock: number } {
  const a = blockAt(w.from)
  const b = blockAt(w.to)
  return { fromBlock: a - (a % w.step), toBlock: b - (b % w.step) }
}

export function labWindow(id: string): LabWindow {
  const w = LAB_WINDOWS.find((x) => x.id === id)
  if (!w) throw new Error(`unknown window ${id}; known: ${LAB_WINDOWS.map((x) => x.id).join(', ')}`)
  return w
}
