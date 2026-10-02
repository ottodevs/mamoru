import { describe, expect, test } from 'bun:test'
import type { AppConfig, FundingView, OpView, SessionView, SignInChallenge, SignInRequest } from '@mamoru/domain'
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
import { capNote, cbbtcPrice, ceilCents, humanMessage, overCapOf, split, usd, usdPlain } from '../../src/web/lib/money.ts'
import { activationLive, historyOps, needsRetry, opLine } from '../../src/web/lib/ops.ts'
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

async function renderRoute(path: string, session: SessionView | null, funding?: FundingView, more: { ops?: OpView[]; config?: AppConfig } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(queryKeys.config, more.config ?? fixtureConfig)
  qc.setQueryData(queryKeys.session, session)
  qc.setQueryData(queryKeys.pools, poolsResponse)
  if (funding) qc.setQueryData(queryKeys.funding(FIXTURE_ACCOUNT_KEY), funding)
  qc.setQueryData(queryKeys.ops(FIXTURE_ACCOUNT_KEY), { ops: more.ops ?? [] })
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
  test('Home over the cap: what happened, what to do, and the withdraw that fixes it instead of a Start that would fail', async () => {
    const { text, html } = await renderRoute('/', fixtureSession, overFunding, { ops: [refused] })
    expect(text).toContain('This account is over the 25 USDC cap, so Mamoru has not started.')
    expect(text).toContain('It holds 26.92 USDC. Nothing was moved. Withdraw at least 1.92 USDC to an address you control, then start Mamoru.')
    expect(text).toContain('Withdraw 1.92 USDC')
    expect(html).toContain('data-testid="over-cap"')
    expect(html).not.toContain('data-testid="start"')
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
    expect(html).not.toContain('data-testid="start"')
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
  test('operator errors become plain USDC copy', () => {
    expect(humanMessage('the Safe cannot free 2000000 USDC base units', 1_930_000n)).toBe('You can withdraw up to 1.93 USDC right now.')
    expect(humanMessage('needs 2000000 USDC base units')).toBe('needs 2.00 USDC')
  })
  test('ops read as one plain line', () => {
    const op = (o: Partial<OpView>): OpView => ({ opId: 'x', kind: 'enter', state: 'confirmed', updatedAt: '2026-09-26T20:00:00Z', ...o })
    expect(opLine(op({}))).toBe('Opened USDC/cbBTC position')
    expect(opLine(op({ kind: 'activate', state: 'proposed', code: 'ARMED' }))).toBe('Start approved')
    expect(activationLive([op({ kind: 'activate', state: 'failed' })])).toBe(false)
    expect(opLine(op({ opId: 'own-4-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR' }))).toBe('Stop needs another approval')
    expect(opLine(op({ opId: 'own-4-exit', kind: 'exit' }))).toBe('Allocation stopped')
    expect(opLine(op({ opId: 'eng-1-1-op-1-enter_swap' }))).toBe('Swapped USDC to cbBTC')
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
