import type { OpView, OwnerTxToSign, WhatsNew } from '@mamoru/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiRequestError, useApi } from '../api/client.ts'
import { queryKeys, useOps } from '../api/queries.ts'
import { errorText } from './owner-flow.ts'
import { signOwnerTx, storedCredential } from './passkey-sign.ts'

/**
 * otto/mamoru#428 (spec 014): leaving Monad. One screen, one decision, one passkey prompt per step: first on Monad (the
 * Safe there ends Mamoru's access and sends its USDC home), then on Base (the account moves to the Base-only mix). A
 * passkey assertion signs one Safe transaction and a Safe's transaction hash names its chain, so each chain takes its
 * own prompt; a Safe on Monad whose engine cannot sell the WMON it holds takes one more, the sale, before its return.
 *
 * Every step is prepared before its button is live, so a tap goes straight to the passkey (a prompt must run inside a
 * user gesture) and the lines shown are exactly the ones about to be signed (spec 014 threats S17).
 */
export type LeaveKind = 'monad-sell' | 'return-home' | 'renew'
export type LeaveStep = WhatsNew['steps'][number] & { kind: LeaveKind }

/** The steps of a base-v8 offer that names a Monad step, or null: anything else is not this screen's. */
export function leaveSteps(w: WhatsNew | undefined | null): LeaveStep[] | null {
  if (!w || w.policy !== 'base-v8') return null
  const steps = w.steps.filter((s): s is LeaveStep => s.kind === 'monad-sell' || s.kind === 'return-home' || s.kind === 'renew')
  if (steps.length !== w.steps.length || !steps.some((s) => s.chain === 'monad')) return null
  return steps
}

export const leaveMonadCopy = {
  // C1, the Home card.
  cardTitle: 'Bring your Monad funds to Base',
  cardBody: 'Mamoru has moved your Monad position to USDC. Approve to bring it to your Safe on Base and put it to work in USDC/cbBTC.',
  review: 'Review',
  // C2, the authorization screen.
  title: 'Leave Monad',
  onMonad: 'On Monad',
  onBase: 'On Base',
  approve: (k: LeaveKind) => (k === 'monad-sell' ? 'Approve sale on Monad' : k === 'return-home' ? 'Approve on Monad' : 'Approve on Base'),
  approved: 'Approved',
  preparing: 'Preparing',
  signing: 'Waiting for passkey',
  sending: 'Sending',
  failed: 'That step did not go through. Nothing moved. You can approve it again.',
  // C3, progress and done.
  stepDone: (n: number, of: number) => (n === 1 && of === 2 ? 'Step 1 of 2 done. Your USDC is on its way to Base' : `Step ${n} of ${of} done`),
  done: 'Done. Mamoru will put it to work when it arrives',
  unwinding: 'Mamoru is still moving your Monad position to USDC. Try again in a few minutes',
  expired: 'That approval expired. Tap again to refresh it.',
}

/** A prepared approval past its time, or one whose time cannot be read: never signed, prepared again. */
export function expired(tx: Pick<OwnerTxToSign, 'expiresAt'>, now = Date.now()): boolean {
  const at = Date.parse(tx.expiresAt)
  return !(at > now)
}

/**
 * Where a step stands. `done` only on the chain's word: the operator's view marks it, or the operation this screen sent
 * for it is confirmed. A signature that was sent is `sent` until then, and open again if its operation failed.
 */
export type StepState = 'open' | 'sent' | 'done'
export function stepState(step: Pick<LeaveStep, 'done'>, sent: Pick<OpView, 'opId' | 'state'> | undefined, ops: readonly Pick<OpView, 'opId' | 'state'>[]): StepState | 'failed' {
  if (step.done) return 'done'
  if (!sent) return 'open'
  const now = ops.find((o) => o.opId === sent.opId) ?? sent
  return now.state === 'confirmed' ? 'done' : now.state === 'failed' ? 'failed' : 'sent'
}

/** Codes that mean the Monad position is not all USDC yet (or its transaction is on its way): the step waits. */
const UNWINDING = new Set(['MONAD_UNWIND_PENDING', 'STOP_IN_FLIGHT'])
const said = (e: unknown): string => (e instanceof ApiRequestError && e.code && UNWINDING.has(e.code) ? leaveMonadCopy.unwinding : errorText(e))

type Held = { tx: OwnerTxToSign | null; error: string | null; preparing: boolean }
const EMPTY: Held = { tx: null, error: null, preparing: false }

/**
 * `baseKey`: the Base account. `monadKey`: the same owner's account on Monad. `home`: the Base Safe's address, where the
 * Monad Safe's USDC goes (the Worker refuses any other). `steps`: the operator's view, re-read as the flow moves.
 */
