import { describe, expect, test } from 'bun:test'
import { DEBRIDGE_DLN_SOURCE, debridgeAdapter } from './debridge.ts'
import type { Fetch } from '../types.ts'

// deBridge's compliance screen flags the repeated-digit test address this package's other fixtures use
// (0x1111...1111) as high-risk and refuses the quote outright — confirmed live 18 Oct 2026
// (COMPLIANCE_ADDRESS_BLOCKED). This account is the one actually used to record the fixture below.
const ACCOUNT = '0x2222222222222222222222222222222222222222' as const
const NOW = 1_792_325_000_000

// Recorded 18 Oct 2026, GET https://dln.debridge.finance/v1.0/dln/order/create-tx, Base -> Ethereum, 150 USDC.
const DEBRIDGE_FIXTURE = {
  estimation: { srcChainTokenIn: { chainId: 8453 }, dstChainTokenOut: { chainId: 1, amount: '149561072' } },
  order: { approximateFulfillmentDelay: 12 },
  fixFee: '1000000000000000',
  tx: {
    data: '0xb930370100000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000001a14ee5c4a400000000000000000000000000000000000000000000000000000000000003600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000008f0d18000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000008ea1ef0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002800000000000000000000000000000000000000000000000000000000000000014a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000000000000000000000000000000142222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000000000000000000000000001422222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000000000000000000000000000014555ce236c0220695b68341bc48c68d52210cc35b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000420101000000e8dd040000000000000000000000000000000000f01eea0800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    to: '0xeF4fB24aD0916217251F553c0596F8Edc630EB66',
    value: '1000000000000000',
  },
}

// Recorded 18 Oct 2026, same endpoint, DISTINCT sender (0x4444...) and recipient (0x7777...). This is the test
// that found deBridge's recipient check never actually worked: `calldataPinsRecipient` requires a left-padded
// 32-byte word, but deBridge's recipient argument is RIGHT-padded inside its word — the function never matches
// it. Only the sender's (left-padded) word matched, which was indistinguishable from a correct recipient match
// as long as every fixture set sender === recipient === account. See debridge.ts's module comment.
const DEBRIDGE_DISTINCT_FIXTURE = {
  estimation: { srcChainTokenIn: { chainId: 8453 }, dstChainTokenOut: { chainId: 1, amount: '149571084' } },
  order: { approximateFulfillmentDelay: 12 },
  fixFee: '1000000000000000',
  tx: {
    data: '0xb930370100000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000001a15854721e00000000000000000000000000000000000000000000000000000000000003600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000008f0d18000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000008ea460c000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002800000000000000000000000000000000000000000000000000000000000000014a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000000000000000000000000000000147777777777777777777777777777777777777777000000000000000000000000000000000000000000000000000000000000000000000000000000000000001477777777777777777777777777777777777777770000000000000000000000000000000000000000000000000000000000000000000000000000000000000014555ce236c0220695b68341bc48c68d52210cc35b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000420101000000ccb60400000000000000000000000000000000000c46ea0800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    to: '0xeF4fB24aD0916217251F553c0596F8Edc630EB66',
    value: '1000000000000000',
  },
}

function fetchReturning(body: unknown, ok = true): Fetch {
  return (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 })) as unknown as Fetch
}

