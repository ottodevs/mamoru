import { describe, expect, test } from 'bun:test'
import { grantKey } from './grants.ts'
import { computeCaps, instantiateGrant, policyHash, type GrantContext } from './instantiate.ts'
import { POLICIES } from './policies.ts'
import { preferenceTotal } from './policies-v6.ts'
import { conservadorLiveV7, v7EnginePolicy } from './policies-v7.ts'
import { conservadorLabV8, conservadorLiveV8, V8_MIGRATES_FROM, V8_POOLS } from './policies-v8.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
const CAP = 1_000n * 1_000_000n
const PRICES = { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } }

function ctx(): GrantContext {
  return { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 8453, salt: `0x${'00'.repeat(32)}`, validAfter: 0, validUntil: 1, caps: computeCaps(conservadorLiveV8, CAP, PRICES) }
}

describe('conservador-live-v8 (otto/mamoru#428): v7 without Monad', () => {
  test('50 Stable in vaults, 35 Balance WETH/USDC as v7; Monad\'s 15 % on USDC/cbBTC; USDC/USDT exit only; no remote bucket', () => {
    expect(conservadorLiveV8.buckets).toEqual([
      { id: 'stables', preference: 5000, pools: [], vaults: ['vault:gtUSDCp', 'vault:waBasUSDC'] },
      { id: 'risk', preference: 3500, pools: ['pool:WETH/USDC/3000'] },
      { id: 'btc-usdc', preference: 1500, pools: ['pool:USDC/cbBTC/500'] },
      { id: 'stables-lp', preference: 0, pools: ['pool:USDC/USDT/100'], exitOptIn: true },
    ])
    expect('remoteBuckets' in conservadorLiveV8).toBe(false)
    expect(preferenceTotal(conservadorLiveV8)).toBe(10_000)
    // The buckets an account already holds keep their share: only Monad's moves.
    for (const id of ['stables', 'risk']) expect(conservadorLiveV8.buckets.find((b) => b.id === id)).toEqual(conservadorLiveV7.buckets.find((b) => b.id === id)!)
  })

  test('a new id and hash, Base only, not in POLICIES', () => {
    expect(POLICIES[conservadorLiveV8.policyId]).toBeUndefined()
    expect(conservadorLiveV8.chain).toBe('base')
    expect(conservadorLabV8.chain).toBe('fork')
    expect(policyHash(conservadorLiveV8)).not.toBe(policyHash(conservadorLiveV7))
  })

  test('grants: vaults and WETH/USDC as v7, USDC/cbBTC takes money on V3 alone, USDC/USDT exit only, no bridge', () => {
    expect(conservadorLiveV8.session.grants.map(grantKey)).toEqual(['vault-supply:vault:gtUSDCp', 'vault-supply:vault:waBasUSDC', 'manage-any:pool:WETH/USDC/3000', 'manage-any:pool:USDC/USDT/100', 'manage-any:pool:USDC/cbBTC/500'])
    const v7 = (k: string) => conservadorLiveV7.session.grants.find((g) => grantKey(g) === k)
    for (const k of ['vault-supply:vault:gtUSDCp', 'vault-supply:vault:waBasUSDC', 'manage-any:pool:WETH/USDC/3000', 'manage-any:pool:USDC/USDT/100']) {
      expect(conservadorLiveV8.session.grants.find((g) => grantKey(g) === k), k).toEqual(v7(k)!)
    }
    expect(conservadorLiveV8.session.grants.some((g) => g.name === 'bridge-out')).toBe(false)
    expect(conservadorLiveV8.session.grants.some((g) => g.requiresPauseGate)).toBe(false)
    const btc = conservadorLiveV8.session.grants.find((g) => grantKey(g) === 'manage-any:pool:USDC/cbBTC/500')!
    expect(btc).toMatchObject({ actionPolicyOnly: true, requiresActionPolicy: true })
    const g = instantiateGrant(conservadorLiveV8, 'manage-any:pool:USDC/cbBTC/500', ctx())
    expect(g.actions.some((a) => a.signature.startsWith('mint'))).toBe(true)
    expect(g.actions.some((a) => a.target === 'USDC' && a.signature.startsWith('approve'))).toBe(true)
  })

  test('USDC/cbBTC caps at its 15 % share (v4/v5 sized it for 40 %)', () => {
    expect(V8_POOLS.btc.capShareBps).toBe(1500)
    const caps = computeCaps(conservadorLiveV8, CAP, PRICES)
    // per-call stable swap cap: 15 % of the cap
    const perCall = Object.entries(caps).find(([k]) => k.startsWith('btc') && /swap/i.test(k) && /percall/i.test(k))
    expect(perCall?.[1]).toBe((CAP * 1500n) / 10_000n)
  })

  test('only accounts with a Monad leg move to it; its engine keeps v7\'s vault floor', () => {
    expect([...V8_MIGRATES_FROM].sort()).toEqual(['conservador-lab-v6', 'conservador-lab-v7', 'conservador-live-v6', 'conservador-live-v7'])
    expect(v7EnginePolicy(conservadorLiveV8).vaultMinDeposit).toBe(1_000_000n)
    expect(v7EnginePolicy(conservadorLiveV8)).toBe(v7EnginePolicy(conservadorLiveV8))
  })
})
