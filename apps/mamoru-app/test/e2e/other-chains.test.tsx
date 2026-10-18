import { describe, expect, test } from 'bun:test'
import type { FundingView, OtherChainsView } from '@mamoru/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ApiContext } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { BridgeStatus, exact, fundsElsewhere, movable, OtherChainNotice, otherChainCopy, WrongNetwork } from '../../src/web/components/other-chain-notice.tsx'
import { fixtureClient, fixtureConfig, fixtureFunding, fixtureSession } from '../../src/web/fixtures/client.ts'
import { FIXTURE_ACCOUNT_KEY, FIXTURE_ADDRESS } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { addCopy } from '../../src/web/routes/add-money.tsx'
import { buildRouter } from '../../src/web/router.tsx'
import { render } from './render.ts'

const at = '2026-10-07T10:00:00.000Z'
const view = (chains: OtherChainsView['chains']): OtherChainsView => ({ address: FIXTURE_ADDRESS, accountChainId: 8453, chains })
const eth = (usdc: string, wei = '0'): OtherChainsView => view([{ chainId: 1, name: 'Ethereum', status: 'observed', block: 21_000_000, usdc, eth: wei, observedAt: at }])
const onEthereum = eth('150000000')
const NOTICE = /<section[^>]*data-testid="other-chain".*?<\/section>/s

function client(funding: FundingView, other: OtherChainsView | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(queryKeys.config, { ...fixtureConfig, fundsGate: 'live', dryRun: false, capUsdc: '25000000' })
  qc.setQueryData(queryKeys.session, fixtureSession)
  qc.setQueryData(queryKeys.pools, poolsResponse)
  qc.setQueryData(queryKeys.funding(FIXTURE_ACCOUNT_KEY), funding, { updatedAt: Date.parse(at) })
  qc.setQueryData(queryKeys.ops(FIXTURE_ACCOUNT_KEY), { ops: [] })
  if (other) qc.setQueryData(queryKeys.otherChains(FIXTURE_ACCOUNT_KEY), other)
  return qc
}

/** The real route, mounted with the Base funding answer and the other-chains answer side by side. */
async function page(path: string, funding: FundingView, other: OtherChainsView | undefined) {
  const router = buildRouter(createMemoryHistory({ initialEntries: [path] }))
  await router.load()
  return render(
    <ApiContext.Provider value={fixtureClient}>
      <QueryClientProvider client={client(funding, other)}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiContext.Provider>,
  )
}

describe('wrong-network notice (#117)', () => {
  test('says the amount, that it is on Ethereum and not on Base, that it is not in the balance, and when it was checked', () => {
    const { text, html } = render(<OtherChainNotice view={onEthereum} />)
    expect(text).toContain('150.00 USDC at your address on Ethereum, not on Base')
    expect(text).toContain('not part of your Mamoru balance')
    expect(text).toContain('Mamoru has not moved it')
    expect(text).toContain('when last checked it was at your address on Ethereum')
    expect(text).not.toContain('still')
    expect(text).toContain('Do not send more on Ethereum')
    expect(text).toContain('Ethereum block 21000000 · Checked')
    expect(html).toContain('data-chain-id="1"')
  })

  test('nothing is shown when nothing is there, when it was not observed, or before the answer', () => {
    const unknown = view([{ chainId: 1, name: 'Ethereum', status: 'not_observed', observedAt: at }])
    for (const v of [eth('0'), unknown, view([]), undefined]) {
      expect(fundsElsewhere(v)).toEqual([])
      expect(render(<OtherChainNotice view={v} />).html).toBe('')
    }
  })

  test('after a check that failed the earlier amount is no longer shown', () => {
    const qc = client({ ...fixtureFunding, usdc: '0' }, onEthereum)
    const mounted = () =>
      render(
        <ApiContext.Provider value={fixtureClient}>
          <QueryClientProvider client={qc}>
            <WrongNetwork accountKey={FIXTURE_ACCOUNT_KEY} />
          </QueryClientProvider>
        </ApiContext.Provider>,
      )
    expect(mounted().text).toContain('150.00 USDC')
    // What React Query holds after a refetch fails: the error, with the previous data still there.
    const query = qc.getQueryCache().find({ queryKey: queryKeys.otherChains(FIXTURE_ACCOUNT_KEY) })!
    query.setState({ status: 'error', error: new Error('503'), fetchStatus: 'idle' })
    expect(query.state.data).toEqual(onEthereum)
    expect(mounted().html).toBe('')
  })

  test("a row on the account's own chain is never shown as money elsewhere", () => {
    const own = view([{ chainId: 8453, name: 'Base', status: 'observed', block: 1, usdc: '5000000', eth: '0', observedAt: at }])
    expect(fundsElsewhere(own)).toEqual([])
  })

  test('an amount above zero is never painted as zero', () => {
    const title = (v: OtherChainsView) => otherChainCopy.title(fundsElsewhere(v)[0]!)
    expect(title(eth('1'))).toBe('0.000001 USDC at your address on Ethereum, not on Base')
    expect(title(eth('0', '7'))).toBe('0.000000000000000007 ETH at your address on Ethereum, not on Base')
    expect(title(eth('150000001'))).toBe('150.000001 USDC at your address on Ethereum, not on Base')
    expect(title(eth('1234560000'))).toBe('1,234.56 USDC at your address on Ethereum, not on Base')
    expect(title(eth('0', '20000000000000000'))).toBe('0.02 ETH at your address on Ethereum, not on Base')
    expect(title(eth('10000', '1000000000000000000'))).toBe('0.01 USDC and 1 ETH at your address on Ethereum, not on Base')
    expect(exact('1234567890123456789012', 18)).toBe('1,234.567890123456789012')
  })

  test('Add capital, mounted: the notice appears and the page still waits for USDC on Base', async () => {
    const base: FundingView = { ...fixtureFunding, usdc: '0' }
    const withL1 = await page('/add', base, onEthereum)
    const without = await page('/add', base, eth('0'))
    expect(withL1.text).toContain('150.00 USDC at your address on Ethereum, not on Base')
    expect(withL1.text).toContain(addCopy.waiting)
    expect(withL1.text).not.toContain('USDC arrived')
    expect(withL1.text).toContain(addCopy.baseOnly)
    // Apart from the notice itself the page is the one an owner with nothing on Ethereum sees.
    expect(without.html).not.toContain('data-testid="other-chain"')
    expect(withL1.html.replace(NOTICE, '')).toBe(without.html)
  })

  test('Home, mounted: balance, cap, Start and every Base figure are the same with or without money on Ethereum', async () => {
    for (const base of [{ ...fixtureFunding, usdc: '0' }, { ...fixtureFunding, usdc: '20000000' }] as FundingView[]) {
      const withL1 = await page('/', base, onEthereum)
      const without = await page('/', base, undefined)
      expect(withL1.html).toContain('data-testid="other-chain"')
      expect(withL1.html.replace(NOTICE, '')).toBe(without.html)
      expect(withL1.html).not.toContain('data-testid="over-cap"')
    }
  })
})