describe('debridgeAdapter', () => {
  test('Base -> Ethereum, 150 USDC, from the recorded live quote — quote-only, no calldata or value', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await debridgeAdapter.quote(req, { fetch: fetchReturning(DEBRIDGE_FIXTURE), now: () => NOW })
    expect(q.provider).toBe('debridge')
    expect(q.amountOut).toBe(149_561_072n)
    expect(q.fee).toBe(150_000_000n - 149_561_072n)
    expect(q.etaSec).toBe(12)
    expect(q.mode).toBe('owner-only')
    expect(q.recipientCheck).toBe('none')
    expect(q.target.toLowerCase()).toBe('0xef4fb24ad0916217251f553c0596f8edc630eb66')
    expect(q.calldata).toBeUndefined()
    expect(q.value).toBeUndefined()
  })

  // otto/mamoru#181, review round 3: the recipient check never actually worked (see the module comment and the
  // DEBRIDGE_DISTINCT_FIXTURE comment above) — deBridge is quote-only regardless of what `account` is.

  test('with a DIFFERENT sender and recipient, still quotes (nothing here claims to check the recipient) and still never returns calldata', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await debridgeAdapter.quote(req, { fetch: fetchReturning(DEBRIDGE_DISTINCT_FIXTURE), now: () => NOW })
    expect(q.amountOut).toBe(149_571_084n)
    expect(q.recipientCheck).toBe('none')
    expect(q.calldata).toBeUndefined()
  })

  test("Monad's dstChainId is remapped to deBridge's internal id (100000030), not its EVM chain id (143)", async () => {
    const monadFixture = { ...DEBRIDGE_FIXTURE, estimation: { srcChainTokenIn: { chainId: 8453 }, dstChainTokenOut: { chainId: 100_000_030, amount: DEBRIDGE_FIXTURE.estimation.dstChainTokenOut.amount } } }
    const seen: string[] = []
    const spy: Fetch = (async (input: string) => {
      seen.push(input)
      return new Response(JSON.stringify(monadFixture), { status: 200 })
    }) as unknown as Fetch
    const req = { sourceChainId: 8453, destChainId: 143, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await debridgeAdapter.quote(req, { fetch: spy, now: () => NOW })
    expect(seen[0]).toContain('dstChainId=100000030')
    expect(seen[0]).not.toContain('dstChainId=143')
  })

  test('surfaces a provider error (e.g. a compliance block) as a refusal, not a crash', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const blocked = { errorCode: 123, errorId: 'COMPLIANCE_ADDRESS_BLOCKED', errorMessage: 'flagged as high-risk' }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(blocked), now: () => NOW })).rejects.toThrow(/high-risk/)
  })

  // The checks below still run even though the route is quote-only: they protect the trustworthiness of the
  // PRICE (amountOut, fee) a caller compares against every other adapter, not the safety of executing it.

  test('refuses a target contract other than the one pinned (DLN source observed identical on every chain tested)', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const tampered = { ...DEBRIDGE_FIXTURE, tx: { ...DEBRIDGE_FIXTURE.tx, to: '0x000000000000000000000000000000000000dEaD' } }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test("sanity: the fixture's own target is in fact the pinned DLN source", () => {
    expect(DEBRIDGE_FIXTURE.tx.to.toLowerCase()).toBe(DEBRIDGE_DLN_SOURCE.toLowerCase())
  })

  test('refuses when tx.value does not match the response\'s own declared fixFee', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const tampered = { ...DEBRIDGE_FIXTURE, tx: { ...DEBRIDGE_FIXTURE.tx, value: '9999999999999999999' } } // fixFee unchanged
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses a native value (even one that matches fixFee) above the app policy bound', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const huge = '99000000000000000000' // 99 of the native asset — both value and fixFee agree, still refused
    const tampered = { ...DEBRIDGE_FIXTURE, fixFee: huge, tx: { ...DEBRIDGE_FIXTURE.tx, value: huge } }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('ETH-input: the value check still accounts for the bridged principal, not fixFee alone', async () => {
    // Recorded 18 Oct 2026, same endpoint, Ethereum -> Base, 0.01 ETH: tx.value legitimately includes the
    // bridged principal, unlike the USDC-input fixture above where value == fixFee exactly.
    const ethFixture = {
      estimation: { srcChainTokenIn: { chainId: 1 }, dstChainTokenOut: { chainId: 8453, amount: '9974851836328536' } },
      order: { approximateFulfillmentDelay: 3 },
      fixFee: '1000000000000000',
      tx: { ...DEBRIDGE_FIXTURE.tx, value: '11126206620740072' }, // 0.01 ETH principal + 0.001 ETH fee + ~0.00013 ETH top-up
    }
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'ETH' as const, amountIn: 10_000_000_000_000_000n, account: ACCOUNT }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(ethFixture), now: () => NOW })).resolves.toBeDefined()
  })

  test("refuses when either side's chain id is missing from the response, not only when it disagrees", async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const missingSrc = { ...DEBRIDGE_FIXTURE, estimation: { dstChainTokenOut: DEBRIDGE_FIXTURE.estimation.dstChainTokenOut } }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(missingSrc), now: () => NOW })).rejects.toThrow()
  })

  test('refuses a declared fixFee above the per-chain cap even when tx.value agrees with it exactly', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const tooMuch = '1000000000000000000' // 1 ETH-equivalent — well under the old 5 ETH breaker, over the new 0.05 ETH fee cap
    const tampered = { ...DEBRIDGE_FIXTURE, fixFee: tooMuch, tx: { ...DEBRIDGE_FIXTURE.tx, value: tooMuch } }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(tampered), now: () => NOW })).rejects.toThrow()
  })

  test('refuses an ETH-input order whose tx.value overshoots amountIn + fixFee by more than the allowed slack', async () => {
    const ethFixture = {
      estimation: { dstChainTokenOut: { amount: '9974851836328536' } },
      order: { approximateFulfillmentDelay: 3 },
      fixFee: '1000000000000000',
      tx: { ...DEBRIDGE_FIXTURE.tx, value: '20000000000000000' }, // far more than 0.01 ETH + 0.001 ETH + slack
    }
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'ETH' as const, amountIn: 10_000_000_000_000_000n, account: ACCOUNT }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(ethFixture), now: () => NOW })).rejects.toThrow()
  })

  test('refuses when the response names a different source or destination chain than the one requested', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const wrongSrc = { ...DEBRIDGE_FIXTURE, estimation: { ...DEBRIDGE_FIXTURE.estimation, srcChainTokenIn: { chainId: 1 } } }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(wrongSrc), now: () => NOW })).rejects.toThrow()
    const wrongDst = { ...DEBRIDGE_FIXTURE, estimation: { ...DEBRIDGE_FIXTURE.estimation, dstChainTokenOut: { ...DEBRIDGE_FIXTURE.estimation.dstChainTokenOut, chainId: 8453 } } }
    await expect(debridgeAdapter.quote(req, { fetch: fetchReturning(wrongDst), now: () => NOW })).rejects.toThrow()
  })
})
