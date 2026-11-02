import { signedFacts } from '../components/approval-dialog.tsx'

/**
 * otto/mamoru#19: every passkey prompt is preceded by one plain line saying what that signature does and what it
 * cannot do. Copy agreed with Brais on 20-oct (noema 1-projects/mamoru/brand/ux-beta-feedback-2026-10-20, screens 6a-6c).
 */
export const signatureCopy = {
  // otto/mamoru#294 (Brais, v4): one screen and one button create the passkey and sign the authorization. No counters: a
  // withdrawal can come a year later, so nothing here says "1 of 2".
  create: {
    eyebrow: 'Create',
    title: 'Create your account',
    body: 'This signature creates your Mamoru account.',
    points: ['Let Mamoru manage your savings.', 'Every move shows in your history.', 'Only you can take money out.'],
    note: 'Face ID, fingerprint or screen lock. No password, no seed phrase.',
    action: 'Create with passkey',
    creating: 'Creating your account…',
    authorizing: 'Authorizing Mamoru…',
    retry: 'Authorize Mamoru',
    created: 'Your account is created. One more approval lets Mamoru put your USDC to work.',
    details: 'What you sign',
    // The first signature, as it was worded before v4: it stays in the disclosure so its meaning does not change (#41).
    signs: 'This signature creates your Mamoru account on Base. Only you can take money out of it.',
  },
  activate: {
    body: 'This signature lets Mamoru open, adjust and close positions with your USDC.',
    setup: 'Where needed it also creates your Safe on Base and sets up its gas reserve.',
    days: (n: number) => `Valid for ${n} days.`,
    never: 'It can never send your money to anyone but you.',
  },
  // otto/mamoru#295 (Brais, v4): the amount and where it goes come first, right above the button; "only your passkey" is
  // one line under them. The full signed sentence above stays behind "What you sign" (#41).
  withdrawCard: {
    eyebrow: 'Withdraw',
    only: 'Only your passkey can do this.',
    cancel: 'Cancel',
    action: 'Withdraw with passkey',
    details: 'What you sign',
    to: 'to',
  },
  withdraw,
  stop: "This signature ends Mamoru's permission to act, closes every position and swaps what they held to USDC, which stays in your account. Only your passkey can do this.",
  move: 'This signature moves your USDC from Ethereum to this same account on Base. Only your passkey can do this.',
  convert: 'This signature swaps your ETH on Ethereum to USDC, kept in this same account on Ethereum. Only your passkey can do this.',
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
