import type { EthereumSiblingToSign, OpView, OwnerTxToSign } from '@mamoru/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { ApiRequestError, useApi } from '../api/client.ts'
import { queryKeys } from '../api/queries.ts'
import { errorText } from './owner-flow.ts'
import { signOwnerTx, storedCredential } from './passkey-sign.ts'

/**
 * otto/mamoru#311 (#333): one approval screen for everything an account needs, one passkey prompt per chain. A passkey
 * assertion signs one Safe transaction, and a Safe's transaction hash names its chain, so Base and Ethereum each take
 * their own prompt: the screen shows both parts before the first one, and each prompt runs on its own tap (a passkey
 * prompt must run inside a user gesture).
 *
 * Base first: it is what starts Mamoru. When the Ethereum part cannot be prepared (nothing there any more, already set
 * up, the operator has no Ethereum), the approval is Base alone and says nothing about Ethereum.
 */
export type ApprovalPart = 'base' | 'ethereum'
export type PreparedPart = { part: ApprovalPart; tx: OwnerTxToSign; signed: boolean }

/** Codes for which the Ethereum part is simply not needed now: the approval goes on with Base alone, silently. */
const NOT_NEEDED = new Set(['SIBLING_NOTHING', 'SIBLING_IN_PROGRESS', 'SIBLING_NOT_OFFERED', 'NOT_FOUND'])

export const oneApprovalCopy = {
  lead: 'One approval for Base and Ethereum. Your passkey asks once for each.',
  base: 'On Base',
  ethereum: 'On Ethereum',
  approveOn: (p: ApprovalPart) => (p === 'base' ? 'Approve on Base' : 'Approve on Ethereum'),
  approved: 'Approved',
  next: 'Next',
  ethereumLater: 'The Ethereum part could not be prepared just now. Mamoru starts on Base; the notice about Ethereum offers it again.',
  expired: 'That approval expired. Tap again to refresh it.',
  done: 'Done. Mamoru starts on Base and brings what is on Ethereum to Base by itself.',
  doneBase: 'Done. Mamoru starts on Base.',
}

export function nextPart(parts: PreparedPart[] | null): PreparedPart | null {
  return parts?.find((p) => !p.signed) ?? null
}

/**
 * `withEthereum`: the operator offers the Ethereum part (EthereumSiblingView.offered) and the account holds something
 * there. Without it this is the plain Start (`activate`) with one prompt.
 */
export function useOneApproval(accountKey: string | undefined, withEthereum: boolean) {
  const api = useApi()
  const qc = useQueryClient()
  const [parts, setParts] = useState<PreparedPart[] | null>(null)
  const [busy, setBusy] = useState<null | 'preparing' | 'signing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [result, setResult] = useState<OpView | null>(null)
  const [finished, setFinished] = useState(false)

  const prepareEthereum = useCallback(async (): Promise<EthereumSiblingToSign | null> => {
    if (!accountKey) return null
    try {
      return await api.ethereumSiblingPrepare(accountKey)
    } catch (e) {
      if (!(e instanceof ApiRequestError && e.code && NOT_NEEDED.has(e.code))) setNote(oneApprovalCopy.ethereumLater)
      return null
    }
  }, [accountKey, api])

  const prepare = useCallback(async () => {
    if (!accountKey) return null
    setError(null)
    setNote(null)
    setBusy('preparing')
    setParts(null)
    try {
      const [base, eth] = await Promise.all([api.activatePrepare(accountKey), withEthereum ? prepareEthereum() : Promise.resolve(null)])
      const next: PreparedPart[] = [{ part: 'base', tx: base, signed: false }, ...(eth ? [{ part: 'ethereum' as const, tx: eth, signed: false }] : [])]
      setParts(next)
      return next
    } catch (e) {
      setError(errorText(e))
      return null
    } finally {
      setBusy(null)
    }
  }, [accountKey, api, prepareEthereum, withEthereum])

  const refresh = useCallback(() => {
    if (!accountKey) return
    void Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.funding(accountKey) }),
      qc.invalidateQueries({ queryKey: queryKeys.ops(accountKey) }),
      qc.invalidateQueries({ queryKey: queryKeys.ethereumSibling(accountKey) }),
      qc.invalidateQueries({ queryKey: queryKeys.bridgeOut(accountKey) }),
      qc.invalidateQueries({ queryKey: queryKeys.otherChains(accountKey) }),
    ])
  }, [accountKey, qc])

  /** Signs and sends the next part. An expired part is prepared again and waits for another tap. */
  const approve = useCallback(async () => {
    const cur = nextPart(parts)
    if (!accountKey || !parts || !cur) return
    setError(null)
    if (Date.parse(cur.tx.expiresAt) < Date.now()) {
      setBusy('preparing')
      try {
        const tx = cur.part === 'base' ? await api.activatePrepare(accountKey) : await prepareEthereum()
        if (!tx) {
          // The Ethereum part is no longer needed or not available: Base is already done, so the approval is done.
          setParts(parts.filter((p) => p !== cur))
          setFinished(true)
          refresh()
          return
        }
        setParts(parts.map((p) => (p === cur ? { ...p, tx } : p)))
        setError(oneApprovalCopy.expired)
      } catch (e) {
        setError(errorText(e))
      } finally {
        setBusy(null)
      }
      return
    }
    setBusy('signing')
    try {
      const sig = await signOwnerTx(cur.tx, storedCredential(accountKey))
      if (cur.part === 'base') setResult(await api.activate(accountKey, sig))
      else qc.setQueryData(queryKeys.ethereumSibling(accountKey), await api.ethereumSibling(accountKey, sig))
      const next = parts.map((p) => (p === cur ? { ...p, signed: true } : p))
      setParts(next)
      if (!nextPart(next)) setFinished(true)
      refresh()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }, [accountKey, api, parts, prepareEthereum, qc, refresh])

  /** Leaves the Ethereum part for later (the notice offers it again): Base is signed, so Mamoru runs. */
  const skipRest = useCallback(() => {
    setParts((ps) => ps?.filter((p) => p.signed) ?? null)
    setFinished(true)
  }, [])

  return { parts, busy, error, note, result, finished, prepare, approve, skipRest }
}

export type OneApproval = ReturnType<typeof useOneApproval>
