// otto/mamoru#428 (spec 014, RH-11; SCN-RH-11, SCN-RH-12): the Base-side fence of a return home. Before the Monad operator
// prepares the owner's burn, the Base operator fences the account under the lock its bridge sender holds: from then on no
// bridge to Monad is journaled (so none is signed), and the return waits while one signed earlier is not terminal.
//
// The journal's own words: a userOp the bundler dropped is still 'sending' here (it may land) until the chain proves it
// cannot: its nonce spent at a safe block without it, or (behind the fence) its session over with the nonce unspent. Only
// then is it 'dropped' in the journal, which is terminal (the spec's `dead`).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex, PublicClient } from 'viem'
import { POLICIES } from '@mamoru/policy'
import { baseRegistry } from '@mamoru/registry'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import { MonadBridge, type BridgeBurn } from '../src/bridge-monad.ts'
import { HttpError, Operator } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'
import { ctx, quiet } from './owner-world.ts'

const KEY = ctx.accountKey
const ACCOUNT = ctx.address as Hex
const MONAD_SAFE = '0x00000000000000000000000000000000000000ee' as const
const UOP = `0x${'11'.repeat(32)}` as Hex
const T0 = Date.parse('2026-11-23T10:00:00Z')

const signing = (over: Partial<BridgeSigning> = {}): BridgeSigning => ({
  opId: 'op-1', account: ACCOUNT, recipient: MONAD_SAFE, depositor: ACCOUNT, chainId: 143, pool: 'pool:WMON/USDC/3000', bucket: 'growth', amount: 1_500_000_000n, destinationDomain: 15,
  userOpHash: UOP, nonceKey: 0n, nonce: 7n, prepareBlock: 1_000n, ...over,
})
const burn = (o: Partial<BridgeBurn>): BridgeBurn => ({
  id: UOP, accountKey: KEY, account: ACCOUNT, recipient: MONAD_SAFE, opId: 'op-1', chainId: 143, destinationDomain: 15, bucket: 'growth', pool: 'pool:WMON/USDC/3000', amount: '1500000000', state: 'sending',
  at: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), nonceKey: '0', nonce: '7', fromBlock: '1000', ...o,
})

/** Base at a safe block: the EntryPoint nonce of the burn's key there, and no UserOperationEvent of it anywhere. */
const baseAt = (o: { safe: bigint; timestamp: bigint; nonce: bigint }): PublicClient =>
  ({
    getBlock: async () => ({ number: o.safe, timestamp: o.timestamp }),
    getLogs: async () => [],
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getNonce') return o.nonce
      throw new Error(functionName)
    },
  }) as unknown as PublicClient

function bridgeOf(journal: Record<string, unknown> = {}, base: PublicClient = baseAt({ safe: 2_000n, timestamp: 1_800_000_000n, nonce: 7n })) {
  const dir = mkdtempSync(join(tmpdir(), 'mamoru-fence-'))
  if (Object.keys(journal).length) writeFileSync(join(dir, 'bridge-monad.json'), JSON.stringify(journal))
  const make = () => new MonadBridge(dir, base, {} as PublicClient, null, undefined, () => T0)
  return { dir, bridge: make(), again: make, file: () => JSON.parse(readFileSync(join(dir, 'bridge-monad.json'), 'utf8')) as { fences: Record<string, { at: string }>; burns: Record<string, BridgeBurn> } }
}

