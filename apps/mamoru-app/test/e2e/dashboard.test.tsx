import { describe, expect, test } from 'bun:test'
import type { DashboardPayload, Provenance } from '@mamoru/domain'
import { emptyAccount } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { DashboardView } from '../../src/web/panels/dashboard-view.tsx'
import type { PlanPools } from '../../src/web/panels/pools.tsx'
import { populatedAccount } from './populated.ts'
import { count, render } from './render.ts'

const ready: PlanPools = { status: 'ready', pools: poolsResponse.pools, syncedAt: poolsResponse.syncedAt }

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

  test('no decision yet is said once', () => {
    expect(count(text, 'Mamoru has not reviewed your account yet. The first review runs within five minutes.')).toBe(1)
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
    expect(count(text, 'Nothing to manage. Deposits are closed.')).toBe(1)
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

describe('a full pool in your plan (dashboard.md §7.6.2)', () => {
  const pool = poolsResponse.pools[0]
  if (!pool) throw new Error('fixture has no pool')
  const { html, text } = view(emptyAccount)
  const card = html.slice(html.indexOf('data-testid="pool"'))

  test('state at the block: price, tick, TWAP guard, liquidity and balances with chips', () => {
    expect(text).toContain('Price of cbBTC in USDC 65,432.1 USDC Base · block 52114380')
    expect(text).toContain('Tick -64842 Base · block 52114380')
    expect(text).toContain('TWAP tick -64836 Base · block 52114380 Within the policy guard')
    expect(text).toContain('Liquidity in range 1,843,200,418,822,907')
    expect(text).toContain('4,210,385.12 USDC')
    expect(text).toContain('51.20447381 cbBTC')
    expect(text).toContain('Value 7,560,740 USDC Estimate · Base · block 52114380')
    expect(text).toContain('Pool data synced 26 Sep 2026 18:20 UTC.')
  })

  test('window stats name their block range', () => {
    expect(text).toContain(`Last 24 hours · blocks ${pool.window.fromBlock} to ${pool.window.toBlock}`)
    expect(text).toContain('Swaps 1,284')
    expect(text).toContain('18,420,330.1 USDC')
    expect(text).toContain('Low -65118')
    expect(text).toContain('37 changes')
    expect(text).toContain('29 changes')
  })

  test('recent swaps and liquidity link each transaction on Basescan with a reconciled chip', () => {
    expect(count(card, 'data-testid="pool-swap"')).toBe(pool.recentSwaps.length)
    for (const row of [...pool.recentSwaps, ...pool.recentLiquidity]) {
      expect(card).toContain(`href="https://basescan.org/tx/${row.txHash}"`)
    }
    expect(text).toContain('In 0.191 cbBTC, out 12,480.22 USDC tick after -64845')
    expect(text).toContain('Added')
    expect(text).toContain('Removed')
    expect(count(card, 'MultiBaas · Base · checked at block 52114380')).toBe(pool.recentSwaps.length + pool.recentLiquidity.length)
    expect(card).toContain(`href="https://basescan.org/address/${pool.pool.address}"`)
    expect(text).toContain('View pool')
  })

  test("the account's positions in the pool show their range state", () => {
    const withPosition = { ...pool, accountPositions: [{ tokenId: '1234', rangeState: { ...pool.twapGuard, value: 'out_of_range' as const } }] }
    const { text: t } = view(emptyAccount, { status: 'ready', pools: [withPosition], syncedAt: null })
    expect(t).toContain('Your positions in this pool #1234 Out of range Base · block 52114380')
  })

  test('twap above the guard says so', () => {
    const above = { ...pool, twapGuard: { ...pool.twapGuard, value: 'above_guard' as const } }
    const { text: t } = view(emptyAccount, { status: 'ready', pools: [above], syncedAt: null })
    expect(t).toContain('Above the policy guard')
  })
})

describe('account with a position, a decision and history', () => {
  const { html, text } = view(populatedAccount())

  test('current action shows the dry-run stop, the gate trail and the notes', () => {
    expect(text).toContain('Simulated, not sent DRY_RUN_STOP')
    expect(text).toContain('Execution Health Gate GO EHG_OK')
    expect(text).toContain('Shadow, not used to decide')
    expect(text).toContain('Waiting to send. BUNDLER_UNAVAILABLE')
    expect(text).toContain('Recent decisions')
    expect(count(text, 'Mamoru has not reviewed your account yet')).toBe(0)
  })

  test('rows carry reconciled, fallback and mismatch chips', () => {
    expect(text).toContain('Base RPC logs · block 52114380 · MultiBaas query failed')
    expect(text).toContain('Base · block 52114380 · MultiBaas disagreed')
    expect(text).toContain('MultiBaas · Base · checked at block 52114380')
    expect(text).toContain('Not from Mamoru')
  })

  test('position analytics paint the payload', () => {
    expect(text).toContain('#1234 · USDC/cbBTC 0.05% Managed by Mamoru OBS_POSITION_OUT_OF_RANGE')
    expect(text).toContain('Out of range for more than 7 days')
    expect(text).toContain('62.5%')
    expect(text).toContain('History incomplete PROJ_INDEXER_MISMATCH')
    expect(text).toContain('500 USDC')
    expect(text).toContain('0.00764 cbBTC')
  })

  test('savings log row shows kind, amount and code; no empty copy', () => {
    expect(count(html, 'data-testid="savings-row"')).toBe(1)
    expect(text).toContain('Harvest 2.38 USDC')
    expect(text).toContain('PROJ_RECONCILED')
    expect(text).not.toContain('No harvests yet. In simulation mode Mamoru collects nothing.')
    expect(text).not.toContain('No savings yet. Deposits are closed.')
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

  test('journal not projected yet: nulls, the gate note and a held conversion without cause', () => {
    const d = clone()
    const journalMissing: Provenance = { source: 'journal', chainId: 8453, observedAt: d.sources.rpc.observedAt, status: 'not_observed' }
    d.currentAction.session = { value: null, provenance: journalMissing }
    d.currentAction.paused = { value: null, provenance: journalMissing }
    d.currentAction.notes = ['FUNDS_GATE_CLOSED']
    d.treasury.convert = { ...d.treasury.convert, state: 'held', code: 'FUNDS_GATE_CLOSED' }
    d.savings.ledgerTotal = { value: null, unit: 'USDC', provenance: journalMissing }
    const { text } = view(d)
    expect(text).toContain('Deposits are closed. FUNDS_GATE_CLOSED')
    expect(text).toContain('Conversion Deposits are closed. FUNDS_GATE_CLOSED')
    expect(text).not.toContain('Waiting for a healthy market')
    expect(text).not.toContain('No savings yet. Deposits are closed.')
    expect(count(text, 'Not observed')).toBeGreaterThanOrEqual(3)
  })

  test('a conversion held by the market names the market cause', () => {
    const d = clone()
    d.treasury.convert = { ...d.treasury.convert, state: 'held', cause: 'EHG_PRICE_DIVERGENCE', code: 'DECIDE_CONVERT_HELD' }
    expect(view(d).text).toContain('Waiting for a healthy market: EHG_PRICE_DIVERGENCE DECIDE_CONVERT_HELD')
  })

  test('stale projection shows the update time', () => {
    const d = clone()
    d.savings.ledgerTotal = { ...d.savings.ledgerTotal, provenance: { ...d.savings.ledgerTotal.provenance, status: 'stale' } }
    expect(view(d).text).toContain('Stale · updated 18:20 UTC')
  })

  test('nothing read from Base yet: balances, positions and pools say not observed, never "No positions"', () => {
    const d = clone()
    const missing: Provenance = { source: 'chain_rpc', chainId: 8453, observedAt: d.sources.rpc.observedAt, status: 'not_observed' }
    d.sources.rpc = { status: 'unavailable', observedAt: d.sources.rpc.observedAt }
    d.portfolio.tokens = []
    d.portfolio.positions = { managed: { value: null, provenance: missing }, unmanaged: { value: null, provenance: missing }, value: { value: null, unit: 'USDC', provenance: missing } }
    d.treasury.idle.usdc = { value: null, unit: 'USDC', provenance: missing }
    d.treasury.idle.cbBTC = { value: null, unit: 'cbBTC', provenance: missing }
    const { text } = view(d, { status: 'ready', pools: [], syncedAt: null })
    expect(text).toContain('Token balances not observed.')
    expect(text).not.toContain('No positions. Deposits are closed.')
    expect(text).toContain('Not observed yet. Mamoru has not read the pools in your plan on Base.')
    expect(text).not.toContain('Pool data synced')
    expect(text).toContain('USDC Not observed Base')
    expect(text).toContain('cbBTC Not observed Base')
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
