import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { toFunctionSelector } from 'viem'
import { address } from '@mamoru/registry'
import { computeCaps, instantiateGrant, policyHash, type GrantContext } from './instantiate.ts'
import { POLICIES } from './policies.ts'
import { conservadorLabV4, conservadorLabV5, conservadorLiveV4, conservadorLiveV5, INCREASE_TOLERANCE_BPS } from './policies-v4.ts'
import { grantKey } from './grants.ts'
import { DEFAULT_GAS_CEILING, enterSwapV4Grant, grantsV4, grantsV5, hasIncrease, manageAnyV4Grant, POLICY_INCREASE_SIG, retargetToPolicy, splitV4Keys, V4_POOLS } from './v4-grants.ts'

/**
 * Spec 007 (otto/mamoru#151, #171): conservador-live-v5, the policy version for MamoruActionPolicyV2. Every policy
 * that existed before it keeps its hash, byte for byte: these are the values `policyHash` returns on origin/main at
 * 3cd720a (computed there, pasted here), for POLICIES and the two v4 policies.
 */
const HASHES_ON_MAIN: Record<string, string> = {
  'conservador-v1': '0xb98c8b55215256eb21ba107ed84e8ee54cfe4658422528cebcdb91e5c9345d18',
  'conservador-lab-v1': '0xcceafbb24a2e9ef40e496a756f97d338eec76a08f4a2e4a3eb9185240339b3c2',
  'conservador-live-v1': '0xa8973212b542a232f25e09b73ef39c8496c5b5f599667f2a9236109fc6660376',
  'conservador-live-v2': '0x3b4759978007f38513d67d64d09b65957e90f9ab4d0c75afa22a1d016d939cf0',
  'lab-weth-usdc-v1': '0x7eb02363bcc36716f3558bded564e9a84ea7ee1866ed7c06ecb408f8eba5405b',
  'conservador-lab-guards-v1': '0x5a1e148c145901727b6848f9188c5a2c7bc362e4ea36fb5bf2a93e7ad9331ed2',
  'conservador-lab-geometry-v1': '0x80523980a91354ff4593b109e62d2168d2a9525ae6e1d37d9fdc7299b4d83162',
  'conservador-live-v4': '0xdabdedb0d116c1135a085c3f295e8d3297c37e9ae11165c172fde776e0121955',
  'conservador-lab-v4': '0x732bd7b8afa2d27805941c8f6aae0facdf57ebe2895b2e136828599f3875d429',
}

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
const SESSION_KEY = '0x00000000000000000000000000000000000000bb' as const
const POLICY_V2 = '0x00000000000000000000000000000000000000Fe' as const

function ctx(): GrantContext {
  const caps = computeCaps(conservadorLiveV5, 10_000n * 1_000_000n, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } })
  return { account: ACCOUNT, sessionKey: SESSION_KEY, chainId: 8453, salt: `0x${'00'.repeat(32)}` as const, validAfter: 0, validUntil: 1, caps }
}

const DEADLINE = toFunctionSelector('function multicall(uint256,bytes[])')
const INCREASE = toFunctionSelector(`function ${POLICY_INCREASE_SIG}`)

describe('no existing policy hash changes (otto/mamoru#151)', () => {
  test('every policy of POLICIES and both v4 policies hash exactly as on main', () => {
    const now: Record<string, string> = { ...Object.fromEntries(Object.entries(POLICIES).map(([k, p]) => [k, policyHash(p)])), [conservadorLiveV4.policyId]: policyHash(conservadorLiveV4), [conservadorLabV4.policyId]: policyHash(conservadorLabV4) }
    expect(now).toEqual(HASHES_ON_MAIN)
  })

  test('v5 is a new id and a new hash, and is not in POLICIES (resolved only with the deployed V2 address)', () => {
    expect(conservadorLiveV5.policyId).toBe('conservador-live-v5')
    expect(conservadorLabV5.policyId).toBe('conservador-lab-v5')
    expect(Object.values(HASHES_ON_MAIN)).not.toContain(policyHash(conservadorLiveV5))
    expect(Object.values(HASHES_ON_MAIN)).not.toContain(policyHash(conservadorLabV5))
    expect(POLICIES[conservadorLiveV5.policyId]).toBeUndefined()
  })

  test('the v4 builders still build exactly the v4 grants (v5 only adds)', () => {
    for (const p of Object.values(V4_POOLS)) {
      expect(enterSwapV4Grant(p, 1).actions).toHaveLength(2)
      expect(manageAnyV4Grant(p, 1).actions).toHaveLength(7)
    }
    expect(conservadorLiveV4.session.grants).toEqual([...grantsV4(V4_POOLS.stables, { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 }), ...grantsV4(V4_POOLS.btc, { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 }), ...grantsV4(V4_POOLS.risk, { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 })])
  })
})

