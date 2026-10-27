import { describe, expect, test } from 'bun:test'
import { conservadorLiveV7, grantKey } from '@mamoru/policy'
import { baseRegistry, address, entry } from '@mamoru/registry'
import { quoteMint, sqrtRatioAtTick, token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { allocate, bucketValues, decide, type Observation, type PoolObs, type PositionObs, type VaultObs } from './index.ts'

// otto/mamoru#210: conservador-live-v7, the stables bucket in ERC-4626 vaults (Morpho gtUSDCp first, Aave waBasUSDC).
const V7 = conservadorLiveV7
const USDC = 1_000_000n
/** gtUSDCp has 18-decimal shares worth ~1.117 USDC each. */
const ONE_SHARE = 10n ** 18n
const PRICE = 1_117_043n

function pool(name: string, tick: number): PoolObs {
  const e = entry(name, baseRegistry)
  return {
    name,
    address: e.address,
    token0: e.token0!,
    token1: e.token1!,
    fee: e.fee!,
    tickSpacing: e.tickSpacing!,
    sqrtPriceX96: sqrtRatioAtTick(tick),
    tick,
    liquidity: 10n ** 18n,
    twapTick: tick,
    identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}

const POOLS = [pool('pool:USDC/USDT/100', 1), pool('pool:USDC/cbBTC/500', -69_080), pool('pool:WETH/USDC/3000', -193_380)]

function vault(name: string, assets: bigint, over: Partial<VaultObs> = {}): VaultObs {
  const shares = name === 'vault:gtUSDCp' ? (assets * ONE_SHARE) / PRICE : assets
  return { name, shares, assets, maxWithdraw: assets, maxDeposit: 10n ** 30n, maxRedeem: shares, ...over } as VaultObs
}

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: V7.session.grants.map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 0n, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: POOLS,
    vaults: [vault('vault:gtUSDCp', 0n), vault('vault:waBasUSDC', 0n)],
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    remote: { value: 0n, inFlight: 0n, ready: false },
    ...over,
  }
}

