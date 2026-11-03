// otto/mamoru#348: the A1 batch builder and its validator against MamoruGasPolicyV2's shape and V4's checkAction.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { decodeFunctionData, getAddress, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, ethereumRegistry, monadRegistry } from '@mamoru/registry'
import { V4_DOMAIN_BY_CHAIN } from '@mamoru/policy'
import { A1_FIXTURE_CTX, A1_FIXTURE_INTENTS, A1_FIXTURE_PATH, a1Fixture, a1FixtureJson } from './a1-batch-fixture.ts'
import { a1Abi, a1CallData, a1ExpiresAt, A1_CHAINS, A1_CLOCK_SLACK, a1Shape, A1BatchError, buildA1Batch, buildA1CallData, checkA1Batch, type A1Intent } from './batch.ts'

const ctx = A1_FIXTURE_CTX
const USDC = A1_CHAINS[8453]!.stables[0]!
const CBBTC: Address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'
const DL = ctx.t + 300n
const swap = (amountIn: bigint, deadline = DL): A1Intent => ({ kind: 'swap', params: { pool: USDC, tokenIn: USDC, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 1n, deadline } })
const fnOf = (data: Hex) => decodeFunctionData({ abi: a1Abi, data }).functionName

describe('A1 batch parity fixture (contracts/action-policy/test/A1BatchParity.t.sol)', () => {
  test('the committed fixture is what the TypeScript builds', () => {
    expect(readFileSync(A1_FIXTURE_PATH, 'utf8')).toBe(a1FixtureJson())
  })

  test('a1Shape gives the gas policy verdict and checkA1Batch the full one, for every case', () => {
    const f = a1Fixture()
    expect(f.cases.length).toBeGreaterThan(30)
    for (const c of f.cases) {
      expect({ name: c.name, shape: a1Shape(c.callData, A1_CHAINS[8453]!.npm).ok }).toEqual({ name: c.name, shape: c.shape })
      expect({ name: c.name, check: checkA1Batch(c.callData, ctx).ok }).toEqual({ name: c.name, check: c.check })
    }
  })
})

describe('A1_CHAINS mirrors MamoruV4Chains and the registry files', () => {
  test('position manager, wrapped native, stables and domain per chain', () => {
    for (const [reg, stables, wrapped] of [
      [baseRegistry, ['USDC', 'USDT'], 'WETH'],
      [monadRegistry, ['USDC'], 'WMON'],
      [ethereumRegistry, ['USDC'], 'WETH'],
    ] as const) {
      const c = A1_CHAINS[reg.chainId]!
      expect(c.npm).toBe(address('NonfungiblePositionManager', reg))
      expect(c.wrapped).toBe(address(wrapped, reg))
      expect(c.stables).toEqual(stables.map((s) => address(s, reg)))
      expect(c.domain).toBe(V4_DOMAIN_BY_CHAIN[reg.chainId]!)
    }
  })
})

