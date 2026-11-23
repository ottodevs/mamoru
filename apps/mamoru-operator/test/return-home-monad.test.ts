// otto/mamoru#428 (spec 014, step 1 of leaving Monad), the Monad side: a return home on a design-C Safe is ONE owner
// Safe tx built by buildReturnHome (remove every session, burn the whole USDC to the owner's Base Safe), held as a Stop.
// Refused while a position is open or WMON is held. The confirmed burn is kept as an owner-signed release, reported home.
import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, pad, type Hex, type PublicClient } from 'viem'
import type { AccountContext, Address, RemoteSpec } from '@mamoru/domain'
import { buildReturnHome, TOKEN_MESSENGER_V2 } from '@mamoru/account/return-home'
import { address, monadRegistry, tokenMessengerV2Abi } from '@mamoru/registry'
import { liveWmonUsdcMonadV6 } from '@mamoru/policy'
import { monadV6Deployed, remoteAccountKey, remoteInput, remoteSafe } from '@mamoru/account/remote'
import { HttpError, Operator, returnBurnMismatch } from '../src/operator.ts'
import { releasesToCount } from '../src/release.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'
import { withPinnedV3 } from '../../../packages/account/remote/fixture.ts'
import { ctx, quiet } from './owner-world.ts'

const registry = withPinnedV3(monadRegistry)
const HOME = ctx.address as Address
const SPEC: RemoteSpec = { chainId: 143, policyId: liveWmonUsdcMonadV6.policyId, sessionKey: `0x${'11'.repeat(20)}`, validAfter: 1_790_000_000, validUntil: 1_821_536_000, capUsdc: '50000000' }
const SAFE = remoteSafe(remoteInput(ctx, SPEC, registry)).address as Address
const rctx: AccountContext = { accountKey: remoteAccountKey(ctx.accountKey, 143), chainId: 143, address: SAFE, owners: ctx.owners, saltNonce: ctx.saltNonce, passkey: ctx.passkey, remote: SPEC }
const GRANTS: Hex[] = [`0x${'0a'.repeat(32)}`, `0x${'0b'.repeat(32)}`]

type Read = { deployed: boolean; usdc: bigint; tokens: Record<string, bigint>; positions: { tokenId: bigint; liquidity: bigint; tokensOwed0: bigint; tokensOwed1: bigint }[]; block: bigint }

function monad(read: Partial<Read> = {}, listed: Hex[] | null = GRANTS) {
  const client = { getBlockNumber: async () => 500n, getCode: async () => '0x01', readContract: async ({ functionName }: { functionName: string }) => (functionName === 'nonce' ? 5n : 0n) } as unknown as PublicClient
  const state = { accounts: {} as Record<string, AccountState> }
  const store = { state, save: () => {} } as unknown as StateStore
  const op = new Operator({ chainId: 143, registry, chainWrites: [143], live: true, rpcUrl: '', bundlerUrl: '', policy: monadV6Deployed(registry), reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }, client, { address: `0x${'7'.repeat(40)}` } as unknown as Relayer, store)
  state.accounts[rctx.accountKey] = { accountKey: rctx.accountKey, ctx: rctx, active: true, trusted: true, policyId: liveWmonUsdcMonadV6.policyId, grants: GRANTS.map((permissionId, i) => ({ name: `g${i}`, permissionId, grant: {} })), ops: [], revoked: [] } as unknown as AccountState
  const held: { kind: string; calls: { to: string; data: Hex }[]; summary: string[]; extra: Record<string, unknown> }[] = []
  const p = op as unknown as Record<string, unknown>
  p.enforceGrants = async () => true
  // SmartSession.getPermissionIDs(safe): the sessions enabled on the Safe now (null: unreadable).
  const chain = { listed }
  p.listedEnabled = async () => chain.listed
  p.readOf = async () => ({ deployed: true, usdc: 28_850_000n, tokens: { USDC: 28_850_000n }, positions: [], block: 500n, ...read })
  p.hold = async (_a: AccountState, _l: unknown, kind: string, calls: { to: string; data: Hex }[], summary: string[], extra: Record<string, unknown>) => (held.push({ kind, calls, summary, extra }), { safeTxHash: '0x' })
  return { op, held, state, chain }
}

