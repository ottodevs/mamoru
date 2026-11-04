import type { FundingView, Hex0x, MoneyInFlight } from '@mamoru/domain'
import { braisFunding } from './money.ts'

// otto/mamoru#264: Brais's 2.075638 USDC on its way from Base to his Monad Safe on 1 Nov, at each stage the money map can
// report, with the real burn (Base 10:22:53) and mint (Monad 10:38:34) transactions and Safe. Times are relative to `now`
// so the dev view always shows a live window. Dev (?braismoney=flight&stage=...) and tests.

export const BRAIS_BURN_TX: Hex0x = '0x9d4b22ca017956d4e48bfad5973c52b9d4f275bbe2fb62f8ef9c4c3189df31dd'
export const BRAIS_MINT_TX: Hex0x = '0x51298f68e43b0f2425acaba4e9ff621cb6e8e1cf61e7518094d92180d2edfe72'
export const BRAIS_MONAD_RECIPIENT: Hex0x = '0xD72A7cB9773Dc58a9B944f9737996F45dBD1F108'

export type FlightStage = MoneyInFlight['stage'] | 'late'
const min = 60_000
const at = (now: number, offsetMin: number) => new Date(now + offsetMin * min).toISOString()

/** The in-flight row at `stage`; 'late' is a burn past its window that the operator has not flagged stuck. */
export function braisFlight(stage: FlightStage, now: number = Date.now()): FundingView {
  const f = braisFunding(stage === 'minted' ? 'arriving' : 'flight', now)
  const burnedAt = at(now, stage === 'late' ? -24 : stage === 'sending' ? 0 : -6)
  const t0 = Date.parse(burnedAt)
  const eta = { from: new Date(t0 + 13 * min).toISOString(), to: new Date(t0 + 19 * min).toISOString(), late: stage === 'late' }
  const row: MoneyInFlight = {
    id: 'cctp-brais-1', kind: 'cctp', from: 8453, to: 143, recipient: BRAIS_MONAD_RECIPIENT, amountUsdc: '2075638', feeUsdc: '0', finality: 'standard',
    stage: stage === 'late' ? 'burned' : stage,
    ...(stage !== 'sending' ? { burnTx: BRAIS_BURN_TX, burnedAt } : {}),
    ...(stage === 'attested' || stage === 'minting' || stage === 'minted' ? { attestedAt: at(now, -1) } : {}),
    ...(stage === 'minted' ? { mintTx: BRAIS_MINT_TX, mintedAt: at(now, 0) } : {}),
    ...(stage !== 'sending' && stage !== 'minted' ? { eta } : {}),
  }
  return { ...f, money: { ...f.money!, inFlight: [row] } }
}
