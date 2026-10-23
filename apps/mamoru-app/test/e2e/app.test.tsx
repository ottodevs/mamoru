import { describe, expect, test } from 'bun:test'
import type { AppConfig, ApyView, FundingView, OpView, SessionView, SignInChallenge, SignInRequest } from '@mamoru/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ApiContext, ApiRequestError, type ApiClient } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { fixtureClient, fixtureConfig, fixtureFunding, fixtureSession } from '../../src/web/fixtures/client.ts'
import { FIXTURE_ACCOUNT_KEY } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { base64url, PasskeyError } from '../../src/web/lib/passkey.ts'
import { challengeUsable, signInCopy, signInProblem, signInWithPasskey, WALKAWAY_URL } from '../../src/web/lib/signin.ts'
import { SignInCard } from '../../src/web/routes/signin.tsx'
import { base64urlDecode, hexToBytes } from '../../src/web/lib/passkey-sign.ts'
import { capNote, cbbtcPrice, ceilCents, holdings, humanMessage, overCapOf, split, usd, usdExactInput, usdPlain } from '../../src/web/lib/money.ts'
import { activationLive, historyOps, needsRetry, opLine } from '../../src/web/lib/ops.ts'
import { isAddress, parseUsdc } from '../../src/web/lib/owner-flow.ts'
import { encodeQr } from '../../src/web/lib/qr.ts'
import { localTime } from '../../src/web/lib/time.ts'
import { ApprovalBody, Emph, signedFacts } from '../../src/web/components/approval-dialog.tsx'
import { approvalDay, approvalHeading, approvalRowKey, approvalTitle, askedBefore, preparedFitsRow, engineLine, History, renewAskFor } from '../../src/web/routes/home.tsx'
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

async function renderRoute(path: string, session: SessionView | null, funding?: FundingView, more: { ops?: OpView[]; config?: AppConfig; apy?: ApyView } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(queryKeys.config, more.config ?? fixtureConfig)
  qc.setQueryData(queryKeys.session, session)
  qc.setQueryData(queryKeys.pools, poolsResponse)
  if (funding) qc.setQueryData(queryKeys.funding(FIXTURE_ACCOUNT_KEY), funding)
  qc.setQueryData(queryKeys.ops(FIXTURE_ACCOUNT_KEY), { ops: more.ops ?? [] })
  if (more.apy) qc.setQueryData(queryKeys.apy, more.apy)
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
    expect(text).toContain('1 position')
    expect(text).toContain('Idle capital 10.00 USDC · waiting to be placed')
    expect(text).toContain('Stop allocation')
    // Rates not loaded: n/a with the reason, never a figure.
    expect(text).toContain('Current rate n/a')
    expect(text).toContain('Monthly rate n/a')
    expect(text).not.toContain('UTC')
  })
  // otto/mamoru#198: the two rates under the balance, figure over "APY · what", sources behind (i); earned so
  // far with the balance. The per-pool rates sit next to each position in the Working capital table.
  test('rates: monthly and current under the balance, sources behind (i), per-pool rates beside each position', async () => {
    const apy: ApyView = {
      pool: 'conservador-live-v2',
      currentPct: 6.4,
      currentWindow: '24h',
      currentSource: 'Plan pools, fee APR · GeckoTerminal/DefiLlama',
      monthlyPct: 5.9,
      monthlySource: 'Plan pools, 30-day mean · DefiLlama',
      byPool: [{ pool: 'pool:USDC/cbBTC/500', weight: 10000, currentPct: 6.4, monthlyPct: 5.9 }],
      asOf: '2026-10-10T00:00:00.000Z',
    }
    const one: FundingView = { ...funded, positions: [{ tokenId: '1', pool: 'pool:USDC/cbBTC/500', liquidity: '1', inRange: true, amountUsdc: '5000000', amountCbbtc: '0', valueUsdc: '5000000' }] }
    const { text, html } = await renderRoute('/', fixtureSession, one, { apy })
    expect(text).toContain('5.9% Monthly rate APY · 30-day avg')
    expect(text).toContain('Current rate APY · now')
    expect(text).toContain('Monthly: DefiLlama')
    expect(text).toContain('Today: GeckoTerminal/DefiLlama')
    expect(html).toContain('aria-label="Rate sources"')
    expect(text).toContain('earned so far')
    expect(text).not.toContain('Saves automatically')
    expect(text).toContain('Balanced · USDC/cbBTC')
    expect(html).not.toContain('aria-label="Sources and method"')
    expect(html).toMatch(/<details class="dash-fold" open/)
  })
  test('funds present but not running: one Start button', async () => {
    const { text } = await renderRoute('/', fixtureSession, { ...fixtureFunding, active: false })
    expect(text).toContain('Mamoru is not running on this money yet.')
    expect(text).toContain('Start')
  })
  // otto/mamoru#135 review: a deposit never invalidates the operator's funding-poll cache (only an owner op
  // does), so a cached total of 0 can be stale. The Withdraw button must not disable off it — only "funding
  // has not loaded at all" does, same as the rest of the page.
  test('withdraw button: enabled once funding has loaded, even at a (possibly stale) zero total', async () => {
    const buttonTag = (html: string) => html.match(/<button[^>]*data-testid="withdraw-button"[^>]*>/)?.[0] ?? ''
    const zero: FundingView = { ...fixtureFunding, usdc: '0', cbbtc: '0', positions: [] }
    const loaded = await renderRoute('/', fixtureSession, zero)
    expect(buttonTag(loaded.html)).not.toContain('disabled')
    const notLoaded = await renderRoute('/', fixtureSession)
    expect(buttonTag(notLoaded.html)).toContain('disabled')
  })
  // otto/mamoru#135 review: a stopped account's restart is offered on the operator's state, not on the poll's
  // idle balance, which can be behind the deposit that makes a restart possible.
  test('stopped after running: the restart is offered even at a (possibly stale) zero idle balance', async () => {
    const started: OpView = { opId: 'own-1-activate', kind: 'activate', state: 'confirmed', updatedAt: '2026-10-01T10:00:00Z' }
    const stopped: FundingView = { ...fixtureFunding, active: false, usdc: '0', cbbtc: '0', positions: [], overCap: null }
    const { html } = await renderRoute('/', fixtureSession, stopped, { ops: [started] })
    expect(html).toContain('>Start allocation</button>')
  })
  test('old paths redirect home; unknown paths are not found', async () => {
    expect((await renderRoute('/deposit', null)).text).toContain('Page not found')
  })
})

