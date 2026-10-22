import { describe, expect, test } from 'bun:test'
import { TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem'
import { ACROSS_SPOKE_POOL, BridgeOut, checkQuote, DAILY_BUDGET_WEI, MAX_FEE_BPS, type AcrossQuote, type BaseMinter } from '../src/bridge-out.ts'
import { HttpError } from '../src/operator.ts'

const NOW = 1_800_000_000
const AMOUNT = 150_000_000n
const good = (over: Partial<AcrossQuote> = {}): AcrossQuote => ({
  outputAmount: '149980866',
  totalRelayFee: { total: '19134' },
  timestamp: String(NOW - 30),
  fillDeadline: String(NOW + 4 * 3600),
  exclusiveRelayer: '0x0000000000000000000000000000000000000000',
  exclusivityDeadline: 0,
  spokePoolAddress: ACROSS_SPOKE_POOL,
  estimatedFillTimeSec: 2,
  isAmountTooLow: false,
  ...over,
})
const refused = (q: AcrossQuote) => {
  try {
    checkQuote(q, AMOUNT, NOW)
    return 'accepted'
  } catch (e) {
    return e instanceof HttpError ? `${e.code}: ${e.message}` : 'unexpected'
  }
}

describe('bridge-out quote check (#133)', () => {
  test('a normal Across quote becomes the deposit as quoted', () => {
    const d = checkQuote(good(), AMOUNT, NOW)
    expect(d).toEqual({ amount: AMOUNT, outputAmount: 149_980_866n, exclusiveRelayer: '0x0000000000000000000000000000000000000000', quoteTimestamp: NOW - 30, fillDeadline: NOW + 4 * 3600, exclusivityDeadline: 0, fillSec: 2 })
  })

  test('refuses another contract, a fee that does not match, a fee above the bound, and an output above the input', () => {
    expect(refused(good({ spokePoolAddress: '0x000000000000000000000000000000000000dEaD' }))).toContain('unexpected contract')
    expect(refused(good({ totalRelayFee: { total: '1' } }))).toContain('fee does not match')
    const over = (AMOUNT * (MAX_FEE_BPS + 1n)) / 10_000n
    expect(refused(good({ outputAmount: String(AMOUNT - over), totalRelayFee: { total: String(over) } }))).toContain('fee too high')
    expect(refused(good({ outputAmount: String(AMOUNT + 1n), totalRelayFee: { total: '-1' } }))).toContain('out of range')
  })

  test('an exclusive relayer may hold the fill for minutes, not until the deadline', () => {
    const relayer = '0xFD03AbCAdaF3F930fA4E37Eb2f6ea3A44a41b7F0'
    expect(refused(good({ exclusiveRelayer: relayer, exclusivityDeadline: NOW + 208 }))).toBe('accepted')
    expect(refused(good({ exclusiveRelayer: relayer, exclusivityDeadline: 120 }))).toBe('accepted')
    expect(refused(good({ exclusiveRelayer: relayer, exclusivityDeadline: NOW + 4 * 3600 }))).toContain('exclusivity too long')
    expect(refused(good({ exclusiveRelayer: relayer, exclusivityDeadline: 3600 }))).toContain('exclusivity too long')
    expect(refused(good({ exclusivityDeadline: 60 }))).toContain('exclusivity without a relayer')
    expect(refused(good({ fillDeadline: String(NOW + 3 * 86_400) }))).toContain('fill deadline too far')
  })

  test('refuses a stale quote, a close fill deadline, malformed fields, and an amount Across calls too low', () => {
    expect(refused(good({ timestamp: String(NOW - 3600) }))).toContain('stale')
    expect(refused(good({ fillDeadline: String(NOW + 60) }))).toContain('fill deadline too close')
    expect(refused(good({ exclusiveRelayer: 'nope' }))).toContain('malformed')
    expect(refused(good({ outputAmount: 'x' }))).toContain('malformed')
    expect(refused(good({ isAmountTooLow: true }))).toStartWith('BRIDGE_AMOUNT_TOO_LOW')
  })
})

describe('the operator bundler guard (#180)', () => {
  const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  type Hex = `0x${string}`
  const K1 = `0x${'01'.repeat(32)}` as Hex
  const K2 = `0x${'02'.repeat(32)}` as Hex
  const T1 = `0x${'a1'.repeat(32)}` as Hex
  const route = (id: string, userOpHash: Hex) => ({ id, safe: '0x0000000000000000000000000000000000000aaa', safeNonce: '0', fromBlock: '0', state: 'sending', amountUsdc: '1', outputUsdc: '1', userOpHash, at: new Date().toISOString() })
  const make = (o: { now?: () => number; dir?: string; chain?: Partial<Record<string, unknown>> } = {}) => {
    const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'mamoru-guard-'))
    if (!o.dir) writeFileSync(join(dir, 'bridge-out.json'), JSON.stringify({ routes: { a: route('r1', K1), b: route('r2', K2) }, spent: { day: '', wei: '0' }, moves: {} }))
    const notFound = async ({ hash }: { hash: Hex }) => {
      throw new TransactionReceiptNotFoundError({ hash })
    }
    const l1 = { getGasPrice: async () => 1_000_000_000n, getBalance: async () => 10n ** 18n, getTransactionReceipt: notFound, getTransaction: async ({ hash }: { hash: Hex }) => Promise.reject(new TransactionNotFoundError({ hash })), getTransactionCount: async () => 0, ...o.chain } as unknown as import('viem').PublicClient
    const relayer = { address: '0x0000000000000000000000000000000000000001' as const, send: async () => Promise.reject(new Error('unused')) }
    const bo = new BridgeOut(l1, relayer, dir, fetch, o.now ?? Date.now, undefined, () => true)
    const j = () => JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8'))
    return { bo, dir, spent: () => BigInt(j().spent.wei), reserved: () => j().reservations ?? {} }
  }

  test('fronts gas only for a userOp of a move under way, one bundle at a time', async () => {
    const { bo } = make()
    const g = bo.bundlerGuard()
    await expect(g.before(`0x${'09'.repeat(32)}`, 1_400_000n)).rejects.toThrow('no move under way')
    await g.before(K1, 1_400_000n)
    await expect(g.before(K2, 1_400_000n)).rejects.toThrow('another bundle is in flight')
  })

  test('reservations are per userOp: a failed signed send of one never clears another; unsigned ones go back', async () => {
    const { bo, reserved } = make()
    const g = bo.bundlerGuard()
    await g.before(K1, 1_400_000n)
    g.sending(K1, 3_000_000_000_000_000n, 1_400_000n)
    g.sent(K1, T1, 7)
    g.failed(K1, true)
    await g.before(K2, 1_000_000n)
    g.failed(K2, false)
    expect(Object.keys(reserved())).toEqual([K1])
    expect(reserved()[K1]).toMatchObject({ wei: '3000000000000000', tx: T1, nonce: 7 })
    // The held 0.003 ETH counts against the budget: a second bundle bound of 0.0028 ETH is refused before any send.
    await expect(g.before(K2, 1_400_000n)).rejects.toThrow('paused for today')
  })

  test('a held reservation is released only on proof: a node error changes nothing; a taken nonce with no receipt and no transaction, seen twice 30 min apart, settles 0', async () => {
    let receiptMode: 'error' | 'none' = 'error'
    let count = 5
    let clock = Date.parse('2026-10-20T10:00:00Z')
    const { bo, dir, reserved, spent } = make({
      now: () => clock,
      chain: {
        getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
          if (receiptMode === 'error') throw new Error('node down')
          throw new TransactionReceiptNotFoundError({ hash })
        },
        getTransactionCount: async () => count,
      },
    })
    const g = bo.bundlerGuard()
    await g.before(K1, 1_000_000n)
    g.sending(K1, 2_000_000_000_000_000n, 1_000_000n)
    g.sent(K1, T1, 7)
    g.failed(K1, true)
    count = 8
    await bo.tick()
    expect(Object.keys(reserved())).toEqual([K1])
    receiptMode = 'none'
    await bo.tick()
    expect(reserved()[K1]?.goneAt).toBeDefined()
    clock += 10 * 60_000
    await bo.tick()
    expect(Object.keys(reserved())).toEqual([K1])
    clock += 25 * 60_000
    await bo.tick()
    expect(reserved()).toEqual({})
    expect(spent()).toBe(0n)
    // A restart keeps a signed reservation and drops one that was never signed.
    const { bo: b2, reserved: r2 } = make({ dir, now: () => clock })
    const g2 = b2.bundlerGuard()
    await g2.before(K2, 1_000_000n)
    expect(Object.keys(r2())).toEqual([K2])
    expect(Object.keys(make({ dir }).reserved())).toEqual([])
  })

  test('after(): cost minus refund, never below zero; across midnight the reservation still counts until settled', async () => {
    let clock = Date.parse('2026-10-18T23:59:50Z')
    const { bo, spent, reserved } = make({ now: () => clock })
    const g = bo.bundlerGuard()
    await g.before(K1, 1_000_000n)
    g.sending(K1, 4_000_000_000_000_000n, 1_000_000n)
    clock = Date.parse('2026-10-19T00:00:10Z')
    await expect(g.before(K2, 1_000_000n)).rejects.toThrow()
    g.after(K1, 1_000n, 900n)
    expect(spent()).toBe(100n)
    expect(reserved()).toEqual({})
    expect(() => g.sending(K2, DAILY_BUDGET_WEI + 1n, 1_000_000n)).toThrow('budget')
  })
})

