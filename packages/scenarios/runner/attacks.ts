import { encodeFunctionData, encodePacked, getAddress, maxUint128, maxUint256, parseAbi, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import {
  address,
  erc20Abi,
  erc4626Abi,
  nonfungiblePositionManagerAbi,
  safe7579Abi,
  safeAbi,
  smartSessionAbi,
  swapRouter02Abi,
} from '@mamoru/registry'
import { approve, collect, decreaseLiquidity, exactInputSingle } from '@mamoru/uniswap-v3'
import type { CallLike } from '../fixtures/session-op.ts'
import type { World } from '../fixtures/world.ts'

/** Addresses the attacker brings. None of them is in the registry. */
export const PERMIT2: Address = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')
/** A USDC ERC-4626 vault on Base (MetaMorpho), the kind of venue Mamoru never calls. */
export const ERC4626_VAULT: Address = getAddress('0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183')
const SUDO_POLICY: Address = getAddress('0x0000003111cD8e92337C100F22B7A9dbf8DEE301')
const SENTINEL: Address = '0x0000000000000000000000000000000000000001'

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256, uint160, uint32, uint256)',
])

export type AttackCtx = { world: World; params: Record<string, unknown> }
type Builder = (ctx: AttackCtx) => CallLike[] | Promise<CallLike[]>

const call = (to: Address, data: Hex, value = 0n): CallLike => ({ to, data, value })
const usdc = () => address('USDC')
const cbbtc = () => address('cbBTC')
const npm = () => address('NonfungiblePositionManager')
const router = () => address('SwapRouter02')

function managed(w: World): bigint {
  const id = w.a1.managedTokenIds[0]
  if (id === undefined) throw new Error('no managed position')
  return id
}

async function deadline(w: World): Promise<bigint> {
  return BigInt(Number(await w.lab.timestamp()) + 3600)
}

function amountParam(ctx: AttackCtx, name: string, fallback: bigint): bigint {
  const v = ctx.params[name]
  if (v === undefined) return fallback
  if (typeof v === 'string' && v.startsWith('cap:')) {
    const [cap, delta] = v.slice(4).split('+')
    return ctx.world.a1.caps[cap!]! + BigInt(delta ?? 0)
  }
  return BigInt(v as string | number)
}

