import { describe, expect, test } from 'bun:test'
import { conservadorLiveV8, grantKey, v7EnginePolicy } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { allocate, bucketObs, decide, positionValue, savingsSweepOf, type Observation, type PoolObs, type PositionObs, type VaultObs } from './index.ts'

// otto/mamoru#413 (spec 012 savings-layer.md): harvested USDC is savings in the Stable vault, outside the bucket weights.
// conservador-live-v8 as the engine runs it (Stable 50 in vaults / WETH-USDC 25 / USDC-cbBTC 25, vault floor 1 USDC).
const V8 = v7EnginePolicy(conservadorLiveV8)
const USDC = 1_000_000n
const ONE_SHARE = 10n ** 18n
/** gtUSDCp: 18-decimal shares worth ~1.117 USDC each. */
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

const WETH = pool('pool:WETH/USDC/3000', -193_380)
const BTC = pool('pool:USDC/cbBTC/500', -69_080)
const POOLS = [pool('pool:USDC/USDT/100', 1), BTC, WETH]

const sharesOf = (assets: bigint) => (assets * ONE_SHARE) / PRICE

function vault(name: string, assets: bigint, over: Partial<VaultObs> = {}): VaultObs {
  const shares = name === 'vault:gtUSDCp' ? sharesOf(assets) : assets
  return { name, shares, assets, maxWithdraw: assets, maxDeposit: 10n ** 30n, maxRedeem: shares, ...over } as VaultObs
}

/** A position in `p` worth `value` raw USDC at the pool price. */
function position(p: PoolObs, tokenId: bigint, value: bigint): PositionObs {
  const probe: PositionObs = { tokenId, pool: p.name, tickLower: p.tick - 600, tickUpper: p.tick + 600, liquidity: 10n ** 15n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
  return { ...probe, liquidity: (probe.liquidity * value) / positionValue(probe, p, 'USDC') }
}

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: V8.session.grants.map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000, active: true })),
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
    ...over,
  }
}

/**
 * A 1,000 USDC account on its v8 targets (500 Stable in gtUSDCp, 250 in each pool), plus `savings` USDC of savings
 * shares in the same vault and `pending` harvested USDC in the Safe.
 */
