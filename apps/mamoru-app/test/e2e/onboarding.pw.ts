import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// A real browser with a CDP virtual WebAuthn authenticator: three cards, account, recovery kit, then the arming approval.
const SHOTS = process.env.MAMORU_SHOTS_DIR

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${test.info().project.name}-${name}.png`), fullPage: true })
}

test('a new owner goes through the cards, creates the account and reaches the approval', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })

  await page.goto('/')
  await expect(page.getByText('01 / 03')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Fund Mamoru' })).toBeVisible()
  await shot(page, '1-card')
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByRole('heading', { name: 'You keep control' })).toBeVisible()

  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Approve once' })).toBeVisible()
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
  expect(credentials).toHaveLength(1)
  expect(credentials[0]?.isResidentCredential).toBe(true)

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save recovery kit' }).click()])
  expect(download.suggestedFilename()).toMatch(/^mamoru-recovery-kit-0x[0-9a-f]{40}\.json$/)
  const kit = JSON.parse(await readFile(await download.path(), 'utf8')) as { chainId: unknown }
  expect(kit.chainId).toBe(8453)
  await expect(page.getByRole('button', { name: 'Approve with passkey' })).toBeEnabled()
  await shot(page, '2-approve')
})
