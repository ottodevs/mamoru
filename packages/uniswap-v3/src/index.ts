import { encodeFunctionData, maxUint128, type PublicClient } from 'viem'
import { ReasonError, type Address, type Hex } from '@mamoru/domain'
import { address, baseRegistry, entry, erc20Abi, mamoruActionPolicyV2Abi, nonfungiblePositionManagerAbi, swapRouter02Abi, type Registry, type RegistryName } from '@mamoru/registry'
import { quoterV2, type QuoteRequest, type QuoterV2 } from './quote.ts'

/** A call that the session will sign. The target is always a registry entry. */
export type V3Call = { target: RegistryName; to: Address; value: 0n; data: Hex }

/** SwapRouter02 Constants.ADDRESS_THIS: the router keeps the output (then unwrapWETH9 / sweepToken). */
export const ROUTER_ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002'

export type ExactInputSingleParams = {
  account: Address
  tokenIn: RegistryName
  tokenOut: RegistryName
  fee: number
  amountIn: bigint
  amountOutMinimum: bigint
  /**
   * Spec 007 (#151) T3: omitted (every caller before T3) is `0n`, no price limit, byte-identical to before the
   * parameter existed. A v4 policy's swap passes a non-zero limit at its narrower-band edge (`swapBoundsAtBand`,
   * `@mamoru/uniswap-v3/policy-bounds`); `MamoruActionPolicy._swapOk` refuses a zero limit.
   */
  sqrtPriceLimitX96?: bigint
}

export type ExactInputSingleToParams = {
  recipient: Address
  tokenIn: RegistryName
  tokenOut: RegistryName
  fee: number
  amountIn: bigint
  amountOutMinimum: bigint
}

export type MintParams = {
  account: Address
  pool: RegistryName
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
  amount0Min: bigint
  amount1Min: bigint
  deadline: bigint
}

export type DecreaseLiquidityParams = { tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint }

export type SwapToNativeParams = {
  recipient: Address
  tokenIn: RegistryName
  /** Registry name of the chain's wrapped native token (`WETH` on Base, `WMON` on Monad). */
  wrappedNative: RegistryName
  fee: number
  amountIn: bigint
  amountOutMinimum: bigint
  deadline: bigint
}

/** The Uniswap V3 call constructors bound to one registry. Every address they encode comes from it. */
export type UniswapV3 = {
  readonly registry: Registry
  approve(tokenName: RegistryName, spender: 'SwapRouter02' | 'NonfungiblePositionManager', amount: bigint): V3Call
  /** An approval of a registry token of this registry to a spender given by address (the deployed action policy, spec 007). */
  approveTo(tokenName: RegistryName, spender: Address, amount: bigint): V3Call
  /** FR-UNI-002: SwapRouter02.exactInputSingle, recipient the account, positive minimum; no price limit unless `sqrtPriceLimitX96` is given. */
  exactInputSingle(p: ExactInputSingleParams): V3Call
  /** FR-UNI-003: mint to the account, ticks on the pool spacing, both minimums positive, deadline set. */
  mint(p: MintParams): V3Call
  decreaseLiquidity(p: DecreaseLiquidityParams): V3Call
  /** Collect everything owed to the account. */
  collect(p: { account: Address; tokenId: bigint }): V3Call
  burn(tokenId: bigint): V3Call
  /** Owner withdraw: SwapRouter02.exactInputSingle with an explicit recipient (the destination, or ROUTER_ADDRESS_THIS). */
  exactInputSingleTo(p: ExactInputSingleToParams): V3Call
  /**
   * Owner withdraw in the native asset: SwapRouter02.multicall(deadline, [exactInputSingle(tokenIn -> wrapped native,
   * recipient ADDRESS_THIS), unwrapWETH9(amountMinimum, recipient)]). The router never holds funds across calls.
   */
  swapToNative(p: SwapToNativeParams): V3Call
  /**
   * otto/mamoru#140: SwapRouter02.multicall(deadline, []), an on-chain expiry for the batch it rides in: it reverts
   * ("Transaction too old") once the block is past `deadline`, and does nothing before. The session grant pins the
   * array to empty (`swapDeadline` in @mamoru/policy).
   */
  deadlineCheck(deadline: bigint): V3Call
  /** FR-UNI-001: QuoterV2.quoteExactInputSingle of this registry, at the block of the operation. */
  quoteExactInputSingle(client: PublicClient, q: QuoteRequest): Promise<bigint>
  /** Spec 007: the same quote with a price limit (`quoterV2(registry).quoteExactInputSingleWithLimit`). */
  quoteExactInputSingleWithLimit: QuoterV2['quoteExactInputSingleWithLimit']
}

