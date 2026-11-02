import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, keccak256, pad, toHex, type Hex, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address } from '@mamoru/domain'
import type { MonadSender } from '../src/bridge-monad.ts'
import { TOKEN_MESSENGER_V2 } from '../src/cctp.ts'
import type { ReleaseView } from '../src/release.ts'
import { RemotePeer } from '../src/remote-peer.ts'
import { RETURN_ATTEST_FIRST_POLL_MS, RETURN_MINT_PENDING_MS, ReturnHome, type ReturnEntry, type ReturnPeer } from '../src/return-home.ts'

const HOME = '0x00000000000000000000000000000000000000a1' as Address
const V4 = '0x00000000000000000000000000000000000000f4' as Address
const MONAD_USDC = '0x00000000000000000000000000000000000000c5' as Address
const BURN_TX = `0x${'22'.repeat(32)}` as Hex
const AMOUNT = 4_000_000n
/** The remote value when the return was asked. */
const FLOOR = 5_000_000n
const T0 = Date.parse('2026-11-02T18:00:00Z')
const REMOTE = { accountKey: 'r-1', chainId: 143, address: '0x00000000000000000000000000000000000000b2' } as unknown as AccountContext

const u = (v: bigint | number, n: number) => pad(toHex(v), { size: n })
/** A CCTP V2 burn message Monad -> Base: V4 burned Monad USDC to the home. */
const message = (o: { nonce?: bigint; amount?: bigint; recipient?: Hex; sender?: Hex; source?: number; token?: Hex } = {}): Hex =>
  concat([
    u(1, 4), u(o.source ?? 15, 4), u(6, 4), u(o.nonce ?? 42n, 32), pad(TOKEN_MESSENGER_V2, { size: 32 }), pad(TOKEN_MESSENGER_V2, { size: 32 }), u(0, 32), u(2000, 4), u(2000, 4),
    u(1, 4), pad(o.token ?? MONAD_USDC, { size: 32 }), pad(o.recipient ?? HOME, { size: 32 }), u(o.amount ?? AMOUNT, 32), pad(o.sender ?? V4, { size: 32 }), u(0, 32), u(0, 32), u(99, 32),
  ])
const attester = privateKeyToAccount(generatePrivateKey())
const attest = async (m: Hex) => ({ message: m, attestation: await attester.sign({ hash: keccak256(m) }) })

/** The peer: answers per id; `burnAt` is the call (1-based) from which the release is reported burned. */
function peerOf(o: { burned?: { amount?: bigint }; cancelled?: boolean; lose?: number; refuse?: number; code?: string } = {}): ReturnPeer & { asked: string[]; statuses: number } {
  const known = new Map<string, bigint>()
  let lose = o.lose ?? 0
  const p = {
    asked: [] as string[],
    statuses: 0,
    release: async (_r: AccountContext, id: string, amount: bigint): Promise<ReleaseView> => {
      p.asked.push(id)
      if (lose-- > 0) throw new Error('timeout')
      if (o.refuse) throw Object.assign(new Error('refused'), { status: o.refuse, code: o.code ?? 'RELEASE_OPEN' })
      known.set(id, amount)
      return { id, amount: amount.toString(), chainId: 8453, state: 'open' }
    },
    releaseStatus: async (_r: AccountContext, id?: string): Promise<ReleaseView> => {
      p.statuses++
      const amount = id ? known.get(id) : undefined
      if (!id || amount === undefined) return { state: 'none' }
      if (o.cancelled) return { id, amount: amount.toString(), chainId: 8453, state: 'cancelled' }
      if (o.burned) return { id, amount: amount.toString(), chainId: 8453, state: 'burned', burn: { amount: (o.burned.amount ?? amount).toString(), txHash: BURN_TX, block: 777 } }
      return { id, amount: amount.toString(), chainId: 8453, state: 'sending' }
    },
  }
  return p
}

