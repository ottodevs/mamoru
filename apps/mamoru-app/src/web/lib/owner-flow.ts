import type { Hex0x, OpView, OwnerSignature, OwnerTxToSign, TransferPlan, TransferRequest } from '@mamoru/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { ApiRequestError, useApi, type ApiClient } from '../api/client.ts'
import { queryKeys } from '../api/queries.ts'
import { PasskeyError } from './passkey.ts'
import { isPasskeyCancel, signOwnerTx, storedCredential } from './passkey-sign.ts'

const USDC_DECIMALS = 6

export const flowCopy = {
  cancelled: 'Passkey closed. Nothing was signed.',
  apiFailed: 'Mamoru did not answer. Try again.',
}

/** "12.5" USDC to base units. Null when the text is not a positive amount with at most 6 decimals. */
export function parseUsdc(text: string): string | null {
  const t = text.trim()
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return null
  const [whole = '0', frac = ''] = t.split('.')
  const raw = (whole + frac.padEnd(USDC_DECIMALS, '0')).replace(/^0+(?=\d)/, '')
  return /^0+$/.test(raw) ? null : raw
}

export function isAddress(s: string): s is Hex0x {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim())
}

export function errorText(e: unknown): string {
  if (isPasskeyCancel(e)) return flowCopy.cancelled
  if (e instanceof ApiRequestError || e instanceof PasskeyError) return e.message
  return e instanceof Error && e.message ? e.message : flowCopy.apiFailed
}

export type OwnerKind = 'activate' | 'transfer' | 'stop' | 'renew'
type Prepared = { tx: OwnerTxToSign; reduce?: TransferPlan['reduce']; receive?: TransferPlan['receive']; divergence?: TransferPlan['divergence'] }

const SUBMIT: Record<OwnerKind, (api: ApiClient) => ApiClient['activate']> = {
  activate: (api) => api.activate,
  transfer: (api) => api.transfer,
  stop: (api) => api.stop,
  renew: (api) => api.renew,
}

const toPrepared = (plan: TransferPlan): Prepared => ({ tx: plan.ownerTx, reduce: plan.reduce, receive: plan.receive, divergence: plan.divergence })

/**
 * otto/mamoru#155 (security review on 1c54819): the only thing ever allowed out of `accept` and into the submit
 * body is its `acceptDivergence` field — never a spread of `accept` itself. `approve`'s `accept` parameter is
 * typed narrowly, but nothing stops a caller from passing something else at runtime (Review's buttons call
 * `onApprove()` with no arguments precisely so this never happens from a click, but this is the last line of
 * defense regardless): accessing `.acceptDivergence` on an unrelated object such as a React SyntheticEvent is
 * simply `undefined`, safely ignored, never spread into the request — no leaked event internals, no circular
 * refs reaching `JSON.stringify`.
 */
export function withAcceptance(sig: OwnerSignature, accept?: Pick<OwnerSignature, 'acceptDivergence'>): OwnerSignature {
  const acceptDivergence = (accept as { acceptDivergence?: OwnerSignature['acceptDivergence'] } | null | undefined)?.acceptDivergence
  return acceptDivergence ? { ...sig, acceptDivergence } : sig
}

/**
 * otto/mamoru#155: what `approve()`'s catch does on a 409 PRICE_DIVERGENCE_STALE (the owner's accepted quote
 * moved past, between prepare and this submit). Clears the prepared plan FIRST, unconditionally, so there is
 * nothing left to submit while the re-prepare is in flight; if the re-prepare itself fails, `prepared` stays
 * cleared rather than reverting to the stale one, so nothing stays submittable either way. On success the UI
 * re-renders from the fresh plan's own `divergence` (a brand new object), which is never equal to whatever the
 * owner had ticked before, so the acceptance never carries over.
 */
