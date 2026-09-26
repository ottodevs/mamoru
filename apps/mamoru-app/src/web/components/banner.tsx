import { PRODUCTION_BANNER, type DashboardPayload } from '@mamoru/domain'

// Fixed on top and not closable (dashboard.md §4). Until the API answers, production copy is shown:
// production always runs in simulation mode.
export function Banner({ banner }: { banner: DashboardPayload['banner'] | undefined }) {
  const text = banner?.text ?? PRODUCTION_BANNER
  const lab = banner?.kind === 'lab'
  return (
    <div
      role="status"
      data-testid="banner"
      className={`sticky top-0 z-20 w-full border-b px-4 py-2 text-center font-mono text-[0.72rem] tracking-[0.05em] ${
        lab ? 'border-ink bg-ink text-rice' : 'border-emerald/40 bg-[color-mix(in_srgb,var(--color-emerald)_12%,var(--color-rice))] text-emerald'
      }`}
    >
      {text}
    </div>
  )
}
