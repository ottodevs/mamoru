import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, parseAbi } from 'viem'
import { acrossAdapter, checkAcrossQuote, type AcrossSuggestedFees } from './across.ts'
import type { Fetch } from '../types.ts'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
// Fixed instant matching the recorded fixture's own timestamp, so the freshness check passes deterministically.
const NOW_SEC = 1_792_324_955
const NOW = NOW_SEC * 1000

// Recorded 18 Oct 2026, GET https://app.across.to/api/suggested-fees, Ethereum -> Base, 150 USDC.
const SUGGESTED_FEES_ETH_TO_BASE: AcrossSuggestedFees = {
  outputAmount: '149980851',
  totalRelayFee: { total: '19149' },
  timestamp: '1792324955',
  fillDeadline: '1792332155',
  exclusiveRelayer: '0x394311A6Aaa0D8E3411D8b62DE4578D41322d1bD',
  exclusivityDeadline: 1792325163,
  spokePoolAddress: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
  estimatedFillTimeSec: 2,
  isAmountTooLow: false,
}

function fetchReturning(body: unknown, ok = true): Fetch {
  return (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 })) as unknown as Fetch
}

const spokePoolAbi = parseAbi([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
])

describe('acrossAdapter', () => {
  test('supports USDC between any two configured chains, never ETH', () => {
    expect(acrossAdapter.supports({ sourceChainId: 1, destChainId: 8453, asset: 'USDC', amountIn: 1n, account: ACCOUNT })).toBe(true)
    expect(acrossAdapter.supports({ sourceChainId: 1, destChainId: 8453, asset: 'ETH', amountIn: 1n, account: ACCOUNT })).toBe(false)
  })

  test('Ethereum -> Base, 150 USDC, from the recorded live quote', async () => {
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await acrossAdapter.quote(req, { fetch: fetchReturning(SUGGESTED_FEES_ETH_TO_BASE), now: () => NOW })
    expect(q.provider).toBe('across')
    expect(q.amountOut).toBe(149_980_851n)
    expect(q.fee).toBe(19_149n)
    expect(q.etaSec).toBe(2)
    expect(q.mode).toBe('session-key')
    expect(q.recipientCheck).toBe('onchain-pinnable')
    expect(q.target).toBe('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5')

    const decoded = decodeFunctionData({ abi: spokePoolAbi, data: q.calldata! })
    expect(decoded.args[0]).toBe(ACCOUNT) // depositor
    expect(decoded.args[1]).toBe(ACCOUNT) // recipient
    expect(decoded.args[5]).toBe(149_980_851n) // outputAmount
    expect(decoded.args[6]).toBe(8453n) // destinationChainId
  })

  test('refuses a quote naming a different SpokePool than the one configured for that chain', () => {
    const bad = { ...SUGGESTED_FEES_ETH_TO_BASE, spokePoolAddress: '0x0000000000000000000000000000000000dEaD' }
    expect(() => checkAcrossQuote('across', '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', bad, 150_000_000n, NOW_SEC)).toThrow()
  })

  test('refuses a fee above the app policy bound (0.5%)', () => {
    const bad = { ...SUGGESTED_FEES_ETH_TO_BASE, outputAmount: '100000000', totalRelayFee: { total: '50000000' } }
    expect(() => checkAcrossQuote('across', '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', bad, 150_000_000n, NOW_SEC)).toThrow()
  })

  test('refuses an exclusivity window longer than the app policy bound (600s)', () => {
    const bad = { ...SUGGESTED_FEES_ETH_TO_BASE, exclusivityDeadline: 700 }
    expect(() => checkAcrossQuote('across', '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', bad, 150_000_000n, NOW_SEC)).toThrow()
  })

  test('refuses isAmountTooLow', () => {
    const bad = { ...SUGGESTED_FEES_ETH_TO_BASE, isAmountTooLow: true }
    expect(() => checkAcrossQuote('across', '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', bad, 150_000_000n, NOW_SEC)).toThrow()
  })

  test('refuses on a non-2xx answer', async () => {
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(acrossAdapter.quote(req, { fetch: fetchReturning({}, false), now: () => NOW })).rejects.toThrow()
  })
})
