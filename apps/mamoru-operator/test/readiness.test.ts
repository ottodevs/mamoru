// otto/mamoru#348 (spec 010 A1): the readiness state machine (readiness.ts) on a fake pair of chains: announce -> attest
// -> relay -> ready, a restart between any two steps, Circle pending, down or wrong, a relay that reverts or is refused,
// an announce that never ran, the day's cap, and "already ready" (nothing sent). Then the announcing peer's idempotence,
// the message checks and the log reader.
import { describe, expect, test } from 'bun:test'
import { concat, encodeAbiParameters, getAddress, pad, toHex, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { RemotePeer } from '../src/remote-peer.ts'
import { decodeReadinessMessage, peerAnnounce, READY_ATTEST_GIVEUP_MS, READY_RELAY_TRIES, READY_ROUNDS_PER_DAY, readinessMismatch, readyBackoffMs, stepReady, userOpOutcome, type AnnounceRecord, type OpOutcome, type ReadyFlow, type ReadyPorts, type Rejection, type SentOp } from '../src/readiness.ts'

const V4: Address = '0xCd278c96dC14d59ded497bE63c5c8E2De456f2d8'
const HOME: Address = '0x00000000000000000000000000000000000a0e01'
const REMOTE: Address = getAddress('0x00000000000000000000000000000000000b0e02')
const OH: Hex = `0x${'0b'.repeat(32)}`
const T0 = Date.parse('2026-11-04T10:00:00Z')
const h = (n: number): Hex => pad(toHex(n), { size: 32 })

/** A V4 readiness message as Circle attests it: MessageV2 header (finality executed set) and (home, safe, ownersHash). */
function readinessMessage(o: Partial<{ source: number; destination: number; sender: Address; recipient: Address; caller: Hex; minFinality: number; executed: number; home: Address; safe: Address }> = {}): Hex {
  const u = (v: bigint | number, size: number) => toHex(v, { size })
  const w = (a: Address) => pad(a, { size: 32 })
  const header = concat([u(1, 4), u(o.source ?? 15, 4), u(o.destination ?? 6, 4), h(77), w(o.sender ?? V4), w(o.recipient ?? V4), o.caller ?? pad('0x00', { size: 32 }), u(o.minFinality ?? 2000, 4), u(o.executed ?? 2000, 4)])
  return concat([header, encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [o.home ?? HOME, o.safe ?? REMOTE, OH])])
}

/** Two chains in memory: what the ports see, and what was sent. */
class World {
  ready = false
  announces = 0
  relays = 0
  /** The announce: our op (and how it ends), or the peer's transaction directly. */
  announceAs: 'op' | 'tx' | 'wait' = 'op'
  announceEnds: OpOutcome = { txHash: h(1), success: true }
  /** Circle: complete messages for a source tx, null when down. */
  iris: { message: Hex; attestation: Hex }[] | null = []
  rejectWhy: Rejection | null = null
  relayAs: 'op' | 'wait' | 'fault' | 'throwAfterSign' = 'op'
  /** What was written, in order (`persist`), and what the bundler saw: the write always comes first. */
  log: string[] = []
  relayEnds: OpOutcome = { txHash: h(2), success: true }
  /** A successful relay makes it ready (V4's handler writes it), unless the owners changed since. */
  relayMakesReady = true
  againSeen: (Hex | undefined)[] = []
  ports(): ReadyPorts {
    return {
      isReady: async () => this.ready,
      announce: async (again, onSigned) => {
        this.againSeen.push(again)
        if (this.announceAs === 'wait') return { wait: 'lane 1 busy' }
        this.announces++
        if (this.announceAs === 'tx') return { txHash: h(100 + this.announces) }
        const op = { userOpHash: h(200 + this.announces), fromBlock: '10', t: String(T0 / 1000) }
        await onSigned(op)
        this.log.push(`bundler ${op.userOpHash}`)
        return { op }
      },
      outcome: async (side) => {
        if (side === 'source') return this.announceEnds
        const o = this.relayEnds
        if (o !== 'pending' && o !== 'gone' && o.success && this.relayMakesReady) this.ready = true
        return o
      },
      attestations: async () => this.iris,
      reject: async () => this.rejectWhy,
      relay: async (_m, _a, onSigned) => {
        if (this.relayAs === 'wait') return { wait: 'another op in flight' }
        if (this.relayAs === 'fault') return { fault: 'simulation refused' }
        this.relays++
        const op = { userOpHash: h(300 + this.relays), fromBlock: '20', t: String(T0 / 1000) }
        await onSigned(op)
        if (this.relayAs === 'throwAfterSign') throw new Error('bundler timed out')
        this.log.push(`bundler ${op.userOpHash}`)
        return { op }
      },
      persist: (f) => {
        this.log.push(`persist ${f.state} ${f.state === 'relayed' ? f.relayed?.userOpHash : f.announced?.userOpHash}`)
      },
    }
  }
}