export async function recoverFromStaleDivergence(
  accountKey: string,
  body: TransferRequest,
  transferPrepare: ApiClient['transferPrepare'],
  setPrepared: (p: Prepared | null) => void,
  setError: (e: string | null) => void,
): Promise<void> {
  setPrepared(null)
  try {
    setPrepared(toPrepared(await transferPrepare(accountKey, body)))
  } catch (e) {
    setError(errorText(e))
  }
}

/**
 * One owner action: the API prepares a Safe transaction, the passkey signs its safeTxHash, the API submits it.
 * Preparing and signing are two taps, so the passkey prompt always runs inside a user gesture.
 */
export function useOwnerAction(accountKey: string | undefined, kind: OwnerKind) {
  const api = useApi()
  const qc = useQueryClient()
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [busy, setBusy] = useState<null | 'preparing' | 'signing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<OpView | null>(null)
  // otto/mamoru#155: kept so a PRICE_DIVERGENCE_STALE on submit can re-prepare with the same inputs and show
  // the fresh warning, instead of just failing. Irrelevant, and never read, for any kind but 'transfer'.
  const lastTransferBody = useRef<TransferRequest | undefined>(undefined)

  const prepare = useCallback(
    async (body?: TransferRequest) => {
      if (!accountKey) return null
      setError(null)
      setBusy('preparing')
      // otto/mamoru#155: clear whatever was prepared (and so whatever was ticked) before requesting a fresh
      // plan. Normally already null here (the form isn't shown while a Review is up), but this makes it true
      // unconditionally rather than assumed.
      setPrepared(null)
      try {
        let p: Prepared
        if (kind === 'transfer') {
          if (!body) throw new Error('Enter an address and an amount.')
          lastTransferBody.current = body
          p = toPrepared(await api.transferPrepare(accountKey, body))
        } else {
          p = { tx: kind === 'activate' ? await api.activatePrepare(accountKey) : kind === 'renew' ? await api.renewPrepare(accountKey) : await api.stopPrepare(accountKey) }
        }
        setPrepared(p)
        return p
      } catch (e) {
        setError(errorText(e))
        return null
      } finally {
        setBusy(null)
      }
    },
    [accountKey, api, kind],
  )

  /** `accept`: PriceDivergenceWarning.acceptDivergence, present only when the owner ticked the warning box. */
  const approve = useCallback(
    async (accept?: Pick<OwnerSignature, 'acceptDivergence'>) => {
      if (!accountKey || !prepared) return null
      if (Date.parse(prepared.tx.expiresAt) < Date.now()) {
        setPrepared(null)
        setError('That approval expired. Tap again to refresh it.')
        return null
      }
      setError(null)
      setBusy('signing')
      try {
        const sig = await signOwnerTx(prepared.tx, storedCredential(accountKey))
        const op = await SUBMIT[kind](api)(accountKey, withAcceptance(sig, accept))
        setPrepared(null)
        setResult(op)
        await Promise.all([
          qc.invalidateQueries({ queryKey: queryKeys.funding(accountKey) }),
          qc.invalidateQueries({ queryKey: queryKeys.ops(accountKey) }),
        ])
        return op
      } catch (e) {
        // otto/mamoru#155: the accepted quote went stale between prepare and this submit. Never refused and
        // never executed at a worse price than what was shown; never left submittable on the old numbers
        // either. See recoverFromStaleDivergence for exactly what "cleared first" means here.
        if (kind === 'transfer' && e instanceof ApiRequestError && e.code === 'PRICE_DIVERGENCE_STALE' && lastTransferBody.current) {
          await recoverFromStaleDivergence(accountKey, lastTransferBody.current, api.transferPrepare, setPrepared, setError)
          return null
        }
        setError(errorText(e))
        return null
      } finally {
        setBusy(null)
      }
    },
    [accountKey, api, kind, prepared, qc],
  )

  const reset = useCallback(() => {
    setPrepared(null)
    setError(null)
    setResult(null)
    setBusy(null)
  }, [])

  return { prepared, busy, error, result, prepare, approve, reset }
}