/**
 * Bind the constructors to a registry. The registry travels with the caller's context: it is never derived here
 * from a chain id, a chain name or a constant. A name the registry lacks fails with POLICY_TARGET_NOT_IN_REGISTRY.
 */
export function uniswapV3(registry: Registry): UniswapV3 {
  function call(target: RegistryName, data: Hex): V3Call {
    return { target, to: address(target, registry), value: 0n, data }
  }

  function token(name: RegistryName): Address {
    const e = entry(name, registry)
    if (e.kind !== 'token') throw new ReasonError('POLICY_TARGET_NOT_IN_REGISTRY', `${name} is not a registry token`)
    return e.address
  }

  function approve(tokenName: RegistryName, spender: 'SwapRouter02' | 'NonfungiblePositionManager', amount: bigint): V3Call {
    token(tokenName)
    return call(tokenName, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address(spender, registry), amount] }))
  }

  function approveTo(tokenName: RegistryName, spender: Address, amount: bigint): V3Call {
    token(tokenName)
    return call(tokenName, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }))
  }

  function exactInputSingle(p: ExactInputSingleParams): V3Call {
    if (p.amountOutMinimum <= 0n) throw new Error('amountOutMinimum must be positive')
    return call(
      'SwapRouter02',
      encodeFunctionData({
        abi: swapRouter02Abi,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: token(p.tokenIn),
            tokenOut: token(p.tokenOut),
            fee: p.fee,
            recipient: p.account,
            amountIn: p.amountIn,
            amountOutMinimum: p.amountOutMinimum,
            sqrtPriceLimitX96: p.sqrtPriceLimitX96 ?? 0n,
          },
        ],
      }),
    )
  }

  function mint(p: MintParams): V3Call {
    const pool = entry(p.pool, registry)
    if (pool.kind !== 'pool' || !pool.token0 || !pool.token1 || !pool.fee || !pool.tickSpacing) {
      throw new ReasonError('POLICY_TARGET_NOT_IN_REGISTRY', p.pool)
    }
    if (p.tickLower % pool.tickSpacing !== 0 || p.tickUpper % pool.tickSpacing !== 0 || p.tickLower >= p.tickUpper) {
      throw new Error('ticks must be ordered multiples of the pool tick spacing')
    }
    if (p.amount0Min <= 0n || p.amount1Min <= 0n) throw new Error('mint minimums must be positive')
    if (p.deadline <= 0n) throw new Error('deadline must be set')
    return call(
      'NonfungiblePositionManager',
      encodeFunctionData({
        abi: nonfungiblePositionManagerAbi,
        functionName: 'mint',
        args: [
          {
            token0: token(pool.token0),
            token1: token(pool.token1),
            fee: pool.fee,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            amount0Desired: p.amount0Desired,
            amount1Desired: p.amount1Desired,
            amount0Min: p.amount0Min,
            amount1Min: p.amount1Min,
            recipient: p.account,
            deadline: p.deadline,
          },
        ],
      }),
    )
  }

  function decreaseLiquidity(p: DecreaseLiquidityParams): V3Call {
    if (p.deadline <= 0n) throw new Error('deadline must be set')
    return call(
      'NonfungiblePositionManager',
      encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'decreaseLiquidity', args: [p] }),
    )
  }

  function collect(p: { account: Address; tokenId: bigint }): V3Call {
    return call(
      'NonfungiblePositionManager',
      encodeFunctionData({
        abi: nonfungiblePositionManagerAbi,
        functionName: 'collect',
        args: [{ tokenId: p.tokenId, recipient: p.account, amount0Max: maxUint128, amount1Max: maxUint128 }],
      }),
    )
  }

  function burn(tokenId: bigint): V3Call {
    return call('NonfungiblePositionManager', encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'burn', args: [tokenId] }))
  }

  function exactInputSingleTo(p: ExactInputSingleToParams): V3Call {
    if (p.amountOutMinimum <= 0n) throw new Error('amountOutMinimum must be positive')
    return call(
      'SwapRouter02',
      encodeFunctionData({
        abi: swapRouter02Abi,
        functionName: 'exactInputSingle',
        args: [{ tokenIn: token(p.tokenIn), tokenOut: token(p.tokenOut), fee: p.fee, recipient: p.recipient, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum, sqrtPriceLimitX96: 0n }],
      }),
    )
  }

  function swapToNative(p: SwapToNativeParams): V3Call {
    if (p.amountOutMinimum <= 0n) throw new Error('amountOutMinimum must be positive')
    if (p.deadline <= 0n) throw new Error('deadline must be set')
    const swap = exactInputSingleTo({ recipient: ROUTER_ADDRESS_THIS, tokenIn: p.tokenIn, tokenOut: p.wrappedNative, fee: p.fee, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum })
    const unwrap = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'unwrapWETH9', args: [p.amountOutMinimum, p.recipient] })
    return call('SwapRouter02', encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [p.deadline, [swap.data, unwrap]] }))
  }

  function deadlineCheck(deadline: bigint): V3Call {
    if (deadline <= 0n) throw new Error('deadline must be set')
    return call('SwapRouter02', encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [deadline, []] }))
  }

  const quoter = quoterV2(registry)

  return { registry, approve, approveTo, exactInputSingle, mint, decreaseLiquidity, collect, burn, exactInputSingleTo, swapToNative, deadlineCheck, quoteExactInputSingle: quoter.quoteExactInputSingle, quoteExactInputSingleWithLimit: quoter.quoteExactInputSingleWithLimit }
}

