import type { WhatsNew } from '@mamoru/domain'
import { useRef, useState } from 'react'
import { leaveMonadCopy, leaveSteps, useLeaveMonad, type LeaveStep } from '../lib/leave-monad.ts'
import { Modal } from './ui.tsx'

/**
 * otto/mamoru#428 (spec 014, copy C1-C3): the Home card that offers to bring the Monad funds to Base, and the one
 * authorization screen behind it: both steps and every line each one signs, then one tap and one passkey prompt per
 * step, Monad first. Nothing here is decided by the app: the steps and their lines are the operator's, and the Worker
 * checks each transaction against the chain before it can be signed.
 */
export function LeaveMonadCard({ baseKey, monadKey, home, view }: { baseKey: string; monadKey: string; home: string; view: WhatsNew | null }) {
  const [open, setOpen] = useState(false)
  // Once the last step is on chain the operator stops offering the view: the open screen keeps the last one, every
  // step done, so it can say so instead of vanishing under the owner.
  const last = useRef<WhatsNew | null>(null)
  if (view) last.current = view
  const shown = view ?? (open ? last.current : null)
  const steps = (leaveSteps(shown) ?? []).map((s) => (view ? s : { ...s, done: true }))
  if (!shown || !steps.length) return null
  return <LeaveMonadFlow baseKey={baseKey} monadKey={monadKey} home={home} view={shown} steps={steps} open={open} setOpen={setOpen} />
}

export function LeaveMonadFlow({ baseKey, monadKey, home, view, steps, open, setOpen }: { baseKey: string; monadKey: string; home: string; view: WhatsNew; steps: LeaveStep[]; open: boolean; setOpen: (v: boolean) => void }) {
  const flow = useLeaveMonad(baseKey, monadKey, home, steps, open)
  return (
    <>
      <section className="card flex flex-wrap items-center justify-between gap-3" data-testid="leave-monad" role="status">
        <span className="max-w-[40rem]">
          <span className="title">{leaveMonadCopy.cardTitle}</span>
          <span className="sub">{leaveMonadCopy.cardBody}</span>
        </span>
        <button type="button" className="act" onClick={() => setOpen(true)}>
          {leaveMonadCopy.review}
        </button>
      </section>
      <Modal open={open} onClose={() => setOpen(false)} title={leaveMonadCopy.title}>
        <div className="grid gap-3" data-testid="leave-monad-screen">
          <ol className="m-0 grid gap-1 pl-5 text-[0.95rem]">
            {view.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
          {steps.map((s) => {
            const done = flow.isDone(s)
            const h = flow.held[s.kind]
            const lines = h?.tx?.summary ?? s.summary
            const busy = flow.signing === s.kind ? leaveMonadCopy.signing : h?.preparing ? leaveMonadCopy.preparing : null
            // The return home waits for the sale before it; any step waits while another one is at the passkey.
            const blocked = flow.signing !== null || !!h?.preparing || (s.kind === 'return-home' && steps.some((x) => x.kind === 'monad-sell' && !flow.isDone(x)))
            return (
              <section key={s.kind} className="grid gap-2 border-t border-wash pt-2" data-testid={`leave-step-${s.kind}`} data-done={done}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[0.82rem] font-semibold uppercase tracking-[0.06em] text-muted">{s.chain === 'monad' ? leaveMonadCopy.onMonad : leaveMonadCopy.onBase}</span>
                  {done ? (
                    <span className="text-[0.82rem] text-emerald" role="status">
                      ✓ {leaveMonadCopy.approved}
                    </span>
                  ) : null}
                </span>
                {done ? null : (
                  <>
                    <ul className="m-0 grid gap-1 pl-5 text-[0.92rem]">
                      {lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                    {h?.error ? <span className="err block">{h.error}</span> : s.waiting === 'unwinding' ? <span className="sub block">{leaveMonadCopy.unwinding}</span> : null}
                    <span className="flex justify-end">
                      <button type="button" className="cta" onClick={() => void flow.approve(s.kind)} disabled={blocked || !!s.waiting} data-testid={`leave-approve-${s.kind}`}>
                        {busy ?? leaveMonadCopy.approve(s.kind)}
                      </button>
                    </span>
                  </>
                )}
              </section>
            )
          })}
          {flow.doneCount > 0 ? (
            <span className="sub block" role="status" data-testid="leave-progress">
              {flow.finished ? leaveMonadCopy.done : leaveMonadCopy.stepDone(flow.doneCount, flow.total)}
            </span>
          ) : null}
        </div>
      </Modal>
    </>
  )
}
