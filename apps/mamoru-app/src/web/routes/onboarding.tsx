import type { OwnerResponse } from '@mamoru/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { useApi } from '../api/client.ts'
import { queryKeys, useConfig, useSession } from '../api/queries.ts'
import { HexValue } from '../components/hex.tsx'
import { ScopeContext } from '../components/scope.tsx'
import { ErrorNotice, Skeleton } from '../components/section.tsx'
import { errors, GUIDE_URL } from '../copy/dashboard.ts'
import { downloadJson, kitFilename } from '../lib/download.ts'
import { createOwnerPasskey, PasskeyError } from '../lib/passkey.ts'
import { chainName } from '../lib/provenance.ts'

type Pending = { pending: boolean; error: string | null }

export type OnboardingViewProps = {
  mode: 'production' | 'lab'
  owner: OwnerResponse | null
  kitDownloaded: boolean
  acked: boolean
  createOwner: Pending & { run: () => void }
  downloadKit: Pending & { run: () => void }
  ack: Pending & { run: () => void }
  onFinish: () => void
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="sheet grid gap-[0.55rem] px-[1.1rem] py-4" data-testid={`step-${n}`}>
      <div className="flex items-center justify-between gap-3">
        <strong className="mono-label text-[0.8rem] font-normal">
          {n}. {title}
        </strong>
        <span className="shrink-0 whitespace-nowrap rounded-full border border-wash px-2 py-[0.15rem] font-mono text-[0.7rem] uppercase tracking-[0.06em] text-stone">
          {done ? 'Done' : `Step ${n}`}
        </span>
      </div>
      {children}
    </li>
  )
}

const PERMISSIONS = [
  'Mamoru holds no session on your account. It cannot move, swap or withdraw anything.',
  'Only your owners can change your account. Mamoru cannot add owners or install modules.',
  'Mamoru plans and simulates. It does not sign or send transactions.',
]

