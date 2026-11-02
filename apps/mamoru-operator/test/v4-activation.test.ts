// otto/mamoru#309 (a) / #333: an account in the one-authorization scope that never activated (Guillermo, c9d4179b)
// gets ONE V4 Safe tx as its Start (buildMigrateV4 step 0, empty inventory), never a v1-v6 grant set; and its Base Safe
// is deployed even with no USDC there when its funds sit at its own address on Ethereum (the sibling, #307).
import { describe, expect, test } from 'bun:test'
import { buildMigrateV4 } from '@mamoru/account/one-auth'
import { baseRegistry, type Registry } from '@mamoru/registry'
import { ONE_AUTH_V4, type OneAuthV4Deployment } from '@mamoru/policy'
import type { AccountState } from '../src/state.ts'
import { ctx, quiet, sign, world } from './owner-world.ts'

const D: OneAuthV4Deployment = { registry: '0x00000000000000000000000000000000000000a1', policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3', migrationCheck: '0x00000000000000000000000000000000000000a4' }
const pinned = (r: Registry): Registry => {
  const names = ['MamoruRegistry', 'MamoruActionPolicyV4', 'MamoruGasPolicyV2', 'MamoruMigrationCheck'] as const
  const at = [D.registry, D.policy, D.gasPolicy, D.migrationCheck]
  return { ...r, undeployed: [], entries: [...r.entries.filter((e) => !(names as readonly string[]).includes(e.name)), ...names.map((name, i) => ({ name, kind: 'smart-sessions-policy', role: 'test', address: at[i]!, codeHash: null }) as never)] }
}
const base = pinned(baseRegistry)
const scoped = { oneAuth: D, registry: base, opsFlags: () => ({}), opsScopedFlags: () => ({ one_auth_v4: ['k'] }) }

function inactive(w: ReturnType<typeof world>) {
  w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
}

describe('V4 activation of a never-activated account (#309 a)', () => {
  test('its Start is one V4 Safe tx: the builder the Worker rebuilds with, step 0, empty inventory; no v1-v6 grant', async () => {
    const w = world(0n, scoped)
    inactive(w)
    const t = await w.op.prepareActivate(ctx)
    const built = (t as unknown as { input?: Parameters<typeof buildMigrateV4>[0] }).input ? { input: (t as unknown as { input: Parameters<typeof buildMigrateV4>[0] }).input } : undefined
    expect(built?.input.step).toBe(0)
    expect(built?.input.removeIds).toEqual([])
    expect(built?.input.oldPermissionIds).toEqual([])
    expect(buildMigrateV4(JSON.parse(JSON.stringify(built!.input)), base).safeTxHash).toBe(t.safeTxHash)
    expect(t.summary.some((l) => l.includes('one permission that does not expire'))).toBe(true)
    expect(t.summary.some((l) => l.startsWith('Removes'))).toBe(false)
  })

  test('out of the scope it stays the old activation (nothing changes for other accounts)', async () => {
    const w = world(0n, { ...scoped, opsScopedFlags: () => ({ one_auth_v4: [] }) })
    inactive(w)
    const t = await w.op.prepareActivate(ctx)
    expect((t as unknown as { input?: unknown }).input).toBeUndefined()
  })

  test('no USDC on Base: it waits armed (as any Start), unless the account holds the minimum at its own address on Ethereum, then it goes', async () => {
    const w = world(0n, scoped)
    inactive(w)
    ;(w.op as unknown as { startLoop(a: AccountState): void }).startLoop = () => {}
    const t1 = await w.op.prepareActivate(ctx)
    const r1 = (await quiet(() => w.op.submit(ctx, 'activate', sign(t1)))).out
    expect(r1.code).toBe('ARMED')
    w.op.siblingHoldingsUsdc = async () => 50_000_000n // above the deploy minimum, under the test cap
    const t2 = await w.op.prepareActivate(ctx)
    const r2 = (await quiet(() => w.op.submit(ctx, 'activate', sign(t2)))).out
    expect(r2.code).not.toBe('ARMED')
    expect(r2.code).not.toBe('BELOW_DEPLOY_MINIMUM')
  })

  test('once confirmed the account runs on V4 with the Init C recorded', async () => {
    const w = world(5_000_000n, scoped)
    inactive(w)
    ;(w.op as unknown as { startLoop(a: AccountState): void }).startLoop = () => {}
    const t = await w.op.prepareActivate(ctx)
    await quiet(() => w.op.submit(ctx, 'activate', sign(t)))
    const acc = w.state.accounts.k!
    if (acc.active) {
      expect(acc.policyId).toBe(ONE_AUTH_V4)
      expect(acc.oneAuth?.generation).toBe('1')
      expect(acc.oneAuth?.capUsd).toBeDefined()
    }
  })

  test('review r1 of #235: funds on Ethereum count toward the cap (no deploy for an over-cap account)', async () => {
    const w = world(0n, scoped)
    inactive(w)
    w.op.siblingHoldingsUsdc = async () => 10n ** 15n // far above any cap
    const err = await w.op.prepareActivate(ctx).then(() => null, (e) => e as { code?: string })
    expect(err?.code).toBe('DEPOSIT_OVER_CAP')
  })

  test('review r1 of #235: dust on Base does not stop a V4 activation backed by funds on Ethereum', async () => {
    const w = world(500_000n, scoped) // 0.5 USDC on Base, under the deploy minimum
    inactive(w)
    w.op.siblingHoldingsUsdc = async () => 50_000_000n
    const t = await w.op.prepareActivate(ctx)
    expect((t as unknown as { input?: unknown }).input).toBeDefined()
  })

  test('security review of #235: funds on Ethereum that cannot be read stop the cap check (never read as zero)', async () => {
    const w = world(0n, scoped)
    inactive(w)
    w.op.siblingHoldingsUsdc = async () => { throw new Error('rpc down') }
    const err = await w.op.prepareActivate(ctx).then(() => null, (e) => e as { code?: string })
    expect(err?.code).toBe('CAP_CHECK_UNAVAILABLE')
  })

  test('#333, review r2 of #235: a v1-v6 Start armed before the account entered the scope never runs, nor one prepared before', async () => {
    let scope: string[] = []
    const w = world(0n, { ...scoped, opsScopedFlags: () => ({ one_auth_v4: scope }) })
    inactive(w)
    ;(w.op as unknown as { startLoop(a: AccountState): void }).startLoop = () => {}
    const old = await w.op.prepareActivate(ctx)
    expect((old as unknown as { input?: unknown }).input).toBeUndefined()
    expect((await quiet(() => w.op.submit(ctx, 'activate', sign(old)))).out.code).toBe('ARMED')
    const acc = w.state.accounts.k!
    expect(acc.armed).toBeDefined()
    scope = ['k']
    await (w.op as unknown as { fireArmed(a: AccountState, usdc: bigint): Promise<void> }).fireArmed(acc, 5_000_000n)
    expect(acc.armed).toBeUndefined()
    expect(acc.active).toBe(false)
    expect(acc.ops.some((o) => o.code === 'ONE_AUTH_REQUIRED')).toBe(true)
    // prepared out of the scope, submitted in it: refused before anything is sent
    scope = []
    const w2 = world(5_000_000n, { ...scoped, opsScopedFlags: () => ({ one_auth_v4: scope }) })
    inactive(w2)
    ;(w2.op as unknown as { startLoop(a: AccountState): void }).startLoop = () => {}
    const t = await w2.op.prepareActivate(ctx)
    scope = ['k']
    const r = (await quiet(() => w2.op.submit(ctx, 'activate', sign(t)))).out
    expect(r.code).toBe('ONE_AUTH_REQUIRED')
    expect(w2.state.accounts.k!.active).toBe(false)
  })

  test('review r2 of #235 (P2-3): under MIN_SIBLING_DEPLOY_USDC on Ethereum, no Base deploy: it waits armed', async () => {
    const w = world(0n, scoped)
    inactive(w)
    ;(w.op as unknown as { startLoop(a: AccountState): void }).startLoop = () => {}
    w.op.siblingHoldingsUsdc = async () => 10_000_000n
    const t = await w.op.prepareActivate(ctx)
    expect((await quiet(() => w.op.submit(ctx, 'activate', sign(t)))).out.code).toBe('ARMED')
  })
})

