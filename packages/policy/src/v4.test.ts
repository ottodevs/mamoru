import { describe, expect, test } from 'bun:test'
import { toFunctionSelector } from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import { address, baseRegistry, type Registry } from '@mamoru/registry'
import { ACTION_POLICY_DEFAULTS, computeCaps, conservadorLabV4, conservadorLiveV2, conservadorLiveV4, grantKey, grantKeyFor, hasIncrease, hasManageAny, instantiateGrant, POLICIES, policyHash, usesActionPolicy, type GrantContext } from './index.ts'

/**
 * Hashes of every policy on origin/main before spec 007 T2 (computed at 50dbe1c). A policy version is never changed
 * in place: accounts store the policy id and their grants were signed for these exact objects.
 */
const MAIN_HASHES: Record<string, string> = {
  'conservador-v1': '0xb98c8b55215256eb21ba107ed84e8ee54cfe4658422528cebcdb91e5c9345d18',
  'conservador-lab-v1': '0xcceafbb24a2e9ef40e496a756f97d338eec76a08f4a2e4a3eb9185240339b3c2',
  'conservador-live-v1': '0xa8973212b542a232f25e09b73ef39c8496c5b5f599667f2a9236109fc6660376',
  'conservador-live-v2': '0x3b4759978007f38513d67d64d09b65957e90f9ab4d0c75afa22a1d016d939cf0',
  'lab-weth-usdc-v1': '0x7eb02363bcc36716f3558bded564e9a84ea7ee1866ed7c06ecb408f8eba5405b',
  'conservador-lab-guards-v1': '0x5a1e148c145901727b6848f9188c5a2c7bc362e4ea36fb5bf2a93e7ad9331ed2',
  'conservador-lab-geometry-v1': '0x80523980a91354ff4593b109e62d2168d2a9525ae6e1d37d9fdc7299b4d83162',
}

const POLICY = '0x00000000000000000000000000000000000A11cE' as Address
/** Base with MamoruActionPolicy deployed: what the registry looks like after T7. */
const deployed: Registry = { ...baseRegistry, entries: [...baseRegistry.entries, { name: 'MamoruActionPolicy', kind: 'smart-sessions-policy', role: 'test', address: POLICY, codeHash: null }], undeployed: [] }
const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const USDC = 1_000_000n
const prices = { cbBTC: { num: 1n, den: 600n }, WETH: { num: 10n ** 12n, den: 3_000n }, USDT: { num: 1n, den: 1n } }
const caps = computeCaps(conservadorLiveV4, 1_000n * USDC, prices)
const ctx: GrantContext = { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 8453, salt: `0x${'01'.repeat(32)}`, validAfter: 100, validUntil: 200, caps, capUsdc: 1_000n * USDC, generation: 1n, registry: deployed }
const BTC = 'pool:USDC/cbBTC/500'

