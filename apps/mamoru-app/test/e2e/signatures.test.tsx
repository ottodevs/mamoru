import { describe, expect, test } from 'bun:test'
import { signatureCopy } from '../../src/web/lib/signature.ts'
import { ActivateScope, Review } from '../../src/web/routes/home.tsx'
import { CreateSignature } from '../../src/web/routes/onboarding.tsx'
import { render } from './render.ts'

// otto/mamoru#19: every passkey prompt is preceded by one plain line on what that signature does.
describe('before each passkey signature', () => {
  test('signature 1 of 2 says it creates the account and only the owner can take money out', () => {
    const { text, html } = render(<CreateSignature creating={false} error={null} onApprove={() => {}} />)
    expect(text).toContain('Signature 1 of 2')
    expect(text).toContain('This signature creates your Mamoru account on Base. Only you can take money out of it.')
    expect(text).toContain('Next: let Mamoru put it to work')
    // The line comes before the button that opens the prompt.
    expect(html.indexOf('This signature creates')).toBeLessThan(html.indexOf('Approve with passkey'))
  })

  test('the review of an owner action says its scope before the confirm button', () => {
    const { html } = render(<Review scope={signatureCopy.withdraw('USDC')} lines={[]} busy={null} error={null} onApprove={() => {}} />)
    expect(html).toContain('data-testid="sign-scope"')
    expect(html).toContain('This signature sends your USDC to the address you chose. Only your passkey can do this.')
    expect(html.indexOf('sign-scope')).toBeLessThan(html.indexOf('Confirm with passkey'))
  })

  test('the activation line names what it allows and, in bold, what it never does', () => {
    const { html } = render(<ActivateScope />)
    expect(html).toContain('open, adjust and close positions with your USDC.')
    expect(html).toContain('<strong>It can never send your money to anyone but you.</strong>')
  })

  test('the copy stays plain: no exclamation marks', () => {
    const lines = [signatureCopy.create, signatureCopy.activate].flatMap((c) => Object.values(c))
    for (const l of [...lines, signatureCopy.withdraw('USDC'), signatureCopy.stop, signatureCopy.move]) expect(l).not.toContain('!')
  })
})
