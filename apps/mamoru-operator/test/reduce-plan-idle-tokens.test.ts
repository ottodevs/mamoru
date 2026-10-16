// otto/mamoru#140 (part1 #4): reducePlan (prepareTransfer's withdraw sizing) threw INSUFFICIENT_FUNDS the moment
// there was no OPEN LP position, before ever looking at idle non-USDC tokens (left by an enter_swap, a
// close_position re-range, or a failed enter_mint) that line 1059's own idle-token swap exists to recover. An
// owner whose balance sat entirely in such a token, with no position open, could not withdraw at all — a
// funds-lock. These tests call the private reducePlan directly with a hand-built SafeRead, no live chain needed.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector, type Hex, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { quoterV2Abi } from '@mamoru/uniswap-v3/quote'
import { HttpError, Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'
import type { PoolPosition, SafeRead } from '../src/chain.ts'

const SAFE = `0x${'a'.repeat(40)}` as Address
const RELAYER = `0x${'7'.repeat(40)}` as const
const COLLECT_SELECTOR = toFunctionSelector('collect((uint256,address,uint128,uint128))')
const Q96 = 1n << 96n

/** A fake client: eth_simulateV1 answers `collect` from a configured map (tokenId -> [amount0, amount1]), success
 * for anything else; QuoterV2 answers 1:1 (both sides of pool:USDC/USDT/100 are 6-decimal). */
function world(collectReturns: Record<string, [bigint, bigint]> = {}) {
  const client = {
    request: async ({ params }: { params: [{ blockStateCalls: [{ calls: { to: string; data: Hex }[] }] }] }) => {
      const calls = params[0].blockStateCalls[0].calls
      const out = calls.map((c) => {
        if (c.data.startsWith(COLLECT_SELECTOR)) {
          const { args } = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: c.data })
          const tokenId = (args[0] as { tokenId: bigint }).tokenId.toString()
          const [a0, a1] = collectReturns[tokenId] ?? [0n, 0n]
          return { status: '0x1', returnData: encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', result: [a0, a1] }), gasUsed: '0x5208', logs: [] }
        }
        return { status: '0x1', returnData: '0x', gasUsed: '0x5208', logs: [] }
      })
      return [{ calls: out }]
    },
    call: async ({ to, data }: { to: string; data: Hex }) => {
      if (to.toLowerCase() === address('QuoterV2').toLowerCase()) {
        const { args } = decodeFunctionData({ abi: quoterV2Abi, data })
        const amountIn = (args[0] as { amountIn: bigint }).amountIn
        return { data: encodeFunctionResult({ abi: quoterV2Abi, functionName: 'quoteExactInputSingle', result: [amountIn, 0n, 0, 0n] }) }
      }
      throw new Error(`unexpected call to ${to}`)
    },
  } as unknown as PublicClient
  const relayer = { address: RELAYER } as unknown as Relayer
  const store = { state: { accounts: {} }, save: () => {} } as unknown as StateStore
  const cfg = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 } satisfies OperatorConfig
  return { op: new Operator(cfg, client, relayer, store) }
}

function acc(): AccountState {
  return { accountKey: 'k', ctx: {} as AccountState['ctx'], trusted: false, active: false, grants: [], revoked: [], managedTokenIds: [], depositsAfter: '0', historyFromBlock: '0', epoch: 0, ops: [], seq: 0 }
}

type ReducePlanFn = (acc: AccountState, safe: Address, r: SafeRead, amount: bigint, slip: number) => Promise<{ reduce: { pos: PoolPosition; bps: number }[]; swaps: { token: string; amountIn: bigint; amountOutMinimum: bigint }[] }>
const reducePlanOf = (op: Operator) => (op as unknown as { reducePlan: ReducePlanFn }).reducePlan.bind(op) as ReducePlanFn

describe('otto/mamoru#140 part1 #4: idle non-USDC tokens and stranded tokensOwed do not lock a withdrawal', () => {
  test('zero open LP positions, idle USDT: the withdrawal still completes by swapping the idle token', async () => {
    const { op } = world()
    const r: SafeRead = {
      block: 1n,
      deployed: true,
      eth: 0n,
      usdc: 1_000_000n,
      cbbtc: 0n,
      sqrtPriceX96: Q96,
      tick: 0,
      tokens: { USDC: 1_000_000n, USDT: 5_000_000n },
      prices: { 'pool:USDC/USDT/100': { sqrtPriceX96: Q96, tick: 0 } },
      positions: [],
    }
    const plan = await reducePlanOf(op)(acc(), SAFE, r, 4_000_000n, 50)
    expect(plan.reduce).toEqual([])
    expect(plan.swaps).toHaveLength(1)
    expect(plan.swaps[0]).toMatchObject({ token: 'USDT' })
  })

  test('zero open LP positions, no idle tokens either: still a clean INSUFFICIENT_FUNDS, not a crash', async () => {
    const { op } = world()
    const r: SafeRead = {
      block: 1n,
      deployed: true,
      eth: 0n,
      usdc: 1_000_000n,
      cbbtc: 0n,
      sqrtPriceX96: Q96,
      tick: 0,
      tokens: { USDC: 1_000_000n },
      prices: {},
      positions: [],
    }
    const err = await reducePlanOf(op)(acc(), SAFE, r, 4_000_000n, 50).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe('INSUFFICIENT_FUNDS')
  })

  test('a position with liquidity fully decreased but USDC still owed (tokensOwed0) is still collected', async () => {
    const pos: PoolPosition = {
      tokenId: 1n,
      pool: 'pool:USDC/USDT/100',
      token0: 'USDC',
      token1: 'USDT',
      fee: 100,
      liquidity: 0n,
      tickLower: 0,
      tickUpper: 1,
      inRange: false,
      amount0: 0n,
      amount1: 0n,
      tokensOwed0: 3_000_000n,
      tokensOwed1: 0n,
    }
    const { op } = world({ '1': [3_000_000n, 0n] })
    const r: SafeRead = {
      block: 1n,
      deployed: true,
      eth: 0n,
      usdc: 1_000_000n,
      cbbtc: 0n,
      sqrtPriceX96: Q96,
      tick: 0,
      tokens: { USDC: 1_000_000n },
      prices: { 'pool:USDC/USDT/100': { sqrtPriceX96: Q96, tick: 0 } },
      positions: [pos],
    }
    const plan = await reducePlanOf(op)(acc(), SAFE, r, 4_000_000n, 50)
    expect(plan.reduce).toHaveLength(1)
  })
})
