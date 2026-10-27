import { describe, expect, test } from 'bun:test'
import { toFunctionSelector } from 'viem'
import { address, baseRegistry } from '@mamoru/registry'
import { computeCaps, instantiateGrant, policyHash, type GrantContext } from './instantiate.ts'
import { POLICIES } from './policies.ts'
import { conservadorLiveV5 } from './policies-v4.ts'
import { conservadorLabV6, conservadorLiveV6, preferenceTotal, V6_POOLS } from './policies-v6.ts'
import { CCTP_DOMAIN_MONAD, CCTP_FINALITY_STANDARD } from './grants.ts'
import { retargetToPolicy, V4_POOLS } from './v4-grants.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
const CAP = 10_000n * 1_000_000n

function ctx(): GrantContext {
  const caps = computeCaps(conservadorLiveV6, CAP, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } })
  return { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 8453, salt: `0x${'00'.repeat(32)}`, validAfter: 0, validUntil: 1, caps }
}

describe('conservador-live-v6 (otto/mamoru#201, #213)', () => {
  test('50 Stable + 35 Balance on Base, 15 Growth on Monad, USDC/cbBTC as an exit only', () => {
    expect(conservadorLiveV6.buckets).toEqual([
      { id: 'stables', preference: 5000, pools: ['pool:USDC/USDT/100'] },
      { id: 'risk', preference: 3500, pools: ['pool:WETH/USDC/3000'] },
      { id: 'btc-usdc', preference: 0, pools: ['pool:USDC/cbBTC/500'] },
    ])
    expect(conservadorLiveV6.remoteBuckets).toEqual([{ id: 'growth', preference: 1500, chainId: 143, pools: ['pool:WMON/USDC/3000'], policyId: 'live-wmon-usdc-monad-v1' }])
    expect(preferenceTotal(conservadorLiveV6)).toBe(10_000)
    const btc = conservadorLiveV6.session.grants.filter((g) => g.pool === 'pool:USDC/cbBTC/500')
    expect(btc.map((g) => g.name)).toEqual(['manage-any'])
  })

  test('a new id and hash, signed for Base only, not in POLICIES until #214 and #215 ship', () => {
    expect(POLICIES[conservadorLiveV6.policyId]).toBeUndefined()
    expect(conservadorLiveV6.chain).toBe('base')
    expect(conservadorLabV6.chain).toBe('fork')
    expect(policyHash(conservadorLiveV6)).not.toBe(policyHash(conservadorLiveV5))
  })

  test('the WETH/USDC caps follow its 35 % share; stables keep v5', () => {
    const caps = computeCaps(conservadorLiveV6, CAP, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } })
    expect(caps[V6_POOLS.balance.caps.stableSwapPerCall]).toBe((CAP * 3500n) / 10_000n)
    expect(caps[V6_POOLS.balance.caps.budgetWindow]).toBe((CAP * 7000n) / 10_000n)
    expect(caps[V4_POOLS.stables.caps.stableSwapPerCall]).toBe((CAP * 5000n) / 10_000n)
  })

  test('bridge-out: CCTP V2 burn to this same account on Monad, USDC only, open caller, no fee, Standard finality', () => {
    const t = conservadorLiveV6.session.grants.find((g) => g.name === 'bridge-out')!
    expect(t.requiresActionPolicy).toBeUndefined()
    expect(t.requiresPauseGate).toBe(true)
    const g = instantiateGrant(conservadorLiveV6, 'bridge-out', ctx())
    const [approve, burn] = g.actions
    const messenger = address('TokenMessengerV2', baseRegistry)
    expect(approve!.targetAddress).toBe(address('USDC', baseRegistry))
    expect(approve!.params.find((p) => p.field === 'spender')!.ref).toBe(BigInt(messenger))
    expect(burn!.targetAddress).toBe(messenger)
    expect(burn!.selector).toBe(toFunctionSelector('function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)'))
    const rule = (f: string) => burn!.params.find((p) => p.field === f)!
    expect(rule('mintRecipient')).toMatchObject({ index: 2, condition: 'EQUAL', ref: BigInt(ACCOUNT) })
    expect(rule('destinationDomain')).toMatchObject({ index: 1, condition: 'EQUAL', ref: CCTP_DOMAIN_MONAD })
    expect(rule('burnToken')).toMatchObject({ index: 3, condition: 'EQUAL', ref: BigInt(address('USDC', baseRegistry)) })
    expect(rule('destinationCaller')).toMatchObject({ index: 4, condition: 'EQUAL', ref: 0n })
    expect(rule('maxFee')).toMatchObject({ index: 5, condition: 'EQUAL', ref: 0n })
    expect(rule('minFinalityThreshold')).toMatchObject({ index: 6, condition: 'GREATER_THAN_OR_EQUAL', ref: CCTP_FINALITY_STANDARD })
    expect(g.requiresPauseGate).toBe(true)
    expect(() => retargetToPolicy(g, '0x00000000000000000000000000000000000000Fe')).toThrow('MamoruPauseGate')
    expect(rule('amount')).toMatchObject({ index: 0, ref: (CAP * 2000n) / 10_000n, cumulativeLimit: (CAP * 5000n) / 10_000n })
  })
})
