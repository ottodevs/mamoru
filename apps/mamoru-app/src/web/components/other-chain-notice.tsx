import type { OtherChainFunds, OtherChainsView } from '@mamoru/domain'
import { useOtherChains } from '../api/queries.ts'
import { usd } from '../lib/money.ts'
import { localTime } from '../lib/time.ts'

type Found = Extract<OtherChainFunds, { status: 'observed' }>

/** Chains other than the account's own where the address holds something. Not observed is not zero: it shows nothing. */
export function fundsElsewhere(view: OtherChainsView | undefined): Found[] {
  if (!view) return []
  return view.chains.filter((c): c is Found => c.status === 'observed' && c.chainId !== view.accountChainId && (BigInt(c.usdc) > 0n || BigInt(c.eth) > 0n))
}

/** Base units as an exact decimal: every digit that is there, nothing rounded away. */
export function exact(raw: string, decimals: number): string {
  const padded = raw.padStart(decimals + 1, '0')
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return `${BigInt(padded.slice(0, padded.length - decimals)).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`
}

// The usual formats cut at cents and at 6 decimals, which would paint a small amount as zero. Whole cents read as money; anything finer is shown in full.
function amount(c: Found): string {
  const usdc = BigInt(c.usdc)
  const parts = [...(usdc > 0n ? [`${usdc % 10_000n === 0n ? usd(c.usdc) : exact(c.usdc, 6)} USDC`] : []), ...(BigInt(c.eth) > 0n ? [`${exact(c.eth, 18)} ETH`] : [])]
  return parts.join(' and ')
}

export const otherChainCopy = {
  title: (c: Found) => `${amount(c)} at your address on ${c.name}, not on Base`,
  body: (c: Found) =>
    `Mamoru works on Base only. This is not part of your Mamoru balance and Mamoru has not moved it: when last checked it was at your address on ${c.name}. It has to reach Base before Mamoru can use it, and Mamoru cannot move it from ${c.name} yet. Do not send more on ${c.name}.`,
}

/** Money sent on the wrong network: where it is and that it is not in the balance. Renders nothing when there is none. */
export function OtherChainNotice({ view }: { view: OtherChainsView | undefined }) {
  const found = fundsElsewhere(view)
  if (found.length === 0) return null
  return (
    <>
      {found.map((c) => (
        <section key={c.chainId} className="card" data-testid="other-chain" data-chain-id={c.chainId} role="status">
          <span className="max-w-[40rem]">
            <span className="title text-alert-ink">{otherChainCopy.title(c)}</span>
            <span className="sub">{otherChainCopy.body(c)}</span>
            <span className="mt-1 block font-mono text-[0.72rem] text-stone">
              {c.name} block {c.block} · Checked {localTime(c.observedAt)}
            </span>
          </span>
        </section>
      ))}
    </>
  )
}

/** The notice for the signed-in account. A check that failed shows nothing: an amount seen earlier is not claimed to be there now. */
export function WrongNetwork({ accountKey }: { accountKey: string | undefined }) {
  const other = useOtherChains(accountKey)
  return <OtherChainNotice view={other.isError ? undefined : other.data} />
}
