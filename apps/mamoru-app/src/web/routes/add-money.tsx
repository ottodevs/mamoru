import type { FundingView, OverCap } from '@mamoru/domain'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useFunding, useSession } from '../api/queries.ts'
import { ConnectWallet } from '../components/connect-wallet.tsx'
import { AddressBlock, Brand, Copy, Qr, Waiting } from '../components/ui.tsx'
import { capNote, ceilCents, overCapOf, usd, usdPlain } from '../lib/money.ts'
import { localTime } from '../lib/time.ts'
import { useInjectedWallets } from '../lib/wallets.ts'

export const addCopy = {
  title: 'Add capital',
  send: 'Send USDC on Base.',
  waiting: 'Waiting for your USDC',
  arrived: (amount: string) => `${amount} USDC arrived`,
  overCap: (o: OverCap) =>
    `${usd(o.usdc)} USDC arrived. That is ${usd(ceilCents(BigInt(o.excessUsdc)))} USDC over the ${usdPlain(o.capUsdc)} USDC cap, so Mamoru has not started. Your money is in your account and nothing was moved.`,
  overCapNext: 'See what you can do',
}

/** Address, QR and Connect wallet. Shared by the Add money screen and the Home modal. */
export function DepositDetails({ address, capUsdc }: { address: string; capUsdc?: string }) {
  const wallets = useInjectedWallets()
  return (
    <div className="grid gap-6">
      <ConnectWallet to={address} wallets={wallets} />
      <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-7">
        <Qr text={address} />
        <div className="grid min-w-0 gap-3">
          <p className="kicker">Your address on Base</p>
          <AddressBlock address={address} />
          <div className="flex flex-wrap items-center gap-3">
            <Copy text={address} label="Copy address" />
            <span className="text-[0.88rem] text-stone">
              {addCopy.send}
              {capUsdc ? ` ${capNote(capUsdc)}` : ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function hasMoney(f: FundingView | undefined): boolean {
  return f !== undefined && (BigInt(f.usdc) > 0n || f.positions.length > 0 || BigInt(f.cbbtc) > 0n)
}

export function AddMoneyPage() {
  const session = useSession()
  const accountKey = session.data?.accountKey
  const funding = useFunding(accountKey, true, 4_000)
  const navigate = useNavigate()
  const f = funding.data
  const arrived = hasMoney(f)
  const over = overCapOf(f)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (session.isSuccess && !accountKey) void navigate({ to: '/', replace: true })
  }, [session.isSuccess, accountKey, navigate])

  useEffect(() => {
    // Over the cap nothing starts: stay here until the owner has read why.
    if (!arrived || over) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const t1 = setTimeout(() => setLeaving(true), reduce ? 600 : 1400)
    const t2 = setTimeout(() => void navigate({ to: '/', replace: true }), reduce ? 700 : 1650)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [arrived, over, navigate])

  return (
    <main className={`page ${leaving ? 'leave' : ''}`}>
      <title>Mamoru · Add capital</title>
      <header className="mb-7">
        <Brand />
      </header>
      <section className="enter mx-auto grid w-full max-w-[40rem] gap-6">
        <div>
          <h1 className="m-0 text-[clamp(2rem,7vw,3rem)] font-normal leading-[1.05]">{addCopy.title}</h1>
        </div>
        {f ? <DepositDetails address={f.address} capUsdc={f.capUsdc} /> : <div className="h-44 animate-pulse bg-wash/40" aria-hidden="true" />}
        <div className="card flex flex-wrap items-center justify-between gap-3">
          {over ? (
            <p className="m-0 max-w-[34rem] text-[0.95rem] leading-[1.45] text-alert-ink" role="status" data-testid="over-cap">
              {addCopy.overCap(over)}
            </p>
          ) : arrived && f ? (
            <p className="m-0 text-[1.05rem] text-emerald" role="status">
              {addCopy.arrived(usd(f.usdc))}
            </p>
          ) : (
            <Waiting>{addCopy.waiting}</Waiting>
          )}
          {funding.dataUpdatedAt ? <span className="font-mono text-[0.72rem] text-stone">Checked {localTime(new Date(funding.dataUpdatedAt).toISOString())}</span> : null}
        </div>
        {funding.isError ? <p className="err">Could not check your balance. Retrying.</p> : null}
        <p className="m-0">
          <button type="button" className="text-[0.88rem] text-stone underline decoration-wash underline-offset-4 hover:text-ink" onClick={() => void navigate({ to: '/' })}>
            {over ? addCopy.overCapNext : 'Later'}
          </button>
        </p>
      </section>
    </main>
  )
}
