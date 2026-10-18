import { describe, expect, test } from 'bun:test'
import { relayAdapter } from './relay.ts'
import type { Fetch } from '../types.ts'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const NOW = 1_792_325_000_000

// Recorded 18 Oct 2026, POST https://api.relay.link/quote, Base -> Ethereum, 150 USDC, recipient = ACCOUNT.
// Trimmed to the fields this adapter reads; `deposit`'s calldata genuinely carries ACCOUNT as its first word.
const RELAY_FIXTURE = {
  steps: [
    { id: 'approve', items: [{ data: { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b30000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc310000000000000000000000000000000000000000000000000000000008f0d180', value: '0' } }] },
    {
      id: 'deposit',
      items: [
        {
          data: {
            to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
            data: '0xe80179520000000000000000000000001111111111111111111111111111111111111111000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000008f0d18087d8abd93fa9b937f20b6ef46cf6970673b9950e7c353d36bcf9e63ce1319c42',
            value: '0',
          },
        },
      ],
    },
  ],
  details: { recipient: ACCOUNT, currencyIn: { amount: '150000000' }, currencyOut: { amount: '149959256' }, timeEstimate: 6 },
}

function fetchReturning(body: unknown, ok = true): Fetch {
  return (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 })) as unknown as Fetch
}

describe('relayAdapter', () => {
  test('Base -> Ethereum, 150 USDC, from the recorded live quote', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await relayAdapter.quote(req, { fetch: fetchReturning(RELAY_FIXTURE), now: () => NOW })
    expect(q.provider).toBe('relay')
    expect(q.amountOut).toBe(149_959_256n)
    expect(q.fee).toBe(150_000_000n - 149_959_256n)
    expect(q.etaSec).toBe(6)
    expect(q.mode).toBe('owner-only')
    expect(q.recipientCheck).toBe('decoded-calldata')
    expect(q.target.toLowerCase()).toBe('0x4cd00e387622c35bddb9b4c962c136462338bc31')
    expect(q.calldata).toContain(ACCOUNT.slice(2).toLowerCase())
  })

  test('picks the LAST step, not the approve step, as the call to sign', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await relayAdapter.quote(req, { fetch: fetchReturning(RELAY_FIXTURE), now: () => NOW })
    expect(q.target.toLowerCase()).not.toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') // the approve step's target (USDC itself)
  })

  test('refuses when the declared recipient does not match the account', async () => {
    const bad = { ...RELAY_FIXTURE, details: { ...RELAY_FIXTURE.details, recipient: OTHER } }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(bad), now: () => NOW })).rejects.toThrow()
  })

  test('refuses when quoted for a different account than the calldata actually carries', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: OTHER }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(RELAY_FIXTURE), now: () => NOW })).rejects.toThrow()
  })

  test('refuses malformed output amount and on a non-2xx answer', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning({ ...RELAY_FIXTURE, details: {} }), now: () => NOW })).rejects.toThrow()
    await expect(relayAdapter.quote(req, { fetch: fetchReturning({}, false), now: () => NOW })).rejects.toThrow()
  })
})
