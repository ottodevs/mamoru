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

  // Hardening pass, otto/mamoru#181 follow-up: target and recipient offset were only pinned after being
  // confirmed stable live across Ethereum/Base/Monad origin and both ERC20 and native input.

  test('refuses a deposit step naming a target other than the one pinned', async () => {
    const tampered = { ...RELAY_FIXTURE, steps: [RELAY_FIXTURE.steps[0], { id: 'deposit', items: [{ data: { ...RELAY_FIXTURE.steps[1]!.items[0]!.data, to: '0x000000000000000000000000000000000000dEaD' } }] }] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses a decoy at any word OTHER than word 0, even though the old generic scan would have found it', async () => {
    // Same deposit calldata, but the account now sits at word 2 instead of word 0 (where it was always observed
    // to be) — a stricter check than calldataPinsRecipient's any-word scan, which this would still pass.
    const decoyData = '0xe8017952' + '0'.repeat(64) + '0'.repeat(64) + ACCOUNT.slice(2).toLowerCase().padStart(64, '0')
    const tampered = { ...RELAY_FIXTURE, steps: [RELAY_FIXTURE.steps[0], { id: 'deposit', items: [{ data: { ...RELAY_FIXTURE.steps[1]!.items[0]!.data, data: decoyData } }] }] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses an approve step naming a spender other than the deposit target', async () => {
    // Same amount word as the real fixture (150000000 = 0x08f0d180), but the spender word is the zero address.
    const badApprove = `0x095ea7b3${'0'.repeat(64)}${'0'.repeat(56)}08f0d180`
    const tampered = { ...RELAY_FIXTURE, steps: [{ id: 'approve', items: [{ data: { ...RELAY_FIXTURE.steps[0]!.items[0]!.data, data: badApprove } }] }, RELAY_FIXTURE.steps[1]] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses an approve amount that does not match amountIn', async () => {
    // Same spender, but approving far more than the 150 USDC actually quoted (0x3b9aca00 * 10 = 1,500,000,000).
    const bigApprove = '0x095ea7b30000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc3100000000000000000000000000000000000000000000000000000000596d7c80'
    const tampered = { ...RELAY_FIXTURE, steps: [{ id: 'approve', items: [{ data: { ...RELAY_FIXTURE.steps[0]!.items[0]!.data, data: bigApprove } }] }, RELAY_FIXTURE.steps[1]] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('a native-input quote (single step, no approve) is not forced through the approve check', async () => {
    // Recorded live 18 Oct 2026, Ethereum -> Base, native ETH input: Relay's plan has exactly one step.
    const nativeFixture = {
      steps: [{ id: 'deposit', items: [{ data: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: `0x49290c1c${'0'.repeat(24)}${ACCOUNT.slice(2).toLowerCase()}`, value: '10000000000000000' } }] }],
      details: { recipient: ACCOUNT, currencyOut: { amount: '9984542077049941' }, timeEstimate: 2 },
    }
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'ETH' as const, amountIn: 10_000_000_000_000_000n, account: ACCOUNT }
    const q = await relayAdapter.quote(req, { fetch: fetchReturning(nativeFixture), now: () => NOW })
    expect(q.value).toBe(10_000_000_000_000_000n)
  })
})
