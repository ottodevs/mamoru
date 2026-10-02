import { describe, expect, test } from 'bun:test'
import type { DashboardPayload, OwnerResponse, PoolsResponse, Provenance } from '@mamoru/domain'
import { PRODUCTION_BANNER } from '@mamoru/domain'
import { harness, register, PASSKEY_A, PASSKEY_B, sessionCookie } from './helpers.ts'
import { BLOCK, BLOCK_HASH, poolView, tokens } from './fixtures.ts'

const T0 = new Date('2026-09-26T18:00:00Z')

async function onboard(h: ReturnType<typeof harness>, passkey = PASSKEY_A) {
  const res = await register(h, passkey)
  return { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
}

function provenances(v: unknown, out: Provenance[] = []): Provenance[] {
  if (Array.isArray(v)) v.forEach((x) => provenances(x, out))
  else if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    if (typeof o.source === 'string' && typeof o.chainId === 'number' && typeof o.status === 'string') out.push(o as Provenance)
    else Object.values(o).forEach((x) => provenances(x, out))
  }
  return out
}

async function dashboard(h: ReturnType<typeof harness>, cookie: string, key: string) {
  const res = await h.request(`/api/accounts/${key}/dashboard`, { cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as DashboardPayload
}

function seedPool(h: ReturnType<typeof harness>, observedAt: string) {
  const p = poolView(observedAt)
  h.db.raw
    .query('INSERT INTO proj_pool_state (chain_id, pool_address, block, block_hash, observed_at, source, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(8453, p.pool.address, BLOCK, BLOCK_HASH, observedAt, 'chain_rpc', JSON.stringify(p))
}

describe('dashboard, empty account (dashboard.md §7 "Vacío")', () => {
  test('production shape: banner, Base only, gate closed, no actions derived, nothing invented', async () => {
    let now = T0
    const h = harness(() => now)
    const { cookie, owner } = await onboard(h)
    const d = await dashboard(h, cookie, owner.accountKey)

    expect(d.mode).toBe('production')
    expect(d.chainId).toBe(8453)
    expect(d.chains).toEqual([{ chainId: 8453, name: 'Base', observed: true }])
    expect(d.banner).toEqual({ kind: 'simulation', text: PRODUCTION_BANNER })
    expect(d.account.key).toBe(owner.accountKey)
    expect(d.account.address.value).toBe(owner.address)
    expect(d.account.address.provenance).toMatchObject({ source: 'd1', detail: 'ONB_ADDRESS_MATCH', status: 'fresh' })
    expect(d.account.fundsGate).toBe('closed')
    expect(d.account.preset).toBe('conservador')
    expect(d.actions.items).toEqual([])
    expect(d.actions.complete).toBe(false)
    expect(d.actions.notObserved).toEqual(expect.arrayContaining(['journal', 'account state', 'source health', 'pool state']))
    expect(d.treasury.convert.state).toBe('held')
    expect(d.treasury.convert.code).toBe('FUNDS_GATE_CLOSED')
    expect(d.pools).toEqual({ positions: [], plan: [] })
    expect(d.provenanceComplete).toBe(false)
  })

  test('with no projection every chain figure is null + not_observed, never zero', async () => {
    const h = harness()
    const { cookie, owner } = await onboard(h)
    const d = await dashboard(h, cookie, owner.accountKey)
    for (const f of [d.account.deployed, d.account.totalValue, d.treasury.idle.usdc, d.treasury.gasReserve, d.savings.ledgerTotal, d.currentAction.session]) {
      expect(f.value).toBeNull()
      expect(f.provenance.status).toBe('not_observed')
    }
    expect(d.account.totalMissing).toEqual(['account state'])
    expect(d.sources.rpc.status).toBe('unavailable')
    expect(provenances(d).every((p) => p.chainId === 8453)).toBe(true)
  })

  test('the engine projection fills the figures with block provenance and ages them after two cron periods', async () => {
    let now = T0
    const h = harness(() => now)
    const { cookie, owner } = await onboard(h)
    const at = T0.toISOString()
    h.db.raw
      .query('INSERT INTO proj_account_state (account_key, chain_id, block, block_hash, observed_at, deployed, tokens_json, total_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(owner.accountKey, 8453, BLOCK, BLOCK_HASH, at, 0, JSON.stringify(tokens(at)), null)
    h.db.raw
      .query('INSERT INTO source_state (chain_id, rpc_status, block, safe_block, observed_at, index_provider, index_status, index_block, index_code, index_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(8453, 'ok', BLOCK, BLOCK - 10, at, 'multibaas', 'not_indexing_base', null, 'MB_BASE_INDEXING_ABSENT', at)
    seedPool(h, at)

    const d = await dashboard(h, cookie, owner.accountKey)
    expect(d.account.deployed).toEqual({ value: false, provenance: { source: 'chain_rpc', chainId: 8453, blockNumber: BLOCK, blockHash: BLOCK_HASH, observedAt: at, status: 'fresh' } })
    expect(d.treasury.idle.usdc.value).toBe('0')
    expect(d.account.totalValue.value).toBeNull()
    expect(d.account.totalMissing).toEqual(['cbBTC value'])
    expect(d.sources).toEqual({
      rpc: { status: 'ok', block: BLOCK, safeBlock: BLOCK - 10, observedAt: at },
      index: { provider: 'multibaas', status: 'not_indexing_base', code: 'MB_BASE_INDEXING_ABSENT', checkedAt: at },
    })
    expect(d.banner.block).toBe(BLOCK)
    expect(d.pools.plan).toHaveLength(1)
    expect(d.actions.notObserved).not.toContain('account state')

    now = new Date(T0.getTime() + 4 * 60_000 + 1)
    const later = await dashboard(h, cookie, owner.accountKey)
    expect(later.account.deployed.provenance.status).toBe('stale')
    expect(later.pools.plan[0]!.price.provenance.status).toBe('stale')
    expect(later.account.address.provenance.status).toBe('fresh')
  })
})

describe('isolation (TEN)', () => {
  test('another session, no session, and an unknown key all miss the account', async () => {
    const h = harness()
    const a = await onboard(h, PASSKEY_A)
    const b = await onboard(h, PASSKEY_B)
    const foreign = await h.request(`/api/accounts/${a.owner.accountKey}/dashboard`, { cookie: b.cookie })
    const unknown = await h.request(`/api/accounts/${crypto.randomUUID()}/dashboard`, { cookie: b.cookie })
    expect(foreign.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(await foreign.json()).toEqual(await unknown.json())
    expect((await h.request(`/api/accounts/${a.owner.accountKey}/dashboard`)).status).toBe(401)
    expect((await h.request(`/api/accounts/not-a-key/dashboard`, { cookie: a.cookie })).status).toBe(404)
  })
})

describe('pools', () => {
  test('empty before the engine syncs', async () => {
    const res = await harness().request('/api/pools')
    expect((await res.json()) as PoolsResponse).toEqual({ chainId: 8453, pools: [], syncedAt: null })
  })

  test('passes the projected PoolView through unchanged while fresh; no session needed', async () => {
    const h = harness()
    const at = T0.toISOString()
    seedPool(h, at)
    h.db.raw
      .query('INSERT INTO proj_pool_state (chain_id, pool_address, block, block_hash, observed_at, source, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(31337, '0x0000000000000000000000000000000000000001', 1, BLOCK_HASH, at, 'fork_rpc', JSON.stringify(poolView(at)))
    const body = (await (await h.request('/api/pools')).json()) as PoolsResponse
    expect(body).toEqual({ chainId: 8453, pools: [poolView(at)], syncedAt: at })
  })
})