describe('move to Base (#133)', () => {
  /** The /ops flag as the operator reports it for this account. */
  const flag = (qc: QueryClient, enabled: boolean, route: unknown = null) => {
    qc.setQueryData(queryKeys.bridgeOut(FIXTURE_ACCOUNT_KEY), { route, enabled })
    return qc
  }
  const mount = (qc: QueryClient) =>
    render(
      <ApiContext.Provider value={fixtureClient}>
        <QueryClientProvider client={qc}>
          <WrongNetwork accountKey={FIXTURE_ACCOUNT_KEY} />
        </QueryClientProvider>
      </ApiContext.Provider>,
    )

  test('flag off on /ops (or no answer): the notice is as before, no button', () => {
    for (const qc of [flag(client({ ...fixtureFunding, usdc: '0' }, onEthereum), false), client({ ...fixtureFunding, usdc: '0' }, onEthereum)]) {
      const { text, html } = mount(qc)
      expect(html).not.toContain('data-testid="bridge-out"')
      expect(text).toContain('cannot move it from Ethereum yet')
    }
  })

  test('USDC on Ethereum from 1 USDC up, flag on: the notice says it can be moved and offers the button', () => {
    const { text, html } = mount(flag(client({ ...fixtureFunding, usdc: '0' }, onEthereum), true))
    expect(text).toContain('You can move the USDC to this same account on Base with one passkey approval')
    expect(text).toContain('shows what the move costs, Ethereum gas included')
    expect(text).not.toContain('cannot move it')
    expect(text).toContain('Do not send more on Ethereum')
    expect(html).toContain('data-testid="bridge-out"')
    expect(text).toContain(otherChainCopy.move)
  })

  test('below 1 USDC, or only ETH: no button, and the notice says it cannot be moved yet', () => {
    for (const v of [eth('999999'), eth('0', '20000000000000000')]) {
      expect(movable(fundsElsewhere(v)[0]!)).toBe(false)
      const { text, html } = mount(flag(client({ ...fixtureFunding, usdc: '0' }, v), true))
      expect(html).not.toContain('data-testid="bridge-out"')
      expect(text).toContain('cannot move it from Ethereum yet')
    }
  })

  test('USDC and ETH: the USDC can move, the ETH is said to stay', () => {
    expect(otherChainCopy.body(fundsElsewhere(eth('150000000', '1'))[0]!, true)).toContain('The ETH stays on Ethereum.')
  })

  test('a move on its way hides the button and shows its state; once the USDC left, the state stays in view', () => {
    const qc = client({ ...fixtureFunding, usdc: '0' }, onEthereum)
    flag(qc, true, { state: 'deposited', amountUsdc: '150000000', outputUsdc: '149980000', at: new Date().toISOString(), depositId: '1' })
    const during = mount(qc)
    expect(during.text).toContain(otherChainCopy.state.deposited)
    expect(during.text).not.toContain(otherChainCopy.move)
    qc.setQueryData(queryKeys.otherChains(FIXTURE_ACCOUNT_KEY), eth('0'))
    flag(qc, true, { state: 'filled', amountUsdc: '150000000', outputUsdc: '149980000', at: new Date().toISOString(), depositId: '1' })
    const after = mount(qc)
    expect(after.html).toContain('data-testid="bridge-route"')
    expect(after.text).toContain('Moving 150.00 USDC from Ethereum to Base')
    expect(after.text).toContain(otherChainCopy.state.filled)
  })

  test('every state has its own words', () => {
    for (const state of ['sending', 'deposited', 'filled', 'failed', 'unconfirmed', 'expired', 'refunded'] as const) {
      const { html } = render(<BridgeStatus route={{ state, amountUsdc: '1', outputUsdc: '1', at }} />)
      expect(html).toContain(`data-state="${state}"`)
    }
    expect(otherChainCopy.state.failed).toContain('still at your address on Ethereum')
  })

  test('CCTP (#180): waiting for Circle, then arriving on Base, then the same filled words', () => {
    const cctp = (over: object) => render(<BridgeStatus route={{ state: 'deposited', amountUsdc: '1', outputUsdc: '1', at, bridge: 'cctp', ...over }} />).html
    expect(cctp({})).toContain('15 to 20 minutes')
    expect(cctp({ mintTx: `0x${'ab'.repeat(32)}` })).toContain('Circle confirmed it')
    expect(cctp({ state: 'filled' })).toContain(otherChainCopy.state.filled)
  })
})