// otto/mamoru#4: 26.92 USDC arrived on a 25 USDC cap. The operator refuses Start and reports it; the SPA says so.
describe('deposit cap', () => {
  const over = { code: 'DEPOSIT_OVER_CAP' as const, usdc: '26920000', capUsdc: '25000000', excessUsdc: '1920000' }
  const overFunding: FundingView = { ...fixtureFunding, usdc: '26920000', active: false, overCap: over }
  const refused: OpView = { opId: 'own-1-activate', kind: 'activate', state: 'failed', code: 'DEPOSIT_OVER_CAP', amountUsdc: '26920000', capUsdc: '25000000', updatedAt: '2026-10-01T10:00:00Z' }
  const live: AppConfig = { ...fixtureConfig, fundsGate: 'live', dryRun: false, capUsdc: '25000000' }

  test('the cap is said before funding: on the first card when the API runs live, and next to the deposit address', async () => {
    expect((await renderRoute('/', null, undefined, { config: live })).text).toContain('Send the USDC you want to invest. Up to 25 USDC per account for now.')
    expect((await renderRoute('/', null)).text).not.toContain('per account for now')
    expect((await renderRoute('/add', fixtureSession, { ...fixtureFunding, usdc: '0' })).text).toContain('Send USDC on Base. Up to 25 USDC per account for now.')
  })
  // otto/mamoru#135 review (post-merge Codex gpt-6-sol, HIGH): Start used to be hidden whenever this (up to
  // 60 s stale) poll read overCap, so an owner whose withdraw had already cleared the cap on the chain, but
  // not yet on this poll, could not reach the chain-reading prepare that would have let them start. Start now
  // stays offered next to the notice; its own prepare is what actually refuses one that is still over.
  test('Home over the cap: what happened, what to do, and Start stays offered next to it', async () => {
    const { text, html } = await renderRoute('/', fixtureSession, overFunding, { ops: [refused] })
    expect(text).toContain('This account is over the 25 USDC cap, so Mamoru has not started.')
    expect(text).toContain('It holds 26.92 USDC. Nothing was moved. Withdraw at least 1.92 USDC to an address you control, then start Mamoru.')
    expect(text).toContain('Withdraw 1.92 USDC')
    expect(html).toContain('data-testid="over-cap"')
    expect(html).toContain('data-testid="start"')
    expect(text).toContain('Start refused: 26.92 USDC is over the 25 USDC cap')
    expect(text).not.toContain('Approve again')
    expect(text.split('Save recovery kit')[0]).not.toContain('!')
  })
  test('an operator that does not report overCap yet: the SPA derives it from the balance and the cap', async () => {
    const { overCap: _, ...old } = overFunding
    expect(overCapOf(old)).toEqual(over)
    expect((await renderRoute('/', fixtureSession, old)).text).toContain('Withdraw 1.92 USDC')
    expect(overCapOf({ ...old, active: true })).toBeNull()
  })
  test('at the cap or under it nothing changes: one Start button', async () => {
    const { html } = await renderRoute('/', fixtureSession, { ...fixtureFunding, usdc: '25000000', active: false, overCap: null })
    expect(html).toContain('data-testid="start"')
    expect(html).not.toContain('data-testid="over-cap"')
  })
  // otto/mamoru#135 review (post-merge Codex gpt-6-sol, HIGH): canRestart used to require `!over`, so a stopped
  // account whose cap notice still read over (this poll can be behind a withdraw that already cleared it)
  // offered neither Stop (nothing is active, nothing is open) nor a restart — the Working card's own header
  // went blank, no action reachable there at all. The restart stays offered now; its own prepare refuses it,
  // with the real reason, if the account is still over.
  test('stopped while the cap notice still reads over: the restart is still offered, not swallowed by it', async () => {
    const started: OpView = { opId: 'own-1-activate', kind: 'activate', state: 'confirmed', updatedAt: '2026-10-01T10:00:00Z' }
    const stoppedOver: FundingView = { ...fixtureFunding, active: false, usdc: '26920000', cbbtc: '0', positions: [] }
    const { html } = await renderRoute('/', fixtureSession, stoppedOver, { ops: [started] })
    expect(html).toContain('data-testid="over-cap"')
    expect(html).toContain('>Start allocation</button>')
  })
  test('while the withdraw is in flight the notice steps aside', async () => {
    const sending: OpView = { opId: 'own-2-transfer', kind: 'transfer', state: 'submitted', updatedAt: '2026-10-01T10:05:00Z' }
    expect((await renderRoute('/', fixtureSession, overFunding, { ops: [refused, sending] })).html).not.toContain('data-testid="over-cap"')
  })
  test('over the cap wins over an armed activation: the notice and the withdraw show while the start is still armed', async () => {
    const armedOp: OpView = { opId: 'own-1-activate', kind: 'activate', state: 'proposed', code: 'ARMED', updatedAt: '2026-10-01T10:00:00Z' }
    const { text, html } = await renderRoute('/', fixtureSession, overFunding, { ops: [armedOp] })
    expect(html).toContain('data-testid="over-cap"')
    expect(text).toContain('Withdraw 1.92 USDC')
    expect(html).not.toContain('data-testid="start"')
    // After the withdraw the operator fails the armed start as superseded: no notice, no stale line, a fresh Start.
    const superseded: OpView = { ...armedOp, state: 'failed', code: 'ARMED_SUPERSEDED' }
    const sent: OpView = { opId: 'own-2-transfer', kind: 'transfer', state: 'confirmed', amountUsdc: '1920000', updatedAt: '2026-10-01T10:05:00Z' }
    const after = await renderRoute('/', fixtureSession, { ...overFunding, usdc: '25000000', deployed: true, overCap: null }, { ops: [superseded, sent] })
    expect(after.html).toContain('data-testid="start"')
    expect(after.html).not.toContain('data-testid="over-cap"')
    expect(after.text).toContain('Mamoru is not running on this money yet.')
    expect(after.text).not.toContain('Start needs another approval')
  })
  test('under the 1 USDC the relayer deploys for: the account says why nothing started', async () => {
    const small: FundingView = { ...fixtureFunding, usdc: '500000', active: false, deployed: false, overCap: null, deployMinUsdc: '1000000' }
    const { text, html } = await renderRoute('/', fixtureSession, small)
    expect(html).toContain('data-testid="below-minimum"')
    expect(text).toContain('Mamoru starts from 1 USDC. This account holds 0.50 USDC, so it has not started. Add at least 0.50 USDC more.')
    // otto/mamoru#135: the top-up that clears this is a deposit the poll can be behind: Start stays offered, and
    // its prepare reads the chain and refuses below the minimum (BELOW_DEPLOY_MINIMUM) if it still is.
    expect(html).toContain('data-testid="start"')
    expect((await renderRoute('/', fixtureSession, { ...small, usdc: '1000000' })).html).toContain('data-testid="start"')
    expect((await renderRoute('/', fixtureSession, { ...small, deployed: true })).html).toContain('data-testid="start"')
  })
  test('Add capital over the cap: the arrival line says why nothing started and stays', async () => {
    const { text } = await renderRoute('/add', fixtureSession, overFunding)
    expect(text).toContain('26.92 USDC arrived. That is 1.92 USDC over the 25 USDC cap, so Mamoru has not started. Your money is in your account and nothing was moved.')
    expect(text).toContain('See what you can do')
    expect(text).not.toContain('Waiting for your USDC')
  })
  test('the refusal reads as one line and offers no pointless retry; older operators stored CAP_EXCEEDED', () => {
    expect(opLine(refused)).toBe('Start refused: 26.92 USDC is over the 25 USDC cap')
    expect(needsRetry(refused)).toBe(false)
    const legacy: OpView = { opId: 'own-1-activate', kind: 'activate', state: 'failed', code: 'CAP_EXCEEDED', updatedAt: '2026-10-01T10:00:00Z' }
    expect(opLine(legacy)).toBe('Start refused: the deposit was over the cap')
    expect(needsRetry(legacy)).toBe(false)
    expect(needsRetry({ ...refused, code: 'OWNER_TX_REVERTS' })).toBe(true)
    expect(historyOps([refused]).map((o) => o.opId)).toEqual(['own-1-activate'])
  })
  test('the excess is rounded up to the cent, never understated', () => {
    expect(ceilCents(1_920_000n)).toBe(1_920_000n)
    expect(ceilCents(1_920_001n)).toBe(1_930_000n)
    expect(ceilCents(1n)).toBe(10_000n)
    expect(usdPlain('25000000')).toBe('25')
    expect(usdPlain('1920000')).toBe('1.92')
    expect(capNote('25000000')).toBe('Up to 25 USDC per account for now.')
  })
})

