import { describe, expect, test } from 'bun:test'
import type { Provenance } from '@mamoru/domain'
import { formatAmount, formatBps, formatFraction, formatUnits, formatUtcTime } from '../../src/web/lib/format.ts'
import { chainName, chipFor } from '../../src/web/lib/provenance.ts'

const base = { chainId: 8453, observedAt: '2026-09-26T18:20:00.000Z', status: 'fresh' } as const
const prod = { mode: 'production' as const, chains: [{ chainId: 8453, name: 'Base' as const, observed: true as const }] }
const lab = { mode: 'lab' as const, chains: [{ chainId: 31337, name: 'Base fork' as const, observed: true as const }] }

describe('amounts use registry decimals', () => {
  test('USDC 6, cbBTC 8, ETH 18', () => {
    expect(formatUnits('16800000000', 'USDC')).toBe('16,800')
    expect(formatUnits('38190331', 'cbBTC')).toBe('0.38190331')
    expect(formatUnits('2400000000000000000', 'ETH')).toBe('2.4')
    expect(formatAmount('0', 'USDC')).toBe('0 USDC')
  })
  test('truncates and keeps sign', () => {
    expect(formatUnits('1234567', 'USDC')).toBe('1.23')
    expect(formatUnits('-12480221003', 'USDC')).toBe('-12,480.22')
  })
  test('rejects non-integer amounts', () => {
    expect(() => formatUnits('1.5', 'USDC')).toThrow()
  })
  test('percentages and time', () => {
    expect(formatBps(5000)).toBe('50%')
    expect(formatFraction('0.834')).toBe('83.4%')
    expect(formatUtcTime('2026-09-26T08:05:00.000Z')).toBe('08:05 UTC')
  })
})

describe('provenance chips, dashboard.md §5', () => {
  test('chain names', () => {
    expect(chainName(8453, [])).toBe('Base')
    expect(chainName(31338, [])).toBe('Base fork')
  })
  test('production cases', () => {
    const rpc: Provenance = { ...base, source: 'chain_rpc', blockNumber: 100 }
    expect(chipFor(rpc, prod).label).toBe('Base · block 100')
    expect(chipFor({ ...rpc, source: 'multibaas', check: 'reconciled', checkedAt: 120 }, prod).label).toBe('MultiBaas · Base · checked at block 120')
    expect(chipFor({ ...rpc, detail: 'PROJ_SOURCE_FALLBACK_RPC', cause: 'MB_INDEX_LAGGING' }, prod).label).toBe('Base RPC logs · block 100 · MultiBaas behind')
    expect(chipFor({ ...rpc, detail: 'PROJ_SOURCE_FALLBACK_RPC' }, prod).label).toBe('Base RPC logs · block 100')
    expect(chipFor({ ...rpc, check: 'mismatch' }, prod).label).toBe('Base · block 100 · MultiBaas disagreed')
    expect(chipFor({ ...base, source: 'journal' }, prod).label).toBe('Mamoru journal · Base')
    expect(chipFor({ ...base, source: 'd1' }, prod).label).toBe('Mamoru database · Base')
    expect(chipFor({ ...base, source: 'estimate', blockNumber: 100 }, prod).label).toBe('Estimate · Base · block 100')
  })
  test('verification plane cases', () => {
    const fork: Provenance = { ...base, chainId: 31337, source: 'fork_rpc', blockNumber: 7 }
    expect(chipFor(fork, lab).label).toBe('Base fork · block 7')
    expect(chipFor({ ...fork, check: 'reconciled', checkedAt: 9 }, lab).label).toBe('Fork index · Base fork · checked at block 9')
    expect(chipFor({ ...fork, check: 'mismatch' }, lab).label).toBe('Base fork · block 7 · Fork index disagreed')
  })
  test('stale adds the update time', () => {
    expect(chipFor({ ...base, source: 'journal', status: 'stale' }, prod).stale).toBe('Stale · updated 18:20 UTC')
  })
})