describe('v5 grants', () => {
  test('v5 is v4 plus: enter-swap + the swap deadline, manage-any + increase + the swap deadline; everything else equal', () => {
    const { session: s5, range: r5, policyId: _i5, ...rest5 } = conservadorLiveV5
    const { session: s4, range: r4, policyId: _i4, ...rest4 } = conservadorLiveV4
    expect(rest5).toEqual(rest4)
    expect(r5).toEqual({ ...r4, increaseToleranceBps: INCREASE_TOLERANCE_BPS })
    expect(s5.caps).toEqual(s4.caps)
    expect(s5.validitySeconds).toBe(s4.validitySeconds)
    expect(s5.grants.map(grantKey)).toEqual(s4.grants.map(grantKey))
    for (const [i, g5] of s5.grants.entries()) {
      const g4 = s4.grants[i]!
      expect(g5.usageLimit).toBe(g4.usageLimit)
      expect(g5.requiresActionPolicy).toBe(true)
      expect(g5.actions.slice(0, g4.actions.length)).toEqual(g4.actions)
      const added = g5.actions.slice(g4.actions.length).map((a) => a.signature)
      if (g5.name === 'enter-swap') expect(added).toEqual(['multicall(uint256,bytes[])'])
      if (g5.name === 'enter-mint') expect(added).toEqual([])
      if (g5.name === 'manage-any') expect(added).toEqual([POLICY_INCREASE_SIG, 'multicall(uint256,bytes[])'])
    }
    // 15 actions per pool, 45 for three (v4: 12 and 36).
    expect(s5.grants.reduce((n, g) => n + g.actions.length, 0)).toBe(45)
  })

  test('the deadline action pins the empty array as the v2/v3 grants do (deadline > 0, offset 0x40, length 0)', () => {
    const g = grantsV5(V4_POOLS.btc, { enterSwap: 1, enterMint: 1, manageAny: 1 })[0]!
    const d = g.actions.find((a) => a.signature === 'multicall(uint256,bytes[])')!
    expect(d.target).toBe('SwapRouter02')
    expect(d.params.map((p) => [p.index, p.condition, p.ref])).toEqual([[0, 'GREATER_THAN', 0n], [1, 'EQUAL', 64n], [2, 'EQUAL', 0n]])
  })

  test('increase: tokenId > 0, the mint per-call caps, positive minimums; retargeted to the policy like mint, never the manager', () => {
    for (const p of Object.values(V4_POOLS)) {
      const key = `manage-any:${p.pool}`
      const raw = instantiateGrant(conservadorLiveV5, key, ctx())
      const inc = raw.actions.find((a) => a.signature === POLICY_INCREASE_SIG)!
      expect(inc.selector).toBe(INCREASE)
      expect(inc.params.map((r) => r.field)).toEqual(['tokenId', 'amount0Desired', 'amount1Desired', 'amount0Min', 'amount1Min'])
      const mint = raw.actions.find((a) => a.signature.startsWith('mint('))!
      expect(inc.params[1]!.ref).toBe(mint.params.find((r) => r.field === 'amount0Desired')!.ref)
      expect(inc.params[2]!.ref).toBe(mint.params.find((r) => r.field === 'amount1Desired')!.ref)
      const g = retargetToPolicy(raw, POLICY_V2)
      const after = g.actions.find((a) => a.signature === POLICY_INCREASE_SIG)!
      expect(after.targetAddress).toBe(POLICY_V2)
      expect(g.actions.find((a) => a.selector === DEADLINE)!.targetAddress).toBe(address('SwapRouter02'))
      expect(g.actions.some((a) => a.targetAddress === address('NonfungiblePositionManager') && a.selector === INCREASE)).toBe(false)
    }
  })

  test('hasIncrease: v5 in its three pools; no other policy anywhere', () => {
    for (const p of Object.values(V4_POOLS)) {
      expect(hasIncrease(conservadorLiveV5, p.pool)).toBe(true)
      expect(hasIncrease(conservadorLiveV4, p.pool)).toBe(false)
      for (const pol of Object.values(POLICIES)) expect(hasIncrease(pol, p.pool)).toBe(false)
    }
    expect(hasIncrease(conservadorLiveV5, 'pool:WETH/USDC/500')).toBe(false)
  })

  test('the selector the grant names is the one MamoruActionPolicyV2.sol declares', () => {
    const src = readFileSync(join(import.meta.dir, '../../../contracts/action-policy/src/MamoruActionPolicyV2.sol'), 'utf8')
    expect(src).toContain('function increase(IncreaseLiquidityParams calldata n)')
    expect(src).toMatch(/struct IncreaseLiquidityParams \{\s*uint256 tokenId;\s*uint256 amount0Desired;\s*uint256 amount1Desired;\s*uint256 amount0Min;\s*uint256 amount1Min;\s*uint256 deadline;\s*\}/)
    expect(src).toContain('MULTICALL_DEADLINE = 0x5ae401dc')
    expect(DEADLINE).toBe('0x5ae401dc')
  })

  test('splitV4Keys still splits the 45 actions into consecutive transactions under the ceiling', () => {
    const keys = conservadorLiveV5.session.grants.map(grantKey)
    const parts = splitV4Keys(conservadorLiveV5, keys)
    expect(parts.flat().sort()).toEqual([...keys].sort())
    const actions = (k: string) => conservadorLiveV5.session.grants.find((g) => grantKey(g) === k)!.actions.length
    for (const part of parts) expect(BigInt(part.reduce((n, k) => n + actions(k), 0)) * 590_000n).toBeLessThanOrEqual(DEFAULT_GAS_CEILING)
    expect(parts.length).toBeGreaterThanOrEqual(2)
  })
})
