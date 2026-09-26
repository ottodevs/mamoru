import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PRODUCTION_BANNER, type DashboardPayload } from '@mamoru/domain'
import { expect, test, type Page } from '@playwright/test'

// Plan §2: a real browser with a CDP virtual WebAuthn authenticator. Nothing is signed or sent on Base.
const SHOTS = process.env.MAMORU_SHOTS_DIR
const ADDRESS = /0x[0-9a-fA-F]{40}/

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${test.info().project.name}-${name}.png`), fullPage: true })
}

test('a new owner onboards with a passkey and lands on the simulation dashboard', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })

  await page.goto('/')
  await expect(page.getByTestId('banner')).toHaveText(PRODUCTION_BANNER)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('SAVINGS. EXPLAINED.')
  await shot(page, '1-home')

  await page.getByRole('link', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Four steps.')
  await shot(page, '2-onboarding')

  await page.getByRole('button', { name: 'Create passkey' }).click()
  const accountStep = page.getByTestId('step-2')
  await expect(accountStep.locator('code')).toHaveText(ADDRESS)
  await expect(accountStep).toContainText('Base · 8453')
  await expect(accountStep).toContainText('counterfactual')
  const address = (await accountStep.locator('code').textContent()) ?? ''

  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
  expect(credentials).toHaveLength(1)
  expect(credentials[0]?.isResidentCredential).toBe(true)
  await shot(page, '3-onboarding-account')

  const kitStep = page.getByTestId('step-3')
  await expect(kitStep.getByRole('button', { name: 'Confirm I saved the kit' })).toBeDisabled()
  const [download] = await Promise.all([page.waitForEvent('download'), kitStep.getByRole('button', { name: 'Download recovery kit' }).click()])
  expect(download.suggestedFilename()).toBe(`mamoru-recovery-kit-${address.toLowerCase()}.json`)
  const kit = JSON.parse(await readFile(await download.path(), 'utf8')) as { chainId: unknown; address: unknown }
  expect(kit.chainId).toBe(8453)
  expect(kit.address).toBe(address)

  await kitStep.getByRole('button', { name: 'Confirm I saved the kit' }).click()
  await expect(kitStep.getByText('Backup confirmed.')).toBeVisible()

  const presetStep = page.getByTestId('step-4')
  await expect(presetStep).toContainText('Conservador')
  await expect(presetStep.getByText('Deposits are closed', { exact: true })).toBeVisible()
  await shot(page, '4-onboarding-done')

  const payload = page.waitForResponse((r) => /\/api\/accounts\/[^/]+\/dashboard$/.test(new URL(r.url()).pathname) && r.ok())
  await presetStep.getByRole('button', { name: 'Open dashboard' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page).toHaveTitle('Mamoru · Dashboard')
  const data = (await (await payload).json()) as DashboardPayload
  await test.info().attach('dashboard-payload.json', { body: JSON.stringify(data, null, 2), contentType: 'application/json' })
  expect(data.mode).toBe('production')
  expect(data.account.address.value).toBe(address)
  expect(data.account.fundsGate).toBe('closed')

  await expect(page.getByTestId('banner')).toHaveText(PRODUCTION_BANNER)
  const header = page.locator('#account')
  await expect(header).toContainText(address)
  await expect(header).toContainText('Base · 8453')
  await expect(header).toContainText('Conservador')
  const deployed = data.account.deployed.value
  await expect(header).toContainText(deployed === null ? 'Not observed' : deployed ? 'Deployed' : 'Not deployed')
  await expect(page.locator('#positions')).toBeVisible()
  await expect(page.locator('#leave')).toBeVisible()

  // A null figure reads "Not observed" beside its provenance chip, never as a zero.
  if (data.account.totalValue.value === null) await expect(header.getByTestId('not-observed').first()).toHaveText('Not observed')
  const notObserved = await page.getByTestId('not-observed').all()
  expect(notObserved.length).toBeGreaterThan(0)
  for (const label of notObserved) {
    await expect(label).toHaveText('Not observed')
    await expect(label.locator('xpath=..').getByTestId('chip').first()).toBeVisible()
  }

  await expect(page.getByRole('button', { name: /deposit/i })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /deposit/i })).toHaveCount(0)
  await shot(page, '5-dashboard')

  // The session now owns an account: onboarding points back to it instead of offering a second passkey.
  await page.goto('/onboarding')
  await expect(page.getByTestId('existing-account')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create passkey' })).toHaveCount(0)
})
