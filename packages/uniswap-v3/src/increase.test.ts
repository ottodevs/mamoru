import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, erc20Abi, getAddress, toFunctionSelector, type PublicClient } from 'viem'
import { address, baseRegistry, mamoruActionPolicyV2Abi, monadRegistry, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import { approveTo, policyIncrease, uniswapV3 } from './index.ts'
import { quoteExactInputSingleWithLimit, quoterV2Abi } from './quote.ts'

const POLICY = getAddress('0x00000000000000000000000000000000000fa11c')

describe('policyIncrease (otto/mamoru#171)', () => {
  const p = { tokenId: 7n, amount0Desired: 10n, amount1Desired: 20n, amount0Min: 1n, amount1Min: 2n, deadline: 99n }

  test('calls MamoruActionPolicyV2.increase at the given address, never the position manager', () => {
    const c = policyIncrease(POLICY, p)
    expect(c.to).toBe(POLICY)
    expect(c.to).not.toBe(address('NonfungiblePositionManager', baseRegistry))
    expect(c.data.slice(0, 10)).toBe(toFunctionSelector('function increase((uint256,uint256,uint256,uint256,uint256,uint256))'))
    // Not the manager's increaseLiquidity selector: the same struct under another name.
    expect(c.data.slice(0, 10)).not.toBe(toFunctionSelector('function increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))'))
    const d = decodeFunctionData({ abi: mamoruActionPolicyV2Abi, data: c.data })
    expect(d.functionName).toBe('increase')
    expect(d.args[0]).toEqual(p)
    expect(() => decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: c.data })).toThrow()
  })

  test('refuses a missing tokenId, a zero minimum or no deadline', () => {
    expect(() => policyIncrease(POLICY, { ...p, tokenId: 0n })).toThrow('tokenId')
    expect(() => policyIncrease(POLICY, { ...p, amount0Min: 0n })).toThrow('minimums')
    expect(() => policyIncrease(POLICY, { ...p, amount1Min: 0n })).toThrow('minimums')
    expect(() => policyIncrease(POLICY, { ...p, deadline: 0n })).toThrow('deadline')
  })

  test('approveTo approves a pool token to the policy address', () => {
    const c = approveTo('USDC', POLICY, 5n)
    expect(c.to).toBe(address('USDC', baseRegistry))
    expect(decodeFunctionData({ abi: erc20Abi, data: c.data }).args).toEqual([POLICY, 5n])
    expect(() => approveTo('pool:USDC/cbBTC/500', POLICY, 5n)).toThrow()
  })
})

describe('quoteExactInputSingleWithLimit (#151 review P1-3)', () => {
  const answer = (amountOut: bigint, after: bigint) =>
    ({ call: async () => ({ data: encodeFunctionResult({ abi: quoterV2Abi, functionName: 'quoteExactInputSingle', result: [amountOut, after, 1, 100_000n] }) }) }) as unknown as PublicClient
  const q = { tokenIn: address('USDC', baseRegistry), tokenOut: address('cbBTC', baseRegistry), fee: 500, amountIn: 1_000n, blockNumber: 1n, sqrtPriceLimitX96: 12345n }

  test('filled when the price after is short of the limit; not filled when it stops at it', async () => {
    expect(await quoteExactInputSingleWithLimit(answer(900n, 20000n), q)).toEqual({ amountOut: 900n, sqrtPriceX96After: 20000n, filled: true })
    expect(await quoteExactInputSingleWithLimit(answer(400n, 12345n), q)).toEqual({ amountOut: 400n, sqrtPriceX96After: 12345n, filled: false })
  })

  test('sends the limit to QuoterV2 and refuses a zero one', async () => {
    let sent = ''
    const client = { call: async (a: { data: string }) => ((sent = a.data), { data: encodeFunctionResult({ abi: quoterV2Abi, functionName: 'quoteExactInputSingle', result: [1n, 2n, 0, 0n] }) }) } as unknown as PublicClient
    await quoteExactInputSingleWithLimit(client, q)
    expect(sent.endsWith(encodeAbiParameters([{ type: 'uint160' }], [12345n]).slice(2))).toBe(true)
    await expect(quoteExactInputSingleWithLimit(client, { ...q, sqrtPriceLimitX96: 0n })).rejects.toThrow('zero limit')
  })

  test('bound to a registry: tokens of another registry are refused before any RPC', async () => {
    let calls = 0
    const client = { call: async () => ((calls += 1), { data: '0x' }) } as unknown as PublicClient
    await expect(uniswapV3(monadRegistry).quoteExactInputSingleWithLimit(client, q)).rejects.toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
    expect(calls).toBe(0)
    expect(uniswapV3(baseRegistry).approveTo('USDC', POLICY, 1n)).toEqual(approveTo('USDC', POLICY, 1n))
    expect(() => uniswapV3(monadRegistry).approveTo('cbBTC', POLICY, 1n)).toThrow()
  })
})
