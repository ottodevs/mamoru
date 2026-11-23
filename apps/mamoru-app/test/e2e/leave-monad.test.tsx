// otto/mamoru#428 (spec 014, copy C1-C3; SCN-RH-06 view): leaving Monad in the app. One Home card and one authorization
// screen with both steps and every line each one signs, Monad first; nothing is shown that the operator does not offer.
import { describe, expect, test } from 'bun:test'
import type { FundingView, SessionView, WhatsNew } from '@mamoru/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ApiContext } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { LeaveMonadFlow } from '../../src/web/components/leave-monad.tsx'
import { fixtureClient, fixtureConfig, fixtureFunding, fixtureSession } from '../../src/web/fixtures/client.ts'
import { FIXTURE_ACCOUNT_KEY, FIXTURE_ADDRESS } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { expired, leaveMonadCopy, leaveSteps, stepState } from '../../src/web/lib/leave-monad.ts'
import { buildRouter } from '../../src/web/router.tsx'
import { count, render } from './render.ts'

const MONAD_KEY = 'acct_fixture_monad'
const at = '2026-11-23T10:00:00.000Z'
const POINTS = [
  'Your USDC on Monad comes back to your Safe on Base, through Circle (about 15-20 minutes, no fee)',
  'Mamoru stops working on Monad: no more money goes there',
  'On Base, Mamoru aims for 50 % Stable, 25 % WETH/USDC and 25 % USDC/cbBTC',
  'Two confirmations with your passkey, one per network',
]
const HOME_LINES = [
  "Revoke the engine's 1 session grant(s) on your Safe on Monad: Mamoru stops working there",
  `Send 449.55 USDC from your Safe on Monad to your Safe on Base ${FIXTURE_ADDRESS}, through Circle's CCTP (about 15-20 minutes, no fee)`,
  'On Base, Mamoru puts it to work in your positions there',
  'The MON left for gas stays in this Safe',
]
const BASE_LINES = ['Mamoru stops sending money to Monad: on Base it aims for 50% in Stable, 25% in WETH/USDC, 25% in USDC/cbBTC', 'Your USDC on Monad comes here with the other step']
const SELL_LINES = ['Sell 120 WMON in your Safe on Monad for at least 3.58 USDC, so all of it can come home']
const two: WhatsNew = { policy: 'base-v8', points: POINTS, signatures: 2, currentStep: 0, steps: [{ chain: 'monad', kind: 'return-home', summary: HOME_LINES }, { chain: 'base', kind: 'renew', summary: BASE_LINES }] }
const three: WhatsNew = { ...two, signatures: 3, steps: [{ chain: 'monad', kind: 'monad-sell', summary: SELL_LINES }, ...two.steps] }

const running = (whatsNew?: WhatsNew, extra: Partial<NonNullable<FundingView['approval']>> = {}): FundingView => ({
  ...fixtureFunding,
  deployed: true,
  active: true,
  approval: { validUntil: Math.floor(Date.parse(at) / 1000) + 300 * 86_400, renewDue: false, expired: false, policyId: 'conservador-live-v7', upgrade: true, upgradePolicy: 'conservador-live-v8', ...(whatsNew ? { whatsNew } : {}), ...extra },
})
const withMonad: SessionView = { ...fixtureSession, sleeves: [{ accountKey: FIXTURE_ACCOUNT_KEY, chainId: 8453, chain: 'base', address: FIXTURE_ADDRESS }, { accountKey: MONAD_KEY, chainId: 143, chain: 'monad', address: `0x${'cd'.repeat(20)}` }] } as SessionView

async function home(funding: FundingView, session: SessionView = withMonad) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(queryKeys.config, { ...fixtureConfig, fundsGate: 'live', dryRun: false, capUsdc: '10000000000' })
  qc.setQueryData(queryKeys.session, session)
  qc.setQueryData(queryKeys.pools, poolsResponse)
  qc.setQueryData(queryKeys.funding(FIXTURE_ACCOUNT_KEY), funding, { updatedAt: Date.parse(at) })
  qc.setQueryData(queryKeys.ops(FIXTURE_ACCOUNT_KEY), { ops: [] })
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

