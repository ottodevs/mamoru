import { encodeFunctionData, maxUint128 } from 'viem'
import { ReasonError, type Address, type Hex } from '@mamoru/domain'
import { address, entry, erc20Abi, nonfungiblePositionManagerAbi, swapRouter02Abi, type RegistryName } from '@mamoru/registry'

/** A call that the session will sign. The target is always a registry entry. */
export type V3Call = { target: RegistryName; to: Address; value: 0n; data: Hex }

function call(target: RegistryName, data: Hex): V3Call {
  return { target, to: address(target), value: 0n, data }
}

function token(name: RegistryName): Address {
  const e = entry(name)
  if (e.kind !== 'token') throw new ReasonError('POLICY_TARGET_NOT_IN_REGISTRY', `${name} is not a registry token`)
  return e.address
}

export function approve(tokenName: RegistryName, spender: 'SwapRouter02' | 'NonfungiblePositionManager', amount: bigint): V3Call {
  token(tokenName)
  return call(tokenName, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address(spender), amount] }))
}

/** FR-UNI-002: SwapRouter02.exactInputSingle, recipient the account, positive minimum, no price limit. */
export function exactInputSingle(p: {
  account: Address
  tokenIn: RegistryName
  tokenOut: RegistryName
  fee: number
  amountIn: bigint
  amountOutMinimum: bigint
}): V3Call {
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
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  )
}

/** FR-UNI-003: mint to the account, ticks on the pool spacing, both minimums positive, deadline set. */
export function mint(p: {
  account: Address
  pool: RegistryName
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
  amount0Min: bigint
  amount1Min: bigint
  deadline: bigint
}): V3Call {
  const pool = entry(p.pool)
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

export function decreaseLiquidity(p: { tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint }): V3Call {
  if (p.deadline <= 0n) throw new Error('deadline must be set')
  return call(
    'NonfungiblePositionManager',
    encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'decreaseLiquidity', args: [p] }),
  )
}

/** Collect everything owed to the account. */
export function collect(p: { account: Address; tokenId: bigint }): V3Call {
  return call(
    'NonfungiblePositionManager',
    encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: 'collect',
      args: [{ tokenId: p.tokenId, recipient: p.account, amount0Max: maxUint128, amount1Max: maxUint128 }],
    }),
  )
}

export function burn(tokenId: bigint): V3Call {
  return call('NonfungiblePositionManager', encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'burn', args: [tokenId] }))
}