export const ATTACKS: Record<string, Builder> = {
  // positive controls
  'valid-swap': (ctx) => {
    const a = amountParam(ctx, 'amount', 1_000_000n)
    return [approve('USDC', 'SwapRouter02', a), exactInputSingle({ account: ctx.world.a1.safe, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: a, amountOutMinimum: 1n })]
  },
  'valid-collect': (ctx) => [collect({ account: ctx.world.a1.safe, tokenId: managed(ctx.world) })],

  // SESS-01, 02, 03
  'swap-recipient-attacker': (ctx) => {
    const a = 1_000_000n
    return [
      approve('USDC', 'SwapRouter02', a),
      call(router(), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: usdc(), tokenOut: cbbtc(), fee: 500, recipient: ctx.world.attacker.address, amountIn: a, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] })),
    ]
  },
  'collect-recipient-attacker': (ctx) => [
    call(npm(), encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', args: [{ tokenId: managed(ctx.world), recipient: ctx.world.attacker.address, amount0Max: maxUint128, amount1Max: maxUint128 }] })),
  ],
  'mint-recipient-attacker': async (ctx) => {
    const w = ctx.world
    const d = await deadline(w)
    return [
      approve('USDC', 'NonfungiblePositionManager', 1_000_000n),
      approve('cbBTC', 'NonfungiblePositionManager', 1_000n),
      call(npm(), encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [{ token0: usdc(), token1: cbbtc(), fee: 500, tickLower: -887270, tickUpper: 887270, amount0Desired: 1_000_000n, amount1Desired: 1_000n, amount0Min: 1n, amount1Min: 1n, recipient: w.attacker.address, deadline: d }] })),
    ]
  },

  // SESS-04
  'usdc-transfer-attacker': (ctx) => [call(usdc(), encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ctx.world.attacker.address, 1_000_000n] }))],
  'usdc-transferFrom-attacker': (ctx) => [call(usdc(), encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [ctx.world.a1.safe, ctx.world.attacker.address, 1_000_000n] }))],
  'cbbtc-transfer-attacker': (ctx) => [call(cbbtc(), encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ctx.world.attacker.address, 1_000n] }))],
  'cbbtc-transferFrom-attacker': (ctx) => [call(cbbtc(), encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [ctx.world.a1.safe, ctx.world.attacker.address, 1_000n] }))],
  'nft-safeTransferFrom-attacker': (ctx) => [call(npm(), encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'safeTransferFrom', args: [ctx.world.a1.safe, ctx.world.attacker.address, managed(ctx.world)] }))],
  'nft-safeTransferFrom-data-attacker': (ctx) => [call(npm(), encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'safeTransferFrom', args: [ctx.world.a1.safe, ctx.world.attacker.address, managed(ctx.world), '0x'] }))],
  'nft-transferFrom-attacker': (ctx) => [call(npm(), encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'transferFrom', args: [ctx.world.a1.safe, ctx.world.attacker.address, managed(ctx.world)] }))],
  'nft-approve-attacker': (ctx) => [call(npm(), encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'approve', args: [ctx.world.attacker.address, managed(ctx.world)] }))],
  'nft-setApprovalForAll-attacker': (ctx) => [call(npm(), encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'setApprovalForAll', args: [ctx.world.attacker.address, true] }))],

  // SESS-05, 06
  'swap-over-per-call-cap': (ctx) => {
    const a = amountParam(ctx, 'amount', ctx.world.a1.caps.usdcSwapPerCall! + 1n)
    return [exactInputSingle({ account: ctx.world.a1.safe, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: a, amountOutMinimum: 1n })]
  },

  // SESS-07, 08
  'usdc-approve-router-max': () => [call(usdc(), encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router(), maxUint256] }))],
  'usdc-approve-attacker': (ctx) => [call(usdc(), encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ctx.world.attacker.address, 1_000_000n] }))],
  'usdc-increaseAllowance-router': () => [call(usdc(), encodeFunctionData({ abi: erc20Abi, functionName: 'increaseAllowance', args: [router(), 1_000_000n] }))],
  'usdc-approve-permit2': () => [call(usdc(), encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] }))],

  // SESS-09
  'decrease-second-account': async (ctx) => {
    const id = ctx.world.a2.managedTokenIds[0]!
    return [decreaseLiquidity({ tokenId: id, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: await deadline(ctx.world) })]
  },
  'decrease-owner-position': async (ctx) => {
    const id = ctx.world.a1.ownerTokenIds[0]!
    return [decreaseLiquidity({ tokenId: id, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: await deadline(ctx.world) })]
  },
  'decrease-owner-position-latest': async (ctx) => {
    const id = ctx.world.a1.ownerTokenIds.at(-1)!
    return [decreaseLiquidity({ tokenId: id, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: await deadline(ctx.world) })]
  },

  // SESS-10
  'collect-plus-usdc-transfer': (ctx) => [
    collect({ account: ctx.world.a1.safe, tokenId: managed(ctx.world) }),
    call(usdc(), encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ctx.world.attacker.address, 1_000_000n] })),
  ],
  'collect-plus-vault-deposit': (ctx) => [
    collect({ account: ctx.world.a1.safe, tokenId: managed(ctx.world) }),
    call(ERC4626_VAULT, encodeFunctionData({ abi: erc4626Abi, functionName: 'deposit', args: [1_000_000n, ctx.world.attacker.address] })),
  ],

  // SESS-13
  'npm-increaseLiquidity': async (ctx) => [
    call(npm(), encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'increaseLiquidity', args: [{ tokenId: managed(ctx.world), amount0Desired: 1_000_000n, amount1Desired: 1_000n, amount0Min: 0n, amount1Min: 0n, deadline: await deadline(ctx.world) }] })),
  ],
  'contract-not-in-grant': () => [
    call(address('QuoterV2'), encodeFunctionData({ abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: usdc(), tokenOut: cbbtc(), amountIn: 1_000_000n, fee: 500, sqrtPriceLimitX96: 0n }] })),
  ],

  // SESS-14
  'safe-addOwnerWithThreshold': (ctx) => [call(ctx.world.a1.safe, encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [ctx.world.attacker.address, 1n] }))],
  'safe-swapOwner': (ctx) => [call(ctx.world.a1.safe, encodeFunctionData({ abi: safeAbi, functionName: 'swapOwner', args: [SENTINEL, address('SafeWebAuthnSharedSigner'), ctx.world.attacker.address] }))],
  'safe-removeOwner': (ctx) => [call(ctx.world.a1.safe, encodeFunctionData({ abi: safeAbi, functionName: 'removeOwner', args: [address('SafeWebAuthnSharedSigner'), ctx.world.a1.backupOwner.address, 1n] }))],
  'safe-changeThreshold': (ctx) => [call(ctx.world.a1.safe, encodeFunctionData({ abi: safeAbi, functionName: 'changeThreshold', args: [2n] }))],

  // SESS-15
  'account-installModule': (ctx) => [call(ctx.world.a1.safe, encodeFunctionData({ abi: safe7579Abi, functionName: 'installModule', args: [2n, ctx.world.attacker.address, '0x'] }))],
  'account-uninstallModule': (ctx) => [
    call(ctx.world.a1.safe, encodeFunctionData({ abi: safe7579Abi, functionName: 'uninstallModule', args: [1n, address('SmartSession'), encodePacked(['bytes32', 'bytes32'], [`0x${'00'.repeat(31)}01`, `0x${'00'.repeat(32)}`])] })),
  ],
  'safe-setGuard': (ctx) => [call(ctx.world.a1.safe, encodeFunctionData({ abi: safeAbi, functionName: 'setGuard', args: [ctx.world.attacker.address] }))],
  'safe-setFallbackHandler': (ctx) => [call(ctx.world.a1.safe, encodeFunctionData({ abi: safeAbi, functionName: 'setFallbackHandler', args: [ctx.world.attacker.address] }))],
  'safe-enableModule': (ctx) => [call(ctx.world.a1.safe, encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [ctx.world.attacker.address] }))],

  // SESS-16
  'smartsession-enableSessions': (ctx) => [
    call(
      address('SmartSession'),
      encodeFunctionData({
        abi: smartSessionAbi,
        functionName: 'enableSessions',
        args: [
          [
            {
              sessionValidator: address('OwnableValidator'),
              sessionValidatorInitData: encodePacked(['uint256', 'uint256', 'uint256', 'address'], [1n, 64n, 1n, ctx.world.attacker.address]),
              salt: `0x${'ee'.repeat(32)}`,
              userOpPolicies: [{ policy: SUDO_POLICY, initData: '0x' }],
              erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
              actions: [{ actionTargetSelector: '0xa9059cbb', actionTarget: usdc(), actionPolicies: [{ policy: SUDO_POLICY, initData: '0x' }] }],
              permitERC4337Paymaster: true,
            },
          ],
        ],
      }),
    ),
  ],
  'smartsession-enableActionPolicies': (ctx) => [
    call(
      address('SmartSession'),
      encodeFunctionData({
        abi: smartSessionAbi,
        functionName: 'enableActionPolicies',
        args: [ctx.params.permissionId as Hex, [{ actionTargetSelector: '0xa9059cbb', actionTarget: usdc(), actionPolicies: [{ policy: SUDO_POLICY, initData: '0x' }] }]],
      }),
    ),
  ],
  'smartsession-enableUserOpPolicies': (ctx) => [
    call(address('SmartSession'), encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableUserOpPolicies', args: [ctx.params.permissionId as Hex, [{ policy: SUDO_POLICY, initData: '0x' }]] })),
  ],

  // SESS-21
  'swap-with-value': (ctx) => {
    const a = 1_000_000n
    return [
      approve('USDC', 'SwapRouter02', a),
      { ...exactInputSingle({ account: ctx.world.a1.safe, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: a, amountOutMinimum: 1n }), value: 1n },
    ]
  },
  'eth-to-attacker': (ctx) => [call(ctx.world.attacker.address, '0x', 1_000_000_000_000n)],

  // SESS-22
  'router-multicall': (ctx) => [
    call(router(), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [[encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: usdc(), tokenOut: cbbtc(), fee: 500, recipient: ctx.world.attacker.address, amountIn: 1_000_000n, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] })]] })),
  ],
  'router-multicall-deadline': (ctx) => [
    call(router(), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [BigInt(Math.floor(Date.now() / 1000) + 3600), [encodeFunctionData({ abi: swapRouter02Abi, functionName: 'sweepToken', args: [usdc(), 0n, ctx.world.attacker.address] })]] })),
  ],
  'router-exactInput': (ctx) => [
    call(router(), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInput', args: [{ path: encodePacked(['address', 'uint24', 'address'], [usdc(), 500, cbbtc()]), recipient: ctx.world.attacker.address, amountIn: 1_000_000n, amountOutMinimum: 1n }] })),
  ],
  'router-unwrapWETH9': (ctx) => [call(router(), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'unwrapWETH9', args: [0n, ctx.world.attacker.address] }))],
  'router-sweepToken': (ctx) => [call(router(), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'sweepToken', args: [usdc(), 0n, ctx.world.attacker.address] }))],
  'router-refundETH': () => [call(router(), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'refundETH' }))],
  'npm-multicall': (ctx) => [
    call(npm(), encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'multicall', args: [[encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', args: [{ tokenId: managed(ctx.world), recipient: ctx.world.attacker.address, amount0Max: maxUint128, amount1Max: maxUint128 }] })]] })),
  ],

  // SESS-23: a delegatecall into MultiSendCallOnly that would move USDC out.
  'delegatecall-multisend-transfer': (ctx) => {
    const t = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ctx.world.attacker.address, 1_000_000n] })
    const packed = encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, usdc(), 0n, BigInt((t.length - 2) / 2), t])
    return [call(address('MultiSendCallOnly_141'), encodeFunctionData({ abi: parseAbi(['function multiSend(bytes)']), functionName: 'multiSend', args: [packed] }))]
  },
}

export async function buildAttack(name: string, ctx: AttackCtx): Promise<CallLike[]> {
  const b = ATTACKS[name]
  if (!b) throw new Error(`unknown batch ${name}`)
  return b(ctx)
}