const screen = (view: WhatsNew) =>
  render(
    <ApiContext.Provider value={fixtureClient}>
      <QueryClientProvider client={new QueryClient()}>
        <LeaveMonadFlow baseKey={FIXTURE_ACCOUNT_KEY} monadKey={MONAD_KEY} home={FIXTURE_ADDRESS} view={view} steps={leaveSteps(view)!} open setOpen={() => {}} />
      </QueryClientProvider>
    </ApiContext.Provider>,
  )

describe('C1: the Home card', () => {
  test('offered by the operator to an owner with a Safe on Monad: the card, its copy and one Review button', async () => {
    const { html, text } = await home(running(two))
    expect(count(html, 'data-testid="leave-monad"')).toBe(1)
    expect(text).toContain('Bring your Monad funds to Base')
    expect(text).toContain('Mamoru has moved your Monad position to USDC. Approve to bring it to your Safe on Base and put it to work in USDC/cbBTC.')
    expect(html).toMatch(/<button[^>]*class="act"[^>]*>Review<\/button>/)
  })

  test('while its Base step is still to sign, the plain renewal row is not shown beside it: one screen for the move', async () => {
    const { html } = await home(running(two))
    expect(html).not.toContain('data-testid="renew"')
  })

  test('the Base step already done and the renewal due later: the renewal row is back, with the card for Monad', async () => {
    const done: WhatsNew = { ...two, currentStep: 0, steps: [two.steps[0]!, { ...two.steps[1]!, done: true }] }
    const { html } = await home(running(done, { policyId: 'conservador-live-v8', upgrade: false, upgradePolicy: undefined, renewDue: true }))
    expect(html).toContain('data-testid="leave-monad"')
    expect(html).toContain('data-testid="renew"')
  })

  test('nothing new in the app without the offer: no view, the one-authorization view, a Base-only offer, or no Safe on Monad', async () => {
    const baseOnly: WhatsNew = { policy: 'base-v8', points: [BASE_LINES[0]!], signatures: 1, currentStep: 0, steps: [{ chain: 'base', kind: 'renew', summary: [BASE_LINES[0]!] }] }
    const v4: WhatsNew = { policy: 'one-auth-v4', points: ['x'], signatures: 2, currentStep: 0, steps: [{ chain: 'base', summary: ['a'] }, { chain: 'monad', summary: ['b'] }] }
    for (const f of [running(), running(v4), running(baseOnly)]) {
      const { html } = await home(f)
      expect(html).not.toContain('data-testid="leave-monad"')
      // The renewal row is as it was.
      expect(html).toContain('data-testid="renew"')
    }
    expect((await home(running(two), fixtureSession)).html).not.toContain('data-testid="leave-monad"')
  })
})

describe('C2: the authorization screen', () => {
  test('title, the four points, both steps with every line, Monad first, and one button per step', () => {
    const { html, text } = screen(two)
    expect(text).toContain('Leave Monad')
    for (const p of POINTS) expect(text).toContain(p)
    for (const l of [...HOME_LINES, ...BASE_LINES]) expect(text).toContain(l)
    expect(html.indexOf('data-testid="leave-step-return-home"')).toBeGreaterThan(0)
    expect(html.indexOf('data-testid="leave-step-return-home"')).toBeLessThan(html.indexOf('data-testid="leave-step-renew"'))
    expect(html).toMatch(/data-testid="leave-approve-return-home"[^>]*>Approve on Monad</)
    expect(html).toMatch(/data-testid="leave-approve-renew"[^>]*>Approve on Base</)
    expect(count(html, 'class="cta"')).toBe(2)
    expect(html).not.toContain('data-testid="leave-progress"')
  })

  test('a depth-held Safe: the sale first with its own button, and the return waits for it', () => {
    const { html, text } = screen(three)
    expect(text).toContain(SELL_LINES[0]!)
    expect(html).toMatch(/data-testid="leave-approve-monad-sell"[^>]*>Approve sale on Monad</)
    expect(html.indexOf('data-testid="leave-step-monad-sell"')).toBeLessThan(html.indexOf('data-testid="leave-step-return-home"'))
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="leave-approve-return-home"/)
    expect(count(html, 'class="cta"')).toBe(3)
  })

  test('Mamoru still unwinding on Monad: that step says so and cannot be approved; Base can', () => {
    const waiting: WhatsNew = { ...two, steps: [{ ...two.steps[0]!, waiting: 'unwinding' }, two.steps[1]!] }
    const { html, text } = screen(waiting)
    expect(text).toContain('Mamoru is still moving your Monad position to USDC. Try again in a few minutes')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="leave-approve-return-home"/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="leave-approve-renew"/)
  })
})

