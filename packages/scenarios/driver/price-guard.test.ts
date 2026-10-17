import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, toEventSelector, type Hex, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import type { Decision, Proposal } from '@mamoru/decide'
import { POLICIES, grantKey, instantiateGrant, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { address, swapRouter02Abi } from '@mamoru/registry'
import { precheck, SessionLedger } from '@mamoru/account/precheck'
import { executeCallData, permissionIdOf, toSmartSession, useModeSignature } from '@mamoru/account/sessions'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { Engine, grantHasSwapDeadline, settleUnincluded, type EngineSession } from './engine.ts'
import type { OpRecord } from './journal.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const policy = POLICIES['conservador-live-v2']!
const POOL = 'pool:USDC/USDT/100'
const WINDOW = BigInt(policy.execution.twapWindowSeconds)
const sessionKey = privateKeyToAccount(generatePrivateKey())
const caps = new Proxy({}, { get: () => 10n ** 12n }) as Record<string, bigint>

function session(key: string, validUntil = 2_000_000_000): EngineSession {
  const grant = instantiateGrant(policy, key, { account: ACCOUNT, sessionKey: sessionKey.address, chainId: 8453, salt: `0x${'01'.repeat(32)}`, validAfter: 0, validUntil, caps, admittedTokenIds: [] })
  return { name: key, grant, permissionId: permissionIdOf(toSmartSession(grant)) }
}

/** The same grant as a session enabled before otto/mamoru#140: no SwapRouter02 deadline action. */
function legacy(s: EngineSession): EngineSession {
  const grant: SessionGrant = { ...s.grant, actions: s.grant.actions.filter((a) => !a.signature.startsWith('multicall')) }
  return { ...s, grant }
}

/** `nonce`/`enabled`/`timestamp` answer at the safe block (150); `latestNonce`/`latestEnabled` at any other block. */
type Chain = { spotTick: number; twapTick: number | null; nonce: bigint; timestamp: bigint; enabled: boolean; latestNonce?: bigint; latestEnabled?: boolean; events: unknown[]; eventBlock: { number: bigint; hash: Hex } | null; safeNumber: bigint }

/** An engine whose reads answer from `chain`: slot0 at `spotTick`, the policy window's TWAP at `twapTick`, and so on. */
function engineAt(chain: Partial<Chain> = {}, p: PolicyVersion = policy, extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}) {
  const c: Chain = { spotTick: 0, twapTick: 0, nonce: 5n, timestamp: 1_000n, enabled: true, events: [], eventBlock: null, safeNumber: 150n, ...chain }
  const e = new Engine(
    { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: 'http://127.0.0.1:9/', bundlerUrl: 'http://127.0.0.1:9/', policy: p, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 0n, historyFromBlock: 0n, sessions: [], ...extra },
    { waitBlock: async () => {} },
  )
  const client = {
    getBlock: async (q?: { blockTag?: string; blockNumber?: bigint }) => {
      if (q?.blockTag === 'safe') return { number: c.safeNumber, timestamp: c.timestamp, hash: `0x${'22'.repeat(32)}` }
      if (q?.blockNumber !== undefined && c.eventBlock && q.blockNumber === c.eventBlock.number) return { number: q.blockNumber, timestamp: c.timestamp, hash: c.eventBlock.hash }
      return { number: 200n, timestamp: c.timestamp + 100n, hash: `0x${'11'.repeat(32)}`, baseFeePerGas: 1n }
    },
    getLogs: async () => c.events,
    // The bundle's logs: BeforeExecution, then the op's UserOperationEvent (what readUserOpEvent slices on).
    getTransactionReceipt: async () => ({
      logs: [
        { address: address('EntryPointV07'), logIndex: 0, topics: [toEventSelector('event BeforeExecution()')], data: '0x' },
        { address: address('EntryPointV07'), logIndex: 1, topics: [toEventSelector('event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)')], data: '0x' },
      ],
    }),
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      const atSafe = blockNumber === c.safeNumber
      if (functionName === 'slot0') return [sqrtRatioAtTick(c.spotTick), c.spotTick, 0, 0, 0, 0, true]
      if (functionName === 'observe') {
        if (c.twapTick === null) throw new Error('execution reverted: OLD')
        return [[0n, BigInt(c.twapTick) * WINDOW], [0n, 0n]]
      }
      if (functionName === 'getNonce') return atSafe ? c.nonce : (c.latestNonce ?? c.nonce)
      if (functionName === 'isPermissionEnabled') return atSafe ? c.enabled : (c.latestEnabled ?? c.enabled)
      throw new Error(`unexpected read ${functionName}`)
    },
    call: async () => ({ data: `0x${[999_900n, 1n << 96n, 0n, 100_000n].map((w) => w.toString(16).padStart(64, '0')).join('')}` }),
  } as unknown as PublicClient
  ;(e as unknown as { client: PublicClient }).client = client
  return {
    chain: c,
    engine: e,
    priv: e as unknown as {
      priceGuard(pool: string, block: bigint): Promise<number>
      swapMin(p: { pool: string; tokenIn: string; fee: number; amountIn: bigint }, amountOut: bigint, block: bigint): Promise<bigint>
      prepareCalls(p: Proposal, block: bigint, timestamp: bigint, s: EngineSession): Promise<{ calls: { target: Address; callData: Hex }[]; expiresAt: bigint | null }>
      resumePending(): Promise<void>
      watchReleased(): Promise<void>
      released: OpRecord[]
    },
  }
}

