// otto/mamoru#428 (spec 014, step 1 of leaving Monad), the Monad side: a return home on a design-C Safe is ONE owner
// Safe tx built by buildReturnHome (remove every session, burn the whole USDC to the owner's Base Safe), held as a Stop.
// Refused while a position is open or WMON is held. The confirmed burn is kept as an owner-signed release, reported home.
import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, pad, type Hex, type PublicClient } from 'viem'
import type { AccountContext, Address, RemoteSpec } from '@mamoru/domain'
import { buildMonadSell, buildReturnHome, MONAD_SELL_TWAP_WINDOW_SECONDS, monadSellMinOut, monadSellTwapValue, TOKEN_MESSENGER_V2, type MonadSellInput } from '@mamoru/account/return-home'
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

// SCN-RH-02 (spec 014 RH-07): step A0, the owner sale on a Safe whose engine cannot sell.
describe('monad-sell (step A0) on the Monad operator', () => {
  const W = 120n * 10n ** 18n
  // WMON (token0, 18 decimals) at about 0.03 USDC (token1, 6 decimals).
  const TICK = Math.floor(Math.log(0.03e6 / 1e18) / Math.log(1.0001))
  const WORTH = monadSellTwapValue(W, TICK, registry)
  /**
   * A Safe with `wmon` and 300 USDC. `held`: the action policy's deferred depth check is still owed and the pool is under the
   * session's daily budget (#410), so the engine's own sale is refused. `quote`: QuoterV2's answer for the whole sale.
   */
  function sellWorld(o: { wmon?: bigint; held?: boolean; quote?: bigint; positions?: Read['positions']; poolDown?: boolean } = {}) {
    const m = monad({ usdc: 300_000_000n, tokens: { USDC: 300_000_000n, WMON: o.wmon ?? W }, positions: o.positions ?? [] })
    const knobs = { quote: o.quote ?? WORTH, held: o.held ?? true, poolDown: o.poolDown ?? false }
    const p = m.op as unknown as { client: Record<string, unknown>; v3: Record<string, unknown> }
    p.client.readContract = async ({ functionName }: { functionName: string }) => {
      if (knobs.poolDown && functionName !== 'nonce') throw new Error('rpc down')
      switch (functionName) {
        case 'nonce': return 5n
        case 'configOf': return { twapWindow: 1800, twapShortWindow: 300, bandTicks: 500, generation: 1n, budgetIn1: true, budgetWindow: 86_400, anchorTick: 0, anchorBand: 0, perWindow: 10n ** 30n, total: 10n ** 31n, initHash: `0x${'00'.repeat(32)}` }
        case 'spendOf': return { generation: 1n, updatedAt: knobs.held ? 0n : 1_790_000_000n, in1: true, debt: 0n, total: 0n }
        case 'slot0': return [2n ** 96n, 0, 0, 0, 0, 0, true]
        case 'liquidity': return 10n ** 12n
        case 'tickSpacing': return 60
        case 'ticks': return [0n, 0n, 0n, 0n, 0n, 0n, 0, false]
        case 'observe': return [[0n, BigInt(TICK) * BigInt(MONAD_SELL_TWAP_WINDOW_SECONDS)], [0n, 0n]]
        default: return 0n
      }
    }
    p.v3 = { ...p.v3, quoteExactInputSingle: async () => knobs.quote }
    return { ...m, knobs }
  }

  test('a depth-held Safe with 0 positions, 120 WMON and 300 USDC: one transfer-kind owner tx of the builder, nothing revoked, not a Stop', async () => {
    const m = sellWorld()
    await m.op.prepareMonadSell(rctx)
    const h = m.held[0]!
    expect(h.kind).toBe('transfer')
    const input = (h.extra.monadSell as { input: MonadSellInput; safeTxHash: string }).input
    expect(input).toEqual({ chainId: 143, safe: SAFE, safeNonce: '5', amountIn: W.toString(), amountOutMinimum: monadSellMinOut(WORTH).toString(), deadline: input.deadline })
    // Review r1: the batch carries a deadline 15 minutes ahead, so the signature is worth nothing later.
    const ahead = Number(input.deadline) - Math.floor(Date.now() / 1000)
    expect(ahead).toBeGreaterThan(14 * 60)
    expect(ahead).toBeLessThanOrEqual(15 * 60)
    const built = buildMonadSell(input, registry)
    expect(h.calls.map((c) => c.data)).toEqual(built.calls.map((c) => c.data))
    expect((h.extra.monadSell as { safeTxHash: string }).safeTxHash).toBe(built.safeTxHash)
    expect(h.extra.revokes).toBeUndefined()
    expect(h.extra.returnHome).toBeUndefined()
    expect(h.calls.some((c) => c.to.toLowerCase() === address('SmartSession', registry).toLowerCase() || c.to.toLowerCase() === TOKEN_MESSENGER_V2.toLowerCase())).toBe(false)
    expect(h.summary).toEqual([`Sell 120 WMON in your Safe on Monad for at least ${(Math.floor(Number(monadSellMinOut(WORTH)) / 1e4) / 100).toFixed(2)} USDC, so all of it can come home`])
    // The account is as it was: active, its grants untouched.
    expect(m.state.accounts[rctx.accountKey]).toMatchObject({ active: true })
    expect(m.state.accounts[rctx.accountKey]!.grants).toHaveLength(2)
  })

  test('while WMON is held, step A is refused (MONAD_UNWIND_PENDING): the sale comes first', async () => {
    expect(await code(sellWorld().op.prepareReturnHome(rctx, { home: HOME }))).toBe('MONAD_UNWIND_PENDING')
  })

  test('refused: an open position, WMON at dust, a Safe the engine can sell for itself (not depth-held), off Monad', async () => {
    expect(await code(sellWorld({ positions: [{ tokenId: 1n, liquidity: 5n, tokensOwed0: 0n, tokensOwed1: 0n }] }).op.prepareMonadSell(rctx))).toBe('MONAD_UNWIND_PENDING')
    expect(await code(sellWorld({ wmon: 10n ** 16n }).op.prepareMonadSell(rctx))).toBe('NOTHING_TO_SELL')
    expect(await code(sellWorld({ held: false }).op.prepareMonadSell(rctx))).toBe('MONAD_UNWIND_PENDING')
    expect(await code(sellWorld().op.prepareMonadSell({ ...rctx, remote: { ...SPEC, policyId: 'one-auth-v4-remote' } }))).toBe('NOT_A_REMOTE')
  })

  test('the pool cannot be read: nothing prepared, nothing recorded (REMOTE_UNAVAILABLE)', async () => {
    const m = sellWorld({ poolDown: true })
    expect(await code(m.op.prepareMonadSell(rctx))).toBe('REMOTE_UNAVAILABLE')
    expect(m.held).toHaveLength(0)
    expect(m.state.accounts[rctx.accountKey]!.monadSellRefused).toBeUndefined()
  })

  test('a quote more than 300 bps under the TWAP value: MONAD_DEPTH_TOO_LOW, kept on the account with what was read', async () => {
    const quote = (WORTH * 9_700n) / 10_000n - 1n
    const m = sellWorld({ quote })
    expect(await code(m.op.prepareMonadSell(rctx))).toBe('MONAD_DEPTH_TOO_LOW')
    expect(m.held).toHaveLength(0)
    expect(m.state.accounts[rctx.accountKey]!.monadSellRefused).toMatchObject({ code: 'MONAD_DEPTH_TOO_LOW', wmon: W.toString(), quote: quote.toString(), twapValue: WORTH.toString(), block: '500' })
  })

  test("only the operator's own refusal lets the USDC go home alone, and the summary says the WMON stays", async () => {
    const m = sellWorld({ quote: 1n })
    expect(await code(m.op.prepareReturnHome(rctx, { home: HOME }))).toBe('MONAD_UNWIND_PENDING')
    expect(await code(m.op.prepareMonadSell(rctx))).toBe('MONAD_DEPTH_TOO_LOW')
    await m.op.prepareReturnHome(rctx, { home: HOME })
    const h = m.held[0]!
    expect(h.kind).toBe('stop')
    expect((h.extra.returnHome as { input: { amountUsdc: string; removeIds: Hex[] } }).input).toMatchObject({ amountUsdc: '300000000', removeIds: GRANTS })
    expect(h.summary).toContain('Your 120 WMON stays in this Safe: it cannot be sold at a fair price right now. You can withdraw it')
  })

  test('the refusal stands only for that WMON balance, for an hour, and until a sale prepare passes', async () => {
    const refused = (m: ReturnType<typeof sellWorld>) => m.state.accounts[rctx.accountKey]!
    // Another balance.
    const a = sellWorld({ quote: 1n })
    await code(a.op.prepareMonadSell(rctx))
    refused(a).monadSellRefused!.wmon = (W - 1n).toString()
    expect(await code(a.op.prepareReturnHome(rctx, { home: HOME }))).toBe('MONAD_UNWIND_PENDING')
    // Older than an hour.
    const b = sellWorld({ quote: 1n })
    await code(b.op.prepareMonadSell(rctx))
    refused(b).monadSellRefused!.at = new Date(Date.now() - 61 * 60_000).toISOString()
    expect(await code(b.op.prepareReturnHome(rctx, { home: HOME }))).toBe('MONAD_UNWIND_PENDING')
    // The pool recovered: the next sale prepare passes and clears it, so step A waits for the sale again.
    const c = sellWorld({ quote: 1n })
    await code(c.op.prepareMonadSell(rctx))
    c.knobs.quote = WORTH
    await c.op.prepareMonadSell(rctx)
    expect(refused(c).monadSellRefused).toBeUndefined()
    expect(await code(c.op.prepareReturnHome(rctx, { home: HOME }))).toBe('MONAD_UNWIND_PENDING')
  })

  test('with an open position the refusal unlocks nothing', async () => {
    const m = sellWorld({ quote: 1n })
    await code(m.op.prepareMonadSell(rctx))
    ;(m.op as unknown as { readOf: () => Promise<unknown> }).readOf = async () => ({ deployed: true, usdc: 300_000_000n, tokens: { USDC: 300_000_000n, WMON: W }, positions: [{ tokenId: 1n, liquidity: 5n, tokensOwed0: 0n, tokensOwed1: 0n }], block: 500n })
    expect(await code(m.op.prepareReturnHome(rctx, { home: HOME }))).toBe('MONAD_UNWIND_PENDING')
  })

  test('after the sale confirms, step A burns the exact new balance: nothing is left behind', async () => {
    const m = sellWorld()
    const after = 300_000_000n + monadSellMinOut(WORTH) + 1_234n
    ;(m.op as unknown as { readOf: () => Promise<unknown> }).readOf = async () => ({ deployed: true, usdc: after, tokens: { USDC: after, WMON: 0n }, positions: [], block: 501n })
    await m.op.prepareReturnHome(rctx, { home: HOME })
    expect((m.held[0]!.extra.returnHome as { input: { amountUsdc: string } }).input.amountUsdc).toBe(after.toString())
    expect(m.held[0]!.summary.join('\n')).not.toContain('WMON stays')
  })

  // SCN-RH-06 (Monad side): return-home/status, what the Base operator's "What's new" view is built from.
  describe('return-home/status says the next step, with the lines its prepare shows', () => {
    test('a depth-held Safe: the sale next, its line the prepare\'s own, and the return home named as a minimum after it', async () => {
      const m = sellWorld()
      const st = await m.op.returnHomeStatus(rctx, { home: HOME })
      expect(st).toMatchObject({ next: 'monad-sell', sessions: 2, usdc: '300000000', wmon: W.toString(), openPositions: 0, block: '500' })
      await m.op.prepareMonadSell(rctx)
      expect(st.sell).toEqual(m.held[0]!.summary)
      const floor = (Math.floor(Number(300_000_000n + monadSellMinOut(WORTH)) / 1e4) / 100).toFixed(2)
      expect(st.home.join('\n')).toContain(`Send your USDC after the sale (at least ${floor} USDC) from your Safe on Monad to your Safe on Base ${HOME}`)
    })

    test('no WMON left: the return home next, its lines equal to the prepare\'s', async () => {
      const m = sellWorld({ wmon: 0n })
      const st = await m.op.returnHomeStatus(rctx, { home: HOME })
      expect(st.next).toBe('return-home')
      await m.op.prepareReturnHome(rctx, { home: HOME })
      expect(st.home).toEqual(m.held[0]!.summary)
    })

    test('the sale was refused for depth: the return home next, saying the WMON stays, as its prepare does', async () => {
      const m = sellWorld({ quote: 1n })
      await code(m.op.prepareMonadSell(rctx))
      const st = await m.op.returnHomeStatus(rctx, { home: HOME })
      expect(st.next).toBe('return-home')
      await m.op.prepareReturnHome(rctx, { home: HOME })
      expect(st.home).toEqual(m.held[0]!.summary)
    })

    test('an open position, or WMON the engine can sell itself: unwinding', async () => {
      expect((await sellWorld({ positions: [{ tokenId: 1n, liquidity: 5n, tokensOwed0: 0n, tokensOwed1: 0n }] }).op.returnHomeStatus(rctx, { home: HOME })).next).toBe('unwinding')
      expect((await sellWorld({ held: false }).op.returnHomeStatus(rctx, { home: HOME })).next).toBe('unwinding')
    })

    test('no session and no USDC: done, whatever WMON stays; a Stop or a sale on its way: in-flight', async () => {
      const done = monad({ usdc: 0n, tokens: { WMON: W } }, [])
      expect(await done.op.returnHomeStatus(rctx, { home: HOME })).toMatchObject({ next: 'done', sessions: 0, home: [] })
      const m = sellWorld()
      m.state.accounts[rctx.accountKey]!.ops.push({ opId: 'own-1-reduce', kind: 'reduce', state: 'submitted', monadSell: {}, updatedAt: new Date().toISOString() } as never)
      expect((await m.op.returnHomeStatus(rctx, { home: HOME })).next).toBe('in-flight')
    })

    test('unreadable sessions or pool: 503, nothing guessed; no home, or not a design-C Safe: refused', async () => {
      expect(await code(monad({}, null).op.returnHomeStatus(rctx, { home: HOME }))).toBe('REMOTE_UNAVAILABLE')
      expect(await code(sellWorld({ poolDown: true }).op.returnHomeStatus(rctx, { home: HOME }))).toBe('REMOTE_UNAVAILABLE')
      expect(await code(monad().op.returnHomeStatus(rctx, {}))).toBe('BAD_REQUEST')
      expect(await code(monad().op.returnHomeStatus({ ...rctx, remote: { ...SPEC, policyId: 'one-auth-v4-remote' } }, { home: HOME }))).toBe('NOT_A_REMOTE')
    })
  })

  test('only a sale prepare is sent through the monad-sell submit', async () => {
    const m = sellWorld()
    expect(await code(m.op.submitMonadSell(rctx, { prepareId: 'nope' } as never))).toBe('PREPARE_UNKNOWN')
  })
})
