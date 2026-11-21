// otto/mamoru#428 (spec 014, step 1 of leaving Monad), the Monad side: a return home on a design-C Safe is ONE owner
// Safe tx built by buildReturnHome (remove every session, burn the whole USDC to the owner's Base Safe), held as a Stop.
// Refused while a position is open or WMON is held. The confirmed burn is kept as an owner-signed release, reported home.
import { describe, expect, test } from 'bun:test'
import type { Hex, PublicClient } from 'viem'
import type { AccountContext, Address, RemoteSpec } from '@mamoru/domain'
import { buildReturnHome } from '@mamoru/account/return-home'
import { monadRegistry } from '@mamoru/registry'
import { liveWmonUsdcMonadV6 } from '@mamoru/policy'
import { monadV6Deployed, remoteAccountKey, remoteInput, remoteSafe } from '@mamoru/account/remote'
import { HttpError, Operator } from '../src/operator.ts'
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

function monad(read: Partial<Read> = {}) {
  const client = { getBlockNumber: async () => 500n, getCode: async () => '0x01', readContract: async ({ functionName }: { functionName: string }) => (functionName === 'nonce' ? 5n : 0n) } as unknown as PublicClient
  const state = { accounts: {} as Record<string, AccountState> }
  const store = { state, save: () => {} } as unknown as StateStore
  const op = new Operator({ chainId: 143, registry, chainWrites: [143], live: true, rpcUrl: '', bundlerUrl: '', policy: monadV6Deployed(registry), reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }, client, { address: `0x${'7'.repeat(40)}` } as unknown as Relayer, store)
  state.accounts[rctx.accountKey] = { accountKey: rctx.accountKey, ctx: rctx, active: true, trusted: true, policyId: liveWmonUsdcMonadV6.policyId, grants: GRANTS.map((permissionId, i) => ({ name: `g${i}`, permissionId, grant: {} })), ops: [], revoked: [] } as unknown as AccountState
  const held: { kind: string; calls: { to: string; data: Hex }[]; summary: string[]; extra: Record<string, unknown> }[] = []
  const p = op as unknown as Record<string, unknown>
  p.enforceGrants = async () => true
  p.readOf = async () => ({ deployed: true, usdc: 28_850_000n, tokens: { USDC: 28_850_000n }, positions: [], block: 500n, ...read })
  p.hold = async (_a: AccountState, _l: unknown, kind: string, calls: { to: string; data: Hex }[], summary: string[], extra: Record<string, unknown>) => (held.push({ kind, calls, summary, extra }), { safeTxHash: '0x' })
  return { op, held, state }
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
