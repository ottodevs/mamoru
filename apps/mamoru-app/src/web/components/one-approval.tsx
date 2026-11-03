import type { EthereumSiblingToSign, EthereumSiblingView } from '@mamoru/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useApi } from '../api/client.ts'
import { queryKeys } from '../api/queries.ts'
import { nextPart, oneApprovalCopy, type ApprovalPart, type OneApproval, type PreparedPart } from '../lib/one-approval.ts'
import { errorText } from '../lib/owner-flow.ts'
import { signOwnerTx, storedCredential } from '../lib/passkey-sign.ts'
import { activateLine, signatureCopy } from '../lib/signature.ts'

export const ethereumCopy = {
  /** The notice body when the account can hand its Ethereum funds to Mamoru with one approval (#311). */
  offered: (name: string) =>
    `This is not part of your Mamoru balance yet: it is at your address on ${name}. Approve once and Mamoru turns it into USDC and brings it to this same account on Base by itself. The ${name} gas comes out of what is there. Do not send more on ${name}.`,
  /** The same, while Start (below) is still to be approved: Start covers it. */
  withStart: (name: string) =>
    `This is not part of your Mamoru balance yet: it is at your address on ${name}. The approval to start Mamoru below covers it too: Mamoru then turns it into USDC and brings it to this same account on Base by itself. Do not send more on ${name}.`,
  /** Set up, or on its way: Mamoru brings it over; nothing to approve. */
  underway: (name: string) => `This is not part of your Mamoru balance yet: it is at your address on ${name}, and Mamoru is bringing it to this same account on Base. Do not send more on ${name}.`,
  state: {
    sending: 'Setting up Mamoru on Ethereum…',
    unconfirmed: 'Sent on Ethereum; Mamoru is checking the result. Do not approve it again.',
    done: 'Mamoru is set up on Ethereum. It turns what is there into USDC and brings it to Base by itself; this can take a few hours.',
    failed: 'Setting up Mamoru on Ethereum did not go through. Nothing moved. You can approve it again.',
  } satisfies Record<Exclude<EthereumSiblingView['state'], 'none'>, string>,
  approve: 'Approve',
  preparing: 'Preparing',
  signing: 'Waiting for passkey',
}

