import { describe, expect, test } from 'bun:test'
import { fixtureOwner } from '../../src/web/fixtures/client.ts'
import { OnboardingView, type OnboardingViewProps } from '../../src/web/routes/onboarding.tsx'
import { render } from './render.ts'

const idle = { pending: false, error: null, run: () => {} }
const props = (over: Partial<OnboardingViewProps> = {}): OnboardingViewProps => ({
  mode: 'production',
  owner: null,
  kitDownloaded: false,
  acked: false,
  createOwner: idle,
  downloadKit: idle,
  ack: idle,
  onFinish: () => {},
  ...over,
})

describe('onboarding', () => {
  test('before the passkey: only the passkey step can start', () => {
    const { html, text } = render(<OnboardingView {...props()} />)
    expect(text).toContain('Create passkey')
    expect(text).toContain('Your account address appears after you create the passkey.')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Download recovery kit<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Open dashboard<\/button>/)
  })

  test('after the owner: shows the counterfactual Safe address on Base', () => {
    const { text } = render(<OnboardingView {...props({ owner: fixtureOwner })} />)
    expect(text).toContain(fixtureOwner.address)
    expect(text).toContain('Base · 8453')
    expect(text).toContain('counterfactual')
    expect(text).not.toContain('Create passkey')
  })

  test('backup confirmation unlocks the dashboard; deposits stay closed', () => {
    const { html, text } = render(<OnboardingView {...props({ owner: fixtureOwner, kitDownloaded: true, acked: true })} />)
    expect(text).toContain('Backup confirmed.')
    expect(text).toContain('Deposits are closed')
    expect(html).toMatch(/<button type="button" class="btn btn-primary">Open dashboard<\/button>/)
    expect(text).not.toMatch(/deposit (eth|usdc)|go to deposit/i)
  })

  test('errors say what happened and what to do', () => {
    const { text } = render(<OnboardingView {...props({ createOwner: { ...idle, error: 'The passkey prompt was closed. Try again.' } })} />)
    expect(text).toContain('The passkey prompt was closed. Try again.')
  })
})