/** Steps the flow as the operator's tick does, the record through JSON each time (a restart between any two steps). */
async function run(w: World, flow: ReadyFlow | undefined, at: number, steps = 1): Promise<{ flow: ReadyFlow | undefined; ready: boolean; notes: string[] }> {
  let f = flow
  let ready = false
  const notes: string[] = []
  for (let i = 0; i < steps; i++) {
    const s = await stepReady(f === undefined ? undefined : (JSON.parse(JSON.stringify(f)) as ReadyFlow), w.ports(), at)
    f = s.flow
    ready = s.ready
    if (s.note) notes.push(s.note)
    if (ready) break
  }
  return { flow: f, ready, notes }
}

const msg = readinessMessage()
const ATT: Hex = `0x${'aa'.repeat(65)}`

describe('#348 readiness flow: the happy path, a restart between every step', () => {
  test('announce -> announced -> attesting (pending, then complete) -> relay -> relayed -> ready; one announce, one relay', async () => {
    const w = new World()
    let r = await run(w, undefined, T0)
    expect(r.flow?.state).toBe('announced')
    expect(w.announces).toBe(1)
    r = await run(w, r.flow, T0 + 60_000)
    expect(r.flow?.state).toBe('attesting')
    expect(r.flow?.srcTx).toBe(h(1))
    // Circle has nothing yet: nothing moves, nothing is sent again
    r = await run(w, r.flow, T0 + 120_000)
    expect(r.flow?.state).toBe('attesting')
    w.iris = [{ message: msg, attestation: ATT }]
    r = await run(w, r.flow, T0 + 180_000)
    expect(r.flow?.state).toBe('relay')
    expect([r.flow?.message, r.flow?.attestation]).toEqual([msg, ATT])
    r = await run(w, r.flow, T0 + 240_000)
    expect(r.flow?.state).toBe('relayed')
    r = await run(w, r.flow, T0 + 300_000)
    expect(r.ready).toBe(true)
    expect(r.flow).toBeUndefined()
    expect([w.announces, w.relays]).toEqual([1, 1])
  })

  test('a peer that answers with its transaction skips `announced`', async () => {
    const w = new World()
    w.announceAs = 'tx'
    const r = await run(w, undefined, T0)
    expect(r.flow?.state).toBe('attesting')
    expect(r.flow?.srcTx).toBe(h(101))
  })

  test("the peer's announce still on its way: asked again after READY_PENDING_POLL_MS, no failure, no round unless sent", async () => {
    const w = new World()
    const ports = w.ports()
    let n = 0
    ports.announce = async () => (++n < 3 ? { pending: 'ANNOUNCE_SENT' } : { txHash: h(7) })
    let s = await stepReady(undefined, ports, T0)
    expect([s.flow?.state, s.flow?.fails, s.flow?.nextAt, s.flow?.rounds]).toEqual(['announce', 0, new Date(T0 + 60_000).toISOString(), 0])
    s = await stepReady(s.flow, ports, T0 + 1)
    expect(s.changed).toBe(false)
    expect(n).toBe(1)
    s = await stepReady(s.flow, ports, T0 + 60_000)
    s = await stepReady(s.flow, ports, T0 + 120_000)
    expect([s.flow?.state, s.flow?.srcTx, s.flow?.rounds]).toEqual(['attesting', h(7), 1])
  })

  test('already ready: nothing is announced or relayed, from no flow or from any state (also after a restart)', async () => {
    const w = new World()
    w.ready = true
    expect((await run(w, undefined, T0)).ready).toBe(true)
    for (const state of ['announce', 'announced', 'attesting', 'relay', 'relayed'] as const) {
      const r = await stepReady({ state, since: new Date(T0).toISOString(), fails: 0, day: '2026-11-04', rounds: 1, announced: { userOpHash: h(9), fromBlock: '1', t: '1' }, srcTx: h(1), message: msg, attestation: ATT, relayed: { userOpHash: h(8), fromBlock: '1', t: '1' } }, w.ports(), T0)
      expect([r.ready, r.flow, r.changed]).toEqual([true, undefined, true])
    }
    expect([w.announces, w.relays]).toEqual([0, 0])
  })

  test('an op still out stays where it is, a restart included: `announced` and `relayed` re-read, never re-sent', async () => {
    const w = new World()
    w.announceEnds = 'pending'
    let r = await run(w, undefined, T0, 4)
    expect(r.flow?.state).toBe('announced')
    expect(w.announces).toBe(1)
    w.announceEnds = { txHash: h(1), success: true }
    w.iris = [{ message: msg, attestation: ATT }]
    w.relayEnds = 'pending'
    r = await run(w, r.flow, T0 + 60_000, 6)
    expect(r.flow?.state).toBe('relayed')
    expect([w.announces, w.relays]).toEqual([1, 1])
  })
})

