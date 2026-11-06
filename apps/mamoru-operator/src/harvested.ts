// otto/mamoru#107 (spec 012 HRV-R1, R2): volatile the engine's own harvests collected and has not sold yet, per token.
// Derived at every review from the account's stored ops (accounts.json), not kept as a separate counter: it survives a
// restart with the ops themselves, and a review never sees a counter out of step with the history it came from.
//
// Walking the confirmed ops in block order:
// - a harvest adds the non-savings side of each fee its receipt collected (yield-receipts.ts facts), from that op's time;
// - any engine op that spends the token by `tokenIn`/`amountIn` (a harvest sale is an enter_swap; any other swap too)
//   takes its amount off, harvested first;
// - an op that mints or adds liquidity in a pool with the token (an entry, an increase, a re-range) may have used it in
//   amounts no stored field gives: the token's harvested-unsold goes to 0, so a later sale can never reach principal.
// - any owner op (a Stop, a withdrawal, a renewal) clears everything: what it moved out is not in a stored field, and
//   only the owner's signature can move tokens out of the Safe besides the engine's own ops.
// A confirmed harvest whose receipt is not read yet, or a confirmed op whose block is not recorded yet, makes the whole
// result unknown (null): no sale until it is. An operator serves one chain, so `ops` are all of this chain.
import type { Registry, RegistryName } from '@mamoru/registry'
import type { StoredOp } from './state.ts'

export type Harvested = Partial<Record<RegistryName, { amount: bigint; since: number }>>

const SAVINGS = 'USDC'
const MINTS = new Set(['enter_mint', 'increase_liquidity', 'rerange'])

export function harvestedOf(ops: readonly StoredOp[], registry: Registry): Harvested | null {
  const tokensOf = (pool: string | undefined): string[] => {
    const e = pool ? registry.entries.find((x) => x.name === pool) : undefined
    return e?.token0 && e.token1 ? [e.token0, e.token1] : []
  }
  // migrate-v4 step 1 acts on the account's Safe on another chain and is confirmed without a block here: not this Safe.
  const confirmed = ops.filter((o) => (o.opId.startsWith('eng-') || o.opId.startsWith('own-')) && o.state === 'confirmed' && !(o.kind === 'migrate-v4' && o.migrateStep === 1))
  if (confirmed.some((o) => o.block === undefined)) return null
  confirmed.sort((a, b) => a.block! - b.block!)
  const out = new Map<string, { amount: bigint; since: number }>()
  for (const op of confirmed) {
    if (op.opId.startsWith('own-')) {
      out.clear()
      continue
    }
    if (op.step === 'harvest') {
      if (!op.facts) return null
      const t = Math.floor(Date.parse(op.facts.at) / 1000)
      for (const f of op.facts.fees) {
        const [t0, t1] = tokensOf(f.pool)
        for (const [token, amt] of [[t0, BigInt(f.fee0)], [t1, BigInt(f.fee1)]] as const) {
          if (!token || token === SAVINGS || amt <= 0n) continue
          const cur = out.get(token)
          out.set(token, { amount: (cur?.amount ?? 0n) + amt, since: cur && cur.amount > 0n ? cur.since : t })
        }
      }
      continue
    }
    if (op.tokenIn && op.amountIn) {
      const cur = out.get(op.tokenIn)
      if (cur) {
        const left = cur.amount - BigInt(op.amountIn)
        if (left > 0n) out.set(op.tokenIn, { ...cur, amount: left })
        else out.delete(op.tokenIn)
      }
      continue
    }
    if (op.step && MINTS.has(op.step)) for (const token of tokensOf(op.pool)) out.delete(token)
  }
  return Object.fromEntries(out) as Harvested
}