describe('policy v4 (spec 007 T2)', () => {
  test('every policy that existed before keeps its hash and has no action policy', () => {
    for (const [id, hash] of Object.entries(MAIN_HASHES)) {
      expect(POLICIES[id], id).toBeDefined()
      expect(policyHash(POLICIES[id]!), id).toBe(hash as `0x${string}`)
      expect(usesActionPolicy(POLICIES[id]!), id).toBe(false)
      expect(POLICIES[id]!.actionPolicy, id).toBeUndefined()
      expect(POLICIES[id]!.session.grants.some((g) => g.name === 'engine'), id).toBe(false)
    }
    // The only additions are the two v4 versions.
    expect(Object.keys(POLICIES).filter((k) => !(k in MAIN_HASHES)).sort()).toEqual(['conservador-lab-v4', 'conservador-live-v4'])
  })

  test('v1/v2 keys, manage-any and increase answers are what they were', () => {
    const v2 = conservadorLiveV2
    for (const pool of v2.buckets.flatMap((b) => b.pools)) {
      for (const role of ['enter-swap', 'enter-mint', 'manage-any', 'convert-any'] as const) expect(grantKeyFor(v2, role, pool)).toBe(`${role}:${pool}`)
      expect(() => grantKeyFor(v2, 'increase', pool)).toThrow(/no increase grant/)
      expect(hasIncrease(v2, pool)).toBe(false)
    }
    expect(hasManageAny(v2)).toBe(true)
    expect(hasManageAny(POLICIES['conservador-v1']!)).toBe(false)
  })

  test('v4 is conservador-live-v2 with one engine session per pool and the action policy parameters', () => {
    const v4 = conservadorLiveV4
    expect({ ...v4, policyId: v2Id, version: '2.1.0', actionPolicy: undefined, session: undefined }).toEqual({ ...conservadorLiveV2, actionPolicy: undefined, session: undefined })
    expect(v4.session.validitySeconds).toBe(conservadorLiveV2.session.validitySeconds)
    expect(v4.actionPolicy).toBe(ACTION_POLICY_DEFAULTS)
    // spec 007 T5, recommendation C: bands 20/125/125, W 8/3/5 x C_p per day, T 60/42/110 x C_p per approval.
    expect(ACTION_POLICY_DEFAULTS).toEqual({
      twapWindowSeconds: 1800,
      budgetWindowSeconds: 86_400,
      byPool: {
        'pool:USDC/USDT/100': { bandTicks: 20, perWindowBps: 80_000, totalBps: 600_000 },
        'pool:USDC/cbBTC/500': { bandTicks: 125, perWindowBps: 30_000, totalBps: 420_000 },
        'pool:WETH/USDC/3000': { bandTicks: 125, perWindowBps: 50_000, totalBps: 1_100_000 },
      },
    })
    expect(v4.actionPolicy!.twapWindowSeconds).toBe(v4.execution.twapWindowSeconds)
    expect(v4.session.grants.map(grantKey)).toEqual(['engine:pool:USDC/USDT/100', 'engine:pool:USDC/cbBTC/500', 'engine:pool:WETH/USDC/3000'])
    for (const g of v4.session.grants) {
      expect(g.perPosition).toBe(false)
      expect(g.actionPolicy!.bandTicks).toBe(ACTION_POLICY_DEFAULTS.byPool[g.pool!]!.bandTicks)
    }
    for (const pool of v4.buckets.flatMap((b) => b.pools)) {
      for (const role of ['enter-swap', 'enter-mint', 'manage-any', 'convert-any', 'increase'] as const) expect(grantKeyFor(v4, role, pool)).toBe(`engine:${pool}`)
      expect(hasIncrease(v4, pool)).toBe(true)
    }
    expect(hasManageAny(v4)).toBe(true)
    // Budgets in multiples of C_p, the bucket preference of the account cap (1,000 USDC: 500 / 400 / 100).
    expect(caps.btcWindow0).toBe(1_200n * USDC)
    expect(caps.btcTotal0).toBe(16_800n * USDC)
    expect(caps.stablesWindow1).toBe(4_000n * USDC)
    expect(caps.stablesTotal0).toBe(30_000n * USDC)
    expect(caps.riskWindow1).toBe(500n * USDC)
    expect(caps.riskTotal0).toBe((11_000n * USDC * 10n ** 12n) / 3_000n)
    expect(conservadorLabV4.chain).toBe('fork')
  })

  test('the engine grant: every action, rule and policy a session key gets', () => {
    const g = instantiateGrant(conservadorLiveV4, `engine:${BTC}`, ctx)
    const shape = g.actions.map((a) => [a.target, a.signature.split('(')[0], a.selector, a.uniOnly ?? false, a.params.map((p) => `${p.field} ${p.condition} ${p.ref}`)])
    const acct = BigInt(ACCOUNT)
    const w0 = caps.btcWindow0!
    const w1 = caps.btcWindow1!
    const max = w0 > w1 ? w0 : w1
    expect(shape).toEqual([
      ['USDC', 'approve', '0x095ea7b3', false, [`amount LESS_THAN_OR_EQUAL ${w0}`]],
      ['cbBTC', 'approve', '0x095ea7b3', false, [`amount LESS_THAN_OR_EQUAL ${w1}`]],
      ['SwapRouter02', 'exactInputSingle', '0x04e45aaf', false, ['fee EQUAL 500', `recipient EQUAL ${acct}`, `amountIn LESS_THAN_OR_EQUAL ${max}`, 'amountOutMinimum GREATER_THAN 0']],
      ['SwapRouter02', 'multicall', '0x5ae401dc', true, ['deadline GREATER_THAN 0', 'dataOffset EQUAL 64', 'dataLength EQUAL 0']],
      ['MamoruActionPolicy', 'mint', '0x88316456', false, [`token0 EQUAL ${BigInt(address('USDC'))}`, `token1 EQUAL ${BigInt(address('cbBTC'))}`, 'fee EQUAL 500', `amount0Desired LESS_THAN_OR_EQUAL ${w0}`, `amount1Desired LESS_THAN_OR_EQUAL ${w1}`, 'amount0Min GREATER_THAN 0', 'amount1Min GREATER_THAN 0', `recipient EQUAL ${acct}`]],
      ['MamoruActionPolicy', 'increase', '0x4110c363', false, ['tokenId GREATER_THAN 0', `amount0Desired LESS_THAN_OR_EQUAL ${w0}`, `amount1Desired LESS_THAN_OR_EQUAL ${w1}`, 'amount0Min GREATER_THAN 0', 'amount1Min GREATER_THAN 0']],
      ['NonfungiblePositionManager', 'decreaseLiquidity', '0x0c49ccbe', false, ['tokenId GREATER_THAN 0']],
      ['NonfungiblePositionManager', 'collect', '0xfc6f7865', false, [`recipient EQUAL ${acct}`]],
      ['NonfungiblePositionManager', 'burn', '0x42966c68', false, ['tokenId GREATER_THAN 0']],
    ])
    expect(toFunctionSelector('function increase((uint256,uint256,uint256,uint256,uint256,uint256))')).toBe('0x4110c363')
    // Mint and increase go to the policy, never the manager; no action can transfer or approve an NFT; the swap has no
    // `sqrtPriceLimitX96 EQUAL 0` (the policy requires a limit inside its band).
    expect(g.actions.filter((a) => a.signature.startsWith('mint') || a.signature.startsWith('increase')).every((a) => a.targetAddress === POLICY)).toBe(true)
    expect(g.actions.some((a) => a.target === 'NonfungiblePositionManager' && /^(mint|increaseLiquidity)\(/.test(a.signature))).toBe(false)
    expect(g.actions.some((a) => /^(transfer|transferFrom|safeTransferFrom|setApprovalForAll)\(/.test(a.signature))).toBe(false)
    expect(g.actions.flatMap((a) => a.params).some((p) => p.field === 'sqrtPriceLimitX96')).toBe(false)
    expect(g.actionPolicy).toEqual({
      address: POLICY,
      init: { pool: address(BTC), twapWindow: 1800, bandTicks: 125, generation: 1n, budgetWindow: 86_400, perWindow0: w0, perWindow1: w1, total0: caps.btcTotal0!, total1: caps.btcTotal1! },
    })
    expect(g.userOp.usageLimit).toBe(1_000 + 6_500)
    expect(instantiateGrant(conservadorLiveV4, `engine:${BTC}`, { ...ctx, capUsdc: 100_000n * USDC }).userOp.usageLimit).toBe(32_000 + 6_500)
  })

  test('no v4 grant without MamoruActionPolicy in the registry: as it is today on Base', () => {
    let e: unknown
    try {
      instantiateGrant(conservadorLiveV4, `engine:${BTC}`, { ...ctx, registry: undefined })
    } catch (x) {
      e = x
    }
    expect(e).toBeInstanceOf(ReasonError)
    expect((e as ReasonError).code).toBe('POLICY_TARGET_NOT_IN_REGISTRY')
    expect((e as ReasonError).detail).toMatch(/MamoruActionPolicy is not deployed on base/)
  })

  test('a v4 grant needs a generation; a v1/v2 grant takes none, and maps as before', () => {
    expect(() => instantiateGrant(conservadorLiveV4, `engine:${BTC}`, { ...ctx, generation: undefined })).toThrow(/needs a generation/)
    expect(() => instantiateGrant(conservadorLiveV4, `engine:${BTC}`, { ...ctx, generation: 0n })).toThrow(/needs a generation/)
    const v2ctx = { ...ctx, caps: computeCaps(conservadorLiveV2, 1_000n * USDC, prices), generation: undefined, registry: undefined }
    expect(() => instantiateGrant(conservadorLiveV2, `enter-swap:${BTC}`, { ...v2ctx, generation: 1n })).toThrow(/no action policy/)
    const v2 = instantiateGrant(conservadorLiveV2, `enter-swap:${BTC}`, v2ctx)
    expect('actionPolicy' in v2).toBe(false)
    expect(v2.actions.some((a) => 'uniOnly' in a)).toBe(false)
  })

  test('budgets beyond uint128 or a window above the total are refused', () => {
    expect(() => instantiateGrant(conservadorLiveV4, `engine:${BTC}`, { ...ctx, caps: { ...caps, btcTotal1: 1n << 128n } })).toThrow(/out of uint128/)
    expect(() => instantiateGrant(conservadorLiveV4, `engine:${BTC}`, { ...ctx, caps: { ...caps, btcTotal0: caps.btcWindow0! - 1n } })).toThrow(/window budget above the approval total/)
  })
})

const v2Id = conservadorLiveV2.policyId