describe('#348 readiness flow: Circle', () => {
  test('iris down: backoff, the state kept, then it goes on', async () => {
    const w = new World()
    w.announceAs = 'tx'
    let r = await run(w, undefined, T0)
    w.iris = null
    r = await run(w, r.flow, T0 + 1_000)
    expect(r.flow?.state).toBe('attesting')
    expect(r.flow?.fails).toBe(1)
    expect(Date.parse(r.flow!.nextAt!)).toBe(T0 + 1_000 + readyBackoffMs(1))
    // inside the backoff nothing is asked
    w.iris = [{ message: msg, attestation: ATT }]
    r = await run(w, r.flow, T0 + 2_000)
    expect(r.flow?.state).toBe('attesting')
    r = await run(w, r.flow, T0 + 2_000 + readyBackoffMs(1))
    expect(r.flow?.state).toBe('relay')
    expect(r.flow?.fails).toBe(0)
  })

  test('an attestation that is not this readiness (wrong signers, wrong message) is ignored; never relayed', async () => {
    const w = new World()
    w.announceAs = 'tx'
    w.iris = [{ message: msg, attestation: ATT }]
    w.rejectWhy = { why: 'not signed by the attesters enabled on Base' }
    let r = await run(w, undefined, T0, 3)
    expect(r.flow?.state).toBe('attesting')
    expect(r.flow?.why).toContain('attesters')
    expect(w.relays).toBe(0)
    // and past the give-up time, announced again naming the unusable transaction
    r = await run(w, r.flow, T0 + READY_ATTEST_GIVEUP_MS + 1)
    expect(r.flow?.state).toBe('announce')
    expect(r.flow?.again).toBe(h(101))
    r = await run(w, r.flow, T0 + READY_ATTEST_GIVEUP_MS + 1 + readyBackoffMs(1))
    expect(w.againSeen.at(-1)).toBe(h(101))
    expect(w.announces).toBe(2)
  })

  test('Circle never attests: announced again after READY_ATTEST_GIVEUP_MS', async () => {
    const w = new World()
    w.announceAs = 'tx'
    let r = await run(w, undefined, T0)
    r = await run(w, r.flow, T0 + READY_ATTEST_GIVEUP_MS - 1)
    expect(r.flow?.state).toBe('attesting')
    r = await run(w, r.flow, T0 + READY_ATTEST_GIVEUP_MS + 1)
    expect(r.flow?.state).toBe('announce')
  })
})