type BaseState = { used: Set<string>; receipts: Map<string, 'success' | 'reverted'> }
function base(st: BaseState): PublicClient {
  return {
    getBlockNumber: async () => 9_000n,
    getGasPrice: async () => 10_000_000n,
    estimateGas: async () => 150_000n,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const s = st.receipts.get(hash)
      return s ? { status: s, blockNumber: 9_001n } : null
    },
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === 'signatureThreshold') return 1n
      if (functionName === 'isEnabledAttester') return (args![0] as string).toLowerCase() === attester.address.toLowerCase()
      if (functionName === 'usedNonces') return st.used.has((args![0] as string).toLowerCase()) ? 1n : 0n
      throw new Error(functionName)
    },
  } as unknown as PublicClient
}

function relayer(st: BaseState, status: 'success' | 'reverted' = 'success'): MonadSender & { sent: Hex[] } {
  const sent: Hex[] = []
  return {
    address: '0x0000000000000000000000000000000000000002',
    sent,
    send: async (tx, _onSent, onSending, onSigned) => {
      const hash = u(sent.length + 1, 32)
      onSending?.(1n, { hash, nonce: sent.length, maxFeePerGas: 10_000_000n })
      onSigned?.(hash, sent.length)
      sent.push(tx.data!)
      st.receipts.set(hash, status)
      return { hash, receipt: { status, blockNumber: 9_001n } as never }
    },
  }
}

