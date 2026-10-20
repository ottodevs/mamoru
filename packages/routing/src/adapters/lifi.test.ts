import { describe, expect, test } from 'bun:test'
import { lifiAdapter } from './lifi.ts'
import type { Fetch } from '../types.ts'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const NOW = 1_792_325_000_000

// Recorded 18 Oct 2026, GET https://li.quest/v1/quote, Base -> Ethereum, 150 USDC, fromAddress=toAddress=ACCOUNT.
const LIFI_FIXTURE = {
  action: { toAddress: ACCOUNT },
  estimate: { toAmount: '149625000', executionDuration: 1080 },
  transactionRequest: {
    value: '0x0',
    to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    data: '0x17917a4e0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000004207f7fcfd2f69ca27c53c4c7dcb33b5ce7e0c0933d098b3d3ab8d72f975765f2fa000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000008eb18a8',
  },
}

function fetchReturning(body: unknown, ok = true): Fetch {
  return (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 })) as unknown as Fetch
}

describe('lifiAdapter', () => {
  test('Base -> Ethereum, 150 USDC, from the recorded live quote', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await lifiAdapter.quote(req, { fetch: fetchReturning(LIFI_FIXTURE), now: () => NOW })
    expect(q.provider).toBe('lifi')
    expect(q.amountOut).toBe(149_625_000n)
    expect(q.fee).toBe(150_000_000n - 149_625_000n) // ~0.25% of 150 USDC, consistent with LI.FI's documented fee
    expect(q.etaSec).toBe(1080)
    expect(q.mode).toBe('owner-only')
    expect(q.recipientCheck).toBe('decoded-calldata')
    expect(q.target.toLowerCase()).toBe('0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae')
    expect(q.value).toBe(0n)
    expect(q.calldata).toContain(ACCOUNT.slice(2).toLowerCase())
  })

  test('refuses when the declared toAddress does not match the account', async () => {
    const bad = { ...LIFI_FIXTURE, action: { toAddress: OTHER } }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(lifiAdapter.quote(req, { fetch: fetchReturning(bad), now: () => NOW })).rejects.toThrow()
  })

  test('refuses an output amount above amountIn (malformed) and a non-2xx answer', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const tooMuch = { ...LIFI_FIXTURE, estimate: { ...LIFI_FIXTURE.estimate, toAmount: '999999999999' } }
    await expect(lifiAdapter.quote(req, { fetch: fetchReturning(tooMuch), now: () => NOW })).rejects.toThrow()
    await expect(lifiAdapter.quote(req, { fetch: fetchReturning({}, false), now: () => NOW })).rejects.toThrow()
  })

  // Hardening pass, otto/mamoru#181 follow-up: the target allowlist is per origin chain, not one global address.

  test('a Monad-origin quote is checked against its own target, the LiFiDiamond is not reused there', async () => {
    // Recorded live 18 Oct 2026: Monad-origin quotes go to a different executor than Ethereum/Base ones do.
    const monadFixture = { ...LIFI_FIXTURE, transactionRequest: { ...LIFI_FIXTURE.transactionRequest, to: '0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37' } }
    const req = { sourceChainId: 143, destChainId: 8453, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await lifiAdapter.quote(req, { fetch: fetchReturning(monadFixture), now: () => NOW })
    expect(q.target.toLowerCase()).toBe('0x026f252016a7c47cdef1f05a3fc9e20c92a49c37')
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

  // otto/mamoru#181, review round 3: the same confound that broke relay.ts's recipient check (every earlier
  // fixture used the same address for sender and recipient) was checked here too. Recorded live 18 Oct 2026
  // with DISTINCT fromAddress (0x5555...) and toAddress (0x6666...): unlike Relay, LI.FI's calldata genuinely
  // carries the real recipient — this fixture's account is the recipient, not the sender, and the quote
  // succeeds only when `account` matches the recipient.
  const LIFI_DISTINCT_FIXTURE = {
    action: { toAddress: '0x6666666666666666666666666666666666666666' },
    estimate: { toAmount: '149625000', executionDuration: 1080 },
    transactionRequest: {
      value: '0x0',
      to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      data: '0x17917a4e0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000004200f3a233b0f2485c6ab7ef016932cf125e2084cb67f107f92d67569e1da760969000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000066666666666666666666666666666666666666660000000000000000000000000000000000000000000000000000000008eb18a8',
    },
  }

  test("with distinct sender and recipient, the quote succeeds for the RECIPIENT's account (proving the calldata genuinely carries it, unlike Relay)", async () => {
    const recipient = '0x6666666666666666666666666666666666666666' as const
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: recipient }
    const q = await lifiAdapter.quote(req, { fetch: fetchReturning(LIFI_DISTINCT_FIXTURE), now: () => NOW })
    expect(q.recipientCheck).toBe('decoded-calldata')
    expect(q.calldata).toContain(recipient.slice(2).toLowerCase())
  })

  test("the same fixture refuses for the SENDER's account — LI.FI's own declared action.toAddress (the recipient) does not match it, even though the sender's bytes also appear somewhere in this calldata", async () => {
    const sender = '0x5555555555555555555555555555555555555555' as const
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: sender }
    await expect(lifiAdapter.quote(req, { fetch: fetchReturning(LIFI_DISTINCT_FIXTURE), now: () => NOW })).rejects.toThrow()
  })
})
