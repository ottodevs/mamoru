import { describe, expect, test } from 'bun:test'
import { toFunctionSelector } from 'viem'
import { address, baseRegistry } from '@mamoru/registry'
import { grantKey } from './grants.ts'
import { computeCaps, instantiateGrant, policyHash, type GrantContext } from './instantiate.ts'
import { POLICIES } from './policies.ts'
import { conservadorLiveV6, preferenceTotal } from './policies-v6.ts'
import { conservadorLabV7, conservadorLiveV7, V7_VAULTS } from './policies-v7.ts'
import { retargetToPolicy } from './v4-grants.ts'

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
      { id: 'stables-lp', preference: 0, pools: ['pool:USDC/USDT/100'] },
      { id: 'btc-usdc', preference: 0, pools: ['pool:USDC/cbBTC/500'] },
    ])
    expect(conservadorLiveV7.remoteBuckets).toEqual(conservadorLiveV6.remoteBuckets)
    expect(preferenceTotal(conservadorLiveV7)).toBe(10_000)
  })

  test('a new id and hash, Base only, not in POLICIES until decide, the engine and the exit know vaults', () => {
    expect(POLICIES[conservadorLiveV7.policyId]).toBeUndefined()
    expect(conservadorLiveV7.chain).toBe('base')
    expect(conservadorLabV7.chain).toBe('fork')
    expect(policyHash(conservadorLiveV7)).not.toBe(policyHash(conservadorLiveV6))
  })

  test('grants: one vault-supply per vault, WETH/USDC and the bridge as v6, exit only on USDC/USDT and USDC/cbBTC', () => {
    expect(conservadorLiveV7.session.grants.map(grantKey)).toEqual([
      'vault-supply:vault:gtUSDCp',
      'vault-supply:vault:waBasUSDC',
      'enter-swap:pool:WETH/USDC/3000',
      'enter-mint:pool:WETH/USDC/3000',
      'manage-any:pool:WETH/USDC/3000',
      'bridge-out',
      'manage-any:pool:USDC/USDT/100',
      'manage-any:pool:USDC/cbBTC/500',
    ])
    for (const pool of ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500']) {
      const g = instantiateGrant(conservadorLiveV7, `manage-any:${pool}`, ctx())
      expect(g.actions.some((a) => a.signature.startsWith('mint') || a.signature.startsWith('increase')), pool).toBe(false)
      expect(g.actions.some((a) => a.target === 'USDC' && a.signature.startsWith('approve')), pool).toBe(false)
    }
  })

  test.each(V7_VAULTS.map((v) => [v]))('%s: approve USDC to the vault, deposit to the account, redeem to the account from its own shares', (vault) => {
    const t = conservadorLiveV7.session.grants.find((g) => g.vault === vault)!
    expect(t).toMatchObject({ name: 'vault-supply', perPosition: false, requiresPauseGate: true })
    expect(t.pool).toBeUndefined()
    expect(t.requiresActionPolicy).toBeUndefined()
    const g = instantiateGrant(conservadorLiveV7, `vault-supply:${vault}`, ctx())
    expect(g.vault).toBe(vault)
    expect(g.pool).toBeUndefined()
    expect(g.requiresPauseGate).toBe(true)
    const at = address(vault, baseRegistry)
    const [approve, deposit, redeem] = g.actions
    expect(g.actions).toHaveLength(3)
    expect(approve!.targetAddress).toBe(address('USDC', baseRegistry))
    expect(approve!.params).toMatchObject([
      { field: 'spender', index: 0, condition: 'EQUAL', ref: BigInt(at) },
      { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: (CAP * 6000n) / 10_000n },
    ])
    expect(deposit!.targetAddress).toBe(at)
    expect(deposit!.selector).toBe(toFunctionSelector('function deposit(uint256,address)'))
    expect(deposit!.params).toMatchObject([
      { field: 'assets', index: 0, condition: 'LESS_THAN_OR_EQUAL', ref: (CAP * 6000n) / 10_000n, cumulativeLimit: CAP * 2n },
      { field: 'receiver', index: 1, condition: 'EQUAL', ref: BigInt(ACCOUNT) },
    ])
    expect(redeem!.targetAddress).toBe(at)
    expect(redeem!.selector).toBe(toFunctionSelector('function redeem(uint256,address,address)'))
    expect(redeem!.params).toMatchObject([
      { field: 'shares', index: 0, condition: 'GREATER_THAN', ref: 0n },
      { field: 'receiver', index: 1, condition: 'EQUAL', ref: BigInt(ACCOUNT) },
      { field: 'owner', index: 2, condition: 'EQUAL', ref: BigInt(ACCOUNT) },
    ])
    expect(g.userOp.usageLimit).toBe(256)
    // MamoruActionPolicy knows only Uniswap: the vault grant is never retargeted to it.
    expect(() => retargetToPolicy(g, '0x00000000000000000000000000000000000000Fe')).toThrow('MamoruPauseGate')
  })

  test('no 4626 entry point beyond deposit and redeem, and never SESS-10\'s vault', () => {
    const sigs = conservadorLiveV7.session.grants.filter((g) => g.name === 'vault-supply').flatMap((g) => g.actions.map((a) => a.signature.split('(')[0]))
    expect([...new Set(sigs)].sort()).toEqual(['approve', 'deposit', 'redeem'])
    const targets = V7_VAULTS.map((v) => address(v, baseRegistry).toLowerCase())
    expect(targets).not.toContain('0xbeef010f9cb27031ad51e3333f9af9c6b1228183')
  })
})
