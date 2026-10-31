// otto/mamoru#214: the Monad sleeve runs a v5-shaped policy. Base is untouched; the v1 sleeve policy keeps its hash.
import { describe, expect, test } from 'bun:test'
import { address, baseRegistry, monadRegistry } from '@mamoru/registry'
import { computeCaps, grantKey, instantiateGrant, labWmonUsdcMonadV1, labWmonUsdcMonadV5, liveWmonUsdcMonadV1, liveWmonUsdcMonadV5, MONAD_GAS_CAPS, MONAD_LAB_POLICIES, MONAD_LIVE_POLICIES, policyHash, policyRegistry, retargetToPolicy, V4_POOLS, V4_POOLS_MONAD, v4PoolOf, v4PoolsOn, mamoruInitFor, conservadorLiveV6, conservadorLiveV5, INCREASE_TOLERANCE_BPS } from './index.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
const POLICY = '0x00000000000000000000000000000000000000Fe' as const
const CAP = 10_000n * 1_000_000n

const caps = computeCaps(liveWmonUsdcMonadV5, CAP, { WMON: { num: 1n, den: 1n } })
const ctx = { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb' as const, chainId: 143, salt: `0x${'00'.repeat(32)}` as const, validAfter: 0, validUntil: 1, caps }

describe('liveWmonUsdcMonadV1 is untouched', () => {
  test('hashes pinned (computed on origin/feat/213-policy-v6 before this change)', () => {
    expect(policyHash(liveWmonUsdcMonadV1)).toBe('0x1dc7a69a214c6f342cded52c69861e300efbca9d7cd63ba97206122b92247744')
    expect(policyHash(labWmonUsdcMonadV1)).toBe('0x251011d6b7748fffec963871f1a4bda0e194ab49c6a7a122119d020b34be1310')
    expect(MONAD_LIVE_POLICIES[liveWmonUsdcMonadV1.policyId]).toBe(liveWmonUsdcMonadV1)
  })

  test('the v5 sleeve policies are in neither record: the operator resolves them only with the contract addresses', () => {
    expect(Object.keys(MONAD_LIVE_POLICIES)).toEqual([liveWmonUsdcMonadV1.policyId])
    expect(Object.keys(MONAD_LAB_POLICIES)).toEqual([labWmonUsdcMonadV1.policyId])
  })
})

describe('live-wmon-usdc-monad-v5', () => {
  test('shape: Monad mainnet only, Monad names, one bucket holding the whole sleeve, MON reserve, lab range, v5 tolerance', () => {
    const p = liveWmonUsdcMonadV5
    expect(p.policyId).toBe('live-wmon-usdc-monad-v5')
    expect(p.chain).toBe('monad')
    expect(p.sourceChainId).toBe(143)
    expect(policyRegistry(p)).toBe(monadRegistry)
    expect(p.buckets).toEqual([{ id: 'risk', preference: 10_000, pools: ['pool:WMON/USDC/3000'] }])
    expect(p.gasReserveWei).toBe(liveWmonUsdcMonadV1.gasReserveWei)
    expect(p.range).toEqual({ ...labWmonUsdcMonadV1.range, increaseToleranceBps: INCREASE_TOLERANCE_BPS })
    expect(p.session.grants.map(grantKey)).toEqual(['enter-swap:pool:WMON/USDC/3000', 'enter-mint:pool:WMON/USDC/3000', 'manage-any:pool:WMON/USDC/3000'])
    expect(p.session.grants.every((g) => g.requiresActionPolicy)).toBe(true)
    expect(p.session.grants.every((g) => g.pool === 'pool:WMON/USDC/3000')).toBe(true)
    expect(p.session.grants.find((g) => g.name === 'manage-any')!.actions.some((a) => a.signature.startsWith('increase('))).toBe(true)
    expect(policyHash(p)).not.toBe(policyHash(liveWmonUsdcMonadV1))
    expect(labWmonUsdcMonadV5.chain).toBe('fork')
    expect(labWmonUsdcMonadV5.session).toBe(p.session)
  })

  test('the pool spec: WMON/USDC 0.30 %, USDC the budget unit (token1), the whole sleeve cap (not 15 % twice), Monad only', () => {
    const s = V4_POOLS_MONAD.growth
    expect(s).toMatchObject({ pool: 'pool:WMON/USDC/3000', stable: 'USDC', volatile: 'WMON', token0: 'WMON', token1: 'USDC', fee: 3000, bandTicks: 100, capShareBps: 10_000, windowMultiple: 3, totalMultiple: 10, sourceChainId: 143 })
    const e = monadRegistry.entries.find((x) => x.name === s.pool)!
    expect([e.token0, e.token1, e.fee]).toEqual(['WMON', 'USDC', 3000])
    expect(caps[s.caps.budgetWindow]).toBe(CAP * 3n)
    expect(caps[s.caps.budgetTotal]).toBe(CAP * 10n)
  })

  test('v4PoolOf finds it on Monad only, and never a Base pool there', () => {
    expect(v4PoolOf('pool:WMON/USDC/3000', 143)).toBe(V4_POOLS_MONAD.growth)
    expect(v4PoolOf('pool:WMON/USDC/3000')).toBeUndefined()
    expect(v4PoolOf('pool:WETH/USDC/3000', 143)).toBeUndefined()
    expect(v4PoolOf('pool:WETH/USDC/3000')).toBe(V4_POOLS.risk)
    expect(v4PoolsOn()).toEqual(Object.values(V4_POOLS))
    expect(v4PoolsOn(143)).toEqual([V4_POOLS_MONAD.growth])
  })

  test('the Init pool is the Monad pool; Base specs still read the Base registry', () => {
    const init = mamoruInitFor(V4_POOLS_MONAD.growth, 1n, caps)
    expect(init.pool.toLowerCase()).toBe(address('pool:WMON/USDC/3000', monadRegistry).toLowerCase())
    expect(init.budgetIn1).toBe(true)
    expect(init.bandTicks).toBe(100)
    const base = mamoruInitFor(V4_POOLS.risk, 1n, computeCaps(conservadorLiveV5, CAP, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } }))
    expect(base.pool.toLowerCase()).toBe(address('pool:WETH/USDC/3000', baseRegistry).toLowerCase())
  })

  test('every grant instantiates against the Monad registry and retargets to the policy with Monad NPM', () => {
    const npmMonad = BigInt(address('NonfungiblePositionManager', monadRegistry))
    for (const t of liveWmonUsdcMonadV5.session.grants) {
      const g = instantiateGrant(liveWmonUsdcMonadV5, grantKey(t), ctx)
      const r = retargetToPolicy(g, POLICY, policyRegistry(liveWmonUsdcMonadV5))
      expect(r.actionPolicy).toBe(POLICY)
      // Retargeting needed the Monad manager: no approval names it any more, mint/increase name the policy.
      for (const a of r.actions) {
        if (a.signature.startsWith('approve(')) expect(a.params.some((p) => p.field === 'spender' && p.ref === npmMonad)).toBe(false)
        if (a.signature.startsWith('mint(') || a.signature.startsWith('increase(')) expect(a.targetAddress).toBe(POLICY)
      }
      const approvesPolicy = g.actions.filter((a) => a.signature.startsWith('approve(') && a.params.some((p) => p.field === 'spender' && p.ref === npmMonad))
      expect(r.actions.filter((a) => a.signature.startsWith('approve(') && a.params.some((p) => p.field === 'spender' && p.ref === BigInt(POLICY))).length).toBe(approvesPolicy.length)
    }
  })

  test('Base manager is never looked up for a Monad grant: the default (Base) registry leaves the approvals unretargeted', () => {
    const g = instantiateGrant(liveWmonUsdcMonadV5, 'enter-mint:pool:WMON/USDC/3000', ctx)
    const wrong = retargetToPolicy(g, POLICY) // Base NPM: matches nothing on a Monad grant
    expect(wrong.actions.some((a) => a.params.some((p) => p.field === 'spender' && p.ref === BigInt(address('NonfungiblePositionManager', monadRegistry))))).toBe(true)
  })

  test('Monad gas caps: priced for ~100 gwei, valid for MamoruGasPolicy', () => {
    expect(MONAD_GAS_CAPS.maxFeePerGas).toBeGreaterThanOrEqual(10n * 100_000_000_000n)
    expect(MONAD_GAS_CAPS.maxFeePerGas).toBeGreaterThanOrEqual(MONAD_GAS_CAPS.maxPriorityFeePerGas)
  })
})

describe('review of #137: the first entry fits the caps', () => {
  test('swapping half the sleeve cap fits the per-call swap cap, and minting all of it fits the mint caps', () => {
    const swap = liveWmonUsdcMonadV5.session.caps.find((c) => c.name === V4_POOLS_MONAD.growth.caps.stableSwapPerCall)!
    expect(swap.bpsOfDeposit).toBeGreaterThanOrEqual(5000)
    const mint = liveWmonUsdcMonadV5.session.caps.find((c) => c.name === V4_POOLS_MONAD.growth.caps.mint1)!
    expect(mint.bpsOfDeposit).toBeGreaterThanOrEqual(10_000)
  })
})
