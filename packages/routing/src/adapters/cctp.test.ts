import { describe, expect, test } from 'bun:test'
import { decodeFunctionData } from 'viem'
import { cctpAdapter, feeFromBps, tokenMessengerV2Abi, TOKEN_MESSENGER_V2 } from './cctp.ts'
import type { Fetch } from '../types.ts'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const NOW = 1_792_325_000_000

// Recorded 18 Oct 2026, GET https://iris-api.circle.com/v2/burn/USDC/fees/{src}/{dst}.
const FEES_ETH_TO_BASE = [
  { finalityThreshold: 1000, minimumFee: 1 },
  { finalityThreshold: 2000, minimumFee: 0 },
]
const FEES_BASE_TO_MONAD = [
  { finalityThreshold: 1000, minimumFee: 1.3 },
  { finalityThreshold: 2000, minimumFee: 0 },
]

function fetchReturning(body: unknown, ok = true): Fetch {
  return (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 })) as unknown as Fetch
}

describe('cctpAdapter', () => {
  test('supports USDC between any two configured chains, never ETH', () => {
    expect(cctpAdapter.supports({ sourceChainId: 1, destChainId: 8453, asset: 'USDC', amountIn: 1n, account: ACCOUNT })).toBe(true)
    expect(cctpAdapter.supports({ sourceChainId: 1, destChainId: 8453, asset: 'ETH', amountIn: 1n, account: ACCOUNT })).toBe(false)
    expect(cctpAdapter.supports({ sourceChainId: 1, destChainId: 1, asset: 'USDC', amountIn: 1n, account: ACCOUNT })).toBe(false)
  })

  test('Ethereum -> Base, 150 USDC, picks Fast (both sides support it)', async () => {
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await cctpAdapter.quote(req, { fetch: fetchReturning(FEES_ETH_TO_BASE), now: () => NOW })
    expect(q.provider).toBe('cctp-v2')
    expect(q.route).toBe('CCTP V2 Fast')
    expect(q.fee).toBe(15_000n) // 1 bps of 150_000_000
    expect(q.amountOut).toBe(150_000_000n - 15_000n)
    expect(q.target).toBe(TOKEN_MESSENGER_V2)
    expect(q.mode).toBe('session-key')
    expect(q.recipientCheck).toBe('onchain-pinnable')

    const decoded = decodeFunctionData({ abi: tokenMessengerV2Abi, data: q.calldata! })
    expect(decoded.functionName).toBe('depositForBurn')
    const [amount, destinationDomain, mintRecipient, , , maxFee, minFinalityThreshold] = decoded.args
    expect(amount).toBe(150_000_000n)
    expect(destinationDomain).toBe(6) // Base
    expect(mintRecipient.toLowerCase()).toBe(`0x${'0'.repeat(24)}${ACCOUNT.slice(2).toLowerCase()}`)
    expect(maxFee).toBe(15_000n)
    expect(minFinalityThreshold).toBe(1000)
  })

  test('Base -> Monad, 150 USDC, Monad has no Fast so it falls back to Standard', async () => {
    const req = { sourceChainId: 8453, destChainId: 143, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const q = await cctpAdapter.quote(req, { fetch: fetchReturning(FEES_BASE_TO_MONAD), now: () => NOW })
    expect(q.route).toBe('CCTP V2 Standard')
    expect(q.fee).toBe(0n) // Standard's minimumFee was 0 in the recorded fixture
    expect(q.amountOut).toBe(150_000_000n)
    const decoded = decodeFunctionData({ abi: tokenMessengerV2Abi, data: q.calldata! })
    const [, destinationDomain, , , , , minFinalityThreshold] = decoded.args
    expect(destinationDomain).toBe(15) // Monad
    expect(minFinalityThreshold).toBe(2000)
  })

  test('a fractional bps fee (Base->Monad Fast quoted 1.3) rounds up in whole base units, never down', () => {
    expect(feeFromBps(150_000_000n, 1.3)).toBe(19_500n) // 1.3 bps of 150 USDC = 0.0195 USDC
    expect(feeFromBps(1n, 0.001)).toBe(1n) // rounds a sub-unit fee up, never to zero against the account
  })

  test('refuses when the fee API has no entry for the chosen finality threshold', async () => {
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(cctpAdapter.quote(req, { fetch: fetchReturning([{ finalityThreshold: 2000, minimumFee: 0 }]), now: () => NOW })).rejects.toThrow()
  })

  test('refuses on a non-2xx answer', async () => {
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    await expect(cctpAdapter.quote(req, { fetch: fetchReturning({}, false), now: () => NOW })).rejects.toThrow()
  })

  // otto/mamoru#181 follow-up: this route is session-key, so an unattended signer trusts this adapter's output
  // directly — a malformed or compromised fee answer must never silently become calldata burning most of the
  // amount. Before this fix, only "fee >= 100%" was refused.
  test('refuses a minimumFee far above anything Circle has ever quoted, even though it is still under 100%', async () => {
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const malicious = [{ finalityThreshold: 1000, minimumFee: 9999 }, { finalityThreshold: 2000, minimumFee: 0 }]
    await expect(cctpAdapter.quote(req, { fetch: fetchReturning(malicious), now: () => NOW })).rejects.toThrow()
  })

  test('a fee right at the app policy bound (50 bps) is accepted; one basis point over is refused', async () => {
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'USDC' as const, amountIn: 150_000_000n, account: ACCOUNT }
    const atBound = [{ finalityThreshold: 1000, minimumFee: 50 }, { finalityThreshold: 2000, minimumFee: 0 }]
    await expect(cctpAdapter.quote(req, { fetch: fetchReturning(atBound), now: () => NOW })).resolves.toBeDefined()
    const overBound = [{ finalityThreshold: 1000, minimumFee: 50.1 }, { finalityThreshold: 2000, minimumFee: 0 }]
    await expect(cctpAdapter.quote(req, { fetch: fetchReturning(overBound), now: () => NOW })).rejects.toThrow()
  })
})