const code = async (p: Promise<unknown>) => {
  const e = (await quiet(() => p.catch((x: unknown) => x))).out
  return e instanceof HttpError ? e.code : e
}

describe('return-home on the Monad operator', () => {
  test('one Stop of the builder\'s calls: every session removed, the whole USDC burned to the owner\'s Base Safe', async () => {
    const m = monad()
    await m.op.prepareReturnHome(rctx, { home: HOME })
    const h = m.held[0]!
    expect(h.kind).toBe('stop')
    const input = (h.extra.returnHome as { input: { safe: string; home: string; amountUsdc: string; removeIds: Hex[]; safeNonce: string } }).input
    expect(input).toMatchObject({ chainId: 143, safe: SAFE, home: HOME, amountUsdc: '28850000', removeIds: GRANTS, safeNonce: '5' })
    expect(h.extra.revokes).toEqual(GRANTS)
    const built = buildReturnHome(input as never, registry)
    expect(h.calls.map((c) => c.data)).toEqual(built.calls.map((c) => c.data))
    expect((h.extra.returnHome as { safeTxHash: string }).safeTxHash).toBe(built.safeTxHash)
    expect(h.summary.join('\n')).toContain(`Send 28.85 USDC from your Safe on Monad to your Safe on Base ${HOME}`)
  })

  test('refused while #427 has not finished (an open position, WMON held), without a home, or off Monad / on a V4 Safe', async () => {
    expect(await code(monad({ positions: [{ tokenId: 1n, liquidity: 5n, tokensOwed0: 0n, tokensOwed1: 0n }] }).op.prepareReturnHome(rctx, { home: HOME }))).toBe('MONAD_UNWIND_PENDING')
    expect(await code(monad({ tokens: { USDC: 1n, WMON: 10n ** 18n } }).op.prepareReturnHome(rctx, { home: HOME }))).toBe('MONAD_UNWIND_PENDING')
    expect(await code(monad().op.prepareReturnHome(rctx, {}))).toBe('BAD_REQUEST')
    expect(await code(monad().op.prepareReturnHome(rctx, { home: SAFE }))).toBe('BAD_REQUEST')
    expect(await code(monad().op.prepareReturnHome({ ...rctx, remote: { ...SPEC, policyId: 'one-auth-v4-remote' } }, { home: HOME }))).toBe('NOT_A_REMOTE')
  })

  test('spec 014 RH-02: the sessions removed are the ones enabled on chain now, known to this account or not, and no other', async () => {
    const UNKNOWN = `0x${'0c'.repeat(32)}` as Hex
    // GRANTS[1] is no longer enabled on chain (revoked unseen); UNKNOWN is enabled and this account never recorded it.
    const m = monad({}, [GRANTS[0]!, UNKNOWN])
    await m.op.prepareReturnHome(rctx, { home: HOME })
    const input = (m.held[0]!.extra.returnHome as { input: { removeIds: Hex[] } }).input
    expect(input.removeIds).toEqual([GRANTS[0]!, UNKNOWN])
    expect(m.held[0]!.extra.revokes).toEqual([GRANTS[0]!, UNKNOWN])
    expect(m.held[0]!.summary[0]).toBe("Revoke the engine's 2 session grant(s) on your Safe on Monad: Mamoru stops working there")
  })

  test('the enabled sessions cannot be read: nothing prepared (GRANT_CHECK_UNAVAILABLE)', async () => {
    const m = monad({}, null)
    expect(await code(m.op.prepareReturnHome(rctx, { home: HOME }))).toBe('GRANT_CHECK_UNAVAILABLE')
    expect(m.held).toHaveLength(0)
  })

  test('no session left on chain and USDC on the Safe (a late mint): a send-only step; neither: NOTHING_TO_STOP', async () => {
    const m = monad({}, [])
    await m.op.prepareReturnHome(rctx, { home: HOME })
    expect((m.held[0]!.extra.returnHome as { input: { removeIds: Hex[]; amountUsdc: string } }).input).toMatchObject({ removeIds: [], amountUsdc: '28850000' })
    expect(m.held[0]!.calls).toHaveLength(2)
    expect(await code(monad({ usdc: 0n, tokens: {} }, []).op.prepareReturnHome(rctx, { home: HOME }))).toBe('NOTHING_TO_STOP')
  })

  test('WMON dust and no USDC: a revoke only', async () => {
    const m = monad({ usdc: 0n, tokens: { WMON: 1000n } })
    await m.op.prepareReturnHome(rctx, { home: HOME })
    expect(m.held[0]!.calls).toHaveLength(2)
    expect(m.held[0]!.summary.join('\n')).toContain('There is no USDC to send')
  })
})

