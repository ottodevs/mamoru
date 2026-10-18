#!/usr/bin/env bun
// otto/mamoru#181. Live, read-only smoke run: quotes every adapter against the real public APIs (CCTP, Across,
// Relay, LI.FI, deBridge; the canonical Base adapter needs no network) for one representative request per
// direction class, and prints the selector's pick. No signing, no transactions, no keys — this never writes
// anything on-chain or to any provider.
//
// Run: bun run --cwd packages/routing smoke:live   (or: bun packages/routing/test/smoke-live.ts)
import { ALL_ADAPTERS, quoteAll, rank, type QuoteRequest } from '../src/index.ts'

// Not 0x1111...1111 or 0x2222...2222: deBridge's and LI.FI's compliance screens flag both of those repeated-digit
// addresses (confirmed live 18 Oct 2026 — deBridge: COMPLIANCE_ADDRESS_BLOCKED; LI.FI: a misleadingly worded
// "Zero address is provided" 400). 0x4444...4444 is clean for every provider this script calls.
const ACCOUNT = '0x4444444444444444444444444444444444444444' as const

const REQUESTS: { label: string; req: QuoteRequest }[] = [
  { label: 'L1 -> L2: Ethereum -> Base, 150 USDC', req: { sourceChainId: 1, destChainId: 8453, asset: 'USDC', amountIn: 150_000_000n, account: ACCOUNT } },
  { label: 'L2 -> L1: Base -> Ethereum, 150 USDC', req: { sourceChainId: 8453, destChainId: 1, asset: 'USDC', amountIn: 150_000_000n, account: ACCOUNT } },
  { label: 'L2 -> L2: Base -> Monad, 150 USDC', req: { sourceChainId: 8453, destChainId: 143, asset: 'USDC', amountIn: 150_000_000n, account: ACCOUNT } },
  { label: 'L1 -> L2: Ethereum -> Base, 0.01 ETH', req: { sourceChainId: 1, destChainId: 8453, asset: 'ETH', amountIn: 10_000_000_000_000_000n, account: ACCOUNT } },
]

function fmt(asset: 'USDC' | 'ETH', raw: bigint): string {
  const decimals = asset === 'USDC' ? 6 : 18
  const s = raw.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, -decimals) || '0'
  const frac = s.slice(-decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

let anyQuoted = false
for (const { label, req } of REQUESTS) {
  console.log(`\n=== ${label} ===`)
  const run = await quoteAll(req, ALL_ADAPTERS)
  if (run.quotes.length > 0) anyQuoted = true
  for (const q of rank(run.quotes)) {
    console.log(`  ${q.provider.padEnd(14)} out=${fmt(req.asset, q.amountOut).padEnd(14)} fee=${fmt(req.asset, q.fee).padEnd(12)} eta=${String(q.etaSec).padEnd(7)}s mode=${q.mode.padEnd(11)} check=${q.recipientCheck}`)
  }
  for (const f of run.failures) console.log(`  ${f.provider.padEnd(14)} refused: [${f.code}] ${f.message}`)
  if (run.quotes.length === 0) console.log('  (no adapter quoted this direction)')
}

if (!anyQuoted) {
  console.error('\nno adapter returned a single quote across every direction — treat this run as a network/API failure, not a result')
  process.exit(1)
}