describe('#348 readiness flow: failures', () => {
  test('a relay that reverts is relayed again, then after READY_RELAY_TRIES the message is dropped and announced again', async () => {
    const w = new World()
    w.announceAs = 'tx'
    w.iris = [{ message: msg, attestation: ATT }]
    w.relayEnds = { txHash: h(2), success: false }
    let r = await run(w, undefined, T0, 2)
    expect(r.flow?.state).toBe('relay')
    let at = T0
    for (let i = 1; i < READY_RELAY_TRIES; i++) {
      r = await run(w, r.flow, (at += 3_600_000)) // relay
      expect(r.flow?.state).toBe('relayed')
      r = await run(w, r.flow, (at += 1)) // reverted
      expect(r.flow?.state).toBe('relay')
      expect(r.flow?.relayTries).toBe(i)
      expect(r.flow?.message).toBe(msg)
    }
    r = await run(w, r.flow, (at += 3_600_000))
    r = await run(w, r.flow, (at += 1))
    expect(r.flow?.state).toBe('announce')
    expect(r.flow?.message).toBeUndefined()
    expect(r.flow?.again).toBe(h(101))
    expect(w.relays).toBe(READY_RELAY_TRIES)
  })

  test('a relay the simulation refuses (a message fault) counts the same; never sent', async () => {
    const w = new World()
    w.announceAs = 'tx'
    w.iris = [{ message: msg, attestation: ATT }]
    w.relayAs = 'fault'
    let r = await run(w, undefined, T0, 2)
    let at = T0
    for (let i = 0; i < READY_RELAY_TRIES; i++) r = await run(w, r.flow, (at += 3_600_000))
    expect(r.flow?.state).toBe('announce')
    expect(w.relays).toBe(0)
  })

  test('a relay op that never ran (gone) is relayed again', async () => {
    const w = new World()
    w.announceAs = 'tx'
    w.iris = [{ message: msg, attestation: ATT }]
    w.relayEnds = 'gone'
    let r = await run(w, undefined, T0, 4)
    expect(r.flow?.state).toBe('relay')
    expect(r.flow?.why).toBe('the relay op never ran')
  })

  test('relayed and ran, yet not ready (the owners changed since): announced again', async () => {
    const w = new World()
    w.announceAs = 'tx'
    w.iris = [{ message: msg, attestation: ATT }]
    w.relayMakesReady = false
    const r = await run(w, undefined, T0, 4)
    expect(r.flow?.state).toBe('announce')
    expect(r.flow?.why).toContain('yet not ready')
  })

  test('an announce op that reverted or never ran is announced again, after a backoff', async () => {
    for (const end of [{ txHash: h(1), success: false } as const, 'gone' as const]) {
      const w = new World()
      w.announceEnds = end
      let r = await run(w, undefined, T0, 2)
      expect(r.flow?.state).toBe('announce')
      expect(r.flow?.announced).toBeUndefined()
      r = await run(w, r.flow, T0 + 1)
      expect(w.announces).toBe(1)
      r = await run(w, r.flow, T0 + readyBackoffMs(1))
      expect(w.announces).toBe(2)
    }
  })

  test('an announce not sent (lane busy, gas over the ceiling) backs off and is not counted as a round', async () => {
    const w = new World()
    w.announceAs = 'wait'
    const r = await run(w, undefined, T0)
    expect([r.flow?.state, r.flow?.rounds, r.flow?.fails]).toEqual(['announce', 0, 1])
  })

  test(`at most ${READY_ROUNDS_PER_DAY} announce rounds a day, then it waits for the next UTC day`, async () => {
    const w = new World()
    w.announceEnds = 'gone'
    let r: Awaited<ReturnType<typeof run>> = { flow: undefined, ready: false, notes: [] }
    let at = T0
    for (let i = 0; i < 2 * READY_ROUNDS_PER_DAY + 2; i++) r = await run(w, r.flow, (at += 3_600_000 / 4))
    expect(w.announces).toBe(READY_ROUNDS_PER_DAY)
    expect(r.flow?.nextAt).toBe('2026-11-05T00:00:00.000Z')
    r = await run(w, r.flow, Date.parse('2026-11-05T00:00:01Z'))
    expect(w.announces).toBe(READY_ROUNDS_PER_DAY + 1)
  })
})