describe('the confirmed burn, as this Safe reports it home', () => {
  test('an owner-signed release counts with its home and the owner mark, so the home mints it', () => {
    const acc = { ctx: rctx, releasesDone: [{ id: 'home-1', amount: '28850000', chainId: 8453, state: 'burned', burn: { userOpHash: `0x${'00'.repeat(32)}`, amount: '28850000', txHash: `0x${'22'.repeat(32)}`, block: 777 }, owner: { home: HOME }, at: 't', updatedAt: 't' }] } as unknown as AccountState
    expect(releasesToCount(acc)).toEqual([{ id: 'home-1', chainId: 8453, at: 't', home: HOME, owner: HOME, amount: 28_850_000n, block: 777, tx: `0x${'22'.repeat(32)}` }])
  })
})

const USDC = address('USDC', registry)
const RH = { chainId: 143, safe: SAFE, safeNonce: '5', home: HOME, amountUsdc: '28850000', removeIds: GRANTS }
function burnLog(o: { amount?: bigint; recipient?: Address; depositor?: Address; domain?: number; fee?: bigint; emitter?: Address; finality?: number } = {}) {
  const topics = encodeEventTopics({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', args: { burnToken: USDC, depositor: o.depositor ?? SAFE, minFinalityThreshold: o.finality ?? 2000 } })
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
    [o.amount ?? 28_850_000n, pad(o.recipient ?? HOME, { size: 32 }), o.domain ?? 6, pad(TOKEN_MESSENGER_V2, { size: 32 }), `0x${'00'.repeat(32)}`, o.fee ?? 0n, '0x'],
  )
  return { address: o.emitter ?? TOKEN_MESSENGER_V2, topics, data, blockNumber: 777n, logIndex: 0, transactionHash: `0x${'22'.repeat(32)}`, transactionIndex: 0, blockHash: `0x${'33'.repeat(32)}`, removed: false }
}
const rc = (logs: unknown[], status: 'success' | 'reverted' = 'success') => ({ status, logs, blockNumber: 777n }) as never

describe('review r1: the burn is recorded only from its own receipt', () => {
  test('returnBurnMismatch: exactly the signed burn passes; anything else says why', () => {
    expect(returnBurnMismatch(rc([burnLog()]), RH, USDC)).toBeNull()
    expect(returnBurnMismatch(rc([burnLog()], 'reverted'), RH, USDC)).toBe('RETURN_TX_REVERTED')
    expect(returnBurnMismatch(rc([]), RH, USDC)).toBe('RETURN_BURNS_0')
    expect(returnBurnMismatch(rc([burnLog({ emitter: `0x${'99'.repeat(20)}` })]), RH, USDC)).toBe('RETURN_BURNS_0')
    expect(returnBurnMismatch(rc([burnLog(), burnLog()]), RH, USDC)).toBe('RETURN_BURNS_2')
    for (const o of [{ amount: 1n }, { recipient: `0x${'99'.repeat(20)}` as Address }, { depositor: `0x${'98'.repeat(20)}` as Address }, { domain: 0 }, { fee: 1n }, { finality: 1000 }]) {
      expect(returnBurnMismatch(rc([burnLog(o)]), RH, USDC), JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe('RETURN_BURN_MISMATCH')
    }
  })

  test('a confirmed return home (stored on the op, whatever path settled it): one owner-signed release from its receipt, once', async () => {
    const m = monad()
    const acc = m.state.accounts[rctx.accountKey]!
    acc.ops.push({ opId: 'own-1-exit', kind: 'exit', state: 'confirmed', txHash: `0x${'22'.repeat(32)}`, returnHome: RH, updatedAt: 't' } as never)
    let reads = 0
    ;(m.op as unknown as { client: { getTransactionReceipt: () => Promise<unknown> } }).client.getTransactionReceipt = async () => (reads++, rc([burnLog()]))
    const rec = (m.op as unknown as { recordReturnBurns(a: AccountState): Promise<void> }).recordReturnBurns.bind(m.op)
    await rec(acc)
    await rec(acc)
    expect(reads).toBe(1)
    expect(acc.releasesDone).toHaveLength(1)
    expect(releasesToCount(acc)).toEqual([{ id: `home-${'22'.repeat(12)}`, chainId: 8453, at: acc.releasesDone![0]!.at, home: HOME, owner: HOME, amount: 28_850_000n, block: 777, tx: `0x${'22'.repeat(32)}` }])
  })

  test('review r2: two passes at once (the settle and an exposure answer) record one release, one receipt read', async () => {
    const m = monad()
    const acc = m.state.accounts[rctx.accountKey]!
    acc.ops.push({ opId: 'own-1-exit', kind: 'exit', state: 'confirmed', txHash: `0x${'22'.repeat(32)}`, returnHome: RH, updatedAt: 't' } as never)
    let reads = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ;(m.op as unknown as { client: { getTransactionReceipt: () => Promise<unknown> } }).client.getTransactionReceipt = async () => (reads++, await gate, rc([burnLog()]))
    const rec = (m.op as unknown as { recordReturnBurns(a: AccountState): Promise<void> }).recordReturnBurns.bind(m.op)
    const a = rec(acc)
    const b = rec(acc)
    release()
    await Promise.all([a, b])
    expect(reads).toBe(1)
    expect(acc.releasesDone).toHaveLength(1)
  })

  test('review r2: a receipt with no burn log is read again a few times before it is final', async () => {
    const m = monad()
    const acc = m.state.accounts[rctx.accountKey]!
    acc.ops.push({ opId: 'own-1-exit', kind: 'exit', state: 'confirmed', txHash: `0x${'22'.repeat(32)}`, returnHome: RH, updatedAt: 't' } as never)
    let logs: unknown[] = []
    ;(m.op as unknown as { client: { getTransactionReceipt: () => Promise<unknown> } }).client.getTransactionReceipt = async () => rc(logs)
    const rec = (m.op as unknown as { recordReturnBurns(a: AccountState): Promise<void> }).recordReturnBurns.bind(m.op)
    await rec(acc)
    expect((acc.ops[0] as unknown as { returnRecorded?: string }).returnRecorded).toBeUndefined()
    logs = [burnLog()]
    await rec(acc)
    expect(acc.releasesDone).toHaveLength(1)
  })

  test('a receipt without the signed burn: no release, the reason kept on the op', async () => {
    const m = monad()
    const acc = m.state.accounts[rctx.accountKey]!
    acc.ops.push({ opId: 'own-1-exit', kind: 'exit', state: 'confirmed', txHash: `0x${'22'.repeat(32)}`, returnHome: RH, updatedAt: 't' } as never)
    ;(m.op as unknown as { client: { getTransactionReceipt: () => Promise<unknown> } }).client.getTransactionReceipt = async () => rc([burnLog({ recipient: `0x${'99'.repeat(20)}` })])
    await quiet(() => (m.op as unknown as { recordReturnBurns(a: AccountState): Promise<void> }).recordReturnBurns(acc))
    expect(acc.releasesDone ?? []).toHaveLength(0)
    expect((acc.ops[0] as unknown as { returnRecorded: string }).returnRecorded).toBe('RETURN_BURN_MISMATCH')
  })
})

describe('spec 014 plan: the sessions are read back once the return home confirmed', () => {
  const settled = (m: ReturnType<typeof monad>) => {
    const acc = m.state.accounts[rctx.accountKey]!
    acc.ops.push({ opId: 'own-1-exit', kind: 'exit', state: 'confirmed', txHash: `0x${'22'.repeat(32)}`, returnHome: RH, returnRecorded: 'burned', updatedAt: 't' } as never)
    return { acc, op: acc.ops[0] as unknown as { returnLeft?: number }, readBack: () => (m.op as unknown as { returnReadBack(a: AccountState): Promise<void> }).returnReadBack(acc) }
  }

  test('none left: recorded once, no alert, not read again', async () => {
    const m = monad({}, [])
    const s = settled(m)
    const { logged } = await quiet(() => s.readBack())
    expect(s.op.returnLeft).toBe(0)
    expect(logged.join('\n')).not.toContain('[alert]')
    m.chain.listed = [GRANTS[0]!]
    await s.readBack()
    expect(s.op.returnLeft).toBe(0)
  })

  test('a session still enabled: alerted and kept on the op, so the Monad step is offered again', async () => {
    const m = monad({}, [GRANTS[1]!])
    const s = settled(m)
    const { logged } = await quiet(() => s.readBack())
    expect(s.op.returnLeft).toBe(1)
    expect(logged.join('\n')).toContain('[alert]')
    expect(logged.join('\n')).toContain('1 session(s) still enabled')
  })

  test('the chain unreadable: nothing recorded, read again on the next pass', async () => {
    const m = monad({}, null)
    const s = settled(m)
    await quiet(() => s.readBack())
    expect(s.op.returnLeft).toBeUndefined()
    m.chain.listed = []
    await s.readBack()
    expect(s.op.returnLeft).toBe(0)
  })
})

describe('spec 014 RH-02: a signed return home is judged against the chain before it is sent', () => {
  const stale = (m: ReturnType<typeof monad>, revokes: Hex[], returnHome = true) =>
    (m.op as unknown as { stopStale(a: AccountState, l: unknown, p: unknown): Promise<string | null> }).stopStale(m.state.accounts[rctx.accountKey]!, { safe: SAFE }, { revokes, ...(returnHome ? { returnHome: { input: RH, safeTxHash: '0x' } } : {}) })

  test('it removes every session enabled now: sent, even when this account records a grant that is no longer enabled', async () => {
    // The account records GRANTS[0] and GRANTS[1]; only GRANTS[0] is enabled on chain, and that is what was signed.
    const m = monad({}, [GRANTS[0]!])
    expect(await stale(m, [GRANTS[0]!])).toBeNull()
  })

  test('a session enabled since the prepare is not removed by it: STOP_STALE, prepare again', async () => {
    const m = monad({}, [GRANTS[0]!, `0x${'0c'.repeat(32)}`])
    expect(await stale(m, [GRANTS[0]!])).toBe('STOP_STALE')
  })

  test('the enabled sessions unreadable: not sent', async () => {
    expect(await quiet(() => stale(monad({}, null), GRANTS)).then((r) => r.out)).toBe('GRANT_CHECK_UNAVAILABLE')
  })

  test('a plain Stop keeps its rule: every grant the account records is revoked by it', async () => {
    const m = monad({}, [])
    expect(await stale(m, GRANTS, false)).toBeNull()
    expect(await stale(m, [GRANTS[0]!], false)).toBe('STOP_STALE')
  })
})