describe('SCN-RH-11: every bridge to Monad that is not terminal holds the return', () => {
  const sleeveAt = (block: string) => ({ sleeves: { [KEY]: { value: '0', block, at: new Date(T0).toISOString(), safe: MONAD_SAFE.toLowerCase() } } })
  test.each([
    ['sending (signed, not landed yet)', { burns: { [UOP]: burn({ state: 'sending' }) } }],
    ['sending, the bundler dropped it and its nonce is unspent (it may still land)', { burns: { [UOP]: burn({ state: 'sending', note: 'not sent' }) } }],
    ['burned (attestation or mint pending)', { burns: { [UOP]: burn({ state: 'burned', txHash: `0x${'22'.repeat(32)}`, burnBlock: '1010' }) } }],
    ['minted, no read of the Monad Safe recorded since', { burns: { [UOP]: burn({ state: 'minted', mintedBlock: '900' }) } }],
    ['minted, the last read of the Monad Safe is from before the mint', { burns: { [UOP]: burn({ state: 'minted', mintedBlock: '900' }) }, ...sleeveAt('899') }],
  ])('%s: open', (_what, journal) => {
    const { bridge } = bridgeOf(journal)
    const f = bridge.fence(KEY)
    expect(f.open.map((b) => b.id)).toEqual([UOP])
    expect(bridge.fenced(KEY)).toBe(true)
  })

  test.each([
    ['failed (its UserOperationEvent says it reverted)', { burns: { [UOP]: burn({ state: 'failed', failedBlock: '1010' }) } }],
    ['dropped (its nonce was spent at a safe block without it)', { burns: { [UOP]: burn({ state: 'dropped' }) } }],
    ['minted and read on the Monad Safe at the mint block', { burns: { [UOP]: burn({ state: 'minted', mintedBlock: '900' }) }, ...sleeveAt('900') }],
    ['no bridge at all', {}],
    ["another account's bridge in flight", { burns: { [UOP]: burn({ accountKey: 'someone-else' }) } }],
  ])('%s: terminal, nothing open', (_what, journal) => {
    expect(bridgeOf(journal).bridge.fence(KEY).open).toEqual([])
  })

  test('the fence is on disk before it answers, survives a restart and keeps its first time', () => {
    const w = bridgeOf()
    const at = w.bridge.fence(KEY).at
    expect(w.file().fences[KEY]).toEqual({ at })
    const next = w.again()
    expect(next.fenced(KEY)).toBe(true)
    expect(next.fence(KEY).at).toBe(at)
    expect(next.fenced('another-account')).toBe(false)
  })

  test('behind the fence no bridge is journaled, so none is signed: a new one, and a dropped one signed again', () => {
    const w = bridgeOf({ burns: { [UOP]: burn({ state: 'dropped', note: 'never signed: nothing can burn' }) } })
    w.bridge.fence(KEY)
    expect(() => w.bridge.recordSending(KEY, signing({ userOpHash: `0x${'33'.repeat(32)}` }))).toThrow(/no bridge to Monad is signed/)
    expect(() => w.bridge.recordSending(KEY, signing())).toThrow(/no bridge to Monad is signed/)
    expect(Object.keys(w.file().burns)).toEqual([UOP])
    expect(w.file().burns[UOP]!.state).toBe('dropped')
    // Another account is not fenced.
    w.bridge.recordSending('another-account', signing({ userOpHash: `0x${'44'.repeat(32)}` }))
    expect(w.bridge.burns().some((b) => b.accountKey === 'another-account' && b.state === 'sending')).toBe(true)
  })

  test('a journal that cannot be written fences nothing and throws', () => {
    const w = bridgeOf()
    ;(w.bridge as unknown as { save: () => void }).save = () => {
      throw new Error('disk full')
    }
    expect(() => w.bridge.fence(KEY)).toThrow('disk full')
    expect(w.bridge.fenced(KEY)).toBe(false)
  })
})

describe('SCN-RH-12: a dropped bridge userOp stops holding the return once the chain proves it dead', () => {
  const VALID_UNTIL = 1_800_000_000n
  const sending = { burns: { [UOP]: burn({ state: 'sending', validUntil: VALID_UNTIL.toString() }) } }

  test('recordSending keeps the session end the engine hands it', () => {
    const w = bridgeOf()
    w.bridge.recordSending(KEY, signing({ validUntil: VALID_UNTIL }))
    expect(w.file().burns[UOP]!.validUntil).toBe(VALID_UNTIL.toString())
    const none = bridgeOf()
    none.bridge.recordSending(KEY, signing({ validUntil: 0n }))
    expect(none.file().burns[UOP]!.validUntil).toBeUndefined()
  })

  test('nonce unspent and its session still valid: in flight, before and after a settle pass', async () => {
    const w = bridgeOf(sending, baseAt({ safe: 2_000n, timestamp: VALID_UNTIL, nonce: 7n }))
    expect(w.bridge.fence(KEY).open).toHaveLength(1)
    await w.bridge.settleSending(w.bridge.burns()[0]!)
    expect(w.bridge.fence(KEY).open).toHaveLength(1)
    expect(w.bridge.burns()[0]!.state).toBe('sending')
  })

  test('the EntryPoint nonce advanced past it with no event of its hash: dead, the return is no longer held', async () => {
    const w = bridgeOf(sending, baseAt({ safe: 2_000n, timestamp: VALID_UNTIL - 100n, nonce: 8n }))
    expect(w.bridge.fence(KEY).open).toHaveLength(1)
    await w.bridge.settleSending(w.bridge.burns()[0]!)
    expect(w.bridge.burns()[0]!.state).toBe('dropped')
    expect(w.bridge.fence(KEY).open).toEqual([])
  })

  test('behind the fence, a safe block past its session end with the nonce unspent: dead', async () => {
    const w = bridgeOf(sending, baseAt({ safe: 2_000n, timestamp: VALID_UNTIL + 1n, nonce: 7n }))
    expect(w.bridge.fence(KEY).open).toHaveLength(1)
    await w.bridge.settleSending(w.bridge.burns()[0]!)
    expect(w.bridge.burns()[0]!).toMatchObject({ state: 'dropped' })
    expect(w.bridge.burns()[0]!.note).toContain("past its session's end")
    expect(w.bridge.fence(KEY).open).toEqual([])
  })

  test('without the fence the session-end rule does not apply (the burn stays in flight as before)', async () => {
    const w = bridgeOf(sending, baseAt({ safe: 2_000n, timestamp: VALID_UNTIL + 1n, nonce: 7n }))
    await w.bridge.settleSending(w.bridge.burns()[0]!)
    expect(w.bridge.burns()[0]!.state).toBe('sending')
  })

  test('a burn with no session end recorded (journaled before this) is never dead by time', async () => {
    const w = bridgeOf({ burns: { [UOP]: burn({ state: 'sending' }) } }, baseAt({ safe: 2_000n, timestamp: VALID_UNTIL * 2n, nonce: 7n }))
    w.bridge.fence(KEY)
    await w.bridge.settleSending(w.bridge.burns()[0]!)
    expect(w.bridge.burns()[0]!.state).toBe('sending')
  })
})

