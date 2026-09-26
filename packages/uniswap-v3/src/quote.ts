import { decodeFunctionResult, encodeFunctionData, parseAbi, type PublicClient } from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import { address } from '@mamoru/registry'

export const quoterV2Abi = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

export type QuoteRequest = { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; blockNumber: bigint }

/** FR-UNI-001: QuoterV2.quoteExactInputSingle at the block of the operation, as an eth_call. */
export async function quoteExactInputSingle(client: PublicClient, q: QuoteRequest): Promise<bigint> {
  const data = encodeFunctionData({
    abi: quoterV2Abi,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, fee: q.fee, sqrtPriceLimitX96: 0n }],
  })
  let raw
  try {
    raw = await client.call({ to: address('QuoterV2'), data, blockNumber: q.blockNumber })
  } catch (e) {
    throw new ReasonError('EHG_QUOTE_UNAVAILABLE', (e as Error).message.split('\n')[0])
  }
  if (!raw.data) throw new ReasonError('EHG_QUOTE_UNAVAILABLE', 'empty QuoterV2 answer')
  const [amountOut] = decodeFunctionResult({ abi: quoterV2Abi, functionName: 'quoteExactInputSingle', data: raw.data })
  return amountOut
}

/** FR-UNI-002: the minimum out from a fresh quote and the policy tolerance. Never zero. */
export function minOut(quote: bigint, slippageBps: number): bigint {
  const min = (quote * BigInt(10_000 - slippageBps)) / 10_000n
  if (min <= 0n) throw new ReasonError('EHG_QUOTE_UNAVAILABLE', `quote ${quote} leaves no positive minimum`)
  return min
}

const Q96 = 1n << 96n
const Q192 = 1n << 192n
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_TICK = 887272

// Uniswap V3 TickMath, bit by bit.
const TICK_FACTORS: readonly [bigint, bigint][] = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
]

export function sqrtRatioAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick))
  if (abs > BigInt(MAX_TICK)) throw new Error(`tick ${tick} out of bounds`)
  let ratio = (abs & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n
  for (const [bit, factor] of TICK_FACTORS) if ((abs & bit) !== 0n) ratio = (ratio * factor) >> 128n
  if (tick > 0) ratio = MAX_UINT256 / ratio
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}

function liquidity0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  return (amount0 * ((sqrtA * sqrtB) / Q96)) / (sqrtB - sqrtA)
}

function liquidity1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  return (amount1 * Q96) / (sqrtB - sqrtA)
}

function amount0Of(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return ((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB / sqrtA
}

function amount1Of(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return (liquidity * (sqrtB - sqrtA)) / Q96
}

export type MintQuote = { liquidity: bigint; amount0: bigint; amount1: bigint; amount0Min: bigint; amount1Min: bigint }

/**
 * FR-UNI-003: what a mint at the current price will take from each token,
 * and minimums from those amounts and the policy tolerance.
 */
export function quoteMint(p: {
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
  slippageBps: number
}): MintQuote {
  const a = sqrtRatioAtTick(p.tickLower)
  const b = sqrtRatioAtTick(p.tickUpper)
  const s = p.sqrtPriceX96
  let liquidity: bigint
  let amount0 = 0n
  let amount1 = 0n
  if (s <= a) {
    liquidity = liquidity0(a, b, p.amount0Desired)
    amount0 = amount0Of(a, b, liquidity)
  } else if (s < b) {
    const l0 = liquidity0(s, b, p.amount0Desired)
    const l1 = liquidity1(a, s, p.amount1Desired)
    liquidity = l0 < l1 ? l0 : l1
    amount0 = amount0Of(s, b, liquidity)
    amount1 = amount1Of(a, s, liquidity)
  } else {
    liquidity = liquidity1(a, b, p.amount1Desired)
    amount1 = amount1Of(a, b, liquidity)
  }
  const keep = BigInt(10_000 - p.slippageBps)
  const amount0Min = (amount0 * keep) / 10_000n
  const amount1Min = (amount1 * keep) / 10_000n
  if (liquidity <= 0n || amount0Min <= 0n || amount1Min <= 0n) {
    throw new ReasonError('EHG_QUOTE_UNAVAILABLE', 'the mint leaves a zero minimum on one side')
  }
  return { liquidity, amount0, amount1, amount0Min, amount1Min }
}

/** Raw units of token0 worth `amount1` raw units of token1 at `sqrtPriceX96`. */
export function token1InToken0(amount1: bigint, sqrtPriceX96: bigint): bigint {
  return (amount1 * Q192) / (sqrtPriceX96 * sqrtPriceX96)
}

/** Raw units of token1 worth `amount0` raw units of token0 at `sqrtPriceX96`. */
export function token0InToken1(amount0: bigint, sqrtPriceX96: bigint): bigint {
  return (amount0 * sqrtPriceX96 * sqrtPriceX96) / Q192
}

/** Ticks of a range of `widthTicks` centred on `tick`, on the pool spacing. */
export function rangeAround(tick: number, widthTicks: number, spacing: number): { tickLower: number; tickUpper: number } {
  const half = Math.floor(widthTicks / 2 / spacing) * spacing
  const base = Math.floor(tick / spacing) * spacing
  return { tickLower: base - half, tickUpper: base + half + spacing }
}