function PartBlock({ p, current }: { p: PreparedPart; current: boolean }) {
  return (
    <span className="grid gap-1 border-t border-wash pt-2" data-testid={`approval-part-${p.part}`} data-signed={p.signed}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[0.82rem] font-semibold uppercase tracking-[0.06em] text-muted">{p.part === 'base' ? oneApprovalCopy.base : oneApprovalCopy.ethereum}</span>
        <span className={`text-[0.82rem] ${p.signed ? 'text-emerald' : 'text-stone'}`} role="status">
          {p.signed ? `✓ ${oneApprovalCopy.approved}` : current ? oneApprovalCopy.next : ''}
        </span>
      </span>
      {p.part === 'base' ? (
        <span className="text-[0.95rem]" data-testid="sign-scope">
          {activateLine(p.tx.summary)} <strong>{signatureCopy.activate.never}</strong>
        </span>
      ) : (
        <ul className="m-0 grid gap-1 pl-5 text-[0.92rem]">
          {p.tx.summary.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </span>
  )
}

const label = (busy: string | null, part: ApprovalPart | null, fallback: string) =>
  busy === 'signing' ? ethereumCopy.signing : busy === 'preparing' ? ethereumCopy.preparing : part ? oneApprovalCopy.approveOn(part) : fallback

/**
 * Start for an account whose funds include some on Ethereum that Mamoru can take over (#311): one screen with the Base
 * part and the Ethereum part, then one passkey prompt for each, each on its own tap. `flow` lives in the page, not
 * here: once Base is approved the account is starting and Start's row goes away, but this screen stays until Ethereum.
 */
export function OneApprovalStart({ flow, title, startLabel }: { flow: OneApproval; title: string; startLabel: string }) {
  const cur = nextPart(flow.parts)
  if (flow.finished) {
    const both = flow.parts?.some((p) => p.part === 'ethereum' && p.signed)
    return (
      <section className="card" data-testid="start-done" role="status">
        <span className="title">{both ? oneApprovalCopy.done : oneApprovalCopy.doneBase}</span>
      </section>
    )
  }
  const two = (flow.parts?.length ?? 0) > 1
  return (
    <section className="card grid gap-3" data-testid="start" data-approval="one">
      <span className="flex flex-wrap items-center justify-between gap-3">
        <span className="max-w-[40rem]">
          <span className="title">{title}</span>
          {two ? <span className="sub">{oneApprovalCopy.lead}</span> : null}
        </span>
        {flow.parts ? null : (
          <button type="button" className="act" onClick={() => void flow.prepare()} disabled={flow.busy !== null}>
            {label(flow.busy, null, startLabel)}
          </button>
        )}
      </span>
      {flow.parts ? (
        <span className="grid gap-3">
          {flow.parts.map((p) => (
            <PartBlock key={p.part} p={p} current={p === cur} />
          ))}
          {flow.note ? <span className="sub block" role="status">{flow.note}</span> : null}
          {flow.error ? <span className="err block">{flow.error}</span> : null}
          <span className={flow.parts[0]?.signed ? 'flex flex-wrap items-center justify-between gap-2' : 'flex justify-end'}>
            {flow.parts[0]?.signed ? (
              <button type="button" className="chipbtn" onClick={() => flow.skipRest()} disabled={flow.busy !== null}>
                Later
              </button>
            ) : null}
            <button type="button" className="cta" onClick={() => void flow.approve()} disabled={flow.busy !== null || !cur} data-testid="approve-part" data-part={cur?.part}>
              {label(flow.busy, cur?.part ?? null, ethereumCopy.approve)}
            </button>
          </span>
        </span>
      ) : flow.error ? (
        <span className="err block">{flow.error}</span>
      ) : null}
    </section>
  )
}

/**
 * The Ethereum part alone, from the notice (#311): for an account already running on Base, or one that left it for
 * later. One prepare, one passkey prompt, two taps.
 */
export function EthereumApprovalAction({ accountKey }: { accountKey: string }) {
  const api = useApi()
  const qc = useQueryClient()
  const [prepared, setPrepared] = useState<EthereumSiblingToSign | null>(null)
  const [busy, setBusy] = useState<null | 'preparing' | 'signing'>(null)
  const [error, setError] = useState<string | null>(null)

  async function prepare() {
    setError(null)
    setBusy('preparing')
    try {
      setPrepared(await api.ethereumSiblingPrepare(accountKey))
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
      setError(oneApprovalCopy.expired)
      return
    }
    setError(null)
    setBusy('signing')
    try {
      const sig = await signOwnerTx(prepared, storedCredential(accountKey))
      qc.setQueryData(queryKeys.ethereumSibling(accountKey), await api.ethereumSibling(accountKey, sig))
      setPrepared(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
      await Promise.all([qc.invalidateQueries({ queryKey: queryKeys.ethereumSibling(accountKey) }), qc.invalidateQueries({ queryKey: queryKeys.otherChains(accountKey) })])
    }
  }

  return (
    <span className="mt-3 grid gap-2" data-testid="ethereum-approval">
      {prepared ? (
        <span className="grid gap-2" data-testid="ethereum-review">
          <ul className="m-0 grid gap-1 pl-5 text-[0.9rem]">
            {prepared.summary.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <span className="flex justify-end">
            <button type="button" className="cta" onClick={() => void approve()} disabled={busy !== null}>
              {busy === 'signing' ? ethereumCopy.signing : oneApprovalCopy.approveOn('ethereum')}
            </button>
          </span>
        </span>
      ) : (
        <span className="flex justify-end">
          <button type="button" className="cta" onClick={() => void prepare()} disabled={busy !== null}>
            {busy === 'preparing' ? ethereumCopy.preparing : ethereumCopy.approve}
          </button>
        </span>
      )}
      {error ? <span className="err block">{error}</span> : null}
    </span>
  )
}
