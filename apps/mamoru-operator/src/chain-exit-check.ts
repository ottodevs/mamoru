#!/usr/bin/env bun
// otto/mamoru#427: read-only check before and after a chain exit. For each Monad Safe given, what the exit would take out
// and sell, at the block read: every WMON/USDC position (id, liquidity, value), the idle WMON and its value, the USDC
// already there, and the USDC expected once the exit is done (the WMON sold at the pool price, less the 0.30 % pool fee;
// price impact not counted). Signs nothing and sends nothing.
//   MAMORU_MONAD_RPC_URL=<url> bun apps/mamoru-operator/src/chain-exit-check.ts <safe> [<safe> ...]
import { createPublicClient, getAddress, http } from 'viem'
import { monadRegistry } from '@mamoru/registry'
import type { Address } from '@mamoru/domain'
import { inUsdc, positionUsdc, readSafe, type SafeRead } from './chain.ts'

const POOL = 'pool:WMON/USDC/3000'
const FEE_BPS = 30n

export type ExitRow = { safe: Address; block: bigint; positions: { tokenId: bigint; liquidity: bigint; usdc: bigint }[]; wmon: bigint; wmonUsdc: bigint; usdc: bigint; expectedUsdc: bigint }

/** What the exit would leave on `safe`, from one read of it. Pure: the read is all it uses. */
export function exitRow(safe: Address, r: SafeRead): ExitRow {
  const price = r.prices[POOL]
  const positions = r.positions.filter((p) => p.pool === POOL).map((p) => ({ tokenId: p.tokenId, liquidity: p.liquidity, usdc: price ? positionUsdc(p, price.sqrtPriceX96, monadRegistry) : 0n }))
  const wmon = r.tokens.WMON ?? 0n
  // WMON the positions hold, valued alone, so it is sold too: their value less the USDC side.
  const fromPositions = r.positions.filter((p) => p.pool === POOL).reduce((s, p) => s + (p.token0 === 'WMON' ? p.amount0 + p.tokensOwed0 : p.amount1 + p.tokensOwed1), 0n)
  const usdcInPositions = r.positions.filter((p) => p.pool === POOL).reduce((s, p) => s + (p.token0 === 'USDC' ? p.amount0 + p.tokensOwed0 : p.amount1 + p.tokensOwed1), 0n)
  const toSell = wmon + fromPositions
  const sold = price ? inUsdc(POOL, 'WMON', toSell, price.sqrtPriceX96, monadRegistry) : 0n
  const wmonUsdc = price ? inUsdc(POOL, 'WMON', wmon, price.sqrtPriceX96, monadRegistry) : 0n
  return { safe, block: r.block, positions, wmon, wmonUsdc, usdc: r.usdc, expectedUsdc: r.usdc + usdcInPositions + (sold * (10_000n - FEE_BPS)) / 10_000n }
}

const usd = (raw: bigint) => (Number(raw) / 1e6).toFixed(2)

if (import.meta.main) {
  const url = process.env.MAMORU_MONAD_RPC_URL
  const safes = process.argv.slice(2)
  if (!url || !safes.length) {
    console.error('usage: MAMORU_MONAD_RPC_URL=<url> bun apps/mamoru-operator/src/chain-exit-check.ts <safe> [<safe> ...]')
    process.exit(2)
  }
  const client = createPublicClient({ transport: http(url) })
  let total = 0n
  for (const s of safes) {
    const safe = getAddress(s) as Address
    const row = exitRow(safe, await readSafe(client as never, safe, monadRegistry))
    total += row.expectedUsdc
    const pos = row.positions.map((p) => `#${p.tokenId} L=${p.liquidity} $${usd(p.usdc)}`).join(', ') || 'none'
    console.log(`${safe} block ${row.block}: positions ${pos}; WMON ${row.wmon} ($${usd(row.wmonUsdc)}); USDC $${usd(row.usdc)}; expected after exit $${usd(row.expectedUsdc)}`)
  }
  console.log(`total expected USDC after exit: $${usd(total)} over ${safes.length} Safe(s)`)
}
