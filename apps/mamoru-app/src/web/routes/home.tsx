import { Link } from '@tanstack/react-router'
import { useConfig } from '../api/queries.ts'

const BEATS = [
  {
    title: 'Own',
    body: 'You create a Safe smart account on Base with a passkey that only you hold. Mamoru never holds your keys or your funds.',
  },
  {
    title: 'Watch',
    body: 'Mamoru reads Base, checks MultiBaas history against Base RPC, and shows every figure with its chain and its source.',
  },
  {
    title: 'Leave',
    body: 'You can leave without Mamoru at any time. Your recovery kit and the guide work without Mamoru, its login or MultiBaas.',
  },
]

export function HomePage() {
  const config = useConfig()
  const lab = config.data?.mode === 'lab'
  return (
    <main className="flex flex-1 justify-center px-[clamp(1rem,5vw,4rem)] pt-[clamp(1.25rem,4vh,3rem)] pb-12">
      <title>Mamoru · Savings, explained</title>
      <div className="flex w-full max-w-[40rem] flex-col items-center gap-[0.85rem] text-center">
        <p className="m-0 rounded-full border border-wash px-3 py-1 font-mono text-[0.7rem] uppercase tracking-[0.06em] text-emerald">
          {lab ? 'Verification plane · Base fork' : 'Base · simulation mode'}
        </p>
        <header className="flex flex-col items-center gap-2">
          <img className="block h-auto w-[clamp(2.25rem,3.4vw,2.9rem)]" src="/mark-two-stones.png" width={46} height={46} alt="Mamoru mark" />
          <p className="m-0 text-[clamp(1.15rem,2vw,1.55rem)]">Mamoru</p>
        </header>
        <h1 className="mt-[0.4rem] mb-0 text-[clamp(2rem,6vw,3.2rem)] leading-[1.05] font-normal">SAVINGS. EXPLAINED.</h1>
        <p className="m-0 max-w-[32rem] text-[clamp(1rem,2.2vw,1.15rem)] leading-[1.45] text-stone">
          Mamoru is a non-custodial savings agent on Base. It watches your own smart account, explains each decision with a reason code, and
          shows where every figure comes from.
        </p>
        <section className="mt-2 grid w-full gap-3 text-left" aria-label="How Mamoru works">
          {BEATS.map((b) => (
            <article key={b.title} className="sheet px-4 py-[0.9rem]">
              <h2 className="mono-label m-0 mb-[0.35rem] font-normal">{b.title}</h2>
              <p className="m-0 text-[0.98rem] leading-[1.45]">{b.body}</p>
            </article>
          ))}
        </section>
        <section className="mt-[0.35rem] max-w-[32rem]">
          <h2 className="m-0 mb-[0.4rem] text-[clamp(1.25rem,3vw,1.6rem)] font-normal">Live on Base, capped</h2>
          <p className="m-0 leading-[1.45] text-stone">
            Each account holds at most 25 USDC. Your passkey signs every owner action: start, transfer out and stop. The engine enters positions with a session key that can only do what its grants allow. Harvest is shown on a Base fork.
          </p>
        </section>
        <nav className="mt-[0.6rem] flex flex-wrap justify-center gap-3" aria-label="App entry">
          <Link className="btn btn-primary" to="/onboarding">
            Create account
          </Link>
          <Link className="btn btn-ghost" to="/dashboard">
            Open dashboard
          </Link>
        </nav>
        <p className="mt-1 mb-0 font-mono text-[0.75rem] text-stone">
          <a href="https://github.com/ottodevs/mamoru" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </p>
      </div>
    </main>
  )
}
