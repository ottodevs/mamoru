import type { DashboardPayload } from '@mamoru/domain'
import { FigureValue, ProvenanceChip } from '../components/figure.tsx'
import { HexValue } from '../components/hex.tsx'
import { header, indexStatusText, NOT_OBSERVED } from '../copy/dashboard.ts'
import { formatUnits } from '../lib/format.ts'

export function HeaderPanel({ data }: { data: DashboardPayload }) {
  const { account, sources, chains, mode } = data
  const total = account.totalValue
  return (
    <section id="account" aria-labelledby="account-title" className="mb-8">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <p className="kicker text-[0.86rem] font-bold tracking-[0.14em] text-ink" id="account-title">
            Total value, estimate
          </p>
          {total.value === null ? (
            <p className="mt-1 mb-0 text-[clamp(2.2rem,6vw,3.4rem)] leading-none text-stone" data-testid="not-observed">
              {NOT_OBSERVED}
            </p>
          ) : (
            <p className="mt-1 mb-0 text-[clamp(3.4rem,9vw,5.4rem)] leading-none tracking-[-0.02em] text-emerald tabular-nums">
              {formatUnits(total.value, total.unit)}
              <span className="ml-[0.2em] text-[0.32em] tracking-[0.12em] text-stone">{total.unit ?? 'USDC'}</span>
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ProvenanceChip provenance={total.provenance} />
            {account.totalMissing.length > 0 ? (
              <span className="text-[0.88rem] text-stone">Missing: {account.totalMissing.join(', ')}</span>
            ) : null}
          </div>
        </div>
        <ul className="m-0 flex list-none flex-wrap gap-3 self-center p-0">
          {chains.map((c) => (
            <li key={c.chainId} className="flex min-w-[8.5rem] flex-col gap-1 border border-emerald bg-[color-mix(in_srgb,var(--color-emerald)_10%,var(--color-paper))] px-4 py-3">
              <span className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-emerald">Chain</span>
              <strong className="text-[1.4rem] font-medium leading-none text-emerald">
                {c.name} · {c.chainId}
              </strong>
            </li>
          ))}
          <li className="flex min-w-[8.5rem] flex-col gap-1 border border-emerald bg-[color-mix(in_srgb,var(--color-emerald)_10%,var(--color-paper))] px-4 py-3">
            <span className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-emerald">Preset</span>
            <strong className="text-[1.4rem] font-medium leading-none text-emerald">Conservador</strong>
            <span className="font-mono text-[0.66rem] text-stone">Policy {account.policyVersion}</span>
          </li>
        </ul>
      </div>
      <p className="mt-2 mb-0 text-[0.85rem] text-stone">{header.otherChains}</p>

      <dl className="mt-5 mb-0 grid gap-0">
        <div className="grid gap-1 border-t border-wash py-2 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-[0.92rem] text-stone">Smart account</dt>
          <dd className="m-0 grid gap-1">
            {account.address.value === null ? (
              <FigureValue figure={account.address} />
            ) : (
              <span className="inline-flex flex-wrap items-baseline gap-2">
                <HexValue hex={account.address.value} kind="address" full />
                <ProvenanceChip provenance={account.address.provenance} />
              </span>
            )}
          </dd>
        </div>
        <div className="grid gap-1 border-t border-wash py-2 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-[0.92rem] text-stone">Status</dt>
          <dd className="m-0">
            <FigureValue figure={account.deployed} format={(v) => (v ? header.deployed : header.notDeployed)} />
          </dd>
        </div>
        <div className="grid gap-1 border-t border-wash py-2 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-[0.92rem] text-stone">Base RPC</dt>
          <dd className="m-0 text-[0.95rem]">
            {sources.rpc.status === 'ok' && sources.rpc.block !== undefined ? (
              <span>
                Last block observed {sources.rpc.block}
                {sources.rpc.safeBlock !== undefined ? `, safe ${sources.rpc.safeBlock}` : ''}
              </span>
            ) : (
              <span className="text-alert-ink">{header.rpcDown}</span>
            )}
          </dd>
        </div>
        <div className="grid gap-1 border-t border-wash py-2 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-[0.92rem] text-stone">Index</dt>
          <dd className="m-0 text-[0.95rem]">
            {indexStatusText(sources.index, mode)}
            {sources.index.code ? <code className="code ml-2">{sources.index.code}</code> : null}
          </dd>
        </div>
      </dl>
    </section>
  )
}
