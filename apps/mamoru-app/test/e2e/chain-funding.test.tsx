import { describe, expect, test } from 'bun:test'
import type { FundingView } from '@mamoru/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ApiContext } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { DepositDetails } from '../../src/web/routes/add-money.tsx'
import { fixtureClient, fixtureConfig, fixtureFunding, fixtureSession } from '../../src/web/fixtures/client.ts'
import { FIXTURE_ACCOUNT_KEY } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { buildRouter } from '../../src/web/router.tsx'
import { render } from './render.ts'

// otto/mamoru#238: the operator is down and the Worker answered /funding from the chain.

const listedAt = new Date(Date.now() - 40 * 60_000).toISOString()
const fromChain: FundingView = {
  ...fixtureFunding,
  deployed: true,
  usdc: '3000000',
  cbbtc: '0',
  active: false,
  overCap: null,
  idle: [{ token: 'USDC', amount: '3000000', decimals: 6, valueUsdc: '3000000' }],
  positions: [
    { tokenId: '5101', pool: 'pool:USDC/USDT/100', liquidity: '1', inRange: true, amountUsdc: '10000000', amountCbbtc: '0', valueUsdc: '20000000', amounts: [{ token: 'USDC', amount: '10000000', decimals: 6, valueUsdc: '10000000' }, { token: 'USDT', amount: '10000000', decimals: 6, valueUsdc: '10000000' }] },
  ],
  source: 'chain',
  chainRead: { positions: 'listed', listedAt },
}
const idleOnly: FundingView = { ...fromChain, positions: [], chainRead: { positions: 'unknown', listedAt: null } }

async function home(funding: FundingView) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(queryKeys.config, fixtureConfig)
  qc.setQueryData(queryKeys.session, fixtureSession)
  qc.setQueryData(queryKeys.pools, poolsResponse)
  qc.setQueryData(queryKeys.funding(FIXTURE_ACCOUNT_KEY), funding)
  // the earlier tabs saw a stopped account with history: a chain read must not offer a restart from that
  qc.setQueryData(queryKeys.ops(FIXTURE_ACCOUNT_KEY), { ops: [{ opId: 'o1', kind: 'activate', state: 'confirmed', updatedAt: listedAt }] })
  const router = buildRouter(createMemoryHistory({ initialEntries: ['/'] }))
  await router.load()
  return render(
    <ApiContext.Provider value={fixtureClient}>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiContext.Provider>,
  )
}

describe('Home on a balance read from chain', () => {
  test('the balance shows as live (idle + positions), the notice is up, every action is off', async () => {
    const { text, html } = await home(fromChain)
    expect(text).toContain('23.00')
    expect(text).toContain('Read from chain')
    // the pill does not call it Live, and the engine is promised nothing
    expect(text).toContain('On-chain')
    expect(text).not.toContain('Live ·')
    expect(text).toContain('Engine unreachable: balance read from chain, actions paused.')
    expect(text).toContain('positions Mamoru recorded 40 min ago')
    // live, not a "past" reading
    expect(html).not.toContain('sum past')
    expect(text).not.toContain('Last reading')
    expect(text).not.toContain('Mamoru cannot read your account right now.')
    // Add and Withdraw off
    expect(html).toMatch(/<button type="button" class="act" disabled/)
    expect(html).toMatch(/data-testid="withdraw-button"[^>]*disabled/)
    // no Stop, no Start, no restart, nothing claiming the engine is stopped
    expect(text).not.toContain('Stop allocation')
    expect(text).not.toContain('Start allocation')
    expect(text).not.toContain('Mamoru is stopped')
    expect(text).not.toContain('Mamoru is not running')
    // the positions are real and listed
    expect(text).toContain('Working capital')
  })

  test('positions not read: idle money only, said so, no Working card, no rates, never "nothing placed"', async () => {
    const { text } = await home(idleOnly)
    expect(text).toContain('3.00')
    expect(text).toContain('Idle money only, positions not read')
    expect(text).toContain('Positions could not be read')
    expect(text).not.toContain('Working capital')
    expect(text).not.toContain('Nothing in a position right now')
    expect(text).not.toContain('Start allocation')
  })

  test('an out-of-range position says only "Out of range."; nothing on the page claims engine state', async () => {
    const oor: FundingView = { ...fromChain, positions: [{ ...fromChain.positions[0]!, inRange: false }] }
    const { text } = await home(oor)
    expect(text).toContain('Out of range.')
    for (const claim of ['Paused', 'puts it back to work', 'Placing', 'waiting to be placed', 'being placed', 'Mamoru looks again', 'Nothing to do right now', 'next review']) expect(text).not.toContain(claim)
    // and with the operator answering, the old wording stays
    const live = await home({ ...oor, source: undefined, chainRead: undefined, active: true })
    expect(live.text).toContain('Paused: out of range. Mamoru puts it back to work automatically.')
  })

  test('the cap is shown only when it is known', () => {
    expect(render(<DepositDetails address={fromChain.address} capUsdc="250000000" />).text).toContain('Up to 250 USDC per account')
    expect(render(<DepositDetails address={fromChain.address} />).text).not.toContain('per account')
  })
})