export function useLeaveMonad(baseKey: string, monadKey: string, home: string, steps: LeaveStep[], open: boolean) {
  const api = useApi()
  const qc = useQueryClient()
  const [held, setHeld] = useState<Partial<Record<LeaveKind, Held>>>({})
  /** The operation each signature became, as the operator answered the submit. */
  const [sent, setSent] = useState<Partial<Record<LeaveKind, OpView>>>({})
  const [signing, setSigning] = useState<LeaveKind | null>(null)
  const asking = useRef(new Set<LeaveKind>())
  const monadOps = useOps(monadKey, open).data?.ops
  const baseOps = useOps(baseKey, open).data?.ops
  const stateOf = useCallback((s: LeaveStep) => stepState(s, sent[s.kind], (s.chain === 'monad' ? monadOps : baseOps) ?? []), [baseOps, monadOps, sent])

  const refresh = useCallback(() => {
    void Promise.all([baseKey, monadKey].flatMap((k) => [qc.invalidateQueries({ queryKey: queryKeys.funding(k) }), qc.invalidateQueries({ queryKey: queryKeys.ops(k) })]))
  }, [baseKey, monadKey, qc])

  const prepare = useCallback(
    async (kind: LeaveKind) => {
      if (asking.current.has(kind)) return
      asking.current.add(kind)
      setHeld((h) => ({ ...h, [kind]: { tx: h[kind]?.tx ?? null, error: null, preparing: true } }))
      try {
        const tx = kind === 'monad-sell' ? await api.monadSellPrepare(monadKey) : kind === 'return-home' ? await api.returnHomePrepare(monadKey, home) : await api.renewPrepare(baseKey)
        setHeld((h) => ({ ...h, [kind]: { tx, error: null, preparing: false } }))
      } catch (e) {
        setHeld((h) => ({ ...h, [kind]: { tx: null, error: said(e), preparing: false } }))
      } finally {
        asking.current.delete(kind)
      }
    },
    [api, baseKey, home, monadKey],
  )

  const isDone = useCallback((s: LeaveStep) => stateOf(s) === 'done', [stateOf])
  const isSent = useCallback((s: LeaveStep) => stateOf(s) === 'sent', [stateOf])
  /** The steps that can be prepared now: the first Monad step still to do (the return waits for the sale) and the Base one; none that is on its way. */
  const preparable = useCallback((): LeaveKind[] => {
    const monad = steps.find((s) => s.chain === 'monad' && !isDone(s))
    const base = steps.find((s) => s.chain === 'base' && !isDone(s))
    return [...(monad && !monad.waiting && stateOf(monad) === 'open' ? [monad.kind] : []), ...(base && stateOf(base) === 'open' ? [base.kind] : [])]
  }, [isDone, stateOf, steps])

  // An operation that failed after it was sent: the step is open again and says so; nothing is counted as done.
  const failed = steps.filter((s) => stateOf(s) === 'failed').map((s) => s.kind).join(',')
  useEffect(() => {
    if (!failed) return
    const kinds = failed.split(',') as LeaveKind[]
    setSent((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !kinds.includes(k as LeaveKind))))
    setHeld((h) => ({ ...h, ...Object.fromEntries(kinds.map((k) => [k, { tx: null, preparing: false, error: leaveMonadCopy.failed }])) }))
  }, [failed])

  // Prepared as soon as the screen is open and whenever a step becomes the next one: never from a tap that must sign.
  const wanted = open ? preparable().join(',') : ''
  useEffect(() => {
    for (const k of wanted ? (wanted.split(',') as LeaveKind[]) : []) {
      if (!held[k]?.tx && !held[k]?.error && !held[k]?.preparing) void prepare(k)
    }
  }, [wanted, held, prepare])

  /** One tap on a step's button: its passkey prompt when it is prepared and fresh, else it is prepared again (no prompt). */
  const approve = useCallback(
    async (kind: LeaveKind) => {
      const cur = held[kind]
      if (signing || cur?.preparing || sent[kind]) return
      if (!cur?.tx) return void prepare(kind)
      if (expired(cur.tx)) {
        setHeld((h) => ({ ...h, [kind]: { ...EMPTY } }))
        await prepare(kind)
        setHeld((h) => ({ ...h, [kind]: { tx: h[kind]?.tx ?? null, preparing: false, error: h[kind]?.error ?? leaveMonadCopy.expired } }))
        return
      }
      setSigning(kind)
      try {
        const sig = await signOwnerTx(cur.tx, storedCredential(baseKey))
        const op = kind === 'monad-sell' ? await api.monadSell(monadKey, sig) : kind === 'return-home' ? await api.returnHome(monadKey, sig) : await api.renew(baseKey, sig)
        setSent((x) => ({ ...x, [kind]: op }))
        setHeld((h) => ({ ...h, [kind]: { ...EMPTY } }))
      } catch (e) {
        setHeld((h) => ({ ...h, [kind]: { tx: cur.tx, preparing: false, error: said(e) } }))
      } finally {
        setSigning(null)
        refresh()
      }
    },
    [api, baseKey, held, monadKey, prepare, refresh, sent, signing],
  )

  const total = steps.length
  const doneCount = steps.filter(isDone).length
  return { held, signing, approve, isDone, isSent, total, doneCount, finished: doneCount === total }
}

export type LeaveMonad = ReturnType<typeof useLeaveMonad>
