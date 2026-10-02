import { expect, test } from '@playwright/test'

// otto/mamoru#6 in a real browser with a CDP virtual WebAuthn authenticator: an owner creates the account, loses the
// session, and gets back to the same account with the passkey. Run against a Worker that has migration 0005 applied.
test('a returning owner signs back in with the passkey, with or without what the browser remembered', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  const session = async () => {
    const res = await page.request.get('/api/session')
    return res.ok() ? ((await res.json()) as { userId: string; accountKey?: string }) : null
  }

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'I already have an account' })).toBeVisible()
  await page.getByRole('button', { name: 'Skip' }).click()
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Approve once' })).toBeVisible()
  const created = await session()
  expect(created?.accountKey).toBeTruthy()

  // The cookie is gone but this browser used a passkey here: the sign-in card opens by itself.
  await context.clearCookies()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Open your account' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await expect(page.getByText('Total balance')).toBeVisible()
  expect(await session()).toEqual(created)

  // A clean profile with the synced passkey: nothing remembered, the link on the first card leads in.
  await context.clearCookies()
  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await page.getByRole('button', { name: 'I already have an account' }).click()
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await expect(page.getByText('Total balance')).toBeVisible()
  expect(await session()).toEqual(created)

  // A deep link with no session lands on the sign-in card, and a device without the passkey is told so.
  await context.clearCookies()
  await page.evaluate(() => localStorage.clear())
  await page.goto('/add')
  await expect(page.getByRole('heading', { name: 'Open your account' })).toBeVisible()
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId })
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await expect(page.getByText('No passkey was used, so you are not signed in.')).toBeVisible()
  expect(await session()).toBeNull()
})