const swapIn = { pool: POOL, tokenIn: 'USDC', fee: 100, amountIn: 1_000_000n }

describe('engine prices at the prepare block against the TWAP (otto/mamoru#140)', () => {
  test('a spot within the policy deviation passes and returns the TWAP tick', async () => {
    expect(await engineAt({ spotTick: 40 }).priv.priceGuard(POOL, 1n)).toBe(0)
  })

  test('a spot moved past the deviation at the prepare block is refused', async () => {
    await expect(engineAt({ spotTick: 101 }).priv.priceGuard(POOL, 1n)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
    await expect(engineAt({ spotTick: -101 }).priv.priceGuard(POOL, 1n)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
  })

  test('a pool that cannot answer for the window refuses the operation', async () => {
    await expect(engineAt({ twapTick: null }).priv.priceGuard(POOL, 1n)).rejects.toMatchObject({ code: 'EHG_TWAP_UNAVAILABLE' })
  })

  test('the swap minimum is never under the TWAP floor, and a quote under it is refused', async () => {
    const { priv } = engineAt()
    // USDC -> USDT at tick 0: one raw unit for one, 0.01% fee.
    expect(await priv.swapMin(swapIn, 999_900n, 1n)).toBe(994_900n)
    const held = await priv.swapMin(swapIn, 989_000n, 1n)
    expect(held).toBeGreaterThan(985_000n)
    expect(held).toBeGreaterThan((989_000n * 9_950n) / 10_000n)
    await expect(priv.swapMin(swapIn, 950_000n, 1n)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
  })

  test('with depth sizing on, the larger minimum holds: the impact floor of #127 over the deviation floor', async () => {
    const depth: PolicyVersion = { ...policy, depth: { maxImpactBps: 300, maxShareBps: 1_000 } }
    const { priv } = engineAt({}, depth)
    // A quote 2.8% under the TWAP is inside the 3% impact budget: kept, and its minimum is the impact floor
    // (~96.99%), above the usual 0.5% under the quote (~96.71%) and above the deviation floor (~96.0%).
    const min = await priv.swapMin(swapIn, 972_000n, 1n)
    expect(min).toBe((999_900n * 9_700n) / 10_000n)
    expect(min).toBeGreaterThan((972_000n * 9_950n) / 10_000n)
    // Nearer the TWAP the usual minimum is the larger one again.
    expect(await priv.swapMin(swapIn, 980_000n, 1n)).toBe((980_000n * 9_950n) / 10_000n)
    // Past the impact budget: refused as #127 did.
    await expect(priv.swapMin(swapIn, 960_000n, 1n)).rejects.toMatchObject({ code: 'EHG_SWAP_IMPACT_OVER_LIMIT' })
    // A fair quote keeps the usual minimum, which is the largest.
    expect(await priv.swapMin(swapIn, 999_900n, 1n)).toBe(994_900n)
  })
})

const enterSwap: Proposal = { kind: 'enter_swap', grant: 'enter-swap:pool:USDC/USDT/100', pool: POOL, tokenIn: 'USDC', tokenOut: 'USDT', fee: 100, amountIn: 1_000_000n } as Proposal

function selectors(calls: { callData: Hex }[]): string[] {
  return calls.map((c) => c.callData.slice(0, 10))
}

describe('every engine swap expires on chain (otto/mamoru#140)', () => {
  const key = grantKey(policy.session.grants.find((g) => g.name === 'enter-swap' && g.pool === POOL)!)

  test('grants that hold a swap also hold SwapRouter02.multicall(deadline, []) with an empty array, and nothing else new', () => {
    for (const g of policy.session.grants) {
      const swaps = g.actions.some((a) => a.signature.startsWith('exactInputSingle'))
      const deadline = g.actions.find((a) => a.signature === 'multicall(uint256,bytes[])')
      expect(!!deadline).toBe(swaps)
      if (deadline) {
        expect(deadline.target).toBe('SwapRouter02')
        expect(deadline.params.map((r) => [r.index, r.condition, r.ref])).toEqual([
          [0, 'GREATER_THAN', 0n],
          [1, 'EQUAL', 64n],
          [2, 'EQUAL', 0n],
        ])
      }
    }
    expect(grantHasSwapDeadline(session(key).grant)).toBe(true)
    expect(grantHasSwapDeadline(legacy(session(key)).grant)).toBe(false)
  })

  test('an entry swap carries the deadline first, and the pre-check admits it; a non-empty multicall is refused', async () => {
    const s = session(key)
    const { priv } = engineAt()
    const p = await priv.prepareCalls(enterSwap, 100n, 1_000n, s)
    expect(selectors(p.calls)).toEqual(['0x5ae401dc', '0x095ea7b3', '0x04e45aaf'])
    const deadline = decodeFunctionData({ abi: swapRouter02Abi, data: p.calls[0]!.callData })
    expect(deadline.args).toEqual([1_000n + BigInt(policy.execution.observationTtlSeconds), []])
    expect(p.expiresAt).toBe(1_000n + BigInt(policy.execution.observationTtlSeconds))
    const ledger = new SessionLedger()
    ledger.activate(s.permissionId, s.grant)
    const check = (calls: { target: Address; callData: Hex }[]) =>
      precheck({ sender: ACCOUNT, callData: executeCallData(calls.map((c) => ({ target: c.target, value: 0n, callData: c.callData }))), signature: useModeSignature(s.permissionId, '0x') }, { chainId: 8453, now: 1_000, ledger })
    expect(check(p.calls)).toMatchObject({ ok: true })
    // The same action with a call inside the array: the pre-check (as UniActionPolicy on chain) refuses it.
    const smuggled = { target: address('SwapRouter02'), callData: p.calls[2]!.callData }
    const { encodeFunctionData } = await import('viem')
    const inner = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [2_000n, [smuggled.callData]] })
    expect(check([{ target: address('SwapRouter02'), callData: inner }])).toMatchObject({ ok: false, code: 'POLICY_DENIED_TARGET' })
  })

  test('a grant from before has no deadline action: no deadline call, and the expiry is the session validUntil', async () => {
    const s = legacy(session(key, 1_700_000_000))
    const p = await engineAt().priv.prepareCalls(enterSwap, 100n, 1_000n, s)
    expect(selectors(p.calls)).toEqual(['0x095ea7b3', '0x04e45aaf'])
    expect(p.expiresAt).toBe(1_700_000_000n)
  })

  test('a harvest only collects, and one that asks to convert is refused (finding 3)', async () => {
    const harvest = { kind: 'harvest', grant: 'convert-any:pool:USDC/USDT/100', pool: POOL, tokenId: 9n, fees0: 10n, fees1: 10n, convert: { token: 'USDT', amount: 10n } } as Proposal
    await expect(engineAt().priv.prepareCalls(harvest, 100n, 1_000n, session(key))).rejects.toMatchObject({ code: 'EHG_SIM_DELTA_MISMATCH' })
  })
})

describe('a rejected or unseen userOp is settled from the chain only (otto/mamoru#140, finding 2)', () => {
  const base = { opNonce: 5n, nonceAtSafe: 5n, eventFound: false, safeTimestamp: 1_000n, expiresAt: 1_120n as bigint | null, permissionEnabledAtSafe: true, rejected: true }

  test('nonce unmoved at safe before the expiry: it may still land, so it stays pending', () => {
    expect(settleUnincluded(base)).toBeNull()
    expect(settleUnincluded({ ...base, safeTimestamp: 1_120n })).toBeNull()
  })

  test('nonce unmoved at a safe block past the expiry, or with its permission gone there: it can never execute', () => {
    expect(settleUnincluded({ ...base, safeTimestamp: 1_121n })).toMatchObject({ to: 'failed', code: 'RECON_UNINCLUDABLE' })
    expect(settleUnincluded({ ...base, permissionEnabledAtSafe: false })).toMatchObject({ to: 'failed', code: 'RECON_UNINCLUDABLE' })
  })

  test('its event found: included, whatever else; nonce moved at safe with no event: another op took it', () => {
    expect(settleUnincluded({ ...base, eventFound: true })).toEqual({ to: 'included' })
    expect(settleUnincluded({ ...base, nonceAtSafe: 6n, safeTimestamp: 9_999n, eventFound: true })).toEqual({ to: 'included' })
    expect(settleUnincluded({ ...base, nonceAtSafe: 6n })).toMatchObject({ to: 'failed', code: 'RECON_NONCE_CONSUMED_BY_OTHER' })
  })

  test('an op that prices nothing is freed at once after a rejection; one the bundler accepted waits', () => {
    expect(settleUnincluded({ ...base, expiresAt: null })).toMatchObject({ to: 'failed', code: 'RECON_UNINCLUDABLE' })
    expect(settleUnincluded({ ...base, expiresAt: null, rejected: false })).toBeNull()
  })

  /** A live op of `e` in pending_reconciliation after a bundler rejection, signed with nonce 5. */
  function rejectedOp(e: Engine, expiresAt: bigint | null): OpRecord {
    const decision = { decisionId: `0x${'aa'.repeat(32)}`, premiseHash: `0x${'bb'.repeat(32)}`, reason: 'DECIDE_ENTER_SWAP', proposal: enterSwap, observationRef: { block: 90n, hash: `0x${'cc'.repeat(32)}` }, policyRef: { version: policy.policyId } } as unknown as Decision
    const op = e.journal.propose(e.journal.recordDecision(decision), enterSwap.grant)
    e.journal.move(op.opId, 'prepared', 'EHG_OK', { prepareBlock: 95n, permissionId: `0x${'dd'.repeat(32)}`, nonce: 5n, expiresAt })
    e.journal.move(op.opId, 'simulated', 'EHG_OK')
    e.journal.move(op.opId, 'signed', 'OP_SIGNED', { userOpHash: `0x${'ee'.repeat(32)}` })
    return e.journal.move(op.opId, 'pending_reconciliation', 'BUNDLER_REJECTED')
  }

  test('a revoked permission or a spent nonce seen only at latest (reorgable) settles nothing (Sol review of #64)', async () => {
    const w = engineAt({ latestNonce: 6n, latestEnabled: false })
    const op = rejectedOp(w.engine, 1_120n)
    await w.priv.resumePending()
    expect(w.engine.journal.op(op.opId).state).toBe('pending_reconciliation')
    expect(w.engine.journal.live?.opId).toBe(op.opId)
  })

  test('the engine holds the slot until a safe block is past the expiry, then frees it and backs the premise off', async () => {
    const w = engineAt({ timestamp: 1_000n })
    const op = rejectedOp(w.engine, 1_120n)
    await w.priv.resumePending()
    expect(w.engine.journal.op(op.opId).state).toBe('pending_reconciliation')
    expect(w.engine.journal.live?.opId).toBe(op.opId)
    w.chain.timestamp = 1_121n
    await w.priv.resumePending()
    expect(w.engine.journal.op(op.opId)).toMatchObject({ state: 'failed', stateCode: 'RECON_UNINCLUDABLE' })
    expect(w.engine.journal.live).toBeNull()
    expect((w.engine as unknown as { backoff: { premiseHash: string }[] }).backoff.map((b) => b.premiseHash)).toEqual([`0x${'bb'.repeat(32)}`])
    expect(w.priv.released.map((o) => o.opId)).toEqual([op.opId])
  })

  /** A UserOperationEvent log of `op`, in block 160 (at or below a safe head of 160). */
  function eventOf(op: OpRecord, success: boolean) {
    return {
      address: address('EntryPointV07'),
      blockNumber: 160n,
      blockHash: `0x${'33'.repeat(32)}`,
      transactionHash: `0x${'44'.repeat(32)}`,
      logIndex: 1,
      args: { userOpHash: op.userOpHash, sender: ACCOUNT, paymaster: `0x${'00'.repeat(20)}`, nonce: op.nonce, success, actualGasCost: 7n, actualGasUsed: 1n },
    }
  }

  test('freed bytes that land later are recorded on their op and counted in the ledger (Sol review of #64)', async () => {
    const w = engineAt({ timestamp: 1_121n })
    const op = rejectedOp(w.engine, 1_120n)
    await w.priv.resumePending()
    expect(w.engine.journal.op(op.opId).stateCode).toBe('RECON_UNINCLUDABLE')
    // Nothing yet: still watched.
    await w.priv.watchReleased()
    expect(w.priv.released).toHaveLength(1)
    // It lands (past its expiry its swap reverts), then `safe` reaches its block.
    w.chain.events = [eventOf(op, false)]
    w.chain.eventBlock = { number: 160n, hash: `0x${'33'.repeat(32)}` }
    w.chain.safeNumber = 160n
    w.chain.nonce = 6n
    let recorded: unknown[] = []
    const ledger = w.engine.ledger as unknown as { recordIncluded(id: string, calls: unknown[]): void }
    const original = ledger.recordIncluded.bind(ledger)
    ledger.recordIncluded = (id, calls) => {
      recorded = [id, calls]
      original(id, calls)
    }
    await w.priv.watchReleased()
    expect(w.engine.journal.op(op.opId)).toMatchObject({ state: 'failed', lateIncluded: true, included: { blockNumber: 160n, success: false } })
    expect(recorded[0]).toBe(op.permissionId)
    expect(w.priv.released).toHaveLength(0)
  })

  test('a freed op is dropped from the watch once the nonce at safe is past it without its event', async () => {
    const w = engineAt({ timestamp: 1_121n })
    rejectedOp(w.engine, 1_120n)
    await w.priv.resumePending()
    w.chain.nonce = 6n
    await w.priv.watchReleased()
    expect(w.priv.released).toHaveLength(0)
  })

  test('an op whose block was reorged out is looked for again, not left holding the slot (pre-existing, Sol review of #64)', async () => {
    const w = engineAt({ timestamp: 1_121n })
    const op = rejectedOp(w.engine, 1_120n)
    // Found on chain, then reorged out: back in pending_reconciliation with RECON_REORGED.
    w.chain.events = [eventOf(op, true)]
    await w.priv.resumePending()
    expect(w.engine.journal.op(op.opId).state).toBe('included')
    w.engine.journal.move(op.opId, 'pending_reconciliation', 'RECON_REORGED')
    w.chain.events = []
    await w.priv.resumePending()
    expect(w.engine.journal.op(op.opId)).toMatchObject({ state: 'failed', stateCode: 'RECON_UNINCLUDABLE' })
  })

  test('carried: the live pending op and every freed one; a later engine watches them from the start (Sol review round 2 of #64)', async () => {
    const w = engineAt({ timestamp: 1_000n })
    const op = rejectedOp(w.engine, null)
    // A collect-only op (prices nothing) rejected by the bundler: freed at once, still watched.
    await w.priv.resumePending()
    expect(w.engine.journal.op(op.opId).stateCode).toBe('RECON_UNINCLUDABLE')
    expect(w.engine.carried().map((o) => o.opId)).toEqual([op.opId])
    // A legacy-grant swap with no deadline, still pending: carried too.
    const w2 = engineAt({ timestamp: 1_000n })
    const pending = rejectedOp(w2.engine, 2_000_000_000n)
    await w2.priv.resumePending()
    expect(w2.engine.journal.op(pending.opId).state).toBe('pending_reconciliation')
    expect(w2.engine.carried().map((o) => o.opId)).toEqual([pending.opId])
    // The process restarts: the next engine of the account gets them, and records a late landing on the carried op.
    const carried = w.engine.carried().map((o) => ({ ...o, storedId: 'eng-1-1-x-harvest' }))
    const next = engineAt({ timestamp: 1_121n }, policy, { carried })
    expect(next.priv.released.map((o) => o.opId)).toEqual([op.opId])
    const moved: OpRecord[] = []
    next.engine.journal.onMove = (o) => void moved.push(o)
    next.chain.events = [eventOf(op, false)]
    next.chain.eventBlock = { number: 160n, hash: `0x${'33'.repeat(32)}` }
    next.chain.safeNumber = 160n
    next.chain.nonce = 6n
    const ledger = next.engine.ledger as unknown as { recordIncluded(id: string, calls: unknown[]): void }
    const applied: string[] = []
    const original = ledger.recordIncluded.bind(ledger)
    ledger.recordIncluded = (id, calls) => {
      applied.push(id)
      original(id, calls)
    }
    await next.priv.watchReleased()
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ storedId: 'eng-1-1-x-harvest', lateIncluded: true, included: { blockNumber: 160n } })
    expect(applied).toEqual([op.permissionId!])
    expect(next.engine.carried()).toHaveLength(0)
  })

  test('a carried op whose nonce passed without its event is dropped, and the operator is told (Sol review round 2 of #64)', async () => {
    const w = engineAt({ timestamp: 1_121n })
    const op = rejectedOp(w.engine, 1_120n)
    await w.priv.resumePending()
    const next = engineAt({ timestamp: 1_121n, nonce: 6n }, policy, { carried: w.engine.carried() })
    const moved: string[] = []
    next.engine.journal.onMove = (o) => void moved.push(o.opId)
    await next.priv.watchReleased()
    expect(next.engine.carried()).toHaveLength(0)
    expect(moved).toEqual([op.opId])
  })

  test('a carried op that landed stays watched until its effects are applied and stored, applied once (Sol review round 3 of #64)', async () => {
    const w = engineAt({ timestamp: 1_121n })
    const op = rejectedOp(w.engine, 1_120n)
    await w.priv.resumePending()
    const next = engineAt({ timestamp: 1_121n }, policy, { carried: w.engine.carried() })
    next.chain.events = [eventOf(op, false)]
    next.chain.eventBlock = { number: 160n, hash: `0x${'33'.repeat(32)}` }
    next.chain.safeNumber = 160n
    next.chain.nonce = 6n
    const ledger = next.engine.ledger as unknown as { recordIncluded(id: string, calls: unknown[]): void }
    const original = ledger.recordIncluded.bind(ledger)
    let applied = 0
    let fail = true
    ledger.recordIncluded = (id, calls) => {
      if (fail) throw new Error('HTTP request failed. Status: 429')
      applied++
      original(id, calls)
    }
    // The effects throw: still watched, nothing stored.
    const stored: string[] = []
    let storeFails = true
    next.engine.journal.onMove = (o) => {
      if (storeFails) throw new Error('disk full')
      stored.push(o.opId)
    }
    await next.priv.watchReleased().catch(() => undefined)
    expect(next.engine.carried().map((o) => o.opId)).toEqual([op.opId])
    // The effects apply, the store fails: still watched, applied once.
    fail = false
    await next.priv.watchReleased()
    expect(applied).toBe(1)
    expect(next.engine.carried().map((o) => o.opId)).toEqual([op.opId])
    // The store works: stored, no longer watched, not applied again.
    storeFails = false
    await next.priv.watchReleased()
    expect(applied).toBe(1)
    expect(stored).toEqual([op.opId])
    expect(next.engine.carried()).toHaveLength(0)
  })

  test('a landing whose later effects are retried counts its session use once (Sol review round 4 of #64)', async () => {
    const w = engineAt({ timestamp: 1_121n })
    const op = rejectedOp(w.engine, 1_120n)
    const ledger = w.engine.ledger as unknown as { recordIncluded(id: string, calls: unknown[]): void }
    const original = ledger.recordIncluded.bind(ledger)
    let uses = 0
    ledger.recordIncluded = (id, calls) => {
      uses++
      original(id, calls)
    }
    type After = { afterConfirmed(o: OpRecord, p: unknown, c: unknown[], l: unknown[]): Promise<void> }
    // The first pass records the use and then fails on a read (a harvest's history); the retry runs it all again.
    await (w.engine as unknown as After).afterConfirmed(op, op.intent, [], [])
    await (w.engine as unknown as After).afterConfirmed(op, op.intent, [], [])
    expect(uses).toBe(1)
  })

  test('an op included but not yet safe when the engine stops is carried, and the next engine applies it (rebase review of #64)', async () => {
    const w = engineAt({ timestamp: 1_000n })
    const op = rejectedOp(w.engine, 1_120n)
    // Not rejected after all: found included above safe, then the engine is stopped (a grant sweep) before safe.
    w.engine.journal.move(op.opId, 'included', 'OP_INCLUDED', { included: { blockNumber: 160n, blockHash: `0x${'33'.repeat(32)}`, txHash: `0x${'44'.repeat(32)}`, success: true, actualGasCost: 7n } })
    expect(w.engine.carried().map((o) => o.opId)).toEqual([op.opId])
    const next = engineAt({ timestamp: 1_000n }, policy, { carried: w.engine.carried().map((o) => ({ ...o, storedId: 'eng-1-1-x-enter_swap' })) })
    next.chain.events = [eventOf(op, true)]
    next.chain.eventBlock = { number: 160n, hash: `0x${'33'.repeat(32)}` }
    next.chain.safeNumber = 160n
    next.chain.nonce = 6n
    const moved: OpRecord[] = []
    next.engine.journal.onMove = (o) => void moved.push(o)
    await next.priv.watchReleased()
    expect(moved[0]).toMatchObject({ storedId: 'eng-1-1-x-enter_swap', lateIncluded: true, included: { success: true } })
    expect(next.engine.carried()).toHaveLength(0)
  })

  test('a nonce spent by something else settles the op without waiting for the expiry', async () => {
    const w = engineAt({ nonce: 6n })
    const op = rejectedOp(w.engine, 1_120n)
    await w.priv.resumePending()
    expect(w.engine.journal.op(op.opId)).toMatchObject({ state: 'failed', stateCode: 'RECON_NONCE_CONSUMED_BY_OTHER' })
  })
})