function account(stable: bigint, savings = 0n, pending = 0n, over: Partial<Observation> = {}): Observation {
  return obs({
    balances: { USDC: pending, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions: [position(WETH, 1n, 250n * USDC), position(BTC, 2n, 250n * USDC)],
    vaults: [vault('vault:gtUSDCp', stable + savings), vault('vault:waBasUSDC', 0n)],
    ...(savings > 0n || pending > 0n ? { savings: { pending, shares: savings > 0n ? { 'vault:gtUSDCp': sharesOf(savings) } : {} } } : {}),
    ...over,
  })
}


describe('the bucket books (SAV-R4)', () => {
  test('without savings the observation is the same object, and decides as before', () => {
    const o = account(500n * USDC)
    expect(bucketObs(o, V8)).toBe(o)
  })

  test('pending savings come off the USDC, savings shares off the vault, at its rate; taken twice changes nothing', () => {
    const o = account(500n * USDC, 200n * USDC, 3n * USDC, { balances: { USDC: 10n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } })
    const b = bucketObs(o, V8)
    expect(b.balances.USDC).toBe(7n * USDC)
    const gt = b.vaults!.find((v) => v.name === 'vault:gtUSDCp')!
    const held = o.vaults!.find((v) => v.name === 'vault:gtUSDCp')!
    expect(gt.shares).toBe(held.shares - sharesOf(200n * USDC))
    // Floored at the vault's rate: never above the 500 the bucket put in.
    expect(gt.assets <= 500n * USDC && gt.assets >= 500n * USDC - 2n).toBe(true)
    expect(gt.maxRedeem).toBe(gt.shares)
    expect(b.savings).toBeUndefined()
    expect(bucketObs(b, V8)).toBe(b)
  })

  test('books above what is held are clipped to it: never a negative balance or share count', () => {
    const o = obs({ balances: { USDC: 2n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n }, vaults: [vault('vault:gtUSDCp', 10n * USDC), vault('vault:waBasUSDC', 0n)], savings: { pending: 5n * USDC, shares: { 'vault:gtUSDCp': sharesOf(50n * USDC) } } })
    const b = bucketObs(o, V8)
    expect(b.balances.USDC).toBe(0n)
    expect(b.vaults![0]!.shares).toBe(0n)
    expect(b.vaults![0]!.assets).toBe(0n)
  })

  test('targets are computed on bucket principal: 200 of savings change no target and no weight (SAV-S4)', () => {
    const plain = allocate(account(500n * USDC), V8, false)
    const withSavings = allocate(bucketObs(account(500n * USDC, 200n * USDC, 3n * USDC), V8), V8, false)
    expect(withSavings.total).toBe(plain.total)
    expect(withSavings.buckets.map((b) => [b.bucket, b.target, b.weightBps])).toEqual(plain.buckets.map((b) => [b.bucket, b.target, b.weightBps]))
  })

  test('the drain band never redeems savings: the same shares untagged would be redeemed (SAV-S4)', () => {
    // 700 of shares in gtUSDCp on 1,200: 58 % Stable, past target + 5 points.
    const untagged = decide(account(700n * USDC), V8)
    expect(untagged.proposal?.kind).toBe('vault_redeem')
    // 500 of bucket and 200 of savings in the same vault: the bucket is on its target.
    const tagged = decide(account(500n * USDC, 200n * USDC), V8)
    expect(tagged.proposal?.kind).not.toBe('vault_redeem')
  })

  test('an over-weight bucket redeems exactly what it would without savings, never into the savings shares', () => {
    const without = decide(account(700n * USDC), V8).proposal
    const withSavings = decide(account(700n * USDC, 1_000n * USDC), V8).proposal
    expect(without?.kind).toBe('vault_redeem')
    expect(withSavings).toEqual(without)
  })
})

describe('the savings deposit (SAV-R1, R2)', () => {
  test('harvested USDC goes to the vault tagged savings, not into the pools (SAV-S1)', () => {
    // The risk bucket is 100 short: untagged, the same 50 USDC would go into WETH/USDC.
    const short = (o: Partial<Observation>) => account(500n * USDC, 0n, 0n, { positions: [position(WETH, 1n, 150n * USDC), position(BTC, 2n, 250n * USDC)], ...o })
    const untagged = decide(short({ balances: { USDC: 50n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } }), V8)
    expect(untagged.proposal?.kind).toBe('enter_swap')
    const d = decide(short({ balances: { USDC: 50n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n }, savings: { pending: 50n * USDC, shares: {} } }), V8)
    expect(d.proposal).toEqual({ kind: 'vault_deposit', grant: 'vault-supply:vault:gtUSDCp', bucket: 'stables', pool: 'vault:gtUSDCp', vault: 'vault:gtUSDCp', assets: 50n * USDC, savings: true })
    expect(d.trail.at(-1)).toEqual({ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' })
  })

  test('free bucket money next to pending savings: the entry spends only the bucket money', () => {
    const o = account(500n * USDC, 0n, 0n, { positions: [position(WETH, 1n, 150n * USDC), position(BTC, 2n, 250n * USDC)], balances: { USDC: 100n * USDC + 40n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n }, savings: { pending: 40n * USDC, shares: {} } })
    // The savings deposit goes first; with it done, the entry sees 100 free, not 140.
    expect(decide(o, V8).proposal).toMatchObject({ kind: 'vault_deposit', savings: true, assets: 40n * USDC })
    const a = allocate(bucketObs(o, V8), V8, false)
    expect(a.free).toBe(100n * USDC)
    expect(a.proposal?.kind).toBe('enter_swap')
    expect((a.proposal as { amountIn: bigint }).amountIn <= 100n * USDC).toBe(true)
  })

  test('under the vault floor it waits silently and adds up; at the floor it goes (SAV-S2)', () => {
    const at = (pending: bigint) => decide(account(500n * USDC, 0n, pending), V8)
    const small = at(900_000n)
    expect(small.proposal).toBeNull()
    expect(small.buckets.some((b) => b.code === 'DECIDE_WAIT_BUDGET')).toBe(false)
    expect(at(1n * USDC).proposal).toMatchObject({ kind: 'vault_deposit', savings: true, assets: 1n * USDC })
  })

  test('V4 room short of the all-positions reserve: it waits with DECIDE_WAIT_BUDGET (SAV-S3, HRV-R7)', () => {
    const d = decide(account(500n * USDC, 0n, 5n * USDC, { budget: { room: 10n * USDC } }), V8)
    expect(d.proposal).toBeNull()
    expect(d.buckets).toContainEqual({ bucket: 'stables', code: 'DECIDE_WAIT_BUDGET' })
    // Room for the deposit plus 1.5 x the 500 of positions: it goes.
    expect(decide(account(500n * USDC, 0n, 5n * USDC, { budget: { room: 800n * USDC } }), V8).proposal).toMatchObject({ kind: 'vault_deposit', savings: true })
  })

  test('the V4 vault ratio caps it; under the floor it waits', () => {
    const capped = savingsSweepOf(account(500n * USDC, 0n, 30n * USDC, { budget: { room: 10_000n * USDC, vaultRoom: 12n * USDC } }), V8)
    expect(capped.proposal?.assets).toBe(12n * USDC)
    const full = savingsSweepOf(account(500n * USDC, 0n, 30n * USDC, { budget: { room: 10_000n * USDC, vaultRoom: 500_000n } }), V8)
    expect(full).toEqual({ proposal: null, wait: { bucket: 'stables', code: 'DECIDE_WAIT_BUDGET' } })
  })

  test('the first vault full or without a session: the next one takes it; none open: it waits for liquidity', () => {
    const full = account(500n * USDC, 0n, 5n * USDC)
    full.vaults = [vault('vault:gtUSDCp', 500n * USDC, { maxDeposit: 0n }), vault('vault:waBasUSDC', 0n)]
    expect(savingsSweepOf(full, V8).proposal).toMatchObject({ vault: 'vault:waBasUSDC', savings: true })
    full.vaults = [vault('vault:gtUSDCp', 500n * USDC, { maxDeposit: 0n }), vault('vault:waBasUSDC', 0n, { maxDeposit: 0n })]
    expect(savingsSweepOf(full, V8)).toEqual({ proposal: null, wait: { bucket: 'stables', code: 'DECIDE_WAIT_VAULT_LIQUIDITY' } })
  })

  test('never with an unsafe deposit, an unread vault, or the stables bucket held still', () => {
    const o = account(500n * USDC, 0n, 5n * USDC)
    expect(savingsSweepOf({ ...o, deposits: [{ token: 'USDC', amount: 1n, safe: false } as Observation['deposits'][number]] }, V8).proposal).toBeNull()
    expect(savingsSweepOf({ ...o, vaultsUnread: ['vault:waBasUSDC'] }, V8).proposal).toBeNull()
    expect(savingsSweepOf(o, V8, new Set(['stables'])).proposal).toBeNull()
  })

  test('pending above the USDC held deposits only what is held', () => {
    const o = account(500n * USDC, 0n, 0n, { balances: { USDC: 3n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n }, savings: { pending: 8n * USDC, shares: {} } })
    expect(decide(o, V8).proposal).toMatchObject({ kind: 'vault_deposit', savings: true, assets: 3n * USDC })
  })

  test('after the deposit the books are a partition: bucket + savings = what the vault holds, and nothing moves (SAV-S7)', () => {
    const o = account(500n * USDC, 0n, 20n * USDC)
    const p = decide(o, V8).proposal as { kind: string; assets: bigint }
    expect(p.kind).toBe('vault_deposit')
    // What the chain and the books do with it: 20 USDC out of the Safe, its shares in gtUSDCp tagged savings.
    const after = account(500n * USDC, p.assets, 0n)
    const books = bucketObs(after, V8)
    const held = after.vaults![0]!.shares
    expect(books.vaults![0]!.shares + after.savings!.shares['vault:gtUSDCp']!).toBe(held)
    const next = decide(after, V8)
    expect(next.proposal).toBeNull()
    expect(allocate(books, V8, false).total).toBe(allocate(account(500n * USDC), V8, false).total)
  })

  test('the books hold no pool still: a harvest of the pools still goes first', () => {
    const o = account(500n * USDC, 0n, 20n * USDC)
    const rich = { ...o, positions: o.positions.map((p, i) => (i === 0 ? { ...p, collectable0: 10n ** 17n, collectable1: 300n * USDC } : p)) }
    expect(decide(rich, V8).proposal?.kind).toBe('harvest')
  })
})

describe('no savings, no change', () => {
  test('a policy with no vault bucket (Monad) never proposes a savings deposit', () => {
    const noVault = { ...V8, buckets: V8.buckets.filter((b) => !b.vaults?.length) } as typeof V8
    expect(savingsSweepOf(account(0n, 0n, 50n * USDC), noVault).proposal).toBeNull()
  })

  test('empty books decide byte for byte as no books: free bucket USDC is swept as bucket money (HRV-R3)', () => {
    const o = account(500n * USDC, 0n, 0n, { balances: { USDC: 20n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } })
    const d = decide(o, V8)
    expect(d.proposal).toMatchObject({ kind: 'vault_deposit' })
    expect(d.proposal).not.toHaveProperty('savings')
    const e = decide({ ...o, savings: { pending: 0n, shares: {} } }, V8)
    expect(e.decisionId).toBe(d.decisionId)
    expect(e.proposal).toEqual(d.proposal)
  })
})
