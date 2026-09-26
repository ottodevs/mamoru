import { describe, expect, test } from 'bun:test'
import type { DashboardPayload, Provenance } from '@mamoru/domain'
import { emptyAccount } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { DashboardView } from '../../src/web/panels/dashboard-view.tsx'
import type { PlanPools } from '../../src/web/panels/pools.tsx'
import { count, render } from './render.ts'

const ready: PlanPools = { status: 'ready', pools: poolsResponse.pools }

function view(data: DashboardPayload, plan: PlanPools = ready) {
  return render(<DashboardView data={data} plan={plan} kitState="idle" onDownloadKit={() => {}} />)
}

const clone = (): DashboardPayload => structuredClone(emptyAccount)

describe('empty production account (dashboard.md §7 "Vacío")', () => {
  const { html, text } = view(emptyAccount)

  test('header names the account, the chain and the sources', () => {
    expect(text).toContain('Base · 8453')
    expect(text).toContain('Other chains: not observed in v1.')
    expect(text).toContain('Not deployed')
    expect(text).toContain('Conservador')
    expect(text).toContain('MultiBaas · Base · indexed to block')
    expect(text).toContain('Copy address')
    expect(text).toContain('View on Basescan')
  })

  test('each view shows its empty state copy', () => {
    for (const copy of [
      'Nothing needs your decision.',
      'Mamoru has not reviewed your account yet. The first review runs within five minutes.',
      'No operations on Base yet. In simulation mode Mamoru sends nothing.',
      'No session. Deposits are closed.',
      'Nothing in your treasury yet. Deposits are closed.',
      'No positions. Deposits are closed.',
      'No savings yet. Deposits are closed.',
      'No harvests yet. In simulation mode Mamoru collects nothing.',
      "Only tokens in Mamoru's registry are observed: USDC, cbBTC, WETH and ETH.",
    ]) {
      expect(text).toContain(copy)
    }
  })

  test('zeros read at a block carry their chip; a null figure says Not observed', () => {
    expect(text).toContain('0 USDC')
    expect(count(html, 'data-testid="chip"')).toBeGreaterThan(20)
    expect(text).toContain('Base · block 52114380')
    expect(text).toContain('Mamoru database · Base')
    expect(count(html, 'data-testid="not-observed"')).toBe(1)
  })

  test('intents are disabled once each, with the closed-deposits reason', () => {
    expect(count(html, '>Pause</button>')).toBe(1)
    expect(count(html, '>Exit</button>')).toBe(1)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Pause<\/button>/)
    expect(text).toContain('Nothing to manage. Deposits are closed.')
  })

  test('no deposit, convert, sell or collect button', () => {
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1] ?? '')
    for (const label of buttons) expect(label).not.toMatch(/deposit|convert|sell|collect|harvest/i)
  })

  test('copy has no em dash and no emoji', () => {
    expect(text).not.toContain('\u2014')
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  test('pools in your plan paint reconciled rows with their chips', () => {
    expect(text).toContain('Uniswap V3 · USDC/cbBTC 0.05%')
    expect(text).toContain('In 25,000 USDC, out 0.38190331 cbBTC')
    expect(text).toContain('MultiBaas · Base · checked at block 52114380')
    expect(text).toContain('1,284')
    expect(text).toContain('Leave without Mamoru')
    expect(text).toContain('Download recovery kit')
  })
})

describe('data states', () => {
  test('RPC down: figures say Not observed, never zero', () => {
    const d = clone()
    const missing: Provenance = { source: 'chain_rpc', chainId: 8453, observedAt: d.sources.rpc.observedAt, status: 'not_observed', detail: 'OBS_RPC_UNAVAILABLE' }
    d.sources.rpc = { status: 'unavailable', observedAt: d.sources.rpc.observedAt }
    d.portfolio.tokens = d.portfolio.tokens.map((t) => ({ ...t, amount: { value: null, unit: t.token, provenance: missing } }))
    d.account.totalValue = { value: null, unit: 'USDC', provenance: { ...missing, source: 'estimate' } }
    d.account.totalMissing = ['cbBTC price']
    const { html, text } = view(d)
    expect(text).toContain('Base RPC not responding')
    expect(text).toContain('Missing: cbBTC price')
    expect(count(html, 'data-testid="not-observed"')).toBeGreaterThanOrEqual(6)
  })

  test('incomplete actions never claim there is nothing to decide', () => {
    const d = clone()
    d.actions = { items: [], complete: false, notObserved: ['session', 'balances'] }
    const { text } = view(d)
    expect(text).toContain('Mamoru could not check everything. Not observed: session, balances')
    expect(text).not.toContain('Nothing needs your decision.')
  })

  test('an action shows its code next to its text', () => {
    const d = clone()
    const since = { value: '2026-09-26T18:00:00.000Z', provenance: { source: 'chain_rpc' as const, chainId: 8453, blockNumber: 1, observedAt: '2026-09-26T18:00:00.000Z', status: 'fresh' as const } }
    d.actions.items = [
      {
        id: 'SESSION_REVOKED:session',
        code: 'SESSION_REVOKED',
        kind: 'understand',
        subject: { kind: 'session' },
        title: 'Session revoked',
        body: "You revoked Mamoru's session. Mamoru only watches your account now.",
        since,
        sources: [since.provenance],
      },
    ]
    const { text } = view(d)
    expect(text).toContain("Session revoked Understand SESSION_REVOKED You revoked Mamoru's session.")
  })

  test('stale projection shows the update time', () => {
    const d = clone()
    d.savings.ledgerTotal = { ...d.savings.ledgerTotal, provenance: { ...d.savings.ledgerTotal.provenance, status: 'stale' } }
    expect(view(d).text).toContain('Stale · updated 18:20 UTC')
  })

  test('pool data failure shows its error copy with Try again', () => {
    const { text } = view(emptyAccount, { status: 'error', retry: () => {} })
    expect(text).toContain("Can't load pool data. Try again.")
  })

  test('the verification plane never links Basescan', () => {
    const d = clone()
    d.mode = 'lab'
    d.chainId = 31337
    d.chains = [{ chainId: 31337, name: 'Base fork', observed: true }]
    const { html } = view(d, { status: 'loading' })
    expect(html).not.toContain('basescan')
  })
})
