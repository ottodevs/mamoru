import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, isAddressEqual, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, entry, erc20Abi, monadRegistry, nameOf, nonfungiblePositionManagerAbi, swapRouter02Abi, type Registry } from '@mamoru/registry'
import golden from './base-calls.golden.json' with { type: 'json' }
import {
  approve,
  burn,
  collect,
  deadlineCheck,
  decreaseLiquidity,
  exactInputSingle,
  exactInputSingleTo,
  mint,
  ROUTER_ADDRESS_THIS,
  swapToEth,
  uniswapV3,
  type V3Call,
} from './index.ts'

const ACCOUNT: Address = '0x00000000000000000000000000000000000000aa'
const DESTINATION: Address = '0x00000000000000000000000000000000000000bb'
const POOL = 'pool:WMON/USDC/3000'

/** Entries whose address differs between chains. None of them may resolve to a Base address. */
const DIFFER_BETWEEN_CHAINS = ['UniswapV3Factory', 'NonfungiblePositionManager', 'SwapRouter02', 'QuoterV2', 'USDC', 'WMON', POOL]

/** The address is the one `monad.json` gives to `name`, and, when the entry differs between chains, is not in `base.json`. */
function expectMonad(addr: Address, name: string) {
  expect(isAddressEqual(addr, address(name, monadRegistry))).toBe(true)
  expect(nameOf(addr, monadRegistry)).toBe(name)
  if (DIFFER_BETWEEN_CHAINS.includes(name)) expect(nameOf(addr, baseRegistry)).toBeUndefined()
}

type Decoded = { functionName: string; args: readonly unknown[] | undefined }

function decodeRouter(data: Hex): Decoded {
  return decodeFunctionData({ abi: swapRouter02Abi, data }) as Decoded
}

function decodeNpm(data: Hex): Decoded {
  return decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data }) as Decoded
}

const v3 = uniswapV3(monadRegistry)

