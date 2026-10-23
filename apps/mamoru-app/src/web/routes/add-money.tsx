import type { FundingView, OverCap } from '@mamoru/domain'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useFunding, useSession } from '../api/queries.ts'
import { ConnectWallet } from '../components/connect-wallet.tsx'
import { WrongNetwork } from '../components/other-chain-notice.tsx'
import { AddressBlock, Brand, Copy, Qr, Waiting } from '../components/ui.tsx'
import type { Hex } from 'viem'
import { showToast } from '../components/toast.tsx'
import { BASE_SLEEVE, explorerAddress, explorerTx, useChain, type SleeveChain } from '../lib/chain.tsx'
import { capNote, ceilCents, overCapOf, usd, usdPlain } from '../lib/money.ts'
import { localTime } from '../lib/time.ts'
import { useInjectedWallets } from '../lib/wallets.ts'

export const addCopy = {
  title: 'Add capital',
  send: 'Send USDC on Base.',
  // otto/mamoru#191 (Brais and Ot, 20-22 Oct): one bordered notice above the address, on both Add capital screens.
  baseOnlyLead: 'Only USDC on Base.',
  baseOnlyRest: "Any other token or network won't reach your account.",
  baseOnly: "Only USDC on Base. Any other token or network won't reach your account.",
  waiting: 'Waiting for your USDC',
  arrived: (amount: string) => `${amount} USDC arrived`,
  overCap: (o: OverCap) =>
    `${usd(o.usdc)} USDC arrived. That is ${usd(ceilCents(BigInt(o.excessUsdc)))} USDC over the ${usdPlain(o.capUsdc)} USDC cap, so Mamoru has not started. Your money is in your account and nothing was moved.`,
  overCapNext: 'See what you can do',
  // otto/mamoru#67: a sleeve on another chain. A deposit address is never shown without its chain and its USDC contract.
  sendOn: (c: SleeveChain) => `Send USDC on ${c.name}.`,
  onlyOnLead: (c: SleeveChain) => `Only USDC on ${c.name}.`,
  onlyOnRest: (c: SleeveChain) => `Any other token or network won't reach this ${c.name} balance.`,
  confirmed: (amount: string) => `Confirmed on Base. ${amount} USDC added.`,
  addressOn: (c: SleeveChain) => `Your address on ${c.name}`,
  usdcContract: (c: SleeveChain) => `USDC on ${c.name}`,
}

/** otto/mamoru#191: a wallet transfer Base confirmed, said once in the dark notice with its explorer link. */
export function toastConfirmed(tx: string, raw: bigint): void {
  showToast({ text: addCopy.confirmed(usd(raw)), href: explorerTx(BASE_SLEEVE, tx), linkLabel: `View on ${BASE_SLEEVE.explorer.name}` })
}

/** Address, QR and Connect wallet. Shared by the Add money screen and the Home modal. */
export function DepositDetails({ address, capUsdc, onConfirmed }: { address: string; capUsdc?: string; onConfirmed?: (tx: Hex, raw: bigint) => void }) {
  const wallets = useInjectedWallets()
  const chain = useChain()
  const base = chain.chainId === BASE_SLEEVE.chainId
  return (
    <div className="grid gap-6">
      <p className="m-0 border-2 border-ink px-4 py-3 text-[1rem] leading-[1.45] text-ink" data-testid="base-only">
        <strong className="font-bold">{base ? addCopy.baseOnlyLead : addCopy.onlyOnLead(chain)}</strong> {base ? addCopy.baseOnlyRest : addCopy.onlyOnRest(chain)}
      </p>
      {/* The wallet send is wired to Base (lib/wallet-client.ts); a Monad sleeve takes the address or the QR. */}
      {base ? <ConnectWallet to={address} wallets={wallets} onConfirmed={onConfirmed} /> : null}
      <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-7">
        <Qr text={address} />
        <div className="grid min-w-0 gap-3">
          {base ? (
            <p className="kicker">Your address on Base</p>
          ) : (
            <p className="kicker" data-testid="deposit-chain">
              {addCopy.addressOn(chain)}
            </p>
          )}
          <AddressBlock address={address} />
          <div className="flex flex-wrap items-center gap-3">
            <Copy text={address} label="Copy address" />
            <span className="text-[0.88rem] text-stone">
              {base ? addCopy.send : addCopy.sendOn(chain)}
              {capUsdc ? ` ${capNote(capUsdc)}` : ''}
            </span>
          </div>
          {base ? null : (
            <p className="m-0 font-mono text-[0.78rem] text-stone [overflow-wrap:anywhere]" data-testid="deposit-usdc">
              {addCopy.usdcContract(chain)}{' '}
              <a className="underline decoration-wash underline-offset-4 hover:text-emerald" href={explorerAddress(chain, chain.usdc)} target="_blank" rel="noreferrer">
                {chain.usdc}
              </a>
            </p>
          )}
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
  // otto/mamoru#135: a deposit moves nothing of the account, so it never invalidates the operator's funding
  // cache; `fresh` asks for a read at most 2 s old, under this 4 s poll, so every poll sees the chain.
  const funding = useFunding(accountKey, true, 4_000, false, true)
  const navigate = useNavigate()
  const f = funding.data
  const arrived = hasMoney(f)
  const over = overCapOf(f)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    // No session on a deep link: most likely a returning owner, so open on the sign-in card.
    if (session.isSuccess && !accountKey) void navigate({ to: '/', search: { signin: true }, replace: true })
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
        {f ? (
          <DepositDetails
            address={f.address}
            capUsdc={f.capUsdc}
            onConfirmed={(tx, raw) => {
              toastConfirmed(tx, raw)
              void navigate({ to: '/', replace: true })
            }}
          />
        ) : <div className="h-44 animate-pulse bg-wash/40" aria-hidden="true" />}
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
        <WrongNetwork accountKey={accountKey} />
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
