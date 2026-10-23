import { signedFacts } from '../components/approval-dialog.tsx'

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
    setup: 'Where needed it also creates your Safe on Base and sets up its gas reserve.',
    days: (n: number) => `Valid for ${n} days.`,
    never: 'It can never send your money to anyone but you.',
    details: 'See details',
    next: 'Then add USDC and it starts.',
  },
  withdraw,
  stop: "This signature ends Mamoru's permission to act, closes every position and swaps what they held to USDC, which stays in your account. Only your passkey can do this.",
  move: 'This signature moves your USDC from Ethereum to this same account on Base. Only your passkey can do this.',
}

/** Everything a withdrawal signs, in order: the Safe first if it is not on chain yet, the pool, the swap, the send. */
function withdraw(asset: string, also: { create?: boolean; fromPool?: boolean } = {}): string {
  const steps = [
    ...(also.create ? ['creates your account on Base'] : []),
    ...(also.fromPool ? ['takes the missing USDC out of a position'] : []),
    ...(asset === 'USDC' ? [] : [`swaps USDC to ${asset}`]),
  ]
  const send = steps.length ? 'sends it to the address you chose' : `sends your ${asset} to the address you chose`
  const all = [...steps, send]
  const said = all.length === 1 ? all[0] : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`
  return `This signature ${said}. Only your passkey can do this.`
}

/** What the activation signature allows, what it sets up and, when the signed lines say it, for how long. */
export function activateLine(summary: string[]): string {
  const days = signedFacts(summary).days
  return [signatureCopy.activate.body, signatureCopy.activate.setup, ...(days !== null ? [signatureCopy.activate.days(days)] : [])].join(' ')
}
