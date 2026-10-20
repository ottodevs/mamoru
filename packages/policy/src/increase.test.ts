import { describe, expect, test } from 'bun:test'
import { ReasonError } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { conservadorLabIncreaseV1, conservadorLiveV2, grantKey, hasIncrease, instantiateGrant, POLICIES, type GrantTemplate } from './index.ts'

// otto/mamoru#171: the `increase` grant, per position. NonfungiblePositionManager.increaseLiquidity does not check who
// owns the tokenId, so only `tokenId EQUAL <id>` keeps what it pays in the Safe's own position.
const LAB = conservadorLabIncreaseV1
const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
// A distinct value per cap name, so a rule that read another pair's or side's cap would show.
const caps = new Proxy({}, { get: (_t, k) => BigInt([...String(k)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000_007, 7)) }) as Record<string, bigint>
const ctx = { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb' as const, chainId: 31337, salt: `0x${'00'.repeat(32)}` as const, validAfter: 0, validUntil: 1, caps }

describe('increase grant (otto/mamoru#171)', () => {
  test('only the Lab increase policy has it; every other policy, live ones included, is unchanged', () => {
    for (const p of Object.values(POLICIES)) {
      const has = p.session.grants.some((g) => g.name === 'increase')
      expect(has).toBe(p.policyId === 'conservador-lab-increase-v1')
    }
    expect(LAB.session.grants.filter((g) => g.name === 'increase').map(grantKey)).toEqual(['increase:pool:USDC/USDT/100', 'increase:pool:USDC/cbBTC/500', 'increase:pool:WETH/USDC/3000'])
    expect(hasIncrease(LAB, 'pool:WETH/USDC/3000')).toBe(true)
    expect(hasIncrease(POLICIES['conservador-live-v2']!, 'pool:WETH/USDC/3000')).toBe(false)
  })

  test('per position: never in the activation batch, and the owner enables it only for an admitted tokenId', () => {
    for (const g of LAB.session.grants.filter((g) => g.name === 'increase')) expect(g.perPosition).toBe(true)
    // The activation batch is the non-perPosition grants: the same keys as conservador-live-v2's.
    const batch = (p: { session: { grants: GrantTemplate[] } }) => p.session.grants.filter((g) => !g.perPosition).map(grantKey)
    expect(batch(LAB)).toEqual(batch(conservadorLiveV2))
    expect(() => instantiateGrant(LAB, 'increase:pool:WETH/USDC/3000', ctx)).toThrow('needs a tokenId')
    let denied: unknown
    try {
      instantiateGrant(LAB, 'increase:pool:WETH/USDC/3000', { ...ctx, tokenId: 9n, admittedTokenIds: [8n] })
    } catch (e) {
      denied = e
    }
    expect(denied).toBeInstanceOf(ReasonError)
    expect((denied as ReasonError).code).toBe('POLICY_DENIED_POSITION')
  })

  test('the rules: tokenId EQUAL the position, approvals only to the position manager, desired under the mint caps, minimums positive, no transfer', () => {
    const g = instantiateGrant(LAB, 'increase:pool:WETH/USDC/3000', { ...ctx, tokenId: 6291301n, admittedTokenIds: [6291301n] })
    expect(g.tokenId).toBe(6291301n)
    expect(g.actions.map((a) => `${a.target}.${a.signature.split('(')[0]}`)).toEqual(['WETH.approve', 'USDC.approve', 'NonfungiblePositionManager.increaseLiquidity'])
    const inc = g.actions[2]!
    expect(inc.params.map((p) => [p.field, p.index, p.condition, p.ref])).toEqual([
      ['tokenId', 0, 'EQUAL', 6291301n],
      ['amount0Desired', 1, 'LESS_THAN_OR_EQUAL', caps.riskMint0!],
      ['amount1Desired', 2, 'LESS_THAN_OR_EQUAL', caps.riskMint1!],
      ['amount0Min', 3, 'GREATER_THAN', 0n],
      ['amount1Min', 4, 'GREATER_THAN', 0n],
    ])
    for (const a of g.actions.slice(0, 2)) expect(a.params[0]).toMatchObject({ field: 'spender', condition: 'EQUAL', ref: BigInt(address('NonfungiblePositionManager')) })
    for (const a of g.actions) expect(a.signature).not.toMatch(/^(transfer|transferFrom|safeTransferFrom|setApprovalForAll|mint|collect|decreaseLiquidity|burn)\(/)
  })
})