describe('#348 the announcing peer (Monad): idempotent', () => {
  const op: SentOp = { userOpHash: h(5), fromBlock: '1', t: '1' }
  const ports = (o: { outcome?: OpOutcome; ready?: boolean; sends?: { n: number }; wait?: boolean; log?: string[]; throwAfterSign?: boolean }) => ({
    ...(o.ready !== undefined ? { alreadyReady: async () => o.ready! } : {}),
    send: async (onSigned: (op: SentOp) => Promise<void> | void) => {
      if (o.sends) o.sends.n++
      if (o.wait) return { wait: 'ANNOUNCE_NOT_SENT' }
      await onSigned(op)
      if (o.throwAfterSign) throw new Error('bundler timed out')
      o.log?.push('bundler')
      return { op }
    },
    outcome: async () => o.outcome ?? 'pending',
    persist: (r: AnnounceRecord) => void o.log?.push(`persist ${r.op?.userOpHash ?? ''} n=${r.n}`),
  })

  test('first ask sends; while out it is read, never sent beside; once it ran its tx is answered again and again', async () => {
    const sends = { n: 0 }
    let a = await peerAnnounce(undefined, undefined, ports({ sends }), T0)
    expect(a.answer).toEqual({ state: 'pending', code: 'ANNOUNCE_SENT' })
    let rec = JSON.parse(JSON.stringify(a.record)) as AnnounceRecord
    a = await peerAnnounce(rec, undefined, ports({ sends }), T0 + 1)
    expect(a.answer).toEqual({ state: 'pending', code: 'ANNOUNCE_PENDING' })
    a = await peerAnnounce(rec, undefined, ports({ sends, outcome: { txHash: h(6), success: true } }), T0 + 2)
    expect(a.answer).toEqual({ state: 'announced', txHash: h(6) })
    rec = JSON.parse(JSON.stringify(a.record)) as AnnounceRecord
    for (let i = 0; i < 3; i++) expect((await peerAnnounce(rec, undefined, ports({ sends }), T0 + 3)).answer).toEqual({ state: 'announced', txHash: h(6) })
    // `again` naming another transaction changes nothing
    expect((await peerAnnounce(rec, h(99), ports({ sends }), T0 + 3)).answer).toEqual({ state: 'announced', txHash: h(6) })
    expect(sends.n).toBe(1)
    // `again` naming this one: a new announce
    a = await peerAnnounce(rec, h(6), ports({ sends }), T0 + 4)
    expect(a.answer).toEqual({ state: 'pending', code: 'ANNOUNCE_SENT' })
    expect(sends.n).toBe(2)
  })

  test('already ready there: nothing sent', async () => {
    const sends = { n: 0 }
    expect((await peerAnnounce(undefined, undefined, ports({ sends, ready: true }), T0)).answer).toEqual({ state: 'ready' })
    expect(sends.n).toBe(0)
  })

  test(`at most ${READY_ROUNDS_PER_DAY} sends a day`, async () => {
    const rec: AnnounceRecord = { txHash: h(7), day: '2026-11-04', n: READY_ROUNDS_PER_DAY, at: new Date(T0).toISOString() }
    expect((await peerAnnounce(rec, h(7), ports({}), T0)).answer).toEqual({ state: 'pending', code: 'ANNOUNCE_DAILY_LIMIT' })
    expect((await peerAnnounce(rec, h(7), ports({}), T0 + 86_400_000)).answer).toEqual({ state: 'pending', code: 'ANNOUNCE_SENT' })
  })
})

