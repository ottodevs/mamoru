import { signatureCopy } from '../lib/signature.ts'
import { Modal } from './ui.tsx'

export const howCopy = {
  trigger: 'How Mamoru works',
  title: 'How Mamoru works',
  steps: [
    { title: 'Your account, your passkey', body: 'Your money sits in a Safe smart account on chain. Only your passkey owns it, and Mamoru never holds it.' },
    { title: 'A permission with limits', body: `When you start, you sign what Mamoru may do: open, adjust and close positions with your USDC, in the pools and up to the amount you approved, until a set date. ${signatureCopy.activate.never}` },
    { title: 'Your USDC at work', body: 'Mamoru spreads your USDC across Uniswap pools, from Stable to Growth, where trades pay fees. It watches each position, moves it back when the price leaves its range, and collects what it earns.' },
    { title: 'Leave whenever you want', body: 'Withdraw or stop with your passkey at any time. Stop closes every position and keeps the USDC in your account. The recovery kit lets you reach your account without Mamoru.' },
  ],
  more: 'Learn more',
  links: [
    { label: 'Source code', where: 'GitHub', href: 'https://github.com/ottodevs/mamoru#readme' },
    { label: 'Website', where: 'mamoru.lol', href: 'https://mamoru.lol' },
    { label: 'News', where: 'X @entermamoru', href: 'https://x.com/entermamoru' },
  ],
}

/** #226: the explanation lives in the app; the repository and the networks are one tap further, never the first stop. */
export function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={howCopy.title}>
      <ol className="how-steps">
        {howCopy.steps.map((s, i) => (
          <li key={s.title} style={{ ['--i' as string]: i }}>
            <span className="how-n" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span>
              <span className="how-title">{s.title}</span>
              <span className="how-body">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="kicker mt-6 mb-1">{howCopy.more}</p>
      <ul className="how-links">
        {howCopy.links.map((l) => (
          <li key={l.href}>
            <a href={l.href} target="_blank" rel="noreferrer">
              <span>{l.label}</span>
              <span className="how-where">{l.where}</span>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M9 2h5v5M14 2 7 9M12 10v4H2V4h4" />
              </svg>
            </a>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
