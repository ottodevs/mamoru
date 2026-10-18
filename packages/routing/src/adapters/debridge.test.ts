import { describe, expect, test } from 'bun:test'
import { debridgeAdapter } from './debridge.ts'
import type { Fetch } from '../types.ts'

// deBridge's compliance screen flags the repeated-digit test address this package's other fixtures use
// (0x1111...1111) as high-risk and refuses the quote outright — confirmed live 18 Oct 2026
// (COMPLIANCE_ADDRESS_BLOCKED). This account is the one actually used to record the fixture below.
const ACCOUNT = '0x2222222222222222222222222222222222222222' as const
const OTHER = '0x3333333333333333333333333333333333333333' as const
const NOW = 1_792_325_000_000

// Recorded 18 Oct 2026, GET https://dln.debridge.finance/v1.0/dln/order/create-tx, Base -> Ethereum, 150 USDC.
const DEBRIDGE_FIXTURE = {
  estimation: { dstChainTokenOut: { amount: '149561072' } },
  order: { approximateFulfillmentDelay: 12 },
  tx: {
    data: '0xb930370100000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000001a14ee5c4a400000000000000000000000000000000000000000000000000000000000003600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000008f0d18000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000008ea1ef0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002800000000000000000000000000000000000000000000000000000000000000014a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000000000000000000000000000000142222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000000000000000000000000001422222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000000000000000000000000000014555ce236c0220695b68341bc48c68d52210cc35b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000420101000000e8dd040000000000000000000000000000000000f01eea0800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    to: '0xeF4fB24aD0916217251F553c0596F8Edc630EB66',
    value: '1000000000000000',
  },
}

function fetchReturning(body: unknown, ok = true): Fetch {
  return (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 })) as unknown as Fetch
}

describe('debridgeAdapter', () => {
  test('Base -> Ethereum, 150 USDC, from the recorded live quote', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await debridgeAdapter.quote(req, { fetch: fetchReturning(DEBRIDGE_FIXTURE), now: () => NOW })
    expect(q.provider).toBe('debridge')
    expect(q.amountOut).toBe(149_561_072n)
    expect(q.fee).toBe(150_000_000n - 149_561_072n)
    expect(q.etaSec).toBe(12)
    expect(q.mode).toBe('owner-only')
    expect(q.recipientCheck).toBe('decoded-calldata')
    expect(q.target.toLowerCase()).toBe('0xef4fb24ad0916217251f553c0596f8edc630eb66')
    expect(q.value).toBe(1_000_000_000_000_000n) // the DLN native order-creation fee, separate from the USDC moved
    expect(q.calldata).toContain(ACCOUNT.slice(2).toLowerCase())
  })

  test("Monad's dstChainId is remapped to deBridge's internal id (100000030), not its EVM chain id (143)", async () => {
    const seen: string[] = []
    const spy: Fetch = (async (input: string) => {
      seen.push(input)
      return new Response(JSON.stringify(DEBRIDGE_FIXTURE), { status: 200 })
    }) as unknown as Fetch
    const req = { sourceChainId: 8453, destChainId: 143, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await debridgeAdapter.quote(req, { fetch: spy, now: () => NOW })
    expect(seen[0]).toContain('dstChainId=100000030')
    expect(seen[0]).not.toContain('dstChainId=143')
  })

  test('refuses when the calldata does not actually carry the account', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: OTHER }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(DEBRIDGE_FIXTURE), now: () => NOW })).rejects.toThrow()
  })

  test('surfaces a provider error (e.g. a compliance block) as a refusal, not a crash', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const blocked = { errorCode: 123, errorId: 'COMPLIANCE_ADDRESS_BLOCKED', errorMessage: 'flagged as high-risk' }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(blocked), now: () => NOW })).rejects.toThrow(/high-risk/)
  })
})