describe('review r1 of #253, P1-4: the peer backs off, counts every op it sent, and keeps its last good transaction', () => {
  const op: SentOp = { userOpHash: h(5), fromBlock: '1', t: '1' }
  const mk = (o: { outcome?: OpOutcome; sends: { n: number }; wait?: boolean }) => ({
    send: async (onSigned: (op: SentOp) => Promise<void> | void) => {
      o.sends.n++
      if (o.wait) return { wait: 'ANNOUNCE_NOT_SENT' }
      await onSigned(op)
      return { op }
    },
    outcome: async () => o.outcome ?? 'pending',
    persist: () => {},
  })
  test('an op that never ran or reverted: backed off (not resent at once), counted in n; resent after the backoff', async () => {
    for (const end of ['gone' as const, { txHash: h(8), success: false }]) {
      const sends = { n: 0 }
      const rec: AnnounceRecord = { op, txHash: h(6), day: '2026-11-04', n: 1, at: new Date(T0).toISOString() }
      let a = await peerAnnounce(rec, h(6), mk({ sends, outcome: end }), T0)
      expect(a.answer).toEqual({ state: 'pending', code: 'ANNOUNCE_BACKOFF' })
      expect(sends.n).toBe(0)
      expect([a.record?.n, a.record?.txHash, a.record?.fails, a.record?.op]).toEqual([1, h(6), 1, undefined])
      expect(Date.parse(a.record!.nextAt!)).toBe(T0 + readyBackoffMs(1))
      // inside the backoff, asked again: nothing sent
      a = await peerAnnounce(a.record, h(6), mk({ sends }), T0 + 1)
      expect(sends.n).toBe(0)
      // after it: sent, n counts it, the last good transaction is kept while it is out
      a = await peerAnnounce(a.record, h(6), mk({ sends }), T0 + readyBackoffMs(1))
      expect(a.answer).toEqual({ state: 'pending', code: 'ANNOUNCE_SENT' })
      expect([sends.n, a.record?.n, a.record?.txHash]).toEqual([1, 2, h(6)])
    }
  })
  test('an op not sent (gas, lane busy) backs off too', async () => {
    const sends = { n: 0 }
    const a = await peerAnnounce(undefined, undefined, mk({ sends, wait: true }), T0)
    expect(a.answer).toEqual({ state: 'pending', code: 'ANNOUNCE_NOT_SENT' })
    expect([a.record?.fails, a.record?.n]).toEqual([1, 0])
    expect((await peerAnnounce(a.record, undefined, mk({ sends }), T0 + 1)).answer).toEqual({ state: 'pending', code: 'ANNOUNCE_BACKOFF' })
  })
  test('the ops a day are capped across gone ones too', async () => {
    const sends = { n: 0 }
    let rec: AnnounceRecord | undefined
    let at = T0
    for (let i = 0; i < 3 * READY_ROUNDS_PER_DAY; i++) {
      rec = (await peerAnnounce(rec, undefined, mk({ sends, outcome: 'gone' }), (at += 3_600_000 / 2))).record
    }
    expect(sends.n).toBe(READY_ROUNDS_PER_DAY)
  })
  test("Base counts the peer's send as a round", async () => {
    const w = new World()
    const ports = w.ports()
    ports.announce = async () => ({ pending: 'ANNOUNCE_SENT', sent: true })
    const s = await stepReady(undefined, ports, T0)
    expect([s.flow?.rounds, s.flow?.fails]).toEqual([1, 0])
    expect(Date.parse(s.flow!.nextAt!)).toBe(T0 + 60_000)
  })
})

describe('review r1 of #253, P1-2: an op is on disk before it leaves this host', () => {
  test('stepReady writes `announced` / `relayed` with the op before the bundler sees it', async () => {
    const w = new World()
    w.iris = [{ message: msg, attestation: ATT }]
    let r = await run(w, undefined, T0, 3)
    expect(r.flow?.state).toBe('relay')
    r = await run(w, r.flow, T0)
    expect(w.log).toEqual([`persist announced ${h(201)}`, `bundler ${h(201)}`, `persist relayed ${h(301)}`, `bundler ${h(301)}`])
  })
  test('a send that throws after the write is the op sent: `relayed`, read back next step, never sent again', async () => {
    const w = new World()
    w.announceAs = 'tx'
    w.iris = [{ message: msg, attestation: ATT }]
    w.relayAs = 'throwAfterSign'
    let r = await run(w, undefined, T0, 3)
    expect(r.flow?.state).toBe('relayed')
    expect(r.flow?.relayed?.userOpHash).toBe(h(301))
    w.relayEnds = 'pending'
    r = await run(w, r.flow, T0 + 1, 3)
    expect(w.relays).toBe(1)
  })
  test('the peer writes its op before the bundler sees it; a throw after that is the op sent', async () => {
    const log: string[] = []
    const op: SentOp = { userOpHash: h(5), fromBlock: '1', t: '1' }
    const send = (throws: boolean) => async (onSigned: (o: SentOp) => Promise<void> | void) => {
      await onSigned(op)
      if (throws) throw new Error('bundler timed out')
      log.push('bundler')
      return { op }
    }
    const persist = (r: AnnounceRecord) => void log.push(`persist ${r.op?.userOpHash} n=${r.n}`)
    await peerAnnounce(undefined, undefined, { send: send(false), outcome: async () => 'pending', persist }, T0)
    expect(log).toEqual([`persist ${h(5)} n=1`, 'bundler'])
    const a = await peerAnnounce(undefined, undefined, { send: send(true), outcome: async () => 'pending', persist }, T0)
    expect(a.answer).toEqual({ state: 'pending', code: 'ANNOUNCE_SENT' })
    expect(a.record?.op?.userOpHash).toBe(h(5))
  })
})