describe('C3: progress and done', () => {
  test('step A done: its card says approved, no lines and no button for it, and the progress line', () => {
    const { html, text } = screen({ ...two, currentStep: 1, steps: [{ ...two.steps[0]!, done: true, summary: [] }, two.steps[1]!] })
    expect(text).toContain('Step 1 of 2 done. Your USDC is on its way to Base')
    expect(html).toMatch(/data-testid="leave-step-return-home" data-done="true"/)
    expect(html).not.toContain('data-testid="leave-approve-return-home"')
    expect(html).toContain('data-testid="leave-approve-renew"')
  })

  test('both done: Done', () => {
    const { text, html } = screen({ ...two, steps: two.steps.map((s) => ({ ...s, done: true })) })
    expect(text).toContain('Done. Mamoru will put it to work when it arrives')
    expect(html).not.toContain('class="cta"')
  })

  test('the copy is the spec\'s', () => {
    expect(leaveMonadCopy.stepDone(1, 2)).toBe('Step 1 of 2 done. Your USDC is on its way to Base')
    expect(leaveMonadCopy.approve('return-home')).toBe('Approve on Monad')
    expect(leaveMonadCopy.approve('renew')).toBe('Approve on Base')
    expect(leaveMonadCopy.approve('monad-sell')).toBe('Approve sale on Monad')
  })
})

describe('leaveSteps: only a base-v8 offer that names a Monad step is this screen\'s', () => {
  test('accepted and refused views', () => {
    expect(leaveSteps(two)!.map((s) => s.kind)).toEqual(['return-home', 'renew'])
    expect(leaveSteps(three)!.map((s) => s.kind)).toEqual(['monad-sell', 'return-home', 'renew'])
    expect(leaveSteps(undefined)).toBeNull()
    expect(leaveSteps({ ...two, policy: 'one-auth-v4' })).toBeNull()
    expect(leaveSteps({ ...two, steps: [two.steps[1]!] })).toBeNull()
    // A step this app does not know is never rendered as something else.
    expect(leaveSteps({ ...two, steps: [...two.steps, { chain: 'monad', summary: ['x'] }] })).toBeNull()
  })
})

describe('review r1: a step is done only on the chain\'s word', () => {
  const op = (state: 'proposed' | 'submitted' | 'confirmed' | 'failed') => ({ opId: 'own-7-exit', state })
  test('sent is not done: a submitted signature waits; confirmed is done; failed is open again', () => {
    expect(stepState({}, undefined, [])).toBe('open')
    expect(stepState({}, op('submitted'), [])).toBe('sent')
    expect(stepState({}, op('submitted'), [op('submitted')])).toBe('sent')
    expect(stepState({}, op('submitted'), [op('confirmed')])).toBe('done')
    // The operation failed after it was sent (STOP_STALE, a revert): never counted as done.
    expect(stepState({}, op('submitted'), [op('failed')])).toBe('failed')
    expect(stepState({}, op('failed'), [])).toBe('failed')
    // Another account's or another step's operations say nothing about this one.
    expect(stepState({}, op('submitted'), [{ opId: 'own-8-renew', state: 'confirmed' }])).toBe('sent')
    // The operator's view is the last word.
    expect(stepState({ done: true }, undefined, [])).toBe('done')
    expect(stepState({ done: true }, op('failed'), [op('failed')])).toBe('done')
  })

  test('a prepared approval whose expiry is past, or cannot be read, is never signed', () => {
    const now = Date.parse('2026-11-23T10:00:00Z')
    expect(expired({ expiresAt: '2026-11-23T10:05:00Z' }, now)).toBe(false)
    expect(expired({ expiresAt: '2026-11-23T10:00:00Z' }, now)).toBe(true)
    expect(expired({ expiresAt: '2026-11-23T09:59:59Z' }, now)).toBe(true)
    expect(expired({ expiresAt: 'x' }, now)).toBe(true)
    expect(expired({ expiresAt: '' }, now)).toBe(true)
    expect(expired({} as { expiresAt: string }, now)).toBe(true)
  })
})
