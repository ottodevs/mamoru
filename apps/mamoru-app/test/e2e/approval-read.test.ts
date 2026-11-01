// otto/mamoru#225: the signed lines of an approval read into blocks; every line in exactly one, unknown lines kept whole.
// The operator's own summaries are held to the same reader in apps/mamoru-operator/test/approval-read-parity.test.ts.
import { describe, expect, test } from 'bun:test'
import { linesOf, readApproval } from '../../src/web/lib/approval-read.ts'

const SAFE = '0x967f0e9f4d7aF2F65fCfbdE7b3CcDEe4F320D2dF'
const MONAD = '0x3C59b607abBEB19039a3E4d3b48a47Bbb8ad2B6f'
const KEY = '0x817b8717741fff274231c4ffCe2dFF481C0cE834'
const move = [
  `Renew Mamoru's approval on your Safe ${SAFE} and move it to on-chain limits`,
  'Mamoru can now trade only near the market price, and only the positions it opened',
  `15% of your savings (Growth) goes to your own Safe on Monad, ${MONAD}: same owner (your passkey), created by Mamoru with no other signature`,
  'On Monad Mamoru may only swap and provide liquidity in WMON/USDC 0.30%, near the market price, paid only to that Safe, until 2027-09-21',
  "USDC crosses only to that Safe, through Circle's bridge (CCTP), at no fee",
  'USDC/cbBTC is only wound down, nothing new goes into it',
  `Engine key ${KEY} may keep doing the same kinds of actions for 365 more days, within new limits counted from zero, sized for deposits up to 100.00 USDC (your cap):`,
  'In USDC/USDT 0.01%: swaps, new positions and withdrawals only within 0.10% of the 30- and 5-minute average price and within 0.40% of 1:1; swaps and new positions worth at most 250.00 USDC a day and 500.00 USDC in total on this approval',
  'In WETH/USDC 0.30%: swaps, new positions and withdrawals only within 1.00% of the 30- and 5-minute average price; swaps and new positions worth at most 70.00 USDC a day and 350.00 USDC in total on this approval',
  "Bridge: it may burn USDC with Circle's CCTP only to your own address on Monad (never to another address, never any fee), at most 20.00 USDC a time and 50.00 USDC in total on this approval; a guardian pause stops it",
  "Each engine transaction pays at most 0.00052 ETH of network fee (at most 0.1 gwei per gas), from your Safe's ETH; these grants allow 104,064 transactions in all",
  'The approval it replaces is revoked in the same transaction',
  'Nothing is moved: your positions stay as they are',
  'Whatever it collects, mints or swaps is paid to your Safe, never to anyone else',
]

describe('readApproval', () => {
  test('a v5 -> v6 move: every line read, none left as text', () => {
    const r = readApproval(move)
    expect(linesOf(r)).toEqual(move.map((_, i) => i))
    expect(r.text).toEqual([])
    expect(r.head).toEqual({ line: 0, move: true, safe: SAFE })
    expect(r.engine).toMatchObject({ key: KEY, days: 365, capUsdc: '100.00', form: 'renew' })
    expect(r.pools).toEqual([
      { pool: 'USDC/USDT 0.01%', line: 7, band: '0.10%', peg: '0.40%', dayUsdc: '250.00', totalUsdc: '500.00' },
      { pool: 'WETH/USDC 0.30%', line: 8, band: '1.00%', peg: null, dayUsdc: '70.00', totalUsdc: '350.00' },
    ])
    expect(r.changes.map((c) => c.key)).toEqual(['onchain', 'remote', 'wound', 'revoked'])
    expect(r.changes.find((c) => c.key === 'remote')).toMatchObject({ share: '15%', bucket: 'Growth', chain: 'Monad', safe: MONAD })
    expect(r.remote).toEqual({ lines: [2, 3, 4], chain: 'Monad', grants: [{ pools: 'WMON/USDC 0.30%', until: '2027-09-21', line: 3 }], crosses: true })
    expect(r.bridge).toEqual({ line: 9, chain: 'Monad', perTxUsdc: '20.00', totalUsdc: '50.00', pause: true })
    expect(r.gas).toEqual({ line: 10, perTxEth: '0.00052', gwei: '0.1', txs: '104,064' })
    expect(r.promises.map((p) => p.key)).toEqual(['nothingMoves', 'paidToSafe'])
  })

  test('a line that half-matches a known one is kept whole, never read in part', () => {
    const odd = 'In WETH/USDC 0.30%: swaps, new positions and withdrawals only within 1.00% of the 30- and 5-minute average price; and something new'
    const r = readApproval([odd, 'Something nobody wrote a reader for'])
    expect(r.pools).toEqual([])
    expect(r.text).toEqual([
      { line: 0, text: odd },
      { line: 1, text: 'Something nobody wrote a reader for' },
    ])
  })

  test("an activation's engine line lists its actions: kept whole as text, its days and cap still read", () => {
    const l = `Engine key ${KEY} may, for 365 days and within limits sized for deposits up to 25.00 USDC: take liquidity out of any position your Safe owns`
    const r = readApproval([l])
    expect(r.engine).toMatchObject({ days: 365, capUsdc: '25.00', form: null })
    expect(r.text).toEqual([{ line: 0, text: l }])
    expect(linesOf(r)).toEqual([0])
  })

  test('a head with anything after it is not the head (GPT-6 review): kept whole', () => {
    const l = `Renew Mamoru's approval on your Safe ${SAFE} and move it to on-chain limits and raise the cap to 5,000 USDC`
    const r = readApproval([l])
    expect(r.head).toBeNull()
    expect(r.text).toEqual([{ line: 0, text: l }])
  })

  test('two signed pools on Monad are both kept', () => {
    const r = readApproval([
      'On Monad Mamoru may only swap and provide liquidity in WMON/USDC 0.30%, near the market price, paid only to that Safe, until 2027-09-21',
      'On Monad Mamoru may only swap and provide liquidity in WETH/USDC 0.05%, near the market price, paid only to that Safe, until 2027-09-21',
    ])
    expect(r.remote!.grants.map((g) => g.pools)).toEqual(['WMON/USDC 0.30%', 'WETH/USDC 0.05%'])
    expect(linesOf(r)).toEqual([0, 1])
  })

  test('the head is only the first line', () => {
    const r = readApproval(['x', `Renew Mamoru's approval on your Safe ${SAFE}`])
    expect(r.head).toBeNull()
    expect(r.text.map((t) => t.line)).toEqual([0, 1])
  })
})
