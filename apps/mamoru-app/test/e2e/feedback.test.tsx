import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ApiContext } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { FeedbackDialog, feedbackCopy, FeedbackForm } from '../../src/web/components/feedback-dialog.tsx'
import { fixtureClient, fixtureConfig, fixtureFunding, fixtureSession } from '../../src/web/fixtures/client.ts'
import { FIXTURE_ACCOUNT_KEY } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { buildRouter } from '../../src/web/router.tsx'
import { render } from './render.ts'

/** FeedbackDialog uses react-query and the ApiContext; both need a provider even for a static render. */
function dialog(open: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  return render(
    <ApiContext.Provider value={fixtureClient}>
      <QueryClientProvider client={qc}>
        <FeedbackDialog accountKey={FIXTURE_ACCOUNT_KEY} open={open} onClose={() => {}} />
      </QueryClientProvider>
    </ApiContext.Provider>,
  )
}

describe('feedback dialog copy (#72)', () => {
  test('closed: the dialog paints no content', () => {
    const { html, text } = dialog(false)
    expect(text).toBe('')
    expect(html).not.toContain('data-testid="feedback-pick"')
  })

  test('open, no path chosen yet: one button for help, two for feedback, no form field', () => {
    const { text, html } = dialog(true)
    expect(text).toContain(feedbackCopy.title)
    expect(text).toContain(feedbackCopy.needHelp)
    expect(text).toContain(feedbackCopy.haveFeedbackLead)
    expect(text).toContain(feedbackCopy.bug)
    expect(text).toContain(feedbackCopy.idea)
    expect(html).toContain('data-testid="feedback-pick"')
    expect(html).not.toContain('data-testid="feedback-form"')
  })

  test('the support form asks what help is needed; the bug form asks what went wrong; both carry the honeypot, contact and attach checkbox', () => {
    for (const path of ['support', 'bug', 'idea'] as const) {
      const { text, html } = render(<FeedbackForm path={path} accountKey={FIXTURE_ACCOUNT_KEY} busy={false} error={null} onBack={() => {}} onSend={() => {}} />)
      expect(text).toContain(feedbackCopy.bodyLabel(path))
      expect(text).toContain(feedbackCopy.contactLabel)
      expect(text).toContain(feedbackCopy.attachLabel)
      expect(text).toContain(feedbackCopy.send)
      expect(html).toContain('name="website"')
      expect(html).toContain('aria-hidden="true"')
    }
  })

  test('the attach checkbox is disabled when there is no account to attach', () => {
    const { html } = render(<FeedbackForm path="bug" accountKey={undefined} busy={false} error={null} onBack={() => {}} onSend={() => {}} />)
    expect(html).toContain('disabled')
  })

  test('busy shows "Sending" on the submit button; a 429 shows the rate-limit copy', () => {
    expect(render(<FeedbackForm path="bug" accountKey={FIXTURE_ACCOUNT_KEY} busy error={null} onBack={() => {}} onSend={() => {}} />).text).toContain(feedbackCopy.sending)
    expect(render(<FeedbackForm path="bug" accountKey={FIXTURE_ACCOUNT_KEY} busy={false} error={feedbackCopy.rateLimited} onBack={() => {}} onSend={() => {}} />).text).toContain(
      feedbackCopy.rateLimited,
    )
  })

  test('Home, mounted: the trigger sits in the footer next to Save recovery kit', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    qc.setQueryData(queryKeys.config, fixtureConfig)
    qc.setQueryData(queryKeys.session, fixtureSession)
    qc.setQueryData(queryKeys.pools, poolsResponse)
    qc.setQueryData(queryKeys.funding(FIXTURE_ACCOUNT_KEY), fixtureFunding)
    qc.setQueryData(queryKeys.ops(FIXTURE_ACCOUNT_KEY), { ops: [] })
    qc.setQueryData(queryKeys.otherChains(FIXTURE_ACCOUNT_KEY), undefined)
    const router = buildRouter(createMemoryHistory({ initialEntries: ['/'] }))
    await router.load()
    const { text } = render(
      <ApiContext.Provider value={fixtureClient}>
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ApiContext.Provider>,
    )
    expect(text).toContain('Save recovery kit')
    expect(text).toContain(feedbackCopy.trigger)
    expect(text.indexOf('Save recovery kit')).toBeLessThan(text.indexOf(feedbackCopy.trigger))
  })
})

describe('fixture client (#72)', () => {
  test('feedback() answers received with a fresh id each time, like the real API would', async () => {
    const a = await fixtureClient.feedback({ kind: 'bug', body: 'test one', route: '/' })
    const b = await fixtureClient.feedback({ kind: 'idea', body: 'test two', route: '/' })
    expect(a.received).toBe(true)
    expect(b.received).toBe(true)
    expect(a.id).not.toBe(b.id)
  })
})
