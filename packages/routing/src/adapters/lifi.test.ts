import { describe, expect, test } from 'bun:test'
import { lifiAdapter } from './lifi.ts'
import type { Fetch } from '../types.ts'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const NOW = 1_792_325_000_000

// otto/mamoru#181 DECISION (coordinator, 20 Oct 2026): LI.FI is a price oracle only, after three rounds of
// trying to certify its recipient from facet calldata each ran into a deeper problem than the last (see
// lifi.ts's module comment and docs/research/routing-2026-10.md). These fixtures only need enough of a real
// response shape to exercise the price/target/value validation that remains — no facet-specific calldata.

const LIFI_FIXTURE = {
  estimate: { toAmount: '149625000', executionDuration: 1080 },
  transactionRequest: { value: '0x0', to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', data: '0xaabbccdd' },
}

function fetchReturning(body: unknown, ok = true): Fetch {
  return (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 })) as unknown as Fetch
}

describe('lifiAdapter', () => {
  test('Base -> Ethereum, 150 USDC: a price point, never executable', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await lifiAdapter.quote(req, { fetch: fetchReturning(LIFI_FIXTURE), now: () => NOW })
    expect(q.provider).toBe('lifi')
    expect(q.amountOut).toBe(149_625_000n)
    expect(q.fee).toBe(150_000_000n - 149_625_000n) // ~0.25% of 150 USDC, consistent with LI.FI's documented fee
    expect(q.etaSec).toBe(1080)
    expect(q.mode).toBe('owner-only')
    expect(q.recipientCheck).toBe('none')
    expect(q.target.toLowerCase()).toBe('0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae')
    // Never executable: no calldata, no value, regardless of what the response contained.
    expect(q.calldata).toBeUndefined()
    expect(q.value).toBeUndefined()
  })

  test('refuses an output amount above amountIn (malformed) and a non-2xx answer', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const tooMuch = { ...LIFI_FIXTURE, estimate: { ...LIFI_FIXTURE.estimate, toAmount: '999999999999' } }
    await expect(lifiAdapter.quote(req, { fetch: fetchReturning(tooMuch), now: () => NOW })).rejects.toThrow()
    await expect(lifiAdapter.quote(req, { fetch: fetchReturning({}, false), now: () => NOW })).rejects.toThrow()
  })

  // Target allowlist: still checked, because it protects the quoted price's plausibility (a quote naming an
  // unverified contract isn't a trustworthy price point either), not because anything here is executable.

  test('a Monad-origin quote is checked against its own target, the LiFiDiamond is not reused there', async () => {
    const monadFixture = { ...LIFI_FIXTURE, transactionRequest: { ...LIFI_FIXTURE.transactionRequest, to: '0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37' } }
    const req = { sourceChainId: 143, destChainId: 8453, asset: 'USDC' as const, amountIn: 150_000_000n, account: '0x4444444444444444444444444444444444444444' as const }
    const q = await lifiAdapter.quote(req, { fetch: fetchReturning(monadFixture), now: () => NOW })
    expect(q.target.toLowerCase()).toBe('0x026f252016a7c47cdef1f05a3fc9e20c92a49c37')
    expect(q.recipientCheck).toBe('none')
  })

  test('refuses a Base-origin quote whose target is the Monad-origin address instead (or vice versa)', async () => {
    const wrongTarget = { ...LIFI_FIXTURE, transactionRequest: { ...LIFI_FIXTURE.transactionRequest, to: '0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37' } }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(lifiAdapter.quote(req, { fetch: fetchReturning(wrongTarget), now: () => NOW })).rejects.toThrow()
  })

  test('refuses (via supports) a source chain with no verified target at all', () => {
    const req = { sourceChainId: 42161, destChainId: 8453, asset: 'ETH' as const, amountIn: 1n, account: ACCOUNT }
    expect(lifiAdapter.supports(req)).toBe(false)
  })

  // Native value: still checked, for the same "keep the quoted price plausible" reason as the target.

  test('ERC20-input order: refuses a non-zero native value', async () => {
    const tampered = { ...LIFI_FIXTURE, transactionRequest: { ...LIFI_FIXTURE.transactionRequest, value: '0x3e8' } }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(lifiAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('native-ETH-input order: value must be amountIn (plus the allowed slack); still never returned on the quote', async () => {
    const ethFixture = {
      estimate: { toAmount: '9972138895058684', executionDuration: 2 },
      transactionRequest: { value: '0x2386f26fc10000', to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', data: '0xaabbccdd' }, // 0x2386f26fc10000 = 10_000_000_000_000_000 = exactly amountIn
    }
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'ETH' as const, amountIn: 10_000_000_000_000_000n, account: ACCOUNT }
    const q = await lifiAdapter.quote(req, { fetch: fetchReturning(ethFixture), now: () => NOW })
    expect(q.recipientCheck).toBe('none')
    expect(q.value).toBeUndefined()
  })

  test('native-ETH-input order: refuses a value that overshoots amountIn by more than the allowed slack', async () => {
    const ethFixture = {
      estimate: { toAmount: '9972138895058684', executionDuration: 2 },
      transactionRequest: { value: '0x16345785d8a0000', to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', data: '0xaabbccdd' }, // 0.1 ETH, far more than 0.01
    }
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'ETH' as const, amountIn: 10_000_000_000_000_000n, account: ACCOUNT }
    await expect(lifiAdapter.quote(req, { fetch: fetchReturning(ethFixture), now: () => NOW })).rejects.toThrow()
  })
})