describe('uniswapV3(monadRegistry): every address in the calldata comes from monad.json', () => {
  test('approve: to is the Monad token, spender the Monad router or position manager', () => {
    const toRouter = v3.approve('USDC', 'SwapRouter02', 5_000_000n)
    expect(toRouter.target).toBe('USDC')
    expectMonad(toRouter.to, 'USDC')
    const d = decodeFunctionData({ abi: erc20Abi, data: toRouter.data })
    expect(d.functionName).toBe('approve')
    const [spender, amount] = d.args as readonly [Address, bigint]
    expectMonad(spender, 'SwapRouter02')
    expect(amount).toBe(5_000_000n)

    const toNpm = v3.approve('WMON', 'NonfungiblePositionManager', 7n)
    expectMonad(toNpm.to, 'WMON')
    const [npm] = decodeFunctionData({ abi: erc20Abi, data: toNpm.data }).args as readonly [Address, bigint]
    expectMonad(npm, 'NonfungiblePositionManager')
  })

  test('exactInputSingle: to is the Monad router, tokenIn and tokenOut the Monad tokens, recipient the account', () => {
    const c = v3.exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'WMON', fee: 3000, amountIn: 10n ** 6n, amountOutMinimum: 1n })
    expect(c.target).toBe('SwapRouter02')
    expectMonad(c.to, 'SwapRouter02')
    const d = decodeRouter(c.data)
    expect(d.functionName).toBe('exactInputSingle')
    const [p] = d.args as readonly [{ tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }]
    expectMonad(p.tokenIn, 'USDC')
    expectMonad(p.tokenOut, 'WMON')
    expect(p.fee).toBe(3000)
    expect(isAddressEqual(p.recipient, ACCOUNT)).toBe(true)
    expect(p.amountIn).toBe(10n ** 6n)
    expect(p.amountOutMinimum).toBe(1n)
    expect(p.sqrtPriceLimitX96).toBe(0n)
  })

  test('mint: to is the Monad position manager, token0 and token1 the Monad pool tokens, recipient the account', () => {
    const pool = entry(POOL, monadRegistry)
    const c = v3.mint({ account: ACCOUNT, pool: POOL, tickLower: -600, tickUpper: 600, amount0Desired: 10n ** 18n, amount1Desired: 10n ** 6n, amount0Min: 1n, amount1Min: 1n, deadline: 1_000n })
    expect(c.target).toBe('NonfungiblePositionManager')
    expectMonad(c.to, 'NonfungiblePositionManager')
    const d = decodeNpm(c.data)
    expect(d.functionName).toBe('mint')
    const [p] = d.args as readonly [{ token0: Address; token1: Address; fee: number; tickLower: number; tickUpper: number; recipient: Address; deadline: bigint }]
    expectMonad(p.token0, pool.token0!)
    expectMonad(p.token1, pool.token1!)
    expect(p.token0).not.toBe(p.token1)
    expect(p.fee).toBe(pool.fee!)
    expect(p.tickLower).toBe(-600)
    expect(p.tickUpper).toBe(600)
    expect(isAddressEqual(p.recipient, ACCOUNT)).toBe(true)
    expect(p.deadline).toBe(1_000n)
  })

  test('decreaseLiquidity, collect and burn go to the Monad position manager; collect pays the account', () => {
    const dec = v3.decreaseLiquidity({ tokenId: 9n, liquidity: 5n, amount0Min: 1n, amount1Min: 1n, deadline: 1_000n })
    expectMonad(dec.to, 'NonfungiblePositionManager')
    expect(decodeNpm(dec.data).functionName).toBe('decreaseLiquidity')

    const col = v3.collect({ account: ACCOUNT, tokenId: 9n })
    expectMonad(col.to, 'NonfungiblePositionManager')
    const d = decodeNpm(col.data)
    expect(d.functionName).toBe('collect')
    const [p] = d.args as readonly [{ tokenId: bigint; recipient: Address }]
    expect(p.tokenId).toBe(9n)
    expect(isAddressEqual(p.recipient, ACCOUNT)).toBe(true)

    const b = v3.burn(9n)
    expectMonad(b.to, 'NonfungiblePositionManager')
    const bd = decodeNpm(b.data)
    expect(bd.functionName).toBe('burn')
    expect(bd.args).toEqual([9n])
  })

  test('deadlineCheck: SwapRouter02.multicall(deadline, []) on the Monad router', () => {
    const c = v3.deadlineCheck(1_000n)
    expectMonad(c.to, 'SwapRouter02')
    const d = decodeRouter(c.data)
    expect(d.functionName).toBe('multicall')
    expect(d.args).toEqual([1_000n, []])
  })

  test('exactInputSingleTo: explicit recipient, Monad router and tokens', () => {
    const c = v3.exactInputSingleTo({ recipient: DESTINATION, tokenIn: 'USDC', tokenOut: 'EURW', fee: 100, amountIn: 10n ** 6n, amountOutMinimum: 1n })
    expectMonad(c.to, 'SwapRouter02')
    const [p] = decodeRouter(c.data).args as readonly [{ tokenIn: Address; tokenOut: Address; recipient: Address }]
    expectMonad(p.tokenIn, 'USDC')
    expectMonad(p.tokenOut, 'EURW')
    expect(isAddressEqual(p.recipient, DESTINATION)).toBe(true)
  })

  test('swapToNative: multicall of exactInputSingle(USDC -> WMON, ADDRESS_THIS) and unwrapWETH9(min, recipient)', () => {
    const c = v3.swapToNative({ recipient: DESTINATION, tokenIn: 'USDC', wrappedNative: 'WMON', fee: 3000, amountIn: 10n ** 6n, amountOutMinimum: 42n, deadline: 1_000n })
    expectMonad(c.to, 'SwapRouter02')
    const outer = decodeRouter(c.data)
    expect(outer.functionName).toBe('multicall')
    const [deadline, inner] = outer.args as readonly [bigint, readonly Hex[]]
    expect(deadline).toBe(1_000n)
    expect(inner).toHaveLength(2)

    const swap = decodeRouter(inner[0]!)
    expect(swap.functionName).toBe('exactInputSingle')
    const [p] = swap.args as readonly [{ tokenIn: Address; tokenOut: Address; recipient: Address; amountOutMinimum: bigint }]
    expectMonad(p.tokenIn, 'USDC')
    expectMonad(p.tokenOut, 'WMON')
    expect(isAddressEqual(p.recipient, ROUTER_ADDRESS_THIS)).toBe(true)
    expect(p.amountOutMinimum).toBe(42n)

    const unwrap = decodeRouter(inner[1]!)
    expect(unwrap.functionName).toBe('unwrapWETH9')
    const [min, recipient] = unwrap.args as readonly [bigint, Address]
    expect(min).toBe(42n)
    expect(isAddressEqual(recipient, DESTINATION)).toBe(true)
  })

  test('the whole entry batch resolves to Monad and shares no Uniswap, token or pool address with Base', () => {
    const batch: V3Call[] = [
      v3.approve('USDC', 'SwapRouter02', 10n ** 6n),
      v3.exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'WMON', fee: 3000, amountIn: 10n ** 6n, amountOutMinimum: 1n }),
      v3.approve('USDC', 'NonfungiblePositionManager', 10n ** 6n),
      v3.approve('WMON', 'NonfungiblePositionManager', 10n ** 18n),
      v3.mint({ account: ACCOUNT, pool: POOL, tickLower: -600, tickUpper: 600, amount0Desired: 10n ** 18n, amount1Desired: 10n ** 6n, amount0Min: 1n, amount1Min: 1n, deadline: 1_000n }),
    ]
    const baseAddresses = new Set(baseRegistry.entries.map((e) => e.address.toLowerCase()))
    for (const c of batch) {
      expect(nameOf(c.to, monadRegistry)).toBe(c.target)
      expect(baseAddresses.has(c.to.toLowerCase())).toBe(false)
    }
  })

  test('a name the Monad registry lacks fails loudly, never with a Base address', () => {
    expect(() => v3.approve('cbBTC', 'SwapRouter02', 1n)).toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
    expect(() => v3.exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'WETH', fee: 3000, amountIn: 1n, amountOutMinimum: 1n })).toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
    expect(() => v3.mint({ account: ACCOUNT, pool: 'pool:USDC/cbBTC/500', tickLower: -10, tickUpper: 10, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 1n, amount1Min: 1n, deadline: 1n })).toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
    expect(() => v3.swapToNative({ recipient: DESTINATION, tokenIn: 'USDC', wrappedNative: 'WETH', fee: 3000, amountIn: 1n, amountOutMinimum: 1n, deadline: 1n })).toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
  })

  test('a pool name is not a token', () => {
    expect(() => v3.approve(POOL, 'SwapRouter02', 1n)).toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
  })
})

