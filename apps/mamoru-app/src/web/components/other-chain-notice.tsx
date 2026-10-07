import type { OtherChainFunds, OtherChainsView } from '@mamoru/domain'
import { useOtherChains } from '../api/queries.ts'
import { formatUnits } from '../lib/format.ts'
import { usd } from '../lib/money.ts'

type Found = Extract<OtherChainFunds, { status: 'observed' }>

/** Chains other than the account's own where the address holds something. Not observed is not zero: it shows nothing. */
export function fundsElsewhere(view: OtherChainsView | undefined): Found[] {
  if (!view) return []
  return view.chains.filter((c): c is Found => c.status === 'observed' && c.chainId !== view.accountChainId && (BigInt(c.usdc) > 0n || BigInt(c.eth) > 0n))
}

function amount(c: Found): string {
  const parts = [...(BigInt(c.usdc) > 0n ? [`${usd(c.usdc)} USDC`] : []), ...(BigInt(c.eth) > 0n ? [`${formatUnits(c.eth, 'ETH')} ETH`] : [])]
  return parts.join(' and ')
}

export const otherChainCopy = {
  title: (c: Found) => `${amount(c)} at your address on ${c.name}, not on Base`,
  body: (c: Found) =>
    `Mamoru works on Base only. This is not part of your Mamoru balance and Mamoru has not moved it: it is still at your address on ${c.name}. It has to reach Base before Mamoru can use it, and Mamoru cannot move it from ${c.name} yet. Do not send more on ${c.name}.`,
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
              {c.name} block {c.block}
            </span>
          </span>
        </section>
      ))}
    </>
  )
}

export function WrongNetwork({ accountKey }: { accountKey: string | undefined }) {
  const other = useOtherChains(accountKey)
  return <OtherChainNotice view={other.data} />
}