describe('the CCTP mint on Base (#180): replayed attestations and the admission-day budget', async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const { concat, keccak256, pad, toHex } = await import('viem')
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
  const { cctpMessageKey, TOKEN_MESSENGER_V2 } = await import('../src/cctp.ts')
  const { L1_USDC, MINT_BUDGET_WEI } = await import('../src/bridge-out.ts')
  type Hex = `0x${string}`
  const SAFE = '0x0000000000000000000000000000000000000aaa' as const
  const AMT = 146_930_000n
  const attester = privateKeyToAccount(generatePrivateKey())
  const u = (v: bigint | number, n: number) => pad(toHex(v), { size: n })
  /** A MessageV2 + BurnMessageV2 of this Safe's burn, as Circle attests it (nonce and executed fields filled in). */
  const message = (nonce: bigint, maxFee: bigint): Hex =>
    concat([
      u(1, 4), u(0, 4), u(6, 4), u(nonce, 32), pad(TOKEN_MESSENGER_V2, { size: 32 }), pad(TOKEN_MESSENGER_V2, { size: 32 }), u(0, 32), u(2000, 4), u(2000, 4),
      u(1, 4), pad(L1_USDC, { size: 32 }), pad(SAFE, { size: 32 }), u(AMT, 32), pad(SAFE, { size: 32 }), u(maxFee, 32), u(0, 32), u(0, 32),
    ])
  const attest = async (m: Hex) => ({ message: m, attestation: await attester.sign({ hash: keccak256(m) }) })
  const day = (d: string) => Date.parse(`${d}Z`)

  const make = (o: { iris: Record<string, { message: Hex; attestation: Hex }[]>; used?: Set<string>; now: () => number; send?: (onSending: (w: bigint, p: bigint) => void) => Promise<void>; journal?: object; l1Fee?: unknown }) => {
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-mint-'))
    if (o.journal) writeFileSync(join(dir, 'bridge-out.json'), JSON.stringify({ routes: {}, spent: { day: '', wei: '0' }, moves: {}, ...o.journal }))
    const used = o.used ?? new Set<string>()
    const sent: Hex[] = []
    const client = {
      getGasPrice: async () => 100_000_000n,
      getTransactionReceipt: async () => null,
      readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        if (functionName === 'signatureThreshold') return 1n
        if (functionName === 'isEnabledAttester') return (args![0] as string).toLowerCase() === attester.address.toLowerCase()
        if (functionName === 'usedNonces') return used.has((args![0] as string).toLowerCase()) ? 1n : 0n
        throw new Error(functionName)
      },
    } as unknown as import('viem').PublicClient
    let n = 0
    const relayer = {
      address: '0x0000000000000000000000000000000000000002' as const,
      send: async (tx: { data?: Hex }, _onSent?: unknown, onSending?: (w: bigint, signed: { hash: Hex; nonce: number; maxFeePerGas: bigint }) => void, onSigned?: (h: Hex, nonce: number) => void) => {
        const hash = u(++n, 32)
        // As the Relayer: the bound, then the signed transaction's hash, nonce and fee cap, before the broadcast.
        const bound = (w: bigint, p: bigint) => onSending!(w, { hash, nonce: n, maxFeePerGas: p })
        if (o.send) await o.send(bound)
        else bound(MINT_BUDGET_WEI / 100n, 1_000_000_000n)
        onSigned!(hash, n)
        sent.push(tx.data!)
        return { hash, receipt: { status: 'success', gasUsed: 150_000n, effectiveGasPrice: 100_000_000n, logs: [], ...(o.l1Fee !== undefined ? { l1Fee: o.l1Fee } : {}) } }
      },
    }
    const fetcher = async (url: string) => {
      const tx = new URL(url).searchParams.get('transactionHash')
      if (tx) return new Response(JSON.stringify({ messages: (o.iris[tx] ?? []).map((a) => ({ status: 'complete', ...a })) }))
      if (url.includes('/v2/burn/USDC/fees/')) return new Response(JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0 }]))
      return new Response('no', { status: 500 })
    }
    const bo = new BridgeOut({} as import('viem').PublicClient, { address: relayer.address, send: async () => Promise.reject(new Error('unused')) }, dir, fetcher as typeof fetch, o.now, undefined, () => true, null, { client, relayer: relayer as unknown as BaseMinter['relayer'] })
    const j = () => JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8'))
    const priv = bo as unknown as { cctpMint(k: string, r: object): Promise<void>; pickLeg(a: bigint, now: number, k: string): Promise<{ bridge: string; burn?: { maxFee: bigint } }> }
    return { bo, priv, sent, j }
  }
  const route = (id: string, l1Tx: Hex, maxFee: bigint) => ({ id, safe: SAFE, safeNonce: '0', fromBlock: '0', state: 'deposited', bridge: 'cctp', amountUsdc: AMT.toString(), outputUsdc: AMT.toString(), l1Tx, cctp: { maxFee: maxFee.toString(), minFinality: 2000, message: cctpMessageKey(message(0n, maxFee)) }, at: new Date(0).toISOString() })

  test('astra P1 (b0cd2d9): no later burn of the account reuses an earlier (amount, maxFee), so an old genuine attestation never matches it', async () => {
    const all = Array.from({ length: 999 }, (_, i) => `${AMT}:${i + 1}`)
    // 998 tags used: the picker takes the one left; all 999 used: CCTP is not offered for that amount.
    const left = make({ iris: {}, now: () => day('2026-10-20T10:00:00'), journal: { cctpBurns: { a: all.filter((t) => t !== `${AMT}:417`) } } })
    const leg = await left.priv.pickLeg(AMT, 0, 'a')
    expect(leg.bridge).toBe('cctp')
    expect(leg.burn?.maxFee).toBe(417n)
    const none = make({ iris: {}, now: () => day('2026-10-20T10:00:00'), journal: { cctpBurns: { a: all } } })
    await expect(none.priv.pickLeg(AMT, 0, 'a')).rejects.toThrow()
  })

  test('astra P1 (b0cd2d9): an old authentic attestation, its nonce used on Base, never completes a new burn of the same account and amount', async () => {
    const T1 = u(0xb1, 32)
    const T2 = u(0xb2, 32)
    const N1 = 0x1111n
    const first = await attest(message(N1, 7n))
    const used = new Set<string>()
    const iris: Record<string, { message: Hex; attestation: Hex }[]> = { [T1]: [first] }
    const { priv, sent, j } = make({ iris, used, now: () => day('2026-10-20T10:00:00') })
    // The first move mints and its nonce is recorded.
    const r1 = route('r1', T1, 7n)
    await priv.cctpMint('a', r1)
    expect((r1 as { state: string }).state).toBe('filled')
    expect(sent.length).toBe(1)
    used.add(u(N1, 32).toLowerCase())
    // A second burn: Iris answers for it with the first burn's genuine attestation (nonce used on Base).
    iris[T2] = [first]
    const r2 = route('r2', T2, 8n)
    await priv.cctpMint('a', r2)
    expect((r2 as { state: string }).state).toBe('deposited')
    expect(sent.length).toBe(1)
    // Even a route whose message key equals the first burn's (a journal from before the tags): the completed nonce
    // is the second lock, nothing is filled and nothing is sent.
    const r3 = route('r3', T2, 7n)
    await priv.cctpMint('a', r3)
    expect((r3 as { state: string }).state).toBe('deposited')
    expect(sent.length).toBe(1)
    expect(j().cctpNonces.a).toEqual([u(N1, 32).toLowerCase()])
    // ... and a raw message with nonce zero (Base marks it used at init) is never taken as minted.
    iris[T2] = [await attest(message(0n, 8n))]
    await priv.cctpMint('a', r2)
    expect((r2 as { state: string }).state).toBe('deposited')
    expect(sent.length).toBe(1)
  })

  test('astra P1 (b0cd2d9): a mint queued across midnight is held to the day it was admitted on, signed bound included', async () => {
    let clock = day('2026-10-20T23:59:59')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const TA = u(0xa1, 32)
    const TB = u(0xa2, 32)
    const SAFE_B = SAFE
    const iris = { [TA]: [await attest(message(0x21n, 11n))], [TB]: [await attest(message(0x22n, 12n))] }
    const { priv, sent, j } = make({
      iris,
      now: () => clock,
      send: async (onSending) => {
        // The first mint waits behind the shared Base relayer; at signing its bound (0.003 ETH) is above the
        // 0.002 ETH day budget it was admitted on. The second, admitted after midnight, signs a small bound.
        if (++calls === 1) {
          await gate
          onSending(3_000_000_000_000_000n, 1_000_000_000n)
        } else onSending(6_000_000_000_000n, 1_000_000_000n)
      },
    })
    const a = priv.cctpMint('a', route('ra', TA, 11n))
    await new Promise((r) => setTimeout(r, 5))
    clock = day('2026-10-21T00:00:05')
    await priv.cctpMint('b', { ...route('rb', TB, 12n), safe: SAFE_B })
    release()
    await a
    // Only the second mint went out; the first was stopped before the broadcast and its day got everything back.
    expect(sent.length).toBe(1)
    const days = j().mintDays
    expect(days['2026-10-20']).toEqual({ n: 0, wei: '0' })
    expect(days['2026-10-21'].n).toBe(1)
    expect(BigInt(days['2026-10-21'].wei)).toBeLessThan(MINT_BUDGET_WEI)
  })
  test('opus P1 (55be0fb): the receipt charge parses l1Fee as the node sends it (hex string) and never zeroes the day', async () => {
    const TA = u(0xc1, 32)
    const TB = u(0xc2, 32)
    const iris = { [TA]: [await attest(message(0x31n, 21n))], [TB]: [await attest(message(0x32n, 22n))] }
    const { priv, sent, j } = make({ iris, now: () => day('2026-10-21T12:00:00'), l1Fee: '0x5af3107a4000' })
    await priv.cctpMint('a', route('ra', TA, 21n))
    await priv.cctpMint('b', route('rb', TB, 22n))
    expect(sent.length).toBe(2)
    // Two mints, each 150k gas at 0.1 gwei plus an L1 data fee of 0x5af3107a4000 wei: both stay on the day.
    const each = 150_000n * 100_000_000n + 0x5af3107a4000n
    expect(j().mintDays['2026-10-21']).toEqual({ n: 2, wei: (2n * each).toString() })
  })
  test('sol P2 (b29179d): a mint signed above the 2 gwei Base ceiling is stopped before the broadcast (signed.maxFeePerGas)', async () => {
    const TA = u(0xd1, 32)
    const iris = { [TA]: [await attest(message(0x41n, 31n))] }
    const { priv, sent, j } = make({ iris, now: () => day('2026-10-21T12:00:00'), send: async (onSending) => onSending(1_000_000_000_000n, 2_000_000_001n) })
    const r = route('ra', TA, 31n)
    await priv.cctpMint('a', r)
    expect(sent.length).toBe(0)
    expect((r as { state: string }).state).toBe('deposited')
    expect(j().mintDays['2026-10-21']).toEqual({ n: 0, wei: '0' })
  })
})
