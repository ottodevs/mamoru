import { describe, expect, test } from 'bun:test'
import { toFunctionSelector } from 'viem'
import { address, baseRegistry } from '@mamoru/registry'
import { grantKey } from './grants.ts'
import { computeCaps, instantiateGrant, policyHash, type GrantContext } from './instantiate.ts'
import { POLICIES } from './policies.ts'
import { conservadorLiveV6, preferenceTotal } from './policies-v6.ts'
import { conservadorLabV7, conservadorLiveV7, V7_VAULTS } from './policies-v7.ts'
import { decodeVaultFamilyInit, encodeVaultFamilyInit, retargetToPolicy } from './v4-grants.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
const CAP = 10_000n * 1_000_000n
const PRICES = { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } }

function ctx(): GrantContext {
  return { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 8453, salt: `0x${'00'.repeat(32)}`, validAfter: 0, validUntil: 1, caps: computeCaps(conservadorLiveV7, CAP, PRICES) }
}

describe('conservador-live-v7 (otto/mamoru#210)', () => {
  test('50 Stable in vaults (Morpho first, Aave second), 35 Balance WETH/USDC, 15 Growth on Monad, both old pools exit only', () => {
    expect(conservadorLiveV7.buckets).toEqual([
      { id: 'stables', preference: 5000, pools: [], vaults: ['vault:gtUSDCp', 'vault:waBasUSDC'] },
      { id: 'risk', preference: 3500, pools: ['pool:WETH/USDC/3000'] },
      { id: 'stables-lp', preference: 0, pools: ['pool:USDC/USDT/100'], exitOptIn: true },
      { id: 'btc-usdc', preference: 0, pools: ['pool:USDC/cbBTC/500'] },
    ])
    expect(conservadorLiveV7.remoteBuckets).toEqual(conservadorLiveV6.remoteBuckets)
    expect(preferenceTotal(conservadorLiveV7)).toBe(10_000)
  })

  test('a new id and hash, Base only, not in POLICIES (a renewal target behind vaults_v7 only)', () => {
    expect(POLICIES[conservadorLiveV7.policyId]).toBeUndefined()
    expect(conservadorLiveV7.chain).toBe('base')
    expect(conservadorLabV7.chain).toBe('fork')
    expect(policyHash(conservadorLiveV7)).not.toBe(policyHash(conservadorLiveV6))
  })

  test('grants: one vault-supply per vault on V3, WETH/USDC and the bridge as v6, exit only on USDC/USDT and USDC/cbBTC', () => {
    expect(conservadorLiveV7.session.grants.map(grantKey)).toEqual([
      'vault-supply:vault:gtUSDCp',
      'vault-supply:vault:waBasUSDC',
      'manage-any:pool:WETH/USDC/3000',
      'manage-any:pool:USDC/USDT/100',
      'manage-any:pool:USDC/cbBTC/500',
      'bridge-out',
    ])
    // WETH/USDC and the bridge are v6's own templates, byte for byte; v6 is unchanged.
    const v6 = (k: string) => conservadorLiveV6.session.grants.find((g) => grantKey(g) === k)
    expect(conservadorLiveV7.session.grants.find((g) => grantKey(g) === 'manage-any:pool:WETH/USDC/3000')).toEqual(v6('manage-any:pool:WETH/USDC/3000')!)
    expect(conservadorLiveV7.session.grants.find((g) => g.name === 'bridge-out')).toEqual(v6('bridge-out')!)
    expect(conservadorLiveV7.session.grants.find((g) => grantKey(g) === 'manage-any:pool:USDC/cbBTC/500')).toEqual(v6('manage-any:pool:USDC/cbBTC/500')!)
    for (const pool of ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500']) {
      const g = instantiateGrant(conservadorLiveV7, `manage-any:${pool}`, ctx())
      expect(g.actions.some((a) => a.signature.startsWith('mint') || a.signature.startsWith('increase')), pool).toBe(false)
      expect(g.actions.some((a) => a.target === 'USDC' && a.signature.startsWith('approve')), pool).toBe(false)
    }
    // USDC/USDT: v6's V3-only manage-any without its way in (no UniActionPolicy rule: one owner transaction from v5).
    const lp = conservadorLiveV7.session.grants.find((g) => grantKey(g) === 'manage-any:pool:USDC/USDT/100')!
    expect(lp).toMatchObject({ actionPolicyOnly: true, requiresActionPolicy: true })
    const v6lp = v6('manage-any:pool:USDC/USDT/100')!
    expect(lp.actions.every((a) => v6lp.actions.some((b) => b.target === a.target && b.signature === a.signature))).toBe(true)
    expect(lp.actions.map((a) => a.signature.split('(')[0]).sort()).toEqual(['approve', 'burn', 'collect', 'decreaseLiquidity', 'exactInputSingle', 'multicall'].sort())
    expect(lp.actions.find((a) => a.signature.startsWith('approve'))!.target).toBe('USDT')
    // Only the bridge keeps MamoruPauseGate.
    expect(conservadorLiveV7.session.grants.filter((g) => g.requiresPauseGate).map((g) => g.name)).toEqual(['bridge-out'])
  })

  test('USDC/USDT is held until the account opts in to its exit; USDC/cbBTC is reduced as in v6', () => {
    expect(conservadorLiveV7.buckets.find((b) => b.id === 'stables-lp')!.exitOptIn).toBe(true)
    expect(conservadorLiveV7.buckets.find((b) => b.id === 'btc-usdc')!.exitOptIn).toBeUndefined()
    expect(conservadorLiveV6.buckets.some((b) => b.exitOptIn)).toBe(false)
  })

  test.each(V7_VAULTS.map((v) => [v]))('%s: MamoruActionPolicyV3 alone, no param rule: approve USDC, deposit, redeem on the vault', (vault) => {
    const t = conservadorLiveV7.session.grants.find((g) => g.vault === vault)!
    expect(t).toMatchObject({ name: 'vault-supply', perPosition: false, requiresActionPolicy: true, actionPolicyOnly: true })
    expect(t.pool).toBeUndefined()
    expect(t.requiresPauseGate).toBeUndefined()
    const g = instantiateGrant(conservadorLiveV7, `vault-supply:${vault}`, ctx())
    expect(g.vault).toBe(vault)
    expect(g.pool).toBeUndefined()
    expect(g.actionPolicyOnly).toBe(true)
    const at = address(vault, baseRegistry)
    const [approve, deposit, redeem] = g.actions
    expect(g.actions).toHaveLength(3)
    for (const a of g.actions) expect(a.params).toEqual([])
    expect(approve!.targetAddress).toBe(address('USDC', baseRegistry))
    expect(approve!.selector).toBe(toFunctionSelector('function approve(address,uint256)'))
    expect(deposit!.targetAddress).toBe(at)
    expect(deposit!.selector).toBe(toFunctionSelector('function deposit(uint256,address)'))
    expect(redeem!.targetAddress).toBe(at)
    expect(redeem!.selector).toBe(toFunctionSelector('function redeem(uint256,address,address)'))
    expect(g.userOp.usageLimit).toBe(256)
    // Bound to V3 like every V3 grant; no mint or approval to rewrite.
    const r = retargetToPolicy(g, '0x00000000000000000000000000000000000000Fe')
    expect(r.actions).toEqual(g.actions)
    expect(r.actionPolicy).toBe('0x00000000000000000000000000000000000000Fe')
  })

  test('the vault-family Init: abi.encode(1, generation), nothing else decodes as one', () => {
    const d = encodeVaultFamilyInit(7n)
    expect(d).toBe(`0x${'0'.repeat(63)}1${'0'.repeat(63)}7`)
    expect(decodeVaultFamilyInit(d)).toBe(7n)
    expect(decodeVaultFamilyInit(`0x${'0'.repeat(63)}2${'0'.repeat(63)}7`)).toBeNull()
    expect(decodeVaultFamilyInit(`${d}00`)).toBeNull()
    expect(decodeVaultFamilyInit('0x')).toBeNull()
  })

  test('no 4626 entry point beyond deposit and redeem, and never SESS-10\'s vault', () => {
    const sigs = conservadorLiveV7.session.grants.filter((g) => g.name === 'vault-supply').flatMap((g) => g.actions.map((a) => a.signature.split('(')[0]))
    expect([...new Set(sigs)].sort()).toEqual(['approve', 'deposit', 'redeem'])
    const targets = V7_VAULTS.map((v) => address(v, baseRegistry).toLowerCase())
    expect(targets).not.toContain('0xbeef010f9cb27031ad51e3333f9af9c6b1228183')
  })
})
