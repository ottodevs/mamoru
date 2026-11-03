// otto/mamoru#311 (#333): funds on Ethereum that Mamoru can take over are covered by one approval: Start shows the Base
// part and the Ethereum part on one screen, and the notice offers that approval instead of convert and move.
import { describe, expect, test } from 'bun:test'
import type { EthereumSiblingView, FundingView, OtherChainsView } from '@mamoru/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ApiContext, ApiRequestError } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { ethereumCopy } from '../../src/web/components/one-approval.tsx'
import { ethereumTakeover, otherChainCopy, WrongNetwork } from '../../src/web/components/other-chain-notice.tsx'
import { fixtureClient, fixtureConfig, fixtureFunding, fixtureSession } from '../../src/web/fixtures/client.ts'
import { FIXTURE_ACCOUNT_KEY, FIXTURE_ADDRESS } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { nextPart, oneApprovalCopy, type PreparedPart } from '../../src/web/lib/one-approval.ts'
import { buildRouter } from '../../src/web/router.tsx'
import { render } from './render.ts'

const at = '2026-11-03T01:00:00.000Z'
const ethOnly: OtherChainsView = { address: FIXTURE_ADDRESS, accountChainId: 8453, chains: [{ chainId: 1, name: 'Ethereum', status: 'observed', block: 21_000_000, usdc: '0', eth: '55378350000000000', observedAt: at }] }
const idle: FundingView = { ...fixtureFunding, usdc: '20000000', active: false }

function client(sibling: EthereumSiblingView | undefined, funding: FundingView = idle) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(queryKeys.config, { ...fixtureConfig, fundsGate: 'live', dryRun: false, capUsdc: '125000000' })
  qc.setQueryData(queryKeys.session, fixtureSession)
  qc.setQueryData(queryKeys.pools, poolsResponse)
  qc.setQueryData(queryKeys.funding(FIXTURE_ACCOUNT_KEY), funding, { updatedAt: Date.parse(at) })
  qc.setQueryData(queryKeys.ops(FIXTURE_ACCOUNT_KEY), { ops: [] })
  qc.setQueryData(queryKeys.otherChains(FIXTURE_ACCOUNT_KEY), ethOnly)
  qc.setQueryData(queryKeys.bridgeOut(FIXTURE_ACCOUNT_KEY), { route: null, enabled: true })
  if (sibling) qc.setQueryData(queryKeys.ethereumSibling(FIXTURE_ACCOUNT_KEY), sibling)
  return qc
}
const notice = (qc: QueryClient, startPending = false) =>
  render(
    <ApiContext.Provider value={fixtureClient}>
      <QueryClientProvider client={qc}>
        <WrongNetwork accountKey={FIXTURE_ACCOUNT_KEY} startPending={startPending} />
      </QueryClientProvider>
    </ApiContext.Provider>,
  )