// otto/mamoru#6: a returning owner whose session is gone signs in with the passkey that owns the account.
describe('sign in', () => {
  const noop = () => {}
  const card = (p: Partial<Parameters<typeof SignInCard>[0]>) => render(<SignInCard busy={false} problem={null} remembered={false} onSignIn={noop} onRemembered={noop} onCreate={noop} {...p} />)

  test('the first screen offers the way back in, on every card', async () => {
    const { text } = await renderRoute('/', null)
    expect(text).toContain('01 / 03')
    expect(text).toContain('I already have an account')
  })
  test('?signin=true opens on the sign-in card: what it does, the passkey button, and help for a device without the passkey', async () => {
    const { text, html } = await renderRoute('/?signin=true', null)
    expect(html).toContain('data-testid="signin"')
    expect(text).not.toContain('01 / 03')
    expect(text).toContain('Open your account')
    expect(text).toContain('This only signs you in. No money moves.')
    expect(text).toContain('Sign in with passkey')
    expect(text).toContain('Create a new account')
    expect(text).toContain('Passkeys sync through your Apple, Google or password manager account.')
    expect(text).toContain('The recovery kit cannot sign you in: it holds no key.')
    expect(html).toContain(`href="${WALKAWAY_URL}"`)
  })
  test('a session with an account goes straight to Home, whatever the link says', async () => {
    const { text } = await renderRoute('/?signin=true', fixtureSession, funded)
    expect(text).toContain('Total balance')
    expect(text).not.toContain('Open your account')
  })
  test('the card says what went wrong in plain words', () => {
    expect(card({ busy: true }).text).toContain('Waiting for passkey')
    const cancelled = card({ problem: signInProblem(new DOMException('x', 'NotAllowedError')) })
    expect(cancelled.text).toContain('No passkey was used, so you are not signed in.')
    expect(cancelled.text).not.toContain(signInCopy.remembered)
    expect(card({ problem: signInProblem(new DOMException('x', 'NotAllowedError')), remembered: true }).text).toContain('Try the passkey this browser used before')
    const refused = card({ problem: signInProblem(new ApiRequestError(401, { error: 'Sign-in failed.', code: 'AUTH_SIGNIN_FAILED' })), remembered: true })
    expect(refused.html).toContain('data-testid="signin-refused"')
    expect(refused.text).toContain('That passkey does not open a Mamoru account on this site.')
    // A refusal says the money is safe and how to reach it without Mamoru.
    expect(refused.text).toContain('Your funds are not affected. They are in your account on Base, and your passkey with your recovery kit can withdraw them without Mamoru. How to withdraw with the recovery kit')
    expect(refused.html).toContain('data-testid="signin-funds"')
    expect(cancelled.html).not.toContain('data-testid="signin-funds"')
    expect(refused.text).not.toContain(signInCopy.remembered)
    expect(refused.text).not.toContain('Sign-in failed.')
  })
  test('errors map to a kind: cancelled, refused, rate limited, unsupported, anything else', () => {
    expect(signInProblem(new DOMException('x', 'AbortError')).kind).toBe('cancelled')
    expect(signInProblem(new ApiRequestError(401, null)).kind).toBe('refused')
    expect(signInProblem(new ApiRequestError(429, { error: 'slow' }))).toEqual({ kind: 'limited', message: 'Too many attempts. Wait a few minutes and try again.' })
    expect(signInProblem(new PasskeyError('no passkeys here'))).toEqual({ kind: 'unsupported', message: 'no passkeys here' })
    expect(signInProblem(new ApiRequestError(500, null)).kind).toBe('failed')
    expect(signInProblem(new TypeError('fetch failed')).message).toBe('Mamoru did not answer. Try again.')
    for (const line of Object.values(signInCopy)) expect(line).not.toContain('!')
  })
  test('a challenge close to its expiry is not used', () => {
    const at = Date.parse('2026-10-01T10:00:00Z')
    const c = (ms: number): SignInChallenge => ({ challenge: 'c', token: 't', rpId: 'app.mamoru.lol', expiresAt: new Date(at + ms).toISOString() })
    expect(challengeUsable(c(300_000), at)).toBe(true)
    expect(challengeUsable(c(20_000), at)).toBe(false)
    expect(challengeUsable(undefined, at)).toBe(false)
  })
  test('the ceremony asks for any passkey of this site over the server challenge and posts the assertion as base64url', async () => {
    const g = globalThis as Record<string, unknown>
    const before = { pkc: g.PublicKeyCredential, location: g.location, credentials: Object.getOwnPropertyDescriptor(navigator, 'credentials') }
    const asked: CredentialRequestOptions[] = []
    const sent: SignInRequest[] = []
    const bytes = (...b: number[]) => new Uint8Array(b).buffer
    g.PublicKeyCredential = class {}
    g.location = { hostname: 'app.mamoru.lol' }
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        get: async (o: CredentialRequestOptions) => {
          asked.push(o)
          return { rawId: bytes(251, 255, 0), response: { authenticatorData: bytes(1, 2), clientDataJSON: bytes(3), signature: bytes(4, 5) } }
        },
      },
    })
    try {
      const api = { signIn: async (b: SignInRequest) => (sent.push(b), fixtureSession) } as unknown as ApiClient
      const challenge: SignInChallenge = { challenge: base64url(new Uint8Array(32).fill(7)), token: 'tok', rpId: 'app.mamoru.lol', expiresAt: '2026-10-01T10:05:00Z' }
      expect(await signInWithPasskey(api, challenge)).toEqual(fixtureSession)
      const pk = asked[0]!.publicKey!
      expect(Array.from(pk.challenge as Uint8Array)).toEqual(Array(32).fill(7))
      expect(pk.allowCredentials).toEqual([])
      expect(pk.userVerification).toBe('required')
      expect(pk.rpId).toBe('app.mamoru.lol')
      expect(sent[0]).toEqual({ token: 'tok', credentialId: '-_8A', authenticatorData: 'AQI', clientDataJSON: 'Aw', signature: 'BAU' })
      // Limited to the credentials this browser used before, when asked.
      await signInWithPasskey(api, challenge, ['-_8A'])
      expect(asked[1]!.publicKey!.allowCredentials).toHaveLength(1)
      expect(Array.from(asked[1]!.publicKey!.allowCredentials![0]!.id as Uint8Array)).toEqual([251, 255, 0])
    } finally {
      g.PublicKeyCredential = before.pkc
      g.location = before.location
      if (before.credentials) Object.defineProperty(navigator, 'credentials', before.credentials)
      else delete (navigator as unknown as Record<string, unknown>).credentials
    }
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
  test('Max is all of it when every dollar is idle USDC: nothing to unwind, no margin, no dust left behind', () => {
    const s = split({ ...funded, usdc: '26983456', positions: [] }, cbbtcPrice(poolsResponse))
    expect(s.maxWithdraw).toBe(26_983_456n)
    expect(usdExactInput(s.maxWithdraw)).toBe('26.983456')
    expect(parseUsdc(usdExactInput(s.maxWithdraw))).toBe('26983456')
    expect(usdExactInput(26_900_000n)).toBe('26.90')
    expect(usdExactInput(10_000n)).toBe('0.01')
    // the approval screen shows what is sent, not a cents-truncated figure (usd() would say 26.98)
    expect(usdExactInput(BigInt(parseUsdc('26.983456') ?? '0'))).toBe('26.983456')
    expect(usdExactInput(BigInt(parseUsdc('5') ?? '0'))).toBe('5.00')
  })
  test('operator errors become plain USDC copy', () => {
    expect(humanMessage('the Safe cannot free 2000000 USDC base units', 1_930_000n)).toBe('You can withdraw up to 1.93 USDC right now.')
    expect(humanMessage('needs 2000000 USDC base units')).toBe('needs 2.00 USDC')
  })
  test('ops read as one plain line', () => {
    const op = (o: Partial<OpView>): OpView => ({ opId: 'x', kind: 'enter', state: 'confirmed', updatedAt: '2026-09-26T20:00:00Z', ...o })
    // No pool on the op (a row from before otto/mamoru#131, or an owner op that is not pool-specific): a neutral line, not a guessed pool.
    expect(opLine(op({}))).toBe('Opened a position')
    expect(opLine(op({ pool: 'pool:USDC/cbBTC/500' }))).toBe('Opened USDC/cbBTC position')
    expect(opLine(op({ kind: 'activate', state: 'proposed', code: 'ARMED' }))).toBe('Start approved')
    expect(activationLive([op({ kind: 'activate', state: 'failed' })])).toBe(false)
    expect(opLine(op({ opId: 'own-4-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR' }))).toBe('Stop needs another approval')
    expect(opLine(op({ opId: 'own-4-exit', kind: 'exit' }))).toBe('Allocation stopped')
    expect(opLine(op({ opId: 'eng-1-1-op-1-enter_swap' }))).toBe('Swapped')
    expect(opLine(op({ opId: 'eng-1-1-op-1-enter_swap', tokenIn: 'USDC', tokenOut: 'cbBTC', amountIn: '10000000' }))).toBe('Swapped 10 USDC to cbBTC')
    const { html } = render(<History ops={[op({ txHash: `0x${'b'.repeat(64)}` })]} />)
    expect(html).toContain(`https://basescan.org/tx/0x${'b'.repeat(64)}`)
    expect(opLine(op({ opId: 'own-3-transfer', kind: 'transfer', amountUsdc: '1500000', to: `0x${'c'.repeat(40)}` }))).toBe('Withdrew 1.50 USDC to 0xcccc…cccc')
  })
  test('history hides internal attempts and superseded failures', () => {
    const at = (i: number) => `2026-09-26T21:0${i}:00.000Z`
    const op = (opId: string, kind: OpView['kind'], state: OpView['state'], i: number, code?: string): OpView => ({ opId, kind, state, updatedAt: at(i), ...(code ? { code } : {}) })
    const shown = historyOps([
      op('own-1-activate', 'activate', 'failed', 0, 'OWNER_TX_REVERTS'),
      op('own-2-activate', 'activate', 'confirmed', 1),
      op('eng-1-1-op-1-enter_swap', 'enter', 'failed', 2, 'RECON_UNINCLUDABLE'),
      op('eng-1-1-op-2-enter_mint', 'enter', 'confirmed', 3),
      op('eng-1-1-op-3-enter_swap', 'enter', 'proposed', 4),
      op('own-3-transfer', 'transfer', 'failed', 5, 'OWNER_TX_REVERTS'),
      op('own-4-exit', 'exit', 'failed', 6, 'OWNER_TX_ERROR'),
    ]).map((o) => o.opId)
    expect(shown).toEqual(['own-4-exit', 'own-3-transfer', 'eng-1-1-op-2-enter_mint', 'own-2-activate'])
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

// otto/mamoru#112: one approval lasts a year; in its last weeks a running account is offered the renewal.
describe('renewing the approval', () => {
  const now = Math.floor(Date.now() / 1000)
  const running = (approval: FundingView['approval']): FundingView => ({ ...funded, active: true, approval })

  test('nothing is asked while the approval has months left', async () => {
    const { text, html } = await renderRoute('/', fixtureSession, running({ validUntil: now + 200 * 86_400, renewDue: false, expired: false }))
    expect(html).not.toContain('data-testid="renew"')
    expect(text).not.toContain('Renew approval')
  })

  test('in the renewal window the account says the day it ends and offers one tap', async () => {
    const validUntil = now + 12 * 86_400
    const { text, html } = await renderRoute('/', fixtureSession, running({ validUntil, renewDue: true, expired: false }))
    expect(html).toContain('data-testid="renew"')
    expect(text).toContain(`Mamoru's approval ends on ${approvalDay(validUntil)}. Renew it so your money keeps working.`)
    expect(text).toContain('One tap with your passkey. Nothing is moved.')
    expect(text).toContain('Renew approval')
  })

  test('once it has ended the account says what that means for the money', async () => {
    const { text } = await renderRoute('/', fixtureSession, running({ validUntil: now - 3600, renewDue: true, expired: true }))
    expect(text).toContain("Mamoru's approval has ended. Your money is where it was, but Mamoru cannot manage it until you renew.")
  })

  test('a renewal on its way hides the row; history reads it in plain words', async () => {
    const sent: OpView = { opId: 'own-4-renew', kind: 'renew', state: 'submitted', updatedAt: '2026-10-11T10:00:00Z' }
    const { html } = await renderRoute('/', fixtureSession, running({ validUntil: now + 12 * 86_400, renewDue: true, expired: false }), { ops: [sent] })
    expect(html).not.toContain('data-testid="renew"')
    expect(opLine(sent)).toBe('Renewing approval')
    expect(opLine({ ...sent, state: 'confirmed' })).toBe('Approval renewed')
    expect(opLine({ ...sent, state: 'failed', code: 'OWNER_TX_FAILED' })).toBe('Renewal needs another approval')
  })

  // otto/mamoru#148: owners cannot be messaged, so Home asks in a dialog on arrival, once per visit and approval.
  test('the arrival dialog is asked for only while a running approval is due and no renewal is on its way', () => {
    const due = running({ validUntil: now + 12 * 86_400, renewDue: true, expired: false })
    const key = renewAskFor(due, false)
    expect(key).toBe(`mamoru:renew-asked:${due.address}:${now + 12 * 86_400}`)
    expect(renewAskFor(running({ validUntil: now - 3600, renewDue: true, expired: true }), false)).not.toBeNull()
    expect(renewAskFor(running({ validUntil: now + 200 * 86_400, renewDue: false, expired: false }), false)).toBeNull()
    expect(renewAskFor(running({ validUntil: now + 200 * 86_400, renewDue: false, expired: false, missing: 4 }), false)).toBeNull()
    // #149: a spent grant is asked once too; one at 80% only shows the row.
    const spent = renewAskFor(running({ validUntil: now + 200 * 86_400, renewDue: false, expired: false, usage: { action: 'collect', pool: null, usedBps: 10_000, spent: true } }), false)
    expect(spent).toEndWith(':spent')
    expect(renewAskFor(running({ validUntil: now + 200 * 86_400, renewDue: false, expired: false, usage: { action: 'collect', pool: null, usedBps: 8_000, spent: false } }), false)).toBeNull()
    expect(renewAskFor(due, true)).toBeNull()
    expect(renewAskFor({ ...due, active: false }, false)).toBeNull()
    expect(renewAskFor(undefined, false)).toBeNull()
    // Next year's approval is a new one: its last weeks ask again.
    expect(renewAskFor(running({ validUntil: now + 377 * 86_400, renewDue: true, expired: false }), false)).not.toBe(key)
  })

  test('each approval is asked once per visit, even with storage blocked', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(askedBefore('t:a', () => storage)).toBe(false)
    expect(askedBefore('t:a', () => storage)).toBe(true)
    expect(store.get('t:a')).toBe('1')
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(askedBefore('t:b', () => blocked)).toBe(false)
    expect(askedBefore('t:b', () => blocked)).toBe(true)
    // The browser denies storage itself: reading sessionStorage throws a SecurityError.
    const denied = () => { throw new DOMException('denied', 'SecurityError') }
    expect(askedBefore('t:d', denied)).toBe(false)
    expect(askedBefore('t:d', denied)).toBe(true)
    // A key a previous page load of this tab already asked: storage remembers it.
    store.set('t:c', '1')
    expect(askedBefore('t:c', () => storage)).toBe(true)
  })

  test('the dialog is closed until Home has opened in the browser', async () => {
    const { html } = await renderRoute('/', fixtureSession, running({ validUntil: now + 12 * 86_400, renewDue: true, expired: false }))
    expect(html).toContain('data-testid="renew"')
    expect(html).not.toContain('data-testid="renew-dialog"')
  })

  test('an account that is not running is never asked to renew', async () => {
    const { html } = await renderRoute('/', fixtureSession, { ...funded, active: false, approval: null })
    expect(html).not.toContain('data-testid="renew"')
  })

  // otto/mamoru#5: grants left out at activation to fit Base's gas cap are added with one more tap.
  test('an account missing grants is asked for one more approval, months before any renewal', async () => {
    const { text, html } = await renderRoute('/', fixtureSession, running({ validUntil: now + 200 * 86_400, renewDue: false, expired: false, missing: 4 }))
    expect(html).toContain('data-testid="renew"')
    expect(text).toContain('Mamoru is missing part of its approval: in some pools it cannot re-range or collect fees until you add it.')
    expect(text).toContain('One tap with your passkey. Nothing is moved.')
    expect(text).not.toContain('Renew approval')
    // When the renewal is due as well, the renewal is what is asked first.
    const both = await renderRoute('/', fixtureSession, running({ validUntil: now + 12 * 86_400, renewDue: true, expired: false, missing: 4 }))
    expect(both.text).toContain('Renew approval')
  })

  test('the row comes back for the next approval once one lands: a renewal changes the end date, an extension what is missing', () => {
    const due = { validUntil: now + 12 * 86_400, renewDue: true, expired: false, missing: 4 }
    const renewed = { validUntil: now + 365 * 86_400, renewDue: false, expired: false, missing: 4 }
    const extended = { ...renewed, missing: 2 }
    expect(new Set([approvalRowKey(due), approvalRowKey(renewed), approvalRowKey(extended)]).size).toBe(3)
  })

  test('#149: a grant near the end of its usage shows the renewal row before it stops, and says when it has stopped', async () => {
    const year = { validUntil: now + 300 * 86_400, renewDue: false, expired: false }
    const soon = await renderRoute('/', fixtureSession, running({ ...year, usage: { action: 'collect', pool: 'pool:USDC/cbBTC/500', usedBps: 8_000, spent: false } }))
    expect(soon.text).toContain('Mamoru has used most of what this approval allows for collecting fees in USDC / cbBTC. Renew it now so that does not stop.')
    expect(soon.text).toContain('Renew approval')
    expect(soon.text).toContain('One tap with your passkey. Nothing is moved.')
    const spent = await renderRoute('/', fixtureSession, running({ ...year, missing: 4, usage: { action: 'rerange', pool: 'pool:WETH/USDC/3000', usedBps: 10_000, spent: true } }))
    expect(spent.text).toContain('Mamoru has used all that this approval allows for re-ranging in USDC / WETH, so it has stopped doing that. Renew it to start again.')
    expect(spent.text).toContain('Renew approval')
    // Spent outranks a renewal that is merely due; an approval that ended outranks both.
    expect(approvalTitle({ ...year, renewDue: true, usage: { action: 'enter', pool: null, usedBps: 10_000, spent: true } })).toBe('Mamoru has used all that this approval allows for adding money in its pools, so it has stopped doing that. Renew it to start again.')
    expect(approvalTitle({ ...year, expired: true, usage: { action: 'enter', pool: null, usedBps: 10_000, spent: true } })).toContain('approval has ended')
    expect(new Set([approvalRowKey(year), approvalRowKey({ ...year, usage: { action: 'collect', pool: null, usedBps: 8_000, spent: false } }), approvalRowKey({ ...year, usage: { action: 'collect', pool: null, usedBps: 10_000, spent: true } })]).size).toBe(3)
  })

  test('spec 007 T7: the move to the on-chain action policy is offered on the same row, under a due renewal', async () => {
    const now = Math.floor(Date.now() / 1000)
    const year = { validUntil: now + 300 * 86_400, renewDue: false, expired: false }
    const up = await renderRoute('/', fixtureSession, running({ ...year, upgrade: true }))
    expect(up.text).toContain('it would trade only near the market price, and only the positions it opened')
    expect(up.text).toContain('Renew approval')
    expect(approvalTitle({ ...year, renewDue: true, upgrade: true })).toContain('approval ends on')
    expect(approvalRowKey({ ...year, upgrade: true })).not.toBe(approvalRowKey(year))
    // otto/mamoru#151: the move to MamoruActionPolicyV2 (v5) says what it adds.
    expect(approvalTitle({ ...year, upgrade: true, upgradePolicy: 'conservador-live-v5' })).toContain('adds to a position it already holds instead of opening another')
    expect(approvalTitle({ ...year, upgrade: true, upgradePolicy: 'conservador-live-v5' })).toContain('a guardian key can pause it but never move funds')
    expect(approvalTitle({ ...year, upgrade: true, upgradePolicy: 'conservador-live-v4' })).toContain('it would trade only near the market price')
  })

  test('otto/mamoru#151 (GPT-6 review P1): the row is keyed on the policy it moves to; a prepared move for another is not signed', () => {
    const now = Math.floor(Date.now() / 1000)
    const year = { validUntil: now + 300 * 86_400, renewDue: false, expired: false }
    const toV4 = { ...year, upgrade: true, upgradePolicy: 'conservador-live-v4' }
    const toV5 = { ...year, upgrade: true, upgradePolicy: 'conservador-live-v5' }
    expect(approvalRowKey(toV4)).not.toBe(approvalRowKey(toV5))
    expect(preparedFitsRow(toV5, { policyId: 'conservador-live-v4' })).toBe(false)
    expect(preparedFitsRow(toV5, { policyId: 'conservador-live-v5' })).toBe(true)
    expect(preparedFitsRow(toV4, { policyId: 'conservador-live-v4' })).toBe(true)
    expect(preparedFitsRow(year, { policyId: 'conservador-live-v2' })).toBe(true)
    expect(preparedFitsRow(toV5, {})).toBe(true)
  })

  test('otto/mamoru#151 (GPT-6 round 2): v5 flag off with the dialog open: the prepared v5 move no longer fits, nothing to approve', () => {
    const now = Math.floor(Date.now() / 1000)
    const year = { validUntil: now + 300 * 86_400, renewDue: false, expired: false }
    const offered = { ...year, upgrade: true, upgradePolicy: 'conservador-live-v5', policyId: 'conservador-live-v4' }
    const v5Move = { policyId: 'conservador-live-v5', move: true }
    expect(preparedFitsRow(offered, v5Move)).toBe(true)
    // The flag goes off: the row offers a plain renewal of the account's own v4.
    const after = { ...year, renewDue: true, policyId: 'conservador-live-v4' }
    expect(preparedFitsRow(after, v5Move)).toBe(false)
    expect(preparedFitsRow(after, { policyId: 'conservador-live-v4', move: true })).toBe(false) // a move where none is offered
    expect(preparedFitsRow(after, { policyId: 'conservador-live-v4', move: false })).toBe(true)
    expect(preparedFitsRow(after, { policyId: 'conservador-live-v5', move: false })).toBe(false)
    expect(preparedFitsRow(offered, { policyId: 'conservador-live-v4', move: false })).toBe(false) // a renewal where a move is offered
    expect(approvalRowKey(after)).not.toBe(approvalRowKey(offered))
  })

  test('#176 on #151: the approval dialog heads a guardian pause and a policy move in their own words', () => {
    const now = Math.floor(Date.now() / 1000)
    const year = { validUntil: now + 300 * 86_400, renewDue: false, expired: false }
    expect(approvalHeading({ ...year, renewDue: true, paused: true }).title).toContain('A guardian key has paused Mamoru')
    expect(approvalHeading({ ...year, renewDue: true, paused: true }).lead).toContain('Renewing its approval ends that pause')
    expect(approvalHeading({ ...year, upgrade: true, upgradePolicy: 'conservador-live-v5' }).lead).toContain('a guardian key can pause it but never move funds')
    expect(approvalHeading({ ...year, upgrade: true, upgradePolicy: 'conservador-live-v4' }).lead).toContain('it would trade only near the market price')
    expect(approvalHeading({ ...year, upgrade: true }).title).not.toContain('every pool')
  })

  test('otto/mamoru#151: a guardian pause is named on the row, with the renewal ending it', () => {
    const now = Math.floor(Date.now() / 1000)
    const year = { validUntil: now + 300 * 86_400, renewDue: true, expired: false }
    expect(approvalTitle({ ...year, paused: true })).toContain('A guardian key has paused Mamoru')
    expect(approvalTitle({ ...year, paused: true })).toContain('Renewing its approval ends that pause')
    expect(approvalRowKey({ ...year, paused: true })).not.toBe(approvalRowKey(year))
  })

    test('#176: once prepared, the approval dialog lays out every line the passkey signs, word for word, behind a brief', () => {
    const summary = [
      "Renew Mamoru's approval on your Safe 0x5af19C48077D38F10B4245a6B2D92478aaEFAcD0",
      'Engine key 0x1111111111111111111111111111111111111111 may keep doing the same kinds of actions for 365 more days, within new limits counted from zero, sized for deposits up to 1,000.00 USDC (the cap you signed):',
      'In USDC/cbBTC 0.05%: USDC swapped in at most 25.00 per swap and 50.00 in total',
      'Nothing is moved: your positions stay as they are',
    ]
    const { text, html } = render(<ApprovalBody lead="It ends soon." summary={summary} busy={null} error={null} onPrepare={() => {}} onApprove={() => {}} onLater={() => {}} />)
    expect(html).toContain('data-testid="review"')
    // #41 / #176 review: the signed lines are open next to Approve, never folded away by default.
    expect(html).toMatch(/<details[^>]*data-testid="review"[^>]*\bopen/)
    for (const line of summary) expect(text).toContain(line)
    expect(signedFacts(summary)).toEqual({ days: 365, capUsdc: '1,000.00', pools: ['USDC/cbBTC 0.05%'] })
    expect(text).toContain('Approve with passkey')
    expect(text).toContain('Nothing moves now')
    // Figures are emphasized, never rewritten: the text reads as signed, and "v3" stays plain.
    const line = 'It also keeps acting on any Uniswap v3 position: at most 256 transactions, 1,000.00 USDC'
    const emph = render(<Emph text={line} />)
    expect(emph.text).toBe(line)
    expect(emph.html).toContain('<strong class="signed-num">256</strong>')
    expect(emph.html).toContain('<strong class="signed-num">1,000.00</strong>')
    expect(emph.html).not.toContain('<strong class="signed-num">3</strong>')
    // Before it is prepared: the brief and one action to review it, no signed lines yet.
    const before = render(<ApprovalBody lead="It ends soon." summary={null} busy={null} error={null} onPrepare={() => {}} onApprove={() => {}} onLater={() => {}} />)
    expect(before.html).not.toContain('data-testid="review"')
    expect(before.text).toContain('Review')
  })

    test('history reads an extension in its own words', () => {
    const op: OpView = { opId: 'own-5-renew', kind: 'renew', state: 'confirmed', updatedAt: '2026-10-15T10:00:00Z', extend: true }
    expect(opLine(op)).toBe('Approval extended')
    expect(opLine({ ...op, state: 'submitted' })).toBe('Extending approval')
  })
})

// otto/mamoru#122 and #121: every token counts and shows, and the account says what Mamoru is doing between steps.
describe('funds by token and what Mamoru is doing', () => {
  // Ot's beta account after the first step: 5 USDC in, 1.25 swapped to USDT and waiting for its mint.
  const midEntry: FundingView = {
    ...funded,
    active: true,
    usdc: '3748000',
    cbbtc: '0',
    positions: [],
    idle: [
      { token: 'USDC', amount: '3748000', decimals: 6, valueUsdc: '3748000' },
      { token: 'USDT', amount: '1253694', decimals: 6, valueUsdc: '1253694' },
    ],
    engine: { placing: true, nextReviewAt: new Date(Date.now() + 5_000).toISOString() },
  }

  test('the total counts the USDT too: 5 in, 5 shown', () => {
    expect(usd(split(midEntry, null).total)).toBe('5.00')
    // An operator that does not list tokens yet: the old sum, as before.
    expect(usd(split({ ...midEntry, idle: undefined }, null).total)).toBe('3.74')
  })

  test('Home says the money is being placed and lists each idle token when there is more than one', async () => {
    const { text, html } = await renderRoute('/', fixtureSession, midEntry)
    expect(text).toContain('Total balance 5.00 USDC')
    expect(text).toContain('Idle capital 5.00 USDC · being placed')
    expect(html).toContain('data-testid="idle-tokens"')
    expect(text).toContain('3.74 USDC')
    expect(text).toContain('1.25 USDT')
    expect(text).toContain('Placing your money. The next step starts in a few seconds.')
  })

  test('holdings add what is outside and what is in positions, per token, largest first', () => {
    const f: FundingView = {
      ...midEntry,
      positions: [
        {
          tokenId: '1', pool: 'pool:USDC/USDT/100', liquidity: '1', inRange: true, amountUsdc: '1000000', amountCbbtc: '0', valueUsdc: '2500000',
          amounts: [
            { token: 'USDC', amount: '1000000', decimals: 6, valueUsdc: '1000000' },
            { token: 'USDT', amount: '1500000', decimals: 6, valueUsdc: '1500000' },
          ],
        },
      ],
    }
    const rows = holdings(f)!
    expect(rows.map((h) => [h.token, String(h.amount), String(h.valueUsdc), String(h.idle), String(h.working)])).toEqual([
      ['USDC', '4748000', '4748000', '3748000', '1000000'],
      ['USDT', '2753694', '2753694', '1253694', '1500000'],
    ])
    // Without values per token (an older operator) there is no split to show, rather than a wrong one.
    expect(holdings({ ...f, idle: undefined })).toBeNull()
  })

  test('between operations a running account says when Mamoru looks again; a stopped one says nothing', () => {
    const at = new Date('2026-10-11T21:30:00Z').toISOString()
    const line = engineLine({ ...midEntry, engine: { placing: false, nextReviewAt: at } })!
    expect(line.startsWith('Nothing to do right now. Mamoru looks again at ')).toBe(true)
    expect(engineLine({ ...midEntry, engine: { placing: true, nextReviewAt: at } })).toBe('Placing your money. The next step starts in a few seconds.')
    expect(engineLine({ ...midEntry, active: false })).toBeNull()
    expect(engineLine({ ...midEntry, engine: null })).toBeNull()
  })

  test('money held back on purpose says why and when it was checked (otto/mamoru#128)', () => {
    const at = new Date('2026-10-16T10:00:00Z').toISOString()
    const depth = engineLine({ ...midEntry, engine: { placing: false, nextReviewAt: at, reviewedAt: at, waiting: [{ bucket: 'stables', pool: 'pool:USDC/USDT/100', code: 'DECIDE_WAIT_DEPTH', amountUsdc: '40000000' }] } })!
    expect(depth.startsWith('40.00 USDC is waiting: the USDC/USDT pool is not deep enough for more right now. Checked at ')).toBe(true)
    const fall = engineLine({ ...midEntry, engine: { placing: false, nextReviewAt: at, reviewedAt: at, waiting: [{ bucket: 'btc-usdc', pool: 'pool:USDC/cbBTC/500', code: 'DECIDE_ENTRY_PAUSED_FALL', amountUsdc: '12500000' }] } })!
    expect(fall.startsWith('12.50 USDC is waiting: USDC/cbBTC is falling fast')).toBe(true)
    const many = engineLine({ ...midEntry, engine: { placing: false, nextReviewAt: at, reviewedAt: at, waiting: [{ bucket: 'stables', pool: 'pool:USDC/USDT/100', code: 'DECIDE_WAIT_DEPTH', amountUsdc: '40000000' }, { bucket: 'btc-usdc', pool: 'pool:USDC/cbBTC/500', code: 'DECIDE_ENTRY_PAUSED_FALL', amountUsdc: '10000000' }] } })!
    expect(many.startsWith('50.00 USDC is waiting in 2 pools: some are not deep enough for more right now, some are falling fast. Checked at ')).toBe(true)
    // Placing wins: the engine is already moving that money.
    expect(engineLine({ ...midEntry, engine: { placing: true, nextReviewAt: at, waiting: [{ bucket: 'stables', pool: null, code: 'DECIDE_WAIT_DEPTH', amountUsdc: '1' }] } })).toBe('Placing your money. The next step starts in a few seconds.')
  })

  test('what a swap or a mint rounds off (under a cent per token) counts in the total and is not listed', async () => {
    // Ot's beta account once placed: three positions and a few millionths left in four tokens.
    const placed: FundingView = {
      ...midEntry,
      usdc: '313',
      idle: [
        { token: 'USDC', amount: '313', decimals: 6, valueUsdc: '313' },
        { token: 'cbBTC', amount: '4', decimals: 8, valueUsdc: '3300' },
        { token: 'USDT', amount: '1646', decimals: 6, valueUsdc: '1646' },
        { token: 'WETH', amount: '754', decimals: 18, valueUsdc: '0' },
      ],
      engine: { placing: false, nextReviewAt: null },
      positions: [
        {
          tokenId: '1', pool: 'pool:USDC/USDT/100', liquidity: '1', inRange: true, amountUsdc: '1242700', amountCbbtc: '0', valueUsdc: '2497200',
          amounts: [
            { token: 'USDC', amount: '1242700', decimals: 6, valueUsdc: '1242700' },
            { token: 'USDT', amount: '1254500', decimals: 6, valueUsdc: '1254500' },
          ],
        },
      ],
    }
    const s = split(placed, null)
    expect(s.idleTokens).toEqual([])
    expect(s.idle).toBe(5259n)
    expect(s.total).toBe(2_502_459n)
    expect(holdings(placed)!.map((h) => h.token)).toEqual(['USDT', 'USDC'])
    const { text, html } = await renderRoute('/', fixtureSession, placed)
    expect(html).not.toContain('data-testid="idle-tokens"')
    expect(text).toContain('Idle capital 0.00 USDC · nothing idle')
  })

  test('an account with nothing in progress keeps the plain label', async () => {
    const { text } = await renderRoute('/', fixtureSession, { ...midEntry, engine: { placing: false, nextReviewAt: null } })
    expect(text).toContain('Idle capital 5.00 USDC · waiting to be placed')
  })
})
