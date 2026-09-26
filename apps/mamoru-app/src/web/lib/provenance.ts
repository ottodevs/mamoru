import type { ChainRef, DashboardPayload, Provenance, ReasonCode } from '@mamoru/domain'
import { formatUtcTime } from './format.ts'

export type ViewScope = { mode: DashboardPayload['mode']; chains: ChainRef[] }

// dashboard.md §5: the chip names the chain from `chains`; fork ids fall back to "Base fork".
export function chainName(chainId: number, chains: ChainRef[]): string {
  const known = chains.find((c) => c.chainId === chainId)
  if (known) return known.name
  if (chainId === 8453) return 'Base'
  if (chainId === 31337 || chainId === 31338) return 'Base fork'
  return `Chain ${chainId}`
}

const CAUSE_NOTES: Partial<Record<ReasonCode, string>> = {
  MB_INDEX_LAGGING: 'MultiBaas behind',
  MB_QUERY_FAILED: 'MultiBaas query failed',
  MB_BEFORE_START_BLOCK: 'before MultiBaas start',
  MB_BASE_INDEXING_ABSENT: 'MultiBaas not indexing Base',
}

export type Chip = { label: string; stale?: string }

function withBlock(parts: string[], block: number | undefined): string[] {
  return block === undefined ? parts : [...parts, `block ${block}`]
}

export function chipFor(p: Provenance, scope: ViewScope): Chip {
  const chain = chainName(p.chainId, scope.chains)
  const indexName = scope.mode === 'lab' ? 'Fork index' : 'MultiBaas'
  let parts: string[]
  if (p.check === 'reconciled') {
    parts = [indexName, chain, ...(p.checkedAt === undefined ? [] : [`checked at block ${p.checkedAt}`])]
  } else if (p.check === 'mismatch') {
    parts = [...withBlock([chain], p.blockNumber), `${indexName} disagreed`]
  } else if (p.detail === 'PROJ_SOURCE_FALLBACK_RPC') {
    const note = p.cause ? CAUSE_NOTES[p.cause] : undefined
    parts = [...withBlock([`${chain} RPC logs`], p.blockNumber), ...(note ? [note] : [])]
  } else {
    switch (p.source) {
      case 'chain_rpc':
      case 'fork_rpc':
      case 'multibaas':
        parts = withBlock([chain], p.blockNumber)
        break
      case 'journal':
        parts = ['Mamoru journal', chain]
        break
      case 'd1':
        parts = ['Mamoru database', chain]
        break
      case 'estimate':
        parts = withBlock(['Estimate', chain], p.blockNumber)
        break
    }
  }
  const chip: Chip = { label: parts.join(' · ') }
  if (p.status === 'stale') chip.stale = `Stale · updated ${formatUtcTime(p.observedAt)}`
  return chip
}
