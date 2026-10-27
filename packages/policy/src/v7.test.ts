// otto/mamoru#225: conservador-live-v7, v6 with one session per pool. Pins the merged shape and, rule by rule, exactly
// which UniActionPolicy rules the merge drops (each one is left to MamoruActionPolicyV2; the fork scenario t11 proves V2
// refuses what they refused). v6 itself is unchanged (v6.test.ts pins it).
import { describe, expect, test } from 'bun:test'
import { computeCaps, instantiateGrant, policyHash, type GrantContext } from './instantiate.ts'
import { grantKey, grantKeyFor } from './grants.ts'
import { conservadorLiveV6, V6_POOLS } from './policies-v6.ts'
import { conservadorLabV7, conservadorLiveV7, oneTransaction } from './policies-v7.ts'
import type { ActionRuleTemplate, GrantTemplate, ParamRuleTemplate } from './types.ts'
import { exitOnlyV5Grant, grantsV5, mergeGrants, orderV4Keys, V4_POOLS } from './v4-grants.ts'

const STABLES = 'pool:USDC/USDT/100'
const BALANCE = 'pool:WETH/USDC/3000'
const BTC = 'pool:USDC/cbBTC/500'
const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
const CAP = 10_000n * 1_000_000n

function ctx(): GrantContext {
  const caps = computeCaps(conservadorLiveV7, CAP, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } })
  return { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 8453, salt: `0x${'00'.repeat(32)}`, validAfter: 0, validUntil: 1, caps }
}

const sig = (a: ActionRuleTemplate) => a.signature.split('(')[0]
const ruleKey = (a: ActionRuleTemplate, r: ParamRuleTemplate) => `${a.target}.${sig(a)}.${r.field}`

/** Every UniActionPolicy rule of `parts` the merged grant does not carry as it was (dropped, or loosened). */
function loosened(parts: GrantTemplate[], merged: GrantTemplate): string[] {
  const out = new Set<string>()
  for (const g of parts) {
    for (const a of g.actions) {
      const m = merged.actions.find((x) => x.target === a.target && x.signature === a.signature)
      if (!m) throw new Error(`merged lost ${a.target} ${a.signature}`)
      for (const r of a.params) {
        const kept = m.params.find((x) => x.index === r.index)
        if (!kept) out.add(`${ruleKey(a, r)}: dropped${m.actionPolicyOnly ? ' (V2 only)' : ''}`)
        else if (kept.ref !== r.ref || kept.cumulative !== r.cumulative || kept.condition !== r.condition) out.add(`${ruleKey(a, r)}: ${String(r.ref)}${r.cumulative ? ` cum ${r.cumulative}` : ''} -> ${String(kept.ref)}${kept.cumulative ? ` cum ${kept.cumulative}` : ''}`)
      }
    }
  }
  return [...out].sort()
}

