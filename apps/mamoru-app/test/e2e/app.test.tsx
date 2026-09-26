import { describe, expect, test } from 'bun:test'
import type { FundingView, OpView, SessionView } from '@mamoru/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ApiContext } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { fixtureClient, fixtureConfig, fixtureFunding, fixtureSession } from '../../src/web/fixtures/client.ts'
import { FIXTURE_ACCOUNT_KEY } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { base64url } from '../../src/web/lib/passkey.ts'
import { base64urlDecode, hexToBytes } from '../../src/web/lib/passkey-sign.ts'
import { cbbtcPrice, humanMessage, split, usd } from '../../src/web/lib/money.ts'
import { activationLive, opLine } from '../../src/web/lib/ops.ts'
import { isAddress, parseUsdc } from '../../src/web/lib/owner-flow.ts'
import { encodeQr } from '../../src/web/lib/qr.ts'
import { localTime } from '../../src/web/lib/time.ts'
import { History } from '../../src/web/routes/home.tsx'
import { MIX } from '../../src/web/routes/onboarding.tsx'
import { buildRouter } from '../../src/web/router.tsx'
import { render } from './render.ts'

const funded: FundingView = {
  ...fixtureFunding,
  usdc: '10000000',
  cbbtc: '0',
  active: true,
  positions: [{ tokenId: '1', pool: `0x${'a'.repeat(40)}`, liquidity: '1', inRange: true, amountUsdc: '5000000', amountCbbtc: '10000' }],
}

async function renderRoute(path: string, session: SessionView | null, funding?: FundingView) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(queryKeys.config, fixtureConfig)
  qc.setQueryData(queryKeys.session, session)
  qc.setQueryData(queryKeys.pools, poolsResponse)
  if (funding) qc.setQueryData(queryKeys.funding(FIXTURE_ACCOUNT_KEY), funding)
  qc.setQueryData(queryKeys.ops(FIXTURE_ACCOUNT_KEY), { ops: [] })
  const router = buildRouter(createMemoryHistory({ initialEntries: [path] }))
  await router.load()
  return render(
    <ApiContext.Provider value={fixtureClient}>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiContext.Provider>,
  )
}

describe('routes', () => {
  test('no account: the first onboarding card, no marketing page', async () => {
    const { text } = await renderRoute('/', null)
    expect(text).toContain('01 / 03')
    expect(text).toContain('Fund Mamoru')
    expect(text).toContain('Skip')
    expect(text).not.toContain('SAVINGS. EXPLAINED.')
  })
  test('account: Home with total, working capital, idle and history', async () => {
    const { text } = await renderRoute('/', fixtureSession, funded)
    expect(text).toContain('Total balance')
    expect(text).toContain('Working capital')
    expect(text).toContain('1 open position')
    expect(text).toContain('Idle assets 10.00 USDC')
    expect(text).toContain('Stop allocation')
    expect(text).toContain('Current APY —')
    expect(text).not.toContain('UTC')
  })
  test('funds present but not running: one Start button', async () => {
    const { text } = await renderRoute('/', fixtureSession, { ...fixtureFunding, active: false })
    expect(text).toContain('Mamoru is not running on this money yet.')
    expect(text).toContain('Start')
  })
  test('old paths redirect home; unknown paths are not found', async () => {
    expect((await renderRoute('/deposit', null)).text).toContain('Page not found')
  })
})

describe('helpers', () => {
  test('parseUsdc and isAddress', () => {
    expect(parseUsdc('12.5')).toBe('12500000')
    expect(parseUsdc('0')).toBeNull()
    expect(parseUsdc('1.0000001')).toBeNull()
    expect(isAddress(`0x${'a'.repeat(40)}`)).toBe(true)
    expect(isAddress('0x123')).toBe(false)
  })
  test('safeTxHash hex becomes the 32 challenge bytes; base64url round-trips', () => {
    const bytes = hexToBytes(`0x${'0f'.repeat(32)}`)
    expect(bytes.length).toBe(32)
    expect(Array.from(base64urlDecode(base64url(bytes)))).toEqual(Array.from(bytes))
  })
  test('split values cbBTC at the pool price and keeps a 1% margin on Max', () => {
    const s = split(funded, cbbtcPrice(poolsResponse))
    expect(s.idle).toBe(10_000_000n)
    expect(s.working).toBe(5_000_000n + (10_000n * 65_432_100_000n) / 100_000_000n)
    expect(s.maxWithdraw % 10_000n).toBe(0n)
    expect(s.maxWithdraw < s.total).toBe(true)
    expect(usd(1_930_000n)).toBe('1.93')
  })
  test('operator errors become plain USDC copy', () => {
    expect(humanMessage('the Safe cannot free 2000000 USDC base units', 1_930_000n)).toBe('You can withdraw up to 1.93 USDC right now.')
    expect(humanMessage('needs 2000000 USDC base units')).toBe('needs 2.00 USDC')
  })
  test('ops read as one plain line', () => {
    const op = (o: Partial<OpView>): OpView => ({ opId: 'x', kind: 'enter', state: 'confirmed', updatedAt: '2026-09-26T20:00:00Z', ...o })
    expect(opLine(op({}))).toBe('Opened USDC/cbBTC position')
    expect(opLine(op({ kind: 'activate', state: 'proposed', code: 'ARMED' }))).toBe('Start approved')
    expect(activationLive([op({ kind: 'activate', state: 'failed' })])).toBe(false)
    const { html } = render(<History ops={[op({ txHash: `0x${'b'.repeat(64)}` })]} />)
    expect(html).toContain(`https://basescan.org/tx/0x${'b'.repeat(64)}`)
  })
  test('local time, never UTC', () => {
    const now = new Date('2026-09-26T20:30:00')
    expect(localTime(new Date('2026-09-26T19:05:00').toISOString(), now)).toMatch(/^Today /)
    expect(localTime(new Date('2026-09-25T19:05:00').toISOString(), now)).toMatch(/^Yesterday /)
    expect(localTime('2026-09-01T10:00:00Z', now)).not.toContain('UTC')
  })
  test('QR: version 3 for a Base address, finder patterns in place', () => {
    const m = encodeQr(`0x${'a'.repeat(40)}`)
    expect(m.length).toBe(29)
    expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true)
    expect(m[1]![1]).toBe(false)
  })
  test('the mix is the Conservador policy', () => {
    expect(MIX.reduce((a, s) => a + s.pct, 0)).toBe(100)
  })
})
