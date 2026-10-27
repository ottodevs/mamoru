import { describe, expect, test } from 'bun:test'
import { decodeFunctionData } from 'viem'
import { CONVERT_SLIPPAGE_BPS, convertCall, convertMinOut, L1_USDC, L1_WETH, ORACLE_MAX_AGE_SEC, SWAP_ROUTER_02, swapRouter02Abi, usdcInto, WETH_USDC_FEE } from '../src/bridge-out.ts'
import { HttpError } from '../src/operator.ts'

const SAFE = '0xAF3F151b0B19f556c2f97C6225a1fd22Cb9f703D' as const
const ETH = 55_378_350_000_000_000n
const NOW = 1_793_087_740
// Chainlink 27 Oct 2026: 2,317.63156367 USD per ETH (8 decimals).
const oracle = { answer: 231_763_156_367n, updatedAt: BigInt(NOW - 300) }
const code = (f: () => unknown) => {
  try {
    f()
    return 'ok'
  } catch (e) {
    return e instanceof HttpError ? e.code : 'unexpected'
  }
}

describe('ETH conversion on Ethereum (#211)', () => {
  test('the minimum is the quote less the slippage when the quote agrees with Chainlink', () => {
    const quoted = 128_145_513n
    expect(convertMinOut(ETH, quoted, oracle, NOW)).toBe((quoted * (10_000n - CONVERT_SLIPPAGE_BPS)) / 10_000n)
  })

  test('a quote more than 1% from Chainlink, a stale or non-positive answer is refused', () => {
    const fair = (ETH * oracle.answer) / 10n ** 20n
    expect(code(() => convertMinOut(ETH, (fair * 98n) / 100n, oracle, NOW))).toBe('CONVERT_PRICE_UNAVAILABLE')
    expect(code(() => convertMinOut(ETH, (fair * 102n) / 100n, oracle, NOW))).toBe('CONVERT_PRICE_UNAVAILABLE')
    expect(code(() => convertMinOut(ETH, fair, { ...oracle, updatedAt: BigInt(NOW - ORACLE_MAX_AGE_SEC - 1) }, NOW))).toBe('CONVERT_PRICE_UNAVAILABLE')
    expect(code(() => convertMinOut(ETH, fair, { ...oracle, answer: 0n }, NOW))).toBe('CONVERT_PRICE_UNAVAILABLE')
    expect(code(() => convertMinOut(ETH, (fair * 1005n) / 1000n, oracle, NOW))).toBe('ok')
  })

  test('the call swaps exactly the ETH sent, to the account itself, with the minimum and the deadline', () => {
    const c = convertCall(SAFE, ETH, 127_000_000n, NOW + 900)
    expect(c.to).toBe(SWAP_ROUTER_02)
    expect(c.value).toBe(ETH)
    const outer = decodeFunctionData({ abi: swapRouter02Abi, data: c.data })
    expect(outer.functionName).toBe('multicall')
    const [deadline, inner] = outer.args as [bigint, `0x${string}`[]]
    expect(deadline).toBe(BigInt(NOW + 900))
    expect(inner.length).toBe(1)
    const swap = decodeFunctionData({ abi: swapRouter02Abi, data: inner[0]! })
    expect(swap.functionName).toBe('exactInputSingle')
    expect(swap.args![0]).toEqual({ tokenIn: L1_WETH, tokenOut: L1_USDC, fee: WETH_USDC_FEE, recipient: SAFE, amountIn: ETH, amountOutMinimum: 127_000_000n, sqrtPriceLimitX96: 0n })
  })

  test('only native USDC transfers into the account count', () => {
    const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`
    const log = (token: string, to: string, v: bigint) => ({ address: token, topics: [topic, word('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'), word(to)], data: `0x${v.toString(16).padStart(64, '0')}` }) as never
    const r = { logs: [log(L1_USDC, SAFE, 100n), log(L1_WETH, SAFE, 7n), log(L1_USDC, '0x0000000000000000000000000000000000000001', 9n), log(L1_USDC, SAFE, 5n)] }
    expect(usdcInto(r, SAFE)).toBe(105n)
  })
})
