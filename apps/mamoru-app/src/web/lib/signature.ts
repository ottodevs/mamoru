/**
 * otto/mamoru#19: every passkey prompt is preceded by one plain line saying what that signature does and what it
 * cannot do. Copy agreed with Brais on 20-oct (noema 1-projects/titan26/brand/ux-beta-feedback-2026-10-20, screens 6a-6c).
 */
export const signatureCopy = {
  create: {
    step: 'Signature 1 of 2',
    title: 'Create your account',
    body: 'This signature creates your Mamoru account on Base. Only you can take money out of it.',
    next: 'Next: let Mamoru put it to work',
  },
  activate: {
    step: 'Signature 2 of 2',
    title: 'Let Mamoru put it to work',
    body: 'This signature lets Mamoru open, adjust and close positions with your USDC.',
    never: 'It can never send your money to anyone but you.',
    details: 'See details',
    next: 'Then add USDC and it starts.',
  },
  withdraw: (asset: string) => `This signature sends your ${asset} to the address you chose. Only your passkey can do this.`,
  stop: 'This signature closes every position and keeps your USDC in your account. Only your passkey can do this.',
  move: 'This signature moves your USDC from Ethereum to this same account on Base. Only your passkey can do this.',
}