/** Applies what the chain would do with the proposal (no fees, share price fixed). */
function apply(o: Observation, nextId: bigint): Observation {
  const p = decide(o, V7).proposal
  if (!p) return o
  const balances = { ...o.balances }
  if (p.kind === 'vault_deposit') {
    balances.USDC = balances.USDC! - p.assets
    const vaults = o.vaults!.map((v) => (v.name === p.vault ? vault(v.name, v.assets + p.assets) : v))
    return { ...o, balances, vaults }
  }
  const pl = o.pools.find((x) => x.name === p.pool)!
  if (p.kind === 'enter_swap') {
    const out = pl.token0 === p.tokenIn ? token0InToken1(p.amountIn, pl.sqrtPriceX96) : token1InToken0(p.amountIn, pl.sqrtPriceX96)
    balances[p.tokenIn] = balances[p.tokenIn]! - p.amountIn
    balances[p.tokenOut] = (balances[p.tokenOut] ?? 0n) + out
    return { ...o, balances }
  }
  if (p.kind !== 'enter_mint') throw new Error(`unexpected ${p.kind}`)
  const q = quoteMint({ sqrtPriceX96: pl.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps: 50 })
  balances[pl.token0] = balances[pl.token0]! - q.amount0
  balances[pl.token1] = balances[pl.token1]! - q.amount1
  const pos: PositionObs = { tokenId: nextId, pool: pl.name, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: q.liquidity, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
  return { ...o, balances, positions: [...o.positions, pos] }
}

function run(o: Observation, steps = 12): Observation {
  let id = 1n
  for (let i = 0; i < steps; i++) {
    const p = decide(o, V7).proposal
    if (!p || (p.kind !== 'enter_swap' && p.kind !== 'enter_mint' && p.kind !== 'vault_deposit')) break
    o = apply(o, id++)
  }
  return o
}

describe('conservador-live-v7: the stables bucket in vaults (otto/mamoru#210)', () => {
  test('1,000 USDC: the first op supplies the 50 % Stable share to gtUSDCp, under its own vault-supply session', () => {
    const d = decide(obs({ balances: { USDC: 1_000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V7)
    expect(d.code).toBe('DECIDE_ENTER')
    expect(d.proposal).toMatchObject({ kind: 'vault_deposit', grant: 'vault-supply:vault:gtUSDCp', bucket: 'stables', pool: 'vault:gtUSDCp', vault: 'vault:gtUSDCp' })
    const assets = (d.proposal as { assets: bigint }).assets
    expect(assets > 495n * USDC && assets <= 500n * USDC).toBe(true)
    expect(d.trail.at(-1)).toEqual({ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' })
    // No pool identity check for a vault: the trail has no purga step.
    expect(d.trail.some((t) => t.gate === 'purga')).toBe(false)
  })

  test('to the end: 500 in the vault, 350 in WETH/USDC, the Growth 15 % waits for the sleeve, nothing in USDC/USDT or cbBTC', () => {
    const o = run(obs({ balances: { USDC: 1_000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }))
    const inVault = o.vaults!.find((v) => v.name === 'vault:gtUSDCp')!.assets
    expect(inVault > 495n * USDC && inVault <= 500n * USDC).toBe(true)
    expect(o.vaults!.find((v) => v.name === 'vault:waBasUSDC')!.assets).toBe(0n)
    expect(o.positions.map((p) => p.pool)).toEqual(['pool:WETH/USDC/3000'])
    const a = allocate(o, V7, false)
    const row = a.buckets.find((b) => b.bucket === 'stables')!
    expect(row.value).toBe(inVault)
    expect(a.total > 995n * USDC && a.total <= 1_000n * USDC).toBe(true)
    const d = decide(o, V7)
    expect(d.proposal).toBeNull()
    expect((d.waiting ?? []).find((w) => w.code === 'DECIDE_WAIT_BRIDGE')?.bucket).toBe('growth')
  })

  test('a Stable share under the 40 USDC vault floor waits as savings (DECIDE_WAIT_GAS), the other buckets still enter', () => {
    const d = decide(obs({ balances: { USDC: 60n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V7)
    expect(d.proposal?.kind).not.toBe('vault_deposit')
    expect(d.buckets.find((b) => b.bucket === 'stables')?.code).toBe('DECIDE_WAIT_GAS')
    const w = (d.waiting ?? []).find((x) => x.bucket === 'stables')
    expect(w?.code).toBe('DECIDE_WAIT_GAS')
    expect(w!.amount).toBe(30n * USDC)
  })

  test('gtUSDCp full or without a session: Aave waBasUSDC takes the deposit; neither open: the share waits', () => {
    const base = { balances: { USDC: 1_000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }
    const full = decide(obs({ ...base, vaults: [vault('vault:gtUSDCp', 0n, { maxDeposit: 0n }), vault('vault:waBasUSDC', 0n)] }), V7)
    expect(full.proposal).toMatchObject({ kind: 'vault_deposit', vault: 'vault:waBasUSDC', grant: 'vault-supply:vault:waBasUSDC' })
    const sessions = obs().sessions.filter((s) => s.grant !== 'vault-supply:vault:gtUSDCp')
    expect(decide(obs({ ...base, sessions }), V7).proposal).toMatchObject({ kind: 'vault_deposit', vault: 'vault:waBasUSDC' })
    const closed = decide(obs({ ...base, vaults: [vault('vault:gtUSDCp', 0n, { maxDeposit: 0n }), vault('vault:waBasUSDC', 0n, { maxDeposit: 0n })] }), V7)
    expect(closed.proposal?.kind).not.toBe('vault_deposit')
    expect(closed.buckets.find((b) => b.bucket === 'stables')?.code).toBe('DECIDE_WAIT_VAULT_LIQUIDITY')
  })

  test('no session for either vault: the deposit is proposed and the EHG holds it as SESSION_MISSING (the renewal row)', () => {
    const sessions = obs().sessions.filter((s) => !s.grant.startsWith('vault-supply'))
    const d = decide(obs({ balances: { USDC: 1_000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n }, sessions }), V7)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('SESSION_MISSING')
  })

  test('an over-weight vault bucket redeems its excess in shares, from the last vault first, never more than it can pay', () => {
    // 900 in vaults against 100 elsewhere: target ~500 (50 % of 1,000), so ~400 goes back.
    const o = obs({ vaults: [vault('vault:gtUSDCp', 600n * USDC), vault('vault:waBasUSDC', 300n * USDC)], balances: { USDC: 100n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } })
    const d = decide(o, V7)
    expect(d.proposal).toMatchObject({ kind: 'vault_redeem', vault: 'vault:waBasUSDC', grant: 'vault-supply:vault:waBasUSDC', assets: 300n * USDC, shares: 300n * USDC })
    // The Aave vault empty: the Morpho excess, in its own shares.
    const morpho = decide(obs({ vaults: [vault('vault:gtUSDCp', 900n * USDC), vault('vault:waBasUSDC', 0n)], balances: { USDC: 100n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V7)
    const r = morpho.proposal as { kind: string; shares: bigint; assets: bigint }
    expect(r.kind).toBe('vault_redeem')
    expect(r.assets).toBe(400n * USDC)
    expect(r.shares).toBe(((900n * USDC * ONE_SHARE) / PRICE) * 400n / 900n)
    // A vault lent out to its last cent: nothing is proposed and the bucket says it waits for liquidity.
    const dry = decide(obs({ vaults: [vault('vault:gtUSDCp', 900n * USDC, { maxWithdraw: 0n }), vault('vault:waBasUSDC', 0n)], balances: { USDC: 100n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V7)
    expect(dry.proposal?.kind).not.toBe('vault_redeem')
    expect(dry.buckets.some((b) => b.bucket === 'stables' && b.code === 'DECIDE_WAIT_VAULT_LIQUIDITY')).toBe(true)
    // Part of it payable: that part goes now.
    const part = decide(obs({ vaults: [vault('vault:gtUSDCp', 900n * USDC, { maxWithdraw: 150n * USDC }), vault('vault:waBasUSDC', 0n)], balances: { USDC: 100n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V7)
    expect(part.proposal).toMatchObject({ kind: 'vault_redeem', assets: 150n * USDC })
  })

  test('review of #153: a liquidity-capped redeem never asks for more shares than maxRedeem', () => {
    const v = vault('vault:gtUSDCp', 900n * USDC)
    // maxWithdraw 150, but the vault redeems one share fewer than 150 USDC's worth at its own rounding.
    const capped = { ...v, maxWithdraw: 150n * USDC, maxRedeem: (v.shares * 150n) / 900n - 1n }
    const d = decide(obs({ vaults: [capped, vault('vault:waBasUSDC', 0n)], balances: { USDC: 100n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V7)
    // 99 % of what it redeems: never its edge.
    expect(d.proposal).toMatchObject({ kind: 'vault_redeem', shares: (capped.maxRedeem * 9_900n) / 10_000n })
  })

  test('review of #153: a vault waiting for liquidity does not hold back the USDC/USDT migration', () => {
    const lp = POOLS[0]!
    const held: PositionObs = { tokenId: 7n, pool: lp.name, tickLower: -10, tickUpper: 10, liquidity: 10n ** 9n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
    // The vault is over its target (900 of ~1,000) and pays nothing now; the old position must still leave.
    const d = decide(obs({ positions: [held], vaults: [vault('vault:gtUSDCp', 900n * USDC, { maxWithdraw: 0n, maxRedeem: 0n }), vault('vault:waBasUSDC', 0n)], balances: { USDC: 100n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V7)
    expect(d.proposal).toMatchObject({ kind: 'reduce', pool: 'pool:USDC/USDT/100', tokenId: 7n })
  })

  test('review of #153: dust left in a bucket being left is skipped, never a block on the buckets after it', () => {
    const lp = POOLS[0]!
    // A few units of liquidity: worth far less than its op, so no reduce of it; the over-weight vault still redeems.
    const dust: PositionObs = { tokenId: 8n, pool: lp.name, tickLower: -10, tickUpper: 10, liquidity: 1_000n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
    const d = decide(obs({ positions: [dust], vaults: [vault('vault:gtUSDCp', 900n * USDC), vault('vault:waBasUSDC', 0n)], balances: { USDC: 100n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V7)
    expect(d.proposal).toMatchObject({ kind: 'vault_redeem', vault: 'vault:gtUSDCp' })
  })

  test('within the drift band a vault bucket is left alone', () => {
    const d = decide(obs({ vaults: [vault('vault:gtUSDCp', 520n * USDC), vault('vault:waBasUSDC', 0n)], balances: { USDC: 480n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V7)
    expect(d.proposal?.kind).not.toBe('vault_redeem')
  })

  test('migration: an old USDC/USDT position (stables-lp, target 0) is reduced in full, however small, and USDT sold back', () => {
    const lp = POOLS[0]!
    const small: PositionObs = { tokenId: 7n, pool: lp.name, tickLower: -10, tickUpper: 10, liquidity: 10n ** 9n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
    // The position is a few percent of the account: under v6's drift band it would never leave.
    const o = obs({ positions: [small], vaults: [vault('vault:gtUSDCp', 500n * USDC), vault('vault:waBasUSDC', 0n)], balances: { USDC: 500n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } })
    const b = bucketValues(o, V7, new Set(V7.buckets.flatMap((x) => x.pools))).buckets.find((x) => x.bucket === 'stables-lp')!
    expect(b.value > 0n && b.value * 100n < 1_000n * USDC * 5n).toBe(true)
    const d = decide(o, V7)
    expect(d.proposal).toMatchObject({ kind: 'reduce', pool: 'pool:USDC/USDT/100', tokenId: 7n, liquidity: 10n ** 9n, grant: 'manage-any:pool:USDC/USDT/100' })
    const idle = decide(obs({ vaults: [vault('vault:gtUSDCp', 500n * USDC), vault('vault:waBasUSDC', 0n)], balances: { USDC: 500n * USDC, USDT: 20n * USDC, cbBTC: 0n, WETH: 0n } }), V7)
    expect(idle.proposal).toMatchObject({ kind: 'enter_swap', tokenIn: 'USDT', tokenOut: 'USDC', pool: 'pool:USDC/USDT/100' })
    // And no new money ever goes into USDC/USDT.
    const fresh = run(obs({ balances: { USDC: 1_000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }))
    expect(fresh.positions.some((p) => p.pool === 'pool:USDC/USDT/100')).toBe(false)
  })

  test('shares in a vault the policy does not name count for nothing and get no op', () => {
    const o = obs({ vaults: [vault('vault:gtUSDCp', 0n), vault('vault:waBasUSDC', 0n), { name: 'vault:other', shares: 10n ** 9n, assets: 10n ** 9n, maxWithdraw: 10n ** 9n, maxDeposit: 0n, maxRedeem: 10n ** 9n }] })
    expect(allocate(o, V7, false).total).toBe(0n)
    expect(decide(o, V7).proposal).toBeNull()
  })
})