// Free forms, bound to the Base registry. They go away with the registry default; new code uses `uniswapV3(registry)`.
const base = uniswapV3(baseRegistry)

/** @deprecated Bound to `baseRegistry`. Use `uniswapV3(registry).approve`. */
export function approve(tokenName: RegistryName, spender: 'SwapRouter02' | 'NonfungiblePositionManager', amount: bigint): V3Call {
  return base.approve(tokenName, spender, amount)
}

/** @deprecated Bound to `baseRegistry`. Use `uniswapV3(registry).exactInputSingle`. */
export function exactInputSingle(p: ExactInputSingleParams): V3Call {
  return base.exactInputSingle(p)
}

/** @deprecated Bound to `baseRegistry`. Use `uniswapV3(registry).mint`. */
export function mint(p: MintParams): V3Call {
  return base.mint(p)
}

/** @deprecated Bound to `baseRegistry`. Use `uniswapV3(registry).decreaseLiquidity`. */
export function decreaseLiquidity(p: DecreaseLiquidityParams): V3Call {
  return base.decreaseLiquidity(p)
}

/** @deprecated Bound to `baseRegistry`. Use `uniswapV3(registry).collect`. */
export function collect(p: { account: Address; tokenId: bigint }): V3Call {
  return base.collect(p)
}

/** @deprecated Bound to `baseRegistry`. Use `uniswapV3(registry).burn`. */
export function burn(tokenId: bigint): V3Call {
  return base.burn(tokenId)
}

/** @deprecated Bound to `baseRegistry`. Use `uniswapV3(registry).exactInputSingleTo`. */
export function exactInputSingleTo(p: ExactInputSingleToParams): V3Call {
  return base.exactInputSingleTo(p)
}

/** @deprecated Bound to `baseRegistry` and to WETH. Use `uniswapV3(registry).swapToNative` with the chain's wrapped native. */
export function swapToEth(p: { recipient: Address; tokenIn: RegistryName; fee: number; amountIn: bigint; amountOutMinimum: bigint; deadline: bigint }): V3Call {
  return base.swapToNative({ ...p, wrappedNative: 'WETH' })
}

/** @deprecated Bound to `baseRegistry`. Use `uniswapV3(registry).deadlineCheck`. */
export function deadlineCheck(deadline: bigint): V3Call {
  return base.deadlineCheck(deadline)
}

/**
 * otto/mamoru#171, spec 007: add liquidity to a position the account holds, ONLY through MamoruActionPolicyV2.increase
 * at `policy` (the deployed address, never a registry name: it is a runtime parameter like the policy's `mint`). The
 * position manager's own `increaseLiquidity` does not check who owns the tokenId, so no session ever calls it; the
 * policy adds only to positions it admitted for the account that the account still owns, after the account approved
 * the policy for at most the desired amounts (`approveTo`). Both minimums positive and a deadline set, as for a mint.
 * Chain-neutral: it encodes no registry address, only `policy`.
 */
export function policyIncrease(policy: Address, p: { tokenId: bigint; amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint }): V3Call {
  if (p.tokenId <= 0n) throw new Error('tokenId must be set')
  if (p.amount0Min <= 0n || p.amount1Min <= 0n) throw new Error('increase minimums must be positive')
  if (p.deadline <= 0n) throw new Error('deadline must be set')
  return { target: 'MamoruActionPolicyV2', to: policy, value: 0n, data: encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: 'increase', args: [p] }) }
}

/** @deprecated Bound to `baseRegistry`. Use `uniswapV3(registry).approveTo`. */
export function approveTo(tokenName: RegistryName, spender: Address, amount: bigint): V3Call {
  return base.approveTo(tokenName, spender, amount)
}