describe('Base does not change', () => {
  const bound = uniswapV3(baseRegistry)
  const mintParams = { account: ACCOUNT, pool: 'pool:USDC/cbBTC/500', tickLower: -100, tickUpper: 100, amount0Desired: 10n ** 6n, amount1Desired: 10n ** 4n, amount0Min: 1n, amount1Min: 1n, deadline: 1_000n }
  const swapParams = { account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 10n ** 6n, amountOutMinimum: 1n }
  const toParams = { recipient: DESTINATION, tokenIn: 'USDC', tokenOut: 'EURC', fee: 500, amountIn: 10n ** 6n, amountOutMinimum: 1n }
  const ethParams = { recipient: DESTINATION, tokenIn: 'USDC', fee: 500, amountIn: 10n ** 6n, amountOutMinimum: 1n, deadline: 1_000n }

  test('the free forms and the Base-bound form give the same bytes', () => {
    expect(approve('USDC', 'SwapRouter02', 1n)).toEqual(bound.approve('USDC', 'SwapRouter02', 1n))
    expect(exactInputSingle(swapParams)).toEqual(bound.exactInputSingle(swapParams))
    expect(mint(mintParams)).toEqual(bound.mint(mintParams))
    expect(decreaseLiquidity({ tokenId: 1n, liquidity: 1n, amount0Min: 1n, amount1Min: 1n, deadline: 1n })).toEqual(bound.decreaseLiquidity({ tokenId: 1n, liquidity: 1n, amount0Min: 1n, amount1Min: 1n, deadline: 1n }))
    expect(collect({ account: ACCOUNT, tokenId: 1n })).toEqual(bound.collect({ account: ACCOUNT, tokenId: 1n }))
    expect(burn(1n)).toEqual(bound.burn(1n))
    expect(exactInputSingleTo(toParams)).toEqual(bound.exactInputSingleTo(toParams))
    expect(swapToEth(ethParams)).toEqual(bound.swapToNative({ ...ethParams, wrappedNative: 'WETH' }))
    expect(deadlineCheck(1_000n)).toEqual(bound.deadlineCheck(1_000n))
  })

  // CHN-04: the bytes the free forms produced before the bound form existed (generated from main at 3cd720a).
  test('the Base-bound form reproduces the pre-change Base calldata byte for byte', () => {
    const now: Record<string, V3Call> = {
      approve: bound.approve('USDC', 'SwapRouter02', 1n),
      exactInputSingle: bound.exactInputSingle(swapParams),
      exactInputSingleLimit: bound.exactInputSingle({ ...swapParams, sqrtPriceLimitX96: 4295128740n }),
      mint: bound.mint(mintParams),
      decreaseLiquidity: bound.decreaseLiquidity({ tokenId: 1n, liquidity: 1n, amount0Min: 1n, amount1Min: 1n, deadline: 1n }),
      collect: bound.collect({ account: ACCOUNT, tokenId: 1n }),
      burn: bound.burn(1n),
      exactInputSingleTo: bound.exactInputSingleTo(toParams),
      swapToEth: bound.swapToNative({ ...ethParams, wrappedNative: 'WETH' }),
      deadlineCheck: bound.deadlineCheck(1_000n),
    }
    const ser: Record<string, { target: string; to: string; value: string; data: string }> = Object.fromEntries(Object.entries(now).map(([k, c]) => [k, { target: c.target, to: c.to, value: String(c.value), data: c.data }]))
    expect(ser).toEqual(golden)
  })

  test('the free forms still encode the Base addresses', () => {
    const b: Registry = baseRegistry
    expect(isAddressEqual(approve('USDC', 'SwapRouter02', 1n).to, address('USDC', b))).toBe(true)
    expect(isAddressEqual(exactInputSingle(swapParams).to, address('SwapRouter02', b))).toBe(true)
    expect(isAddressEqual(mint(mintParams).to, address('NonfungiblePositionManager', b))).toBe(true)
    const [p] = decodeRouter(exactInputSingle(swapParams).data).args as readonly [{ tokenIn: Address; tokenOut: Address }]
    expect(isAddressEqual(p.tokenIn, address('USDC', b))).toBe(true)
    expect(isAddressEqual(p.tokenOut, address('cbBTC', b))).toBe(true)
    const [, inner] = decodeRouter(swapToEth(ethParams).data).args as readonly [bigint, readonly Hex[]]
    const [s] = decodeRouter(inner[0]!).args as readonly [{ tokenOut: Address }]
    expect(isAddressEqual(s.tokenOut, address('WETH', b))).toBe(true)
  })

  test('the two bound forms never share a Uniswap, token or pool address', () => {
    const monad = v3.exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'WMON', fee: 3000, amountIn: 1n, amountOutMinimum: 1n })
    const base = bound.exactInputSingle(swapParams)
    expect(monad.to).not.toBe(base.to)
    const [pm] = decodeRouter(monad.data).args as readonly [{ tokenIn: Address; tokenOut: Address }]
    const [pb] = decodeRouter(base.data).args as readonly [{ tokenIn: Address; tokenOut: Address }]
    expect(pm.tokenIn).not.toBe(pb.tokenIn)
    expect(pm.tokenOut).not.toBe(pb.tokenOut)
  })
})