describe('review r1 of #253, P1-1: only message faults count against the message', () => {
  test('a relay that waits (another op in flight, prefund short, gas, lane busy) backs off for ever, never drops the message', async () => {
    const w = new World()
    w.announceAs = 'tx'
    w.iris = [{ message: msg, attestation: ATT }]
    w.relayAs = 'wait'
    let r = await run(w, undefined, T0, 2)
    let at = T0
    for (let i = 0; i < 4 * READY_RELAY_TRIES; i++) r = await run(w, r.flow, (at += 3_600_000))
    expect(r.flow?.state).toBe('relay')
    expect(r.flow?.message).toBe(msg)
    expect(r.flow?.relayTries ?? 0).toBe(0)
    expect(w.announces).toBe(1)
    // then it can be sent: it goes on with the same message
    w.relayAs = 'op'
    r = await run(w, r.flow, (at += 3_600_000), 2)
    expect(r.ready).toBe(true)
  })
  test('waits and faults mixed: only the faults count', async () => {
    const w = new World()
    w.announceAs = 'tx'
    w.iris = [{ message: msg, attestation: ATT }]
    let r = await run(w, undefined, T0, 2)
    let at = T0
    for (const kind of ['fault', 'wait', 'wait', 'fault', 'wait'] as const) {
      w.relayAs = kind
      r = await run(w, r.flow, (at += 3_600_000))
    }
    expect([r.flow?.state, r.flow?.relayTries]).toEqual(['relay', 2])
    w.relayAs = 'fault'
    r = await run(w, r.flow, (at += 3_600_000))
    expect(r.flow?.state).toBe('announce')
  })
})

describe('review r1 of #253, P1-3: a stale owners hash is never relayed', () => {
  test('stepReady: a stale attestation restarts the round at once (again = its tx), no relay', async () => {
    const w = new World()
    w.announceAs = 'tx'
    w.iris = [{ message: msg, attestation: ATT }]
    w.rejectWhy = { why: 'owners hash 0x0b.., V4 requires 0x0c..', stale: true }
    const r = await run(w, undefined, T0, 2)
    expect([r.flow?.state, r.flow?.again, r.flow?.message]).toEqual(['announce', h(101), undefined])
    expect(w.relays).toBe(0)
  })
})

