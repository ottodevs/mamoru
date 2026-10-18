import type { BridgeOutRoute, BridgeOutToSign, OtherChainFunds, OtherChainsView } from '@mamoru/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useApi } from '../api/client.ts'
import { queryKeys, useBridgeOut, useOtherChains } from '../api/queries.ts'
import { errorText } from '../lib/owner-flow.ts'
import { signOwnerTx, storedCredential } from '../lib/passkey-sign.ts'
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

/** USDC on Ethereum from 1 USDC up can be moved to Base (#133). Below that, and ETH, stay where they are. */
export const BRIDGE_CHAIN_ID = 1
export const BRIDGE_MIN_USDC = 1_000_000n
export const movable = (c: Found) => c.chainId === BRIDGE_CHAIN_ID && BigInt(c.usdc) >= BRIDGE_MIN_USDC

export const otherChainCopy = {
  title: (c: Found) => `${amount(c)} at your address on ${c.name}, not on Base`,
  body: (c: Found) =>
    movable(c)
      ? `This is not part of your Mamoru balance and Mamoru has not moved it: when last checked it was at your address on ${c.name}. You can move the USDC to this same account on Base with one passkey approval; Mamoru pays the ${c.name} gas.${BigInt(c.eth) > 0n ? ` The ETH stays on ${c.name}.` : ''} Do not send more on ${c.name}.`
      : `Mamoru works on Base. This is not part of your Mamoru balance and Mamoru has not moved it: when last checked it was at your address on ${c.name}. It has to reach Base before Mamoru can use it, and Mamoru cannot move it from ${c.name} yet. Do not send more on ${c.name}.`,
  move: 'Move to Base',
  preparing: 'Preparing',
  signing: 'Waiting for passkey',
  approve: 'Approve with passkey',
  state: {
    sending: 'Sending from Ethereum…',
    deposited: 'On its way to Base. It usually takes seconds.',
    filled: 'Arrived on Base. It is part of your balance now.',
    failed: 'The move did not go through. The USDC is still at your address on Ethereum.',
    unconfirmed: 'Sent from Ethereum; Mamoru is checking where it is. Do not send it again.',
  } satisfies Record<BridgeOutRoute['state'], string>,
}

/** Money sent on the wrong network: where it is and that it is not in the balance. Renders nothing when there is none. */
export function OtherChainNotice({ view, action }: { view: OtherChainsView | undefined; action?: (c: Found) => ReactNode }) {
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
            {action && movable(c) ? action(c) : null}
          </span>
        </section>
      ))}
    </>
  )
}

/** The last move's state, as the owner reads it. */
export function BridgeStatus({ route }: { route: BridgeOutRoute }) {
  return (
    <span className="mt-2 block text-[0.88rem]" data-testid="bridge-status" data-state={route.state} role="status">
      {otherChainCopy.state[route.state]}
    </span>
  )
}

/**
 * Move to Base (#133): the operator prepares one Safe transaction on Ethereum (approve + Across deposit to this same
 * account on Base), the passkey signs it, the operator sends it and pays the gas. Two taps, so the passkey prompt runs
 * inside a user gesture.
 */
export function BridgeOutAction({ accountKey }: { accountKey: string }) {
  const api = useApi()
  const qc = useQueryClient()
  const status = useBridgeOut(accountKey)
  const [prepared, setPrepared] = useState<BridgeOutToSign | null>(null)
  const [busy, setBusy] = useState<null | 'preparing' | 'signing'>(null)
  const [error, setError] = useState<string | null>(null)
  const route = status.isError ? null : (status.data?.route ?? null)
  const underway = route !== null && ['sending', 'deposited', 'unconfirmed'].includes(route.state)

  async function prepare() {
    setError(null)
    setBusy('preparing')
    try {
      setPrepared(await api.bridgeOutPrepare(accountKey))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  async function approve() {
    if (!prepared) return
    if (Date.parse(prepared.expiresAt) < Date.now()) {
      setPrepared(null)
      setError('That approval expired. Tap again to refresh it.')
      return
    }
    setError(null)
    setBusy('signing')
    try {
      const sig = await signOwnerTx(prepared, storedCredential(accountKey))
      const view = await api.bridgeOut(accountKey, sig)
      setPrepared(null)
      qc.setQueryData(queryKeys.bridgeOut(accountKey), view)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
      await Promise.all([qc.invalidateQueries({ queryKey: queryKeys.bridgeOut(accountKey) }), qc.invalidateQueries({ queryKey: queryKeys.otherChains(accountKey) })])
    }
  }

  return (
    <span className="mt-3 grid gap-2" data-testid="bridge-out">
      {route ? <BridgeStatus route={route} /> : null}
      {prepared ? (
        <span className="grid gap-2" data-testid="bridge-review">
          <ul className="m-0 grid gap-1 pl-5 text-[0.9rem]">
            {prepared.summary.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <span className="flex justify-end">
            <button type="button" className="cta" onClick={() => void approve()} disabled={busy !== null}>
              {busy === 'signing' ? otherChainCopy.signing : otherChainCopy.approve}
            </button>
          </span>
        </span>
      ) : underway ? null : (
        <span className="flex justify-end">
          <button type="button" className="cta" onClick={() => void prepare()} disabled={busy !== null}>
            {busy === 'preparing' ? otherChainCopy.preparing : otherChainCopy.move}
          </button>
        </span>
      )}
      {error ? <span className="err block">{error}</span> : null}
    </span>
  )
}

/** The notice for the signed-in account. A check that failed shows nothing: an amount seen earlier is not claimed to be there now. */
export function WrongNetwork({ accountKey }: { accountKey: string | undefined }) {
  const other = useOtherChains(accountKey)
  const status = useBridgeOut(accountKey)
  const route = status.isError ? null : (status.data?.route ?? null)
  return (
    <>
      <OtherChainNotice view={other.isError ? undefined : other.data} action={accountKey ? () => <BridgeOutAction accountKey={accountKey} /> : undefined} />
      {/* Once the USDC has left Ethereum the notice above is gone; the move's state stays in view until it lands. */}
      {route && fundsElsewhere(other.data).every((c) => !movable(c)) && route.state !== 'failed' && Date.now() - Date.parse(route.at) < 86_400_000 ? (
        <section className="card" data-testid="bridge-route" role="status">
          <span className="max-w-[40rem]">
            <span className="title">Moving {usd(route.amountUsdc)} USDC from Ethereum to Base</span>
            <BridgeStatus route={route} />
          </span>
        </section>
      ) : null}
    </>
  )
}
