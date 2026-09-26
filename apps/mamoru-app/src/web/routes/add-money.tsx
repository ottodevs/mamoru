import type { FundingView } from '@mamoru/domain'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useConfig, useFunding, useSession } from '../api/queries.ts'
import { AddressBlock, Brand, Copy, Qr, Waiting } from '../components/ui.tsx'
import { usd } from '../lib/money.ts'
import { localTime } from '../lib/time.ts'

export const addCopy = {
  title: 'Add capital',
  send: (cap: string) => `Send USDC on Base. Up to ${cap} USDC.`,
  waiting: 'Waiting for your USDC',
  arrived: (amount: string) => `${amount} USDC arrived`,
}

/** Address, QR and the cap. Shared by the Add money screen and the Home modal. */
export function DepositDetails({ address, capUsdc }: { address: string; capUsdc: string }) {
  return (
    <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-7">
      <Qr text={address} />
      <div className="grid min-w-0 gap-3">
        <p className="kicker">Your address on Base</p>
        <AddressBlock address={address} />
        <div className="flex flex-wrap items-center gap-3">
          <Copy text={address} label="Copy address" />
          <span className="text-[0.88rem] text-stone">{addCopy.send(usd(capUsdc).replace(/\.00$/, ''))}</span>
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
  const config = useConfig()
  const accountKey = session.data?.accountKey
  const funding = useFunding(accountKey, true, 4_000)
  const navigate = useNavigate()
  const f = funding.data
  const arrived = hasMoney(f)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (session.isSuccess && !accountKey) void navigate({ to: '/', replace: true })
  }, [session.isSuccess, accountKey, navigate])

  useEffect(() => {
    if (!arrived) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const t1 = setTimeout(() => setLeaving(true), reduce ? 600 : 1400)
    const t2 = setTimeout(() => void navigate({ to: '/', replace: true }), reduce ? 700 : 1650)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [arrived, navigate])

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
        {f ? (
          <DepositDetails address={f.address} capUsdc={f.capUsdc ?? config.data?.capUsdc ?? '25000000'} />
        ) : (
          <div className="h-44 animate-pulse bg-wash/40" aria-hidden="true" />
        )}
        <div className="card flex flex-wrap items-center justify-between gap-3">
          {arrived && f ? (
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
            Later
          </button>
        </p>
      </section>
    </main>
  )
}