describe('#348 the readiness message', () => {
  const want = { source: 15, destination: 6, v4: V4, home: HOME, safe: REMOTE, ownersHash: OH }
  test('decodes the header and the body (home, safe, ownersHash)', () => {
    const d = decodeReadinessMessage(msg)
    expect([d.sourceDomain, d.destinationDomain, d.minFinality, d.finalityExecuted, d.home, d.safe, d.ownersHash]).toEqual([15, 6, 2000, 2000, HOME, REMOTE, OH])
    expect(readinessMismatch(msg, want)).toBeNull()
  })
  test('refused: other domains, not V4 to V4, a destination caller, Fast finality, another Safe, not a readiness body', () => {
    expect(readinessMismatch(readinessMessage({ source: 6, destination: 0 }), want)?.why).toContain('domains')
    expect(readinessMismatch(readinessMessage({ sender: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' }), want)?.why).toBe('not from V4 to V4')
    expect(readinessMismatch(readinessMessage({ caller: pad('0x01', { size: 32 }) }), want)?.why).toBe('destination caller set')
    expect(readinessMismatch(readinessMessage({ executed: 1000 }), want)?.why).toContain('finality')
    expect(readinessMismatch(readinessMessage({ safe: HOME }), want)?.why).toContain('for')
    expect(readinessMismatch(concat([msg, '0x00']), want)?.why).toContain('length')
    for (const m of [readinessMessage({ source: 6, destination: 0 }), readinessMessage({ safe: HOME })]) expect(readinessMismatch(m, want)?.stale).toBeUndefined()
  })
  test('P1-3: another owners hash than the one V4 requires now is stale', () => {
    const r = readinessMismatch(msg, { ...want, ownersHash: `0x${'0c'.repeat(32)}` })
    expect(r?.stale).toBe(true)
    expect(r?.why).toContain('owners hash')
  })
})

describe('#348 reading a sent op back from the EntryPoint logs', () => {
  const op: SentOp = { userOpHash: h(5), fromBlock: '100', t: '1000' }
  const client = (logs: { args: { userOpHash: Hex; success: boolean }; transactionHash: Hex }[], head: { number: bigint; timestamp: bigint }, calls: { from: bigint; to: bigint }[] = []) =>
    ({
      getBlock: async () => head,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => (calls.push({ from: fromBlock, to: toBlock }), logs),
    }) as never
  test('ran: its transaction and outcome', async () => {
    expect(await userOpOutcome(client([{ args: { userOpHash: h(5), success: false }, transactionHash: h(9) }], { number: 110n, timestamp: 1010n }), V4, op, { expiresAt: 1300n })).toEqual({ txHash: h(9), success: false })
  })
  test('not found inside its window: pending; past it: gone; searched in chunks, never past maxBlocks', async () => {
    expect(await userOpOutcome(client([], { number: 110n, timestamp: 1200n }), V4, op, { expiresAt: 1300n })).toBe('pending')
    const calls: { from: bigint; to: bigint }[] = []
    expect(await userOpOutcome(client([], { number: 5_000n, timestamp: 9_000n }, calls), V4, op, { expiresAt: 1300n, chunk: 100n, maxBlocks: 250n })).toBe('gone')
    expect(calls).toEqual([{ from: 100n, to: 199n }, { from: 200n, to: 299n }, { from: 300n, to: 350n }])
  })
})

describe('#348 RemotePeer.announce (POST remote-announce, signed like every peer call)', () => {
  const ctx = { accountKey: 'k@143', chainId: 143, address: REMOTE, owners: [], saltNonce: '0', passkey: { x: '0x1', y: '0x2' } } as never
  const peer = (status: number, body: unknown, seen: { url?: string; body?: string }[] = []) =>
    new RemotePeer(143, 'http://peer', 'secret', async (url, init) => (seen.push({ url, body: init.body as string }), new Response(JSON.stringify(body), { status })))
  test('announced with its transaction, ready, or pending with the code; `again` sent only when named', async () => {
    const seen: { url?: string; body?: string }[] = []
    expect(await peer(200, { state: 'announced', txHash: h(3) }, seen).announce(ctx)).toEqual({ state: 'announced', txHash: h(3) })
    expect(seen[0]!.url).toBe('http://peer/api/accounts/k%40143/remote-announce')
    expect(seen[0]!.body).toBe('{}')
    await peer(200, { state: 'pending', code: 'ANNOUNCE_SENT' }, seen).announce(ctx, h(3))
    expect(JSON.parse(seen[1]!.body!)).toEqual({ again: h(3) })
    expect(await peer(200, { state: 'ready' }).announce(ctx)).toEqual({ state: 'ready' })
    expect(await peer(200, { state: 'pending', code: 'ANNOUNCE_PENDING' }).announce(ctx)).toEqual({ state: 'pending', code: 'ANNOUNCE_PENDING' })
    expect(await peer(404, { code: 'NOT_A_REMOTE' }).announce(ctx)).toEqual({ state: 'pending', code: 'NOT_A_REMOTE' })
    expect(await peer(200, { state: 'announced', txHash: '0x12' }).announce(ctx)).toEqual({ state: 'pending', code: 'HTTP_200' })
  })
})
