import type { OwnerResponse } from '@mamoru/domain'
import { conservadorV1 } from '@mamoru/policy'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useApi } from '../api/client.ts'
import { queryKeys } from '../api/queries.ts'
import { downloadJson, kitFilename } from '../lib/download.ts'
import { errorText, useOwnerAction } from '../lib/owner-flow.ts'
import { createOwnerPasskey } from '../lib/passkey.ts'
import { rememberCredential } from '../lib/passkey-sign.ts'

// The Conservador mix as the policy defines it (basis points), drawn like the mockup's mix bar.
const BUCKET: Record<string, { name: string; note: string; tone: string }> = {
  risk: { name: 'Higher yield', note: 'Off for now', tone: 'mercenary' },
  'btc-usdc': { name: 'BTC + stablecoins', note: 'USDC/cbBTC on Uniswap', tone: 'paired' },
  stables: { name: 'Stablecoins', note: 'Kept in USDC', tone: 'stables' },
}
export const MIX = [...conservadorV1.buckets]
  .reverse()
  .map((b) => ({ id: b.id, pct: b.preference / 100, ...(BUCKET[b.id] ?? { name: b.id, note: '', tone: 'stables' }) }))

export const onboardingCopy = {
  screens: [
    { title: 'Fund Mamoru', body: ['Send the USDC you want to invest.'] },
    { title: "What's next?", body: ['Yield is reinvested. You can transfer part or all of it whenever you want.'] },
  ],
  create: { title: 'You keep control', body: ['No forced lockups or third-party dependencies.', 'Free to exit anytime.'] },
  approve: { title: 'Approve once', body: 'Approve once. Mamoru starts when your money lands.' },
}

function Mix() {
  return (
    <figure className="mix" aria-label="Conservador mix">
      <div className="mix-bar" aria-hidden="true">
        {MIX.map((s) => (
          <div key={s.id} className={`mix-seg ${s.tone}`} style={{ flex: s.pct }}>
            {s.pct}%
          </div>
        ))}
      </div>
      <ul className="m-0 grid list-none gap-[0.95rem] p-0">
        {MIX.map((s) => (
          <li key={s.id} className="grid grid-cols-[0.7rem_1fr] items-start gap-[0.65rem]">
            <span className={`mix-dot ${s.tone}`} />
            <span>
              <span className="block text-base leading-tight">
                {s.name} {s.pct}%
              </span>
              <span className="mt-[0.2rem] block text-[0.85rem] leading-snug text-stone">{s.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

function Identity({ owner, onCreate, creating, createError }: { owner: OwnerResponse | null; onCreate: () => void; creating: boolean; createError: string | null }) {
  const api = useApi()
  const navigate = useNavigate()
  const act = useOwnerAction(owner?.accountKey, 'activate')
  const [kitSaved, setKitSaved] = useState(false)
  const kit = useMutation({
    mutationFn: async (o: OwnerResponse) => {
      downloadJson(kitFilename(o.address), await api.recoveryKit(o.accountKey))
      await api.ackRecovery(o.accountKey).catch(() => undefined)
    },
    onSuccess: () => setKitSaved(true),
  })
  const { prepare, prepared, busy } = act

  // Prepare the activation as soon as the account exists, so the approve tap goes straight to the passkey.
  useEffect(() => {
    if (owner && !prepared && busy === null && !act.error && !act.result) void prepare()
  }, [owner, prepared, busy, act.error, act.result, prepare])

  if (!owner) {
    return (
      <>
        <h1 className="ob-title">{onboardingCopy.create.title}</h1>
        {onboardingCopy.create.body.map((p) => (
          <p key={p} className="ob-body">
            {p}
          </p>
        ))}
        {createError ? <p className="err mt-3">{createError}</p> : null}
        <div className="mt-[1.6rem] flex justify-end">
          <button type="button" className="ob-btn solid" onClick={onCreate} disabled={creating}>
            {creating ? 'Creating account' : 'Create account'}
          </button>
        </div>
      </>
    )
  }

  const approve = async () => {
    const op = prepared ? await act.approve() : null
    if (!prepared) await prepare()
    if (op) void navigate({ to: '/add' })
  }

  return (
    <div className="enter">
      <h1 className="ob-title">{onboardingCopy.approve.title}</h1>
      <p className="ob-body">{onboardingCopy.approve.body}</p>
      {act.error ? <p className="err mt-3">{act.error}</p> : null}
      <div className="mt-[1.6rem] flex flex-wrap items-center justify-between gap-3">
        <button type="button" className="text-[0.88rem] text-stone underline decoration-wash underline-offset-4 hover:text-ink" onClick={() => kit.mutate(owner)} disabled={kit.isPending}>
          {kitSaved ? 'Recovery kit saved' : 'Save recovery kit'}
        </button>
        <button type="button" className="ob-btn solid" onClick={approve} disabled={busy !== null}>
          {busy === 'signing' ? 'Waiting for passkey' : busy === 'preparing' ? 'Preparing' : 'Approve with passkey'}
        </button>
      </div>
    </div>
  )
}

export function Onboarding() {
  const api = useApi()
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const owner = useMutation({
    mutationFn: async () => {
      const passkey = await createOwnerPasskey()
      const created = await api.createOwner({ passkey })
      rememberCredential(created.accountKey, passkey.credentialId)
      return created
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.session }),
  })
  const last = onboardingCopy.screens.length
  const screen = onboardingCopy.screens[step]

  return (
    <div className="fixed inset-0 z-30 grid place-items-center overflow-y-auto bg-[color-mix(in_srgb,var(--color-ink)_42%,transparent)] p-4" role="dialog" aria-modal="true" aria-label="Welcome to Mamoru">
      <div className="w-[min(48rem,100%)] min-[761px]:w-[min(60vw,48rem)]">
        <section className="ob-card rise" aria-live="polite" data-testid={`onboarding-${step + 1}`}>
          <div key={step} className="enter">
            <p className="ob-step">{String(step + 1).padStart(2, '0')} / 03</p>
            {screen ? (
              <>
                <h1 className="ob-title">{screen.title}</h1>
                {screen.body.map((p) => (
                  <p key={p} className="ob-body">
                    {p}
                  </p>
                ))}
                {step === 1 ? <Mix /> : null}
                <div className="mt-[1.6rem] flex flex-wrap justify-end gap-[0.65rem]">
                  <button type="button" className="ob-btn ghost" onClick={() => setStep(last)}>
                    Skip
                  </button>
                  <button type="button" className="ob-btn solid" onClick={() => setStep(step + 1)}>
                    Next
                  </button>
                </div>
              </>
            ) : (
              <Identity
                owner={owner.data ?? null}
                onCreate={() => owner.mutate()}
                creating={owner.isPending}
                createError={owner.error ? errorText(owner.error) : null}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
