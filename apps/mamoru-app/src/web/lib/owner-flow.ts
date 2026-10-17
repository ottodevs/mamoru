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
        const op = await SUBMIT[kind](api)(accountKey, { ...sig, ...accept })
        setPrepared(null)
        setResult(op)
        await Promise.all([
          qc.invalidateQueries({ queryKey: queryKeys.funding(accountKey) }),
          qc.invalidateQueries({ queryKey: queryKeys.ops(accountKey) }),
        ])
        return op
      } catch (e) {
        // otto/mamoru#155: the accepted quote went stale between prepare and this submit. Never refused and
        // never executed at a worse price than what was shown — re-prepare the same request and let the UI
        // show the fresh numbers. The owner's tick does not carry over: it was for the old quoteId.
        if (kind === 'transfer' && e instanceof ApiRequestError && e.code === 'PRICE_DIVERGENCE_STALE' && lastTransferBody.current) {
          try {
            setPrepared(toPrepared(await api.transferPrepare(accountKey, lastTransferBody.current)))
            return null
          } catch (e2) {
            setError(errorText(e2))
            return null
          }
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