describe('return-home/fence on the Base operator', () => {
  function base(bridge: MonadBridge | undefined, chainId = 8453) {
    const state = { accounts: {} as Record<string, AccountState> }
    const store = { state, save: () => {} } as unknown as StateStore
    return new Operator({ chainId, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1, ...(bridge ? { bridgeMonad: bridge } : {}) }, {} as PublicClient, {} as Relayer, store)
  }
  const code = async (p: Promise<unknown>) => {
    const e = (await quiet(() => p.catch((x: unknown) => x))).out
    return e instanceof HttpError ? `${e.status} ${e.code}` : e
  }

  test('nothing in flight: fenced', async () => {
    const w = bridgeOf()
    const out = (await quiet(() => base(w.bridge).returnHomeFence(ctx))).out
    expect(out).toEqual({ fenced: true, at: w.file().fences[KEY]!.at })
  })

  test('a bridge not terminal: 409 BRIDGE_IN_FLIGHT, and the fence stays', async () => {
    const w = bridgeOf({ burns: { [UOP]: burn({ state: 'burned' }) } })
    expect(await code(base(w.bridge).returnHomeFence(ctx))).toBe('409 BRIDGE_IN_FLIGHT')
    expect(w.bridge.fenced(KEY)).toBe(true)
  })

  test('lock order: a bridge signed by a review that holds the account lock is listed by the fence answer; one asked after it is refused', async () => {
    const w = bridgeOf()
    const op = base(w.bridge)
    const lock = (op as unknown as { lock(k: string): { run<T>(f: () => Promise<T>): Promise<T> } }).lock(KEY)
    // A review that already holds the lock journals its bridge a moment later, as the engine does before it signs.
    const review = lock.run(async () => {
      await new Promise((r) => setTimeout(r, 20))
      w.bridge.recordSending(KEY, signing())
    })
    const fence = code(op.returnHomeFence(ctx))
    await review
    expect(await fence).toBe('409 BRIDGE_IN_FLIGHT')
    expect(w.bridge.openBridges(KEY).map((b) => b.id)).toEqual([UOP])
    // And the next review's bridge is refused at the journal: never signed.
    await lock.run(async () => {
      expect(() => w.bridge.recordSending(KEY, signing({ userOpHash: `0x${'55'.repeat(32)}`, nonce: 8n }))).toThrow(/no bridge to Monad is signed/)
    })
  })

  test('no bridge journal on this operator, a journal that cannot be written, or not the home chain: nothing fenced, a refusal', async () => {
    expect(await code(base(undefined).returnHomeFence(ctx))).toBe('503 REMOTE_UNAVAILABLE')
    const w = bridgeOf()
    ;(w.bridge as unknown as { save: () => void }).save = () => {
      throw new Error('disk full')
    }
    expect(await code(base(w.bridge).returnHomeFence(ctx))).toBe('503 REMOTE_UNAVAILABLE')
    expect(await code(base(bridgeOf().bridge, 143).returnHomeFence(ctx))).toBe('409 NOT_A_HOME')
  })
})