async function home(qc: QueryClient) {
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

describe('the Ethereum notice with one approval (#311)', () => {
  test('offered, account running: one Approve replaces Convert to USDC and Move to Base', () => {
    const { text, html } = notice(client({ state: 'none', offered: true }))
    expect(text).toContain('Approve once and Mamoru turns it into USDC')
    expect(html).toContain('data-testid="ethereum-approval"')
    expect(html).not.toContain('data-testid="eth-convert"')
    expect(text).not.toContain(otherChainCopy.convert)
    expect(text).not.toContain('Two passkey approvals')
  })

  test('offered while Start is still to be approved: the notice says Start covers it and has no button of its own', () => {
    const { text, html } = notice(client({ state: 'none', offered: true }), true)
    expect(text).toContain('The approval to start Mamoru below covers it too')
    expect(html).not.toContain('data-testid="ethereum-approval"')
    expect(html).not.toContain('data-testid="eth-convert"')
  })

  test('set up or on its way: its state, no button, and no ask to approve', () => {
    for (const state of ['sending', 'unconfirmed', 'done'] as const) {
      const { text, html } = notice(client({ state, offered: false }))
      expect(html).toContain(`data-state="${state}"`)
      expect(text).toContain(ethereumCopy.state[state])
      expect(text).not.toContain('Approve once')
      expect(html).not.toContain('<button')
    }
  })

  test('a failed poll keeps the last answer: a setup on its way is never traded back for convert and move', () => {
    const qc = client({ state: 'sending', offered: false })
    qc.getQueryCache().find({ queryKey: queryKeys.ethereumSibling(FIXTURE_ACCOUNT_KEY) })!.setState({ status: 'error', error: new Error('down') })
    const { text, html } = notice(qc)
    expect(text).toContain(ethereumCopy.state.sending)
    expect(html).not.toContain('data-testid="eth-convert"')
  })

  test('a failed setup is offered again, and says the first one did not go through', () => {
    const { text, html } = notice(client({ state: 'failed', offered: true }))
    expect(text).toContain(ethereumCopy.state.failed)
    expect(html).toContain('data-testid="ethereum-approval"')
  })

  test('not offered (out of scope, or the operator has no Ethereum): the notice is as before', () => {
    expect(ethereumTakeover({ state: 'none', offered: false }, false, FIXTURE_ACCOUNT_KEY)).toBeUndefined()
    expect(ethereumTakeover(undefined, false, FIXTURE_ACCOUNT_KEY)).toBeUndefined()
    const { html } = notice(client(undefined))
    expect(html).toContain('data-testid="eth-convert"')
  })
})

describe('Start as the one approval (#311)', () => {
  test('offered with funds on Ethereum: Start is the one approval', async () => {
    const { html } = await home(client({ state: 'none', offered: true }))
    expect(html).toContain('data-approval="one"')
  })

  test('before the Ethereum offer is known, Start waits: nothing can be approved on Base alone', async () => {
    const { html } = await home(client(undefined))
    expect(html).toContain('data-testid="start"')
    expect(html).not.toContain('data-approval="one"')
    expect(html).toMatch(/<button[^>]*class="act"[^>]*disabled=""[^>]*>Preparing/)
  })

  test('an operator without Ethereum (404) offers nothing: the plain Start, ready; any other failure keeps Start waiting', async () => {
    const failed = (status: number) => {
      const qc = client(undefined)
      // A static render cannot run the retry a mount would start; the error state is what the poll leaves between tries.
      qc.setQueryDefaults(queryKeys.ethereumSibling(FIXTURE_ACCOUNT_KEY), { retryOnMount: false })
      qc.getQueryCache().build(qc, { queryKey: queryKeys.ethereumSibling(FIXTURE_ACCOUNT_KEY) }).setState({ status: 'error', error: new ApiRequestError(status, { error: 'x' }), fetchStatus: 'idle' })
      return qc
    }
    const none = await home(failed(404))
    expect(none.html).not.toContain('data-approval="one"')
    expect(none.html).not.toMatch(/<button[^>]*class="act"[^>]*disabled=""/)
    const down = await home(failed(503))
    expect(down.html).toMatch(/<button[^>]*class="act"[^>]*disabled=""[^>]*>Preparing/)
  })

  test('not offered: the plain Start, unchanged', async () => {
    const { html } = await home(client({ state: 'none', offered: false }))
    expect(html).toContain('data-testid="start"')
    expect(html).not.toContain('data-approval="one"')
  })

  test('the parts go Base, then Ethereum; the next one is the first not signed', () => {
    const tx = { safe: FIXTURE_ADDRESS, chainId: 8453, safeTxHash: `0x${'a'.repeat(64)}` as const, summary: [], expiresAt: at, prepareId: 'p' }
    const parts: PreparedPart[] = [{ part: 'base', tx, signed: false }, { part: 'ethereum', tx: { ...tx, chainId: 1 }, signed: false }]
    expect(nextPart(parts)?.part).toBe('base')
    expect(nextPart([{ ...parts[0]!, signed: true }, parts[1]!])?.part).toBe('ethereum')
    expect(nextPart(parts.map((p) => ({ ...p, signed: true })))).toBeNull()
    expect(oneApprovalCopy.approveOn('ethereum')).toBe('Approve on Ethereum')
  })
})