describe('buildA1Batch', () => {
  test('clock(T) on V4 first; every approval reset and asserted right after its action', () => {
    for (const [name, intents] of A1_FIXTURE_INTENTS) {
      const xs = buildA1Batch(ctx, intents)
      expect({ name, first: fnOf(xs[0]!.callData), target: xs[0]!.target }).toEqual({ name, first: 'clock', target: ctx.policy })
      expect(checkA1Batch(xs, { ...ctx, now: ctx.t }).ok).toBe(true)
    }
    const xs = buildA1Batch(ctx, [swap(5n)])
    expect(xs.map((x) => fnOf(x.callData))).toEqual(['clock', 'approve', 'swap', 'approve', 'assertZero'])
  })

  test('an exit is checkExit immediately before the decrease, then collect and burn', () => {
    const xs = buildA1Batch(ctx, [{ kind: 'decrease', tokenId: 9n, liquidity: 5n, amount0Min: 1n, amount1Min: 2n, deadline: DL, burn: true, positionLiquidity: 5n }])
    expect(xs.map((x) => fnOf(x.callData))).toEqual(['clock', 'checkExit', 'decreaseLiquidity', 'collect', 'burn'])
    expect(xs[2]!.target).toBe(A1_CHAINS[8453]!.npm)
    const c = decodeFunctionData({ abi: a1Abi, data: xs[3]!.callData })
    expect((c.args![0] as { recipient: Address }).recipient).toBe(getAddress(ctx.account))
  })

  test('a mint approves both tokens, resets both; an increase with one side skips the other approval', () => {
    const mint = buildA1Batch(ctx, [{ kind: 'mint', params: { token0: USDC, token1: CBBTC, fee: 500, tickLower: -10, tickUpper: 10, amount0Desired: 1n, amount1Desired: 2n, amount0Min: 0n, amount1Min: 0n, recipient: ctx.account, deadline: DL } }])
    expect(mint.map((x) => fnOf(x.callData))).toEqual(['clock', 'approve', 'approve', 'mint', 'approve', 'assertZero', 'approve', 'assertZero'])
    const inc = buildA1Batch(ctx, [{ kind: 'increase', token0: USDC, token1: CBBTC, params: { tokenId: 1n, amount0Desired: 0n, amount1Desired: 2n, amount0Min: 0n, amount1Min: 0n, deadline: DL } }])
    expect(inc.map((x) => [fnOf(x.callData), x.target])).toEqual([['clock', ctx.policy], ['approve', CBBTC], ['increase', ctx.policy], ['approve', CBBTC], ['assertZero', ctx.policy]])
  })

  test('the sibling: wrap carries the value, then approve WETH + swap', () => {
    const xs = buildA1Batch({ ...ctx, chainId: 1 }, [{ kind: 'wrap', amount: 7n }, { kind: 'swap', params: { pool: USDC, tokenIn: A1_CHAINS[1]!.wrapped, amountIn: 7n, amountOutMinimum: 1n, sqrtPriceLimitX96: 1n, deadline: DL } }])
    expect(xs[1]).toEqual({ target: A1_CHAINS[1]!.wrapped, value: 7n, callData: '0xd0e30db0' })
    expect(xs.slice(2).every((x) => x.value === 0n)).toBe(true)
  })

  test('refuses what V4 would refuse', () => {
    const bad: [string, A1Intent[], Partial<typeof ctx>?][] = [
      ['no intent', []],
      ['swap of 0', [swap(0n)]],
      ['expired swap', [swap(5n, ctx.t - 1n)]],
      ['a swap deadline inside the op window (T + S - 1)', [swap(5n, ctx.t + A1_CLOCK_SLACK - 1n)]],
      ['burn without taking all the liquidity', [{ kind: 'decrease', tokenId: 1n, liquidity: 4n, amount0Min: 0n, amount1Min: 0n, deadline: DL, burn: true, positionLiquidity: 5n }]],
      ['burn without the position liquidity read', [{ kind: 'decrease', tokenId: 1n, liquidity: 4n, amount0Min: 0n, amount1Min: 0n, deadline: DL, burn: true }]],
      ['burn without the collect', [{ kind: 'decrease', tokenId: 1n, liquidity: 5n, amount0Min: 0n, amount1Min: 0n, deadline: DL, burn: true, positionLiquidity: 5n, collect: false }]],
      ['a bare burn without its collect first', [{ kind: 'burn', tokenId: 1n }, { kind: 'collect', tokenId: 1n }]],
      ['mint to someone else', [{ kind: 'mint', params: { token0: USDC, token1: CBBTC, fee: 500, tickLower: -10, tickUpper: 10, amount0Desired: 1n, amount1Desired: 2n, amount0Min: 0n, amount1Min: 0n, recipient: CBBTC, deadline: DL } }]],
      ['bridge maxFee over 10 bps', [{ kind: 'bridge', domain: 15, token: USDC, amount: 10_000n, maxFee: 11n }]],
      ['bridge to its own domain', [{ kind: 'bridge', domain: 6, token: USDC, amount: 1n, maxFee: 0n }]],
      ['bridge to a domain outside the table', [{ kind: 'bridge', domain: 3, token: USDC, amount: 1n, maxFee: 0n }]],
      ['bridge of a token that is not a pinned stable', [{ kind: 'bridge', domain: 15, token: CBBTC, amount: 1n, maxFee: 0n }]],
      ['bridge of 0', [{ kind: 'bridge', domain: 15, token: USDC, amount: 0n, maxFee: 0n }]],
      ['decrease of 0 liquidity', [{ kind: 'decrease', tokenId: 1n, liquidity: 0n, amount0Min: 0n, amount1Min: 0n, deadline: DL }]],
      ['wrap of 0', [{ kind: 'wrap', amount: 0n }]],
      ['registerRemote without a key', [{ kind: 'registerRemote', domain: 15, sessionKey: '0x0000000000000000000000000000000000000000' }]],
      ['registerRemote on its own domain', [{ kind: 'registerRemote', domain: 6, sessionKey: CBBTC }]],
      ['announceReady to its own domain', [{ kind: 'announceReady', safe: ctx.account, toDomain: 6, sessionKey: CBBTC, permissionId: `0x${'0d'.repeat(32)}` }]],
      ['deposit of a non-stable asset', [{ kind: 'deposit', vault: CBBTC, asset: CBBTC, assets: 1n }]],
      ['a chain outside the table', [swap(5n)], { chainId: 10 }],
      ['a claimed time at the slack', [swap(5n, 10_000n)], { t: 300n }],
    ]
    for (const [name, intents, over] of bad) expect({ name, threw: (() => { try { buildA1Batch({ ...ctx, ...over }, intents); return false } catch (e) { return e instanceof A1BatchError } })() }).toEqual({ name, threw: true })
  })

  test('callData is always batch mode; checkA1Batch refuses a claimed time past the slack', () => {
    expect(() => a1CallData([buildA1Batch(ctx, [swap(5n)])[0]!])).toThrow(A1BatchError)
    const { callData } = buildA1CallData(ctx, [swap(5n)])
    expect(callData.slice(0, 10)).toBe('0xe9ae5c53')
    expect(checkA1Batch(callData, { ...ctx, now: ctx.t + A1_CLOCK_SLACK }).ok).toBe(true)
    expect(checkA1Batch(callData, { ...ctx, now: ctx.t + A1_CLOCK_SLACK + 1n }).ok).toBe(false)
    expect(checkA1Batch(callData, { ...ctx, now: ctx.t - A1_CLOCK_SLACK - 1n }).ok).toBe(false)
    // validAfter is strict in the EntryPoint: now == T - S is still too early
    expect(checkA1Batch(callData, { ...ctx, now: ctx.t - A1_CLOCK_SLACK }).ok).toBe(false)
    expect(checkA1Batch(callData, { ...ctx, now: ctx.t - A1_CLOCK_SLACK + 1n }).ok).toBe(true)
    expect(a1ExpiresAt(ctx.t)).toBe(ctx.t + A1_CLOCK_SLACK)
  })
})
