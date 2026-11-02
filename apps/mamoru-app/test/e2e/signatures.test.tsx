import { describe, expect, test } from 'bun:test'
import { signatureCopy } from '../../src/web/lib/signature.ts'
import { ActivateScope, Review } from '../../src/web/routes/home.tsx'
import { CreateAccount } from '../../src/web/routes/onboarding.tsx'
import { count, render } from './render.ts'

// otto/mamoru#19: every passkey prompt is preceded by one plain line on what that signature does.
describe('before each passkey signature', () => {
  // otto/mamoru#294: one screen, one button; the signed lines stay behind "What you sign".
  test('the create screen is one card with one button and no counters', () => {
    const { text, html } = render(<CreateAccount phase="idle" error={null} summary={null} onStart={() => {}} onSignIn={() => {}} />)
    expect(text).toContain('Create your account')
    expect(text).toContain('This signature creates your Mamoru account.')
    for (const line of ['Let Mamoru manage your savings.', 'Every move shows in your history.', 'Only you can take money out.']) expect(text).toContain(line)
    expect(text).toContain('Face ID, fingerprint or screen lock. No password, no seed phrase.')
    expect(text).toContain('I already have an account')
    expect(text).not.toMatch(/\d of \d|Signature \d/)
    expect(count(html, '<button')).toBe(2)
    expect(html.indexOf('This signature creates')).toBeLessThan(html.indexOf('Create with passkey'))
    // The signed meaning is reachable: both signatures, worded as before.
    expect(html).toContain('data-testid="sign-details"')
    expect(text).toContain('What you sign')
    expect(text).toContain('This signature creates your Mamoru account on Base. Only you can take money out of it.')
    expect(text).toContain('This signature lets Mamoru open, adjust and close positions with your USDC.')
    expect(text).toContain('It can never send your money to anyone but you.')
  })

  test('progress and errors are said next to the button, and the retry resumes at the authorization', () => {
    const creating = render(<CreateAccount phase="creating" error={null} summary={null} onStart={() => {}} onSignIn={() => {}} />)
    expect(creating.text).toContain('Creating your account…')
    expect(creating.text).not.toContain('I already have an account')
    expect(creating.html).toMatch(/<button[^>]*disabled/)
    const authorizing = render(<CreateAccount phase="authorizing" error={null} summary={['Deploy your Safe on Base']} onStart={() => {}} onSignIn={() => {}} />)
    expect(authorizing.text).toContain('Authorizing Mamoru…')
    // With the signed lines prepared, they sit in the disclosure, word for word.
    expect(authorizing.text).toContain('Deploy your Safe on Base')
    const retry = render(<CreateAccount phase="retry" error="Passkey closed. Nothing was signed." summary={null} onStart={() => {}} onSignIn={() => {}} />)
    expect(retry.text).toContain('Passkey closed. Nothing was signed.')
    expect(retry.text).toContain('Authorize Mamoru')
    expect(retry.text).not.toContain('Create with passkey')
  })

  test('the review of an owner action says its scope before the confirm button', () => {
    const { html } = render(<Review scope={signatureCopy.withdraw('USDC')} lines={[]} busy={null} error={null} onApprove={() => {}} />)
    expect(html).toContain('data-testid="sign-scope"')
    expect(html).toContain('This signature sends your USDC to the address you chose. Only your passkey can do this.')
    expect(html.indexOf('sign-scope')).toBeLessThan(html.indexOf('Confirm with passkey'))
  })

  test('a withdrawal names every step it signs', () => {
    expect(signatureCopy.withdraw('USDC', { create: true, fromPool: true })).toBe(
      'This signature creates your account on Base, takes the missing USDC out of a position and sends it to the address you chose. Only your passkey can do this.',
    )
    expect(signatureCopy.withdraw('EURC')).toBe('This signature swaps USDC to EURC and sends it to the address you chose. Only your passkey can do this.')
  })

  test('stop says it ends the permission, closes positions and swaps to USDC', () => {
    expect(signatureCopy.stop).toContain("ends Mamoru's permission to act")
    expect(signatureCopy.stop).toContain('swaps what they held to USDC')
  })

  test('the activation line names what it allows, what it sets up, how long, and in bold what it never does', () => {
    const { html } = render(<ActivateScope summary={['Deploy your Safe on Base', 'Enable the engine session for 365 days']} />)
    expect(html).toContain('open, adjust and close positions with your USDC.')
    expect(html).toContain('creates your Safe on Base and sets up its gas reserve.')
    expect(html).toContain('Valid for 365 days.')
    expect(html).toContain('<strong>It can never send your money to anyone but you.</strong>')
  })

  test('the copy stays plain: no exclamation marks', () => {
    const lines = [signatureCopy.create, signatureCopy.activate].flatMap((c) => Object.values(c).flat())
    for (const l of [...lines, signatureCopy.withdraw('USDC'), signatureCopy.stop, signatureCopy.move]) expect(String(l)).not.toContain('!')
  })
})
