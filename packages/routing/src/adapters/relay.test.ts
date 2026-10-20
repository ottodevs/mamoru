import { describe, expect, test } from 'bun:test'
import { relayAdapter } from './relay.ts'
import type { Fetch } from '../types.ts'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const NOW = 1_792_325_000_000

// Recorded 18 Oct 2026, POST https://api.relay.link/quote, Base -> Ethereum, 150 USDC, recipient = ACCOUNT.
// Trimmed to the fields this adapter reads.
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
  details: { currencyOut: { amount: '149959256' }, timeEstimate: 6 },
}

// Recorded 18 Oct 2026, same endpoint, DISTINCT user (0x5555...) and recipient (0x6666...) — the test this
// whole adapter was rewritten over. The deposit calldata's first word is the depositor (0x5555...), never the
// recipient; 0x6666... does not appear anywhere in it. See the module comment in relay.ts.
const RELAY_DISTINCT_FIXTURE = {
  steps: [
    { id: 'approve', items: [{ data: { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b30000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc310000000000000000000000000000000000000000000000000000000008f0d180', value: '0' } }] },
    {
      id: 'deposit',
      items: [
        {
          data: {
            to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
            data: '0xe80179520000000000000000000000005555555555555555555555555555555555555555000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000008f0d1806710025b91167a9313e1043d3f37daa0b9a7963974d66cd095584aa74681d6f1',
            value: '0',
          },
        },
      ],
    },
  ],
  details: { currencyOut: { amount: '149957542' }, timeEstimate: 4 },
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
    expect(q.target.toLowerCase()).toBe('0x4cd00e387622c35bddb9b4c962c136462338bc31')
  })

  // otto/mamoru#181, review round 3: Relay's deposit calldata has no on-chain destination recipient at all — the
  // first word is the depositor, not the recipient (proven live with distinct user/recipient addresses, see
  // RELAY_DISTINCT_FIXTURE and the module comment). Relay is quote-only: a price point, never executable.

  test('is quote-only: recipientCheck is none, and no calldata or value is ever returned, even for a correct quote', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await relayAdapter.quote(req, { fetch: fetchReturning(RELAY_FIXTURE), now: () => NOW })
    expect(q.recipientCheck).toBe('none')
    expect(q.calldata).toBeUndefined()
    expect(q.value).toBeUndefined()
  })

  test('with a DIFFERENT user and recipient, still quotes (the recipient was never checked) but still never returns calldata', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await relayAdapter.quote(req, { fetch: fetchReturning(RELAY_DISTINCT_FIXTURE), now: () => NOW })
    expect(q.amountOut).toBe(149_957_542n)
    expect(q.recipientCheck).toBe('none')
    expect(q.calldata).toBeUndefined()
  })

  test('refuses a deposit step naming a target other than the one pinned', async () => {
    const tampered = { ...RELAY_FIXTURE, steps: [RELAY_FIXTURE.steps[0], { id: 'deposit', items: [{ data: { ...RELAY_FIXTURE.steps[1]!.items[0]!.data, to: '0x000000000000000000000000000000000000dEaD' } }] }] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses an approve step naming a spender other than the deposit target', async () => {
    const badApprove = `0x095ea7b3${'0'.repeat(64)}${'0'.repeat(56)}08f0d180`
    const tampered = { ...RELAY_FIXTURE, steps: [{ id: 'approve', items: [{ data: { ...RELAY_FIXTURE.steps[0]!.items[0]!.data, data: badApprove } }] }, RELAY_FIXTURE.steps[1]] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses an approve amount that does not match amountIn', async () => {
    const bigApprove = '0x095ea7b30000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc3100000000000000000000000000000000000000000000000000000000596d7c80'
    const tampered = { ...RELAY_FIXTURE, steps: [{ id: 'approve', items: [{ data: { ...RELAY_FIXTURE.steps[0]!.items[0]!.data, data: bigApprove } }] }, RELAY_FIXTURE.steps[1]] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses a deposit whose embedded token does not match the one requested', async () => {
    // Swap the token word (originally Ethereum USDC) for a different, unrelated token address.
    const badToken = RELAY_FIXTURE.steps[1]!.items[0]!.data.data.replace('833589fcd6edb6e08f4c7c32d4f71b54bda02913', '000000000000000000000000000000000000dead')
    const tampered = { ...RELAY_FIXTURE, steps: [RELAY_FIXTURE.steps[0], { id: 'deposit', items: [{ data: { ...RELAY_FIXTURE.steps[1]!.items[0]!.data, data: badToken } }] }] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses a deposit whose embedded amount does not match amountIn', async () => {
    // 0x08f0d180 = 150_000_000; swap for 0x596d7c80 = 1_500_347_520, far more than quoted.
    const badAmount = RELAY_FIXTURE.steps[1]!.items[0]!.data.data.replace('08f0d180', '596d7c80')
    const tampered = { ...RELAY_FIXTURE, steps: [RELAY_FIXTURE.steps[0], { id: 'deposit', items: [{ data: { ...RELAY_FIXTURE.steps[1]!.items[0]!.data, data: badAmount } }] }] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses an ERC20 deposit that attaches a non-zero native value', async () => {
    const tampered = { ...RELAY_FIXTURE, steps: [RELAY_FIXTURE.steps[0], { id: 'deposit', items: [{ data: { ...RELAY_FIXTURE.steps[1]!.items[0]!.data, value: '1000000000000000' } }] }] }
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('a native-input quote (single step, no approve): value must be exactly amountIn', async () => {
    // Recorded live 18 Oct 2026, Ethereum -> Base, native ETH input: Relay's plan has exactly one step; the
    // selector differs from the ERC20 case (0x49290c1c vs 0xe8017952) and there is no token/amount word, only
    // the depositor and an opaque request id.
    const nativeFixture = {
      steps: [{ id: 'deposit', items: [{ data: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: `0x49290c1c${'0'.repeat(24)}${ACCOUNT.slice(2).toLowerCase()}${'0'.repeat(64)}`, value: '10000000000000000' } }] }],
      details: { currencyOut: { amount: '9984542077049941' }, timeEstimate: 2 },
    }
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'ETH' as const, amountIn: 10_000_000_000_000_000n, account: ACCOUNT }
    const q = await relayAdapter.quote(req, { fetch: fetchReturning(nativeFixture), now: () => NOW })
    expect(q.amountOut).toBe(9_984_542_077_049_941n)
    expect(q.recipientCheck).toBe('none')
  })

  test('refuses a native-input deposit whose value does not match amountIn exactly (no top-up allowed, unlike deBridge)', async () => {
    const nativeFixture = {
      steps: [{ id: 'deposit', items: [{ data: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: `0x49290c1c${'0'.repeat(24)}${ACCOUNT.slice(2).toLowerCase()}${'0'.repeat(64)}`, value: '10000000000000001' } }] }], // 1 wei more
      details: { currencyOut: { amount: '9984542077049941' }, timeEstimate: 2 },
    }
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'ETH' as const, amountIn: 10_000_000_000_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(nativeFixture), now: () => NOW })).rejects.toThrow()
  })

  test('refuses a native-input quote whose deposit uses the ERC20 selector, or vice versa', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const wrongSelector = {
      ...RELAY_FIXTURE,
      steps: [RELAY_FIXTURE.steps[0], { id: 'deposit', items: [{ data: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: `0x49290c1c${'0'.repeat(24)}${ACCOUNT.slice(2).toLowerCase()}${'0'.repeat(64)}`, value: '0' } }] }],
    }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning(wrongSelector), now: () => NOW })).rejects.toThrow()
  })

  test('refuses malformed output amount and on a non-2xx answer', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(relayAdapter.quote(req, { fetch: fetchReturning({ ...RELAY_FIXTURE, details: {} }), now: () => NOW })).rejects.toThrow()
    await expect(relayAdapter.quote(req, { fetch: fetchReturning({}, false), now: () => NOW })).rejects.toThrow()
  })
})