function setup(o: { iris?: { message: Hex; attestation: Hex }[]; monadPinned?: boolean; relayerStatus?: 'success' | 'reverted'; noRelayer?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mamoru-return-'))
  let now = T0
  const st: BaseState = { used: new Set(), receipts: new Map() }
  const urls: string[] = []
  const fetcher = async (url: string) => {
    urls.push(url)
    return o.iris ? new Response(JSON.stringify({ messages: o.iris.map((a) => ({ status: 'complete', ...a })) })) : new Response('{}', { status: 404 })
  }
  const rel = o.noRelayer ? null : relayer(st, o.relayerStatus)
  const r = new ReturnHome(dir, base(st), rel, () => (o.monadPinned === false ? null : { v4: V4, usdc: MONAD_USDC }), fetcher as typeof fetch, () => now)
  const j = () => JSON.parse(readFileSync(join(dir, 'return-home.json'), 'utf8')) as { returns: Record<string, ReturnEntry> }
  return { r, st, rel, urls, j, dir, advance: (ms: number) => void (now += ms) }
}

describe('return home (otto/mamoru#278, Base side)', () => {
  test('a request is on disk before the peer is asked; one open return per account; busy while open', async () => {
    const s = setup()
    const p = peerOf()
    const e = await s.r.request('acc-1', HOME, REMOTE, p, AMOUNT, FLOOR)
    expect(s.j().returns[e.id]).toMatchObject({ state: 'requested', amount: AMOUNT.toString(), home: HOME })
    expect(p.asked).toEqual([e.id])
    expect(s.r.busy('acc-1')).toBe(true)
    expect(s.r.inFlight('acc-1')).toBe(0n)
    await expect(s.r.request('acc-1', HOME, REMOTE, p, 1n, FLOOR)).rejects.toThrow('already open')
    await expect(s.r.request('acc-2', HOME, REMOTE, p, 0n, FLOOR)).rejects.toThrow('return of 0')
  })

  test('a lost answer: the tick asks again with the same id; then follows it to burned (in flight) and cancelled', async () => {
    const s = setup()
    const p = peerOf({ lose: 1 })
    const e = await s.r.request('acc-1', HOME, REMOTE, p, AMOUNT, FLOOR)
    await s.r.tick(() => ({ remote: REMOTE, peer: p }))
    expect(p.asked).toEqual([e.id, e.id])
    expect(s.j().returns[e.id]!.state).toBe('requested')
    const burned = setup()
    const pb = peerOf({ burned: { amount: AMOUNT - 5n } })
    const b = await burned.r.request('acc-1', HOME, REMOTE, pb, AMOUNT, FLOOR)
    await burned.r.tick(() => ({ remote: REMOTE, peer: pb }))
    expect(burned.j().returns[b.id]).toMatchObject({ state: 'burned', burn: { amount: (AMOUNT - 5n).toString(), txHash: BURN_TX, block: 777 } })
    expect(burned.r.inFlight('acc-1')).toBe(AMOUNT - 5n)
    const cancelled = setup()
    const pc = peerOf({ cancelled: true })
    const c = await cancelled.r.request('acc-1', HOME, REMOTE, pc, AMOUNT, FLOOR)
    await cancelled.r.tick(() => ({ remote: REMOTE, peer: pc }))
    expect(cancelled.j().returns[c.id]!.state).toBe('cancelled')
    expect(cancelled.r.busy('acc-1')).toBe(false)
  })

  test('a peer reporting a burn above the request is refused (stays requested)', async () => {
    const s = setup()
    const p = peerOf({ burned: { amount: AMOUNT + 1n } })
    const e = await s.r.request('acc-1', HOME, REMOTE, p, AMOUNT, FLOOR)
    await s.r.tick(() => ({ remote: REMOTE, peer: p }))
    expect(s.j().returns[e.id]!.state).toBe('requested')
  })

  const burnedSetup = async (o: Parameters<typeof setup>[0] = {}) => {
    const s = setup(o)
    const p = peerOf({ burned: {} })
    const e = await s.r.request('acc-1', HOME, REMOTE, p, AMOUNT, FLOOR)
    await s.r.tick(() => ({ remote: REMOTE, peer: p }))
    expect(s.j().returns[e.id]!.state).toBe('burned')
    return { ...s, e, p }
  }

  test('burned: waits the first poll, then mints once from the relayer with the attestation of exactly this burn; minted', async () => {
    const s = await burnedSetup({ iris: [await attest(message())] })
    await s.r.tick(() => null)
    expect(s.urls).toHaveLength(0)
    s.advance(RETURN_ATTEST_FIRST_POLL_MS + 1)
    await s.r.tick(() => null)
    expect(s.urls[0]).toContain(`/v2/messages/15?transactionHash=${BURN_TX}`)
    expect(s.rel!.sent).toHaveLength(1)
    expect(s.j().returns[s.e.id]).toMatchObject({ state: 'minted', cctpNonce: u(42n, 32), mintedBlock: '9001' })
    expect(s.r.busy('acc-1')).toBe(false)
    expect(s.r.inFlight('acc-1')).toBe(0n)
  })

  test('an attestation for another recipient, amount, sender, token or route, or not signed by Base attesters: never minted', async () => {
    const forger = privateKeyToAccount(generatePrivateKey())
    const bad = [
      await attest(message({ recipient: V4 })),
      await attest(message({ amount: AMOUNT + 1n })),
      await attest(message({ sender: HOME })),
      await attest(message({ token: V4 })),
      await attest(message({ source: 6 })),
      { message: message(), attestation: await forger.sign({ hash: keccak256(message()) }) },
    ]
    for (const att of bad) {
      const s = await burnedSetup({ iris: [att] })
      s.advance(RETURN_ATTEST_FIRST_POLL_MS + 1)
      await s.r.tick(() => null)
      expect(s.rel!.sent).toHaveLength(0)
      expect(s.j().returns[s.e.id]!.state).toBe('burned')
    }
  })

  test('already used on Base (anyone may mint): minted without a transaction; V4 unpinned on Monad: nothing is minted', async () => {
    const s = await burnedSetup({ iris: [await attest(message())] })
    s.st.used.add(u(42n, 32).toLowerCase())
    s.advance(RETURN_ATTEST_FIRST_POLL_MS + 1)
    await s.r.tick(() => null)
    expect(s.rel!.sent).toHaveLength(0)
    expect(s.j().returns[s.e.id]!.state).toBe('minted')
    const unpinned = await burnedSetup({ iris: [await attest(message())], monadPinned: false })
    unpinned.advance(RETURN_ATTEST_FIRST_POLL_MS + 1)
    await unpinned.r.tick(() => null)
    expect(unpinned.urls).toHaveLength(0)
    expect(unpinned.j().returns[unpinned.e.id]!.state).toBe('burned')
  })

  test('a reverted mint is not sent again at once; a nonce another return holds is never this one', async () => {
    const s = await burnedSetup({ iris: [await attest(message())], relayerStatus: 'reverted' })
    s.advance(RETURN_ATTEST_FIRST_POLL_MS + 1)
    await s.r.tick(() => null)
    expect(s.rel!.sent).toHaveLength(1)
    expect(s.j().returns[s.e.id]).toMatchObject({ state: 'burned', mintReverts: 1 })
    s.advance(RETURN_MINT_PENDING_MS / 2)
    await s.r.tick(() => null)
    expect(s.rel!.sent).toHaveLength(1)
  })

  test('review r2: only a refusal proving the peer holds nothing cancels (400 BAD_REQUEST, 404 NOT_A_REMOTE); a 409 keeps it holding', async () => {
    for (const [status, code] of [[400, 'BAD_REQUEST'], [404, 'NOT_A_REMOTE']] as const) {
      const s = setup()
      const e = await s.r.request('acc-1', HOME, REMOTE, peerOf({ refuse: status, code }), AMOUNT, FLOOR)
      expect(s.j().returns[e.id]).toMatchObject({ state: 'cancelled', note: `refused by the peer: ${status} ${code}` })
      expect(s.r.busy('acc-1')).toBe(false)
      expect(s.r.floor('acc-1')).toBe(0n)
    }
    const open = setup()
    const o = await open.r.request('acc-1', HOME, REMOTE, peerOf({ refuse: 409, code: 'RELEASE_OPEN' }), AMOUNT, FLOOR)
    expect(open.j().returns[o.id]!.state).toBe('requested')
    expect(open.r.busy('acc-1')).toBe(true)
    // Refused on a later re-ask (the peer did not know it, then says not a remote): cancelled too.
    const later = setup()
    const l = await later.r.request('acc-1', HOME, REMOTE, peerOf({ lose: 1 }), AMOUNT, FLOOR)
    await later.r.tick(() => ({ remote: REMOTE, peer: peerOf({ refuse: 404, code: 'NOT_A_REMOTE' }) }))
    expect(later.j().returns[l.id]!.state).toBe('cancelled')
  })

  test('review r2: the real RemotePeer throws a refusal with the status and code ReturnHome reads', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ code: 'NOT_A_REMOTE', error: 'no' }), { status: 404 })
    const peer = new RemotePeer(143, 'http://peer', 'secret', fetchFn as never)
    const s = setup()
    const e = await s.r.request('acc-1', HOME, REMOTE, peer, AMOUNT, FLOOR)
    expect(s.j().returns[e.id]).toMatchObject({ state: 'cancelled', note: 'refused by the peer: 404 NOT_A_REMOTE' })
  })

  test('review r1: until the burn is known the remote value floor is the value asked at; burned or closed, none', async () => {
    const s = setup()
    const p = peerOf({ burned: {} })
    await s.r.request('acc-1', HOME, REMOTE, p, AMOUNT, FLOOR)
    expect(s.r.floor('acc-1')).toBe(FLOOR)
    await s.r.tick(() => ({ remote: REMOTE, peer: p }))
    expect(s.r.floor('acc-1')).toBe(0n)
    expect(s.r.inFlight('acc-1')).toBe(AMOUNT)
  })

  test('review r1: a mint refused before it is signed (gas above the ceiling) does not count against the day', async () => {
    const s = await burnedSetup({ iris: [await attest(message())] })
    const rel = s.rel as unknown as { send: MonadSender['send'] }
    const send = rel.send
    rel.send = async (tx, a, onSending, onSigned) => send(tx, a, (w, x) => onSending?.(w, { ...x, maxFeePerGas: 10n ** 12n }), onSigned)
    s.advance(RETURN_ATTEST_FIRST_POLL_MS + 1)
    await s.r.tick(() => null)
    expect(s.rel!.sent).toHaveLength(0)
    const journal = JSON.parse(readFileSync(join(s.dir, 'return-home.json'), 'utf8')) as { mintDays: Record<string, { n: number }> }
    expect(Object.values(journal.mintDays).reduce((n, d) => n + d.n, 0)).toBe(0)
  })
})