export function OnboardingView(p: OnboardingViewProps) {
  const owner = p.owner
  return (
    <ScopeContext.Provider value={{ mode: p.mode, chains: [] }}>
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        <Step n={1} title="Create your owner passkey" done={owner !== null}>
          <p className="m-0 leading-[1.45]">
            Your smart account is owned by a passkey created for it on this device. It is not your login. Mamoru never sees its private key.
          </p>
          {owner === null ? (
            <button type="button" className="btn btn-primary" onClick={p.createOwner.run} disabled={p.createOwner.pending}>
              {p.createOwner.pending ? 'Creating passkey' : 'Create passkey'}
            </button>
          ) : null}
          {p.createOwner.error ? <ErrorNotice message={p.createOwner.error} /> : null}
        </Step>

        <Step n={2} title="Your account on Base" done={owner !== null}>
          {owner === null ? (
            <p className="m-0 text-stone">Your account address appears after you create the passkey.</p>
          ) : (
            <>
              <p className="m-0 leading-[1.45]">
                This is your Safe smart account on {chainName(owner.chainId, [])} · {owner.chainId}. It is counterfactual: the address is fixed,
                and nothing is deployed until you deploy it.
              </p>
              <HexValue hex={owner.address} kind="address" full />
            </>
          )}
        </Step>

        <Step n={3} title="Save your recovery kit" done={p.acked}>
          <p className="m-0 leading-[1.45]">
            The kit has your account address, its setup, modules and owners. It has no secrets. With it and the guide you can leave without
            Mamoru.
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-ghost" onClick={p.downloadKit.run} disabled={owner === null || p.downloadKit.pending}>
              Download recovery kit
            </button>
            <a className="btn btn-ghost" href={GUIDE_URL} target="_blank" rel="noreferrer">
              Open the guide
            </a>
          </div>
          {p.downloadKit.error ? <ErrorNotice message={p.downloadKit.error} /> : null}
          {p.acked ? (
            <p className="m-0 font-mono text-[0.78rem] text-emerald">Backup confirmed.</p>
          ) : (
            <button type="button" className="btn btn-primary" onClick={p.ack.run} disabled={!p.kitDownloaded || p.ack.pending}>
              Confirm I saved the kit
            </button>
          )}
          {p.ack.error ? <ErrorNotice message={p.ack.error} /> : null}
        </Step>

        <Step n={4} title="Conservador and permissions" done={false}>
          <p className="m-0 leading-[1.45]">
            Conservador is the only preset in v1. Its plan is one Uniswap V3 pool on Base: USDC/cbBTC 0.05%. Stables and risk buckets stay idle:
            no executable pool in v1.
          </p>
          <ul className="m-0 grid gap-1 pl-5 text-[0.95rem]">
            {PERMISSIONS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="m-0 font-mono text-[0.78rem] uppercase tracking-[0.04em] text-emerald">Deposits are closed</p>
          <button type="button" className="btn btn-primary" onClick={p.onFinish} disabled={!p.acked}>
            Open dashboard
          </button>
        </Step>
      </ol>
    </ScopeContext.Provider>
  )
}

function message(e: unknown, fallback: string): string {
  return e instanceof PasskeyError ? e.message : e instanceof DOMException && e.name === 'NotAllowedError' ? 'The passkey prompt was closed. Try again.' : fallback
}

function ExistingAccount() {
  return (
    <div className="sheet grid gap-3 px-[1.1rem] py-4" data-testid="existing-account">
      <p className="m-0 leading-[1.45]">
        This browser already has a Mamoru account. Its owner passkey is set, so there is nothing to create here. Your recovery kit is on the
        dashboard, under Leave without Mamoru.
      </p>
      <Link to="/dashboard" className="btn btn-primary">
        Open dashboard
      </Link>
    </div>
  )
}

export function OnboardingPage() {
  const api = useApi()
  const config = useConfig()
  const session = useSession()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [kitDownloaded, setKitDownloaded] = useState(false)

  const owner = useMutation({
    mutationFn: async () => api.createOwner({ passkey: await createOwnerPasskey() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.session }),
  })
  const kit = useMutation({
    mutationFn: async (o: OwnerResponse) => downloadJson(kitFilename(o.address), await api.recoveryKit(o.accountKey)),
    onSuccess: () => setKitDownloaded(true),
  })
  const ack = useMutation({ mutationFn: (o: OwnerResponse) => api.ackRecovery(o.accountKey) })
  const o = owner.data ?? null
  const returning = o === null && session.data?.accountKey !== undefined

  return (
    <main className="flex flex-1 justify-center px-[clamp(1rem,5vw,4rem)] pt-[clamp(1.5rem,5vh,3.5rem)] pb-12">
      <title>Mamoru · Onboarding</title>
      <div className="flex w-full max-w-[34rem] flex-col gap-4">
        <p className="m-0 w-fit rounded-full border border-wash px-3 py-1 font-mono text-[0.7rem] uppercase tracking-[0.06em] text-emerald">
          {config.data?.mode === 'lab' ? 'Verification plane · Base fork' : 'Base · simulation mode'}
        </p>
        <p className="kicker text-[0.75rem] tracking-[0.06em]">
          <Link to="/" className="no-underline">
            Home
          </Link>{' '}
          / Onboarding
        </p>
        <h1 className="m-0 text-[clamp(2rem,5vw,3rem)] font-normal">Four steps.</h1>
        <p className="m-0 leading-[1.45] text-stone">
          Create the passkey that owns your account, see its address on Base, save your recovery kit, then review what Mamoru may do.
        </p>
        {session.isPending ? (
          <Skeleton lines={4} />
        ) : returning ? (
          <ExistingAccount />
        ) : (
          <OnboardingView
            mode={config.data?.mode ?? 'production'}
            owner={o}
            kitDownloaded={kitDownloaded}
            acked={ack.isSuccess}
            createOwner={{
              run: () => owner.mutate(),
              pending: owner.isPending,
              error: owner.error ? message(owner.error, "Mamoru's API did not create your account. Try again.") : null,
            }}
            downloadKit={{ run: () => o && kit.mutate(o), pending: kit.isPending, error: kit.error ? errors.kit : null }}
            ack={{ run: () => o && ack.mutate(o), pending: ack.isPending, error: ack.error ? "Mamoru's API did not record your backup. Try again." : null }}
            onFinish={() => navigate({ to: '/dashboard' })}
          />
        )}
      </div>
    </main>
  )
}