describe('conservador-live-v7 (otto/mamoru#225)', () => {
  test('v6 buckets, caps and Monad growth; one transaction; v6 untouched', () => {
    expect(conservadorLiveV7.buckets).toEqual(conservadorLiveV6.buckets)
    expect(conservadorLiveV7.remoteBuckets).toEqual(conservadorLiveV6.remoteBuckets)
    expect(conservadorLiveV7.session.caps).toEqual(conservadorLiveV6.session.caps)
    expect(conservadorLiveV7.actionPolicy).toBeUndefined()
    expect(oneTransaction(conservadorLiveV7)).toBe(true)
    expect(oneTransaction(conservadorLiveV6)).toBe(false)
    expect(conservadorLabV7).toMatchObject({ policyId: 'conservador-lab-v7', chain: 'fork' })
    expect(policyHash(conservadorLiveV7)).not.toBe(policyHash(conservadorLiveV6))
    expect(conservadorLiveV6.session.grants).toHaveLength(8)
  })

  test('4 sessions instead of 8: one per pool and bridge-out; 26 actions, 12 of them with UniActionPolicy outside bridge-out', () => {
    const keys = conservadorLiveV7.session.grants.map(grantKey)
    expect(keys).toEqual([`manage-any:${STABLES}`, `manage-any:${BALANCE}`, `manage-any:${BTC}`, 'bridge-out'])
    expect(orderV4Keys(conservadorLiveV7, keys)).toEqual(keys)
    const [stables, balance, btc, bridge] = conservadorLiveV7.session.grants
    expect(stables!.actions.map(sig)).toEqual(['approve', 'exactInputSingle', 'multicall', 'approve', 'mint', 'decreaseLiquidity', 'collect', 'burn', 'increase'])
    expect(balance!.actions).toHaveLength(9)
    expect(btc!.actions.map(sig)).toEqual(['decreaseLiquidity', 'collect', 'burn', 'approve', 'exactInputSingle', 'multicall'])
    expect(bridge).toEqual(conservadorLiveV6.session.grants.at(-1))
    const v2Only = (g: GrantTemplate) => g.actions.filter((a) => a.actionPolicyOnly).map(sig)
    for (const g of [stables!, balance!, btc!]) {
      expect(v2Only(g).sort()).toEqual(['burn', 'collect', 'decreaseLiquidity', 'multicall'])
      expect(g.actions.filter((a) => a.actionPolicyOnly).every((a) => a.params.length === 0)).toBe(true)
      expect(g.requiresActionPolicy).toBe(true)
    }
    expect(stables!.covers).toEqual(['enter-swap', 'enter-mint', 'manage-any'])
    expect(btc!.covers).toEqual(['manage-any'])
    // Usage: the sum of the three v6 grants per pool; the exit one as v6's.
    expect(stables!.usageLimit).toBe(36_000)
    expect(btc!.usageLimit).toBe(32_000)
  })

  test('the engine keeps its role names: enter-swap / enter-mint / manage-any of a pool all key its one session', () => {
    for (const pool of [STABLES, BALANCE]) {
      for (const name of ['enter-swap', 'enter-mint', 'manage-any', 'convert-any'] as const) {
        if (name === 'convert-any') expect(() => grantKeyFor(conservadorLiveV7, name, pool)).toThrow('no convert-any grant')
        else expect(grantKeyFor(conservadorLiveV7, name, pool)).toBe(`manage-any:${pool}`)
      }
    }
    // The exit-only pool has no way in, as in v6.
    expect(() => grantKeyFor(conservadorLiveV7, 'enter-swap', BTC)).toThrow('no enter-swap grant')
    expect(grantKeyFor(conservadorLiveV7, 'manage-any', BTC)).toBe(`manage-any:${BTC}`)
    // v6 resolves as before.
    expect(grantKeyFor(conservadorLiveV6, 'enter-swap', STABLES)).toBe(`enter-swap:${STABLES}`)
  })

  test('security mapping: exactly these UniActionPolicy rules are dropped or loosened by the merge, each left to V2', () => {
    const parts = grantsV5(V6_POOLS.balance, { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 })
    expect(loosened(parts, conservadorLiveV7.session.grants[1]!)).toEqual([
      // V2-only actions: V2 checks an admitted position the Safe owns (decrease, collect, burn), recipient = the Safe
      // (collect), decrease minimums from its band, and the deadline's exact empty encoding.
      'NonfungiblePositionManager.burn.tokenId: dropped (V2 only)',
      'NonfungiblePositionManager.collect.recipient: dropped (V2 only)',
      'NonfungiblePositionManager.decreaseLiquidity.tokenId: dropped (V2 only)',
      // Mint: per-call caps kept, the per-approval totals go to V2's budget (T_p); minimums > 0 go to V2's
      // _checkProvide (spot in the band, minimums met at the spot) as for v6's manage-any mint, which never had them.
      'NonfungiblePositionManager.mint.amount0Desired: cap:riskMint0 cum cap:riskMint0Total -> cap:riskMint0',
      'NonfungiblePositionManager.mint.amount0Min: dropped',
      'NonfungiblePositionManager.mint.amount1Desired: cap:riskMint1 cum cap:riskMint1Total -> cap:riskMint1',
      'NonfungiblePositionManager.mint.amount1Min: dropped',
      'SwapRouter02.exactInputSingle.amountIn: cap:riskConvertPerCall cum cap:riskConvertTotal -> cap:riskSwapPerCall|riskConvertPerCall',
      'SwapRouter02.exactInputSingle.amountIn: cap:riskSwapPerCall cum cap:riskSwapTotal -> cap:riskSwapPerCall|riskConvertPerCall',
      // Swap direction: V2 _checkSwap takes only the pool's two tokens, either way, charging the budget both ways.
      'SwapRouter02.exactInputSingle.tokenIn: dropped',
      'SwapRouter02.exactInputSingle.tokenOut: dropped',
      'SwapRouter02.multicall.dataLength: dropped (V2 only)',
      'SwapRouter02.multicall.dataOffset: dropped (V2 only)',
      'SwapRouter02.multicall.deadline: dropped (V2 only)',
      // Approvals: spender router or V2 is V2's own APPROVE check; the amount keeps the larger per-call cap.
      'USDC.approve.amount: cap:riskMint1 -> cap:riskSwapPerCall|riskMint1',
      'USDC.approve.amount: cap:riskSwapPerCall -> cap:riskSwapPerCall|riskMint1',
      'USDC.approve.spender: dropped',
      'WETH.approve.amount: cap:riskConvertPerCall -> cap:riskMint0|riskConvertPerCall',
      'WETH.approve.amount: cap:riskMint0 -> cap:riskMint0|riskConvertPerCall',
      'WETH.approve.spender: dropped',
    ])
    // Exit-only: nothing loosened but the V2-only actions; the swap stays cbBTC -> USDC.
    expect(loosened([exitOnlyV5Grant(V4_POOLS.btc, 32_000)], conservadorLiveV7.session.grants[2]!).filter((l) => !l.endsWith('(V2 only)'))).toEqual([])
    // Every rule the merge keeps, every part had (nothing is added that would refuse a call a part allowed).
    for (const m of conservadorLiveV7.session.grants.slice(0, 2)) {
      for (const a of m.actions) for (const r of a.params) expect(r.cumulative).toBeUndefined()
    }
  })

  test('instantiated: `cap:a|b` resolves to the larger cap, V2-only actions carry no rule, no action repeats', () => {
    const c = ctx()
    const cap = (n: string) => c.caps[n]!
    const max = (a: string, b: string) => (cap(a) > cap(b) ? cap(a) : cap(b))
    const g = instantiateGrant(conservadorLiveV7, `manage-any:${BALANCE}`, c)
    const swap = g.actions.find((a) => a.signature.startsWith('exactInputSingle'))!
    const amountIn = swap.params.find((p) => p.field === 'amountIn')!
    expect(amountIn.ref).toBe(max('riskSwapPerCall', 'riskConvertPerCall'))
    expect(amountIn.cumulativeLimit).toBeUndefined()
    const approve = g.actions.find((a) => a.target === 'USDC')!.params.find((p) => p.field === 'amount')!
    expect(approve.ref).toBe(max('riskSwapPerCall', 'riskMint1'))
    expect(approve.ref).toBe(cap('riskMint1')) // the mint cap (2x the share) over the swap cap (1x)
    expect(g.actions.filter((a) => a.actionPolicyOnly).map((a) => a.params.length)).toEqual([0, 0, 0, 0])
    expect(g.userOp.usageLimit).toBe(36_000)
    expect(g.requiresActionPolicy).toBe(true)
  })

  test('mergeGrants refuses parts of two pools, gated or tiered grants', () => {
    const s = grantsV5(V4_POOLS.stables, { enterSwap: 1, enterMint: 1, manageAny: 1 })
    const r = grantsV5(V4_POOLS.risk, { enterSwap: 1, enterMint: 1, manageAny: 1 })
    expect(() => mergeGrants([s[0]!, r[0]!])).toThrow('same pool')
    expect(() => mergeGrants([{ ...s[0]!, requiresActionPolicy: undefined }])).toThrow('only MamoruActionPolicy')
    expect(() => mergeGrants([{ ...s[0]!, usageByCap: [{ upToUsdc: 1n, usageLimit: 1 }] }])).toThrow('only MamoruActionPolicy')
  })

  test('instantiateGrant refuses a rule-less action outside V2-only, and a V2-only action with rules', () => {
    const bad = (g: GrantTemplate) => ({ ...conservadorLiveV7, session: { ...conservadorLiveV7.session, grants: [g] } })
    const g = conservadorLiveV7.session.grants[0]!
    expect(() => instantiateGrant(bad({ ...g, actions: [{ ...g.actions[0]!, params: [] }] }), grantKey(g), ctx())).toThrow('has no rule')
    expect(() => instantiateGrant(bad({ ...g, actions: [{ ...g.actions[5]!, params: g.actions[0]!.params }] }), grantKey(g), ctx())).toThrow('needs MamoruActionPolicy and no rules')
    expect(() => instantiateGrant(bad({ ...g, requiresActionPolicy: undefined }), grantKey(g), ctx())).toThrow('needs MamoruActionPolicy')
  })
})
