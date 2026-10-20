import { describe, expect, test } from 'bun:test'
import { netOutput, valueCostInAsset } from './pricing.ts'
import type { Quote } from './types.ts'

const BASE: Omit<Quote, 'provider' | 'route' | 'sourceChainId' | 'asset' | 'amountIn' | 'amountOut' | 'value'> = {
  destChainId: 8453,
  fee: 0n,
  etaSec: 10,
  target: '0x2222222222222222222222222222222222222222',
  recipientCheck: 'none',
  mode: 'owner-only',
  expiresAt: new Date(0).toISOString(),
}

function usdcQuote(sourceChainId: number, amountIn: bigint, amountOut: bigint, value?: bigint): Quote {
  return { ...BASE, provider: 'x', route: 'x', sourceChainId, asset: 'USDC', amountIn, amountOut, value }
}

function ethQuote(sourceChainId: number, amountIn: bigint, amountOut: bigint, value?: bigint): Quote {
  return { ...BASE, provider: 'x', route: 'x', sourceChainId, asset: 'ETH', amountIn, amountOut, value }
}

describe('valueCostInAsset', () => {
  test('zero or absent value costs exactly 0, on any chain, for any asset', () => {
    expect(valueCostInAsset(usdcQuote(1, 150_000_000n, 150_000_000n, 0n))).toBe(0n)
    expect(valueCostInAsset(usdcQuote(143, 150_000_000n, 150_000_000n))).toBe(0n) // value omitted entirely
  })

  // otto/mamoru#181, review round 3: `value` is not always pure cost. When the bridged asset is the source
  // chain's native asset, the principal itself must leave the account as `value` (canonical.ts's ETH bridge) —
  // only the excess over `amountIn` is a real extra cost.

  test('bridging ETH on an ETH-native chain, value == amountIn exactly (canonical.ts): the cost is zero, not the whole value', () => {
    const q = ethQuote(1, 10_000_000_000_000_000n, 10_000_000_000_000_000n, 10_000_000_000_000_000n) // value == amountIn
    expect(valueCostInAsset(q)).toBe(0n)
  })

  test('bridging ETH where value is amountIn PLUS a real fee on top: only the excess counts as cost', () => {
    // 0.01 ETH principal + 0.00013 ETH top-up as value — the kind of figure deBridge's ETH-input orders attach.
    const q = ethQuote(1, 10_000_000_000_000_000n, 9_985_000_000_000_000n, 10_130_000_000_000_000n)
    expect(valueCostInAsset(q)).toBe(130_000_000_000_000n) // 10_130_000_000_000_000 - 10_000_000_000_000_000
  })

  test('bridging USDC while paying an ETH-denominated value: the entire value is extra (principal moves as an ERC20 transfer, not value), converted at the stated conservative price', () => {
    const q = usdcQuote(1, 150_000_000n, 149_880_026n, 1_000_000_000_000_000n) // 0.001 ETH, Ethereum source
    // $5,000/ETH stated price: 0.001 ETH = $5.00 = 5_000_000 in USDC's 6-decimal base units.
    expect(valueCostInAsset(q)).toBe(5_000_000n)
  })

  test('a nonzero value on a chain with no stated native-asset price (Monad/MON) cannot be priced: null, never zero', () => {
    const q = usdcQuote(143, 150_000_000n, 150_000_000n, 2_000_000_000_000_000_000n) // 2 MON
    expect(valueCostInAsset(q)).toBeNull()
  })

  test('an unknown source chain altogether cannot be priced either', () => {
    const q = usdcQuote(999_999, 150_000_000n, 150_000_000n, 1n)
    expect(valueCostInAsset(q)).toBeNull()
  })
})

describe('netOutput', () => {
  test('equals amountOut when there is no native cost', () => {
    expect(netOutput(usdcQuote(1, 150_000_000n, 149_880_026n))).toBe(149_880_026n)
  })

  test('subtracts the priced native cost from amountOut', () => {
    const q = usdcQuote(1, 150_000_000n, 149_880_026n, 1_000_000_000_000_000n) // costs $5.00 at the stated price
    expect(netOutput(q)).toBe(149_880_026n - 5_000_000n)
  })

  test('does not subtract a value that is exactly the principal (canonical.ts), not a real cost', () => {
    const q = ethQuote(1, 10_000_000_000_000_000n, 10_000_000_000_000_000n, 10_000_000_000_000_000n)
    expect(netOutput(q)).toBe(10_000_000_000_000_000n)
  })

  test('propagates null — never substitutes zero — when the cost cannot be priced', () => {
    expect(netOutput(usdcQuote(143, 150_000_000n, 150_000_000n, 2_000_000_000_000_000_000n))).toBeNull()
  })
})
