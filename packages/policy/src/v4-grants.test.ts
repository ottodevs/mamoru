import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeAbiParameters } from 'viem'
import { describe, expect, test } from 'bun:test'
import { address } from '@mamoru/registry'
import { computeCaps, instantiateGrant, type GrantContext } from './instantiate.ts'
import {
  DEFAULT_GAS_CEILING,
  DEFAULT_GAS_MODEL,
  encodeMamoruInit,
  enterMintV4Grant,
  enterSwapV4Grant,
  estimateSessionGas,
  grantsV4,
  mamoruInitFor,
  manageAnyV4Grant,
  retargetToPolicy,
  splitBatches,
  splitSessionsByGas,
  V4_POOLS,
  v4CapFormulas,
  budgetIn1,
  MAMORU_INIT_TUPLE,
  type MamoruInit,
} from './v4-grants.ts'
import { conservadorLiveV4 } from './policies-v4.ts'

const CONTRACT_SRC = join(import.meta.dir, '../../../contracts/action-policy/src/MamoruActionPolicy.sol')

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
const SESSION_KEY = '0x00000000000000000000000000000000000000bb' as const
const MAMORU_POLICY = '0x00000000000000000000000000000000000000Fe' as const

function ctxFor(pool: (typeof V4_POOLS)[keyof typeof V4_POOLS], depositUsdc = 10_000n * 1_000_000n): GrantContext {
  const caps = computeCaps(conservadorLiveV4, depositUsdc, {
    USDT: { num: 1n, den: 1n },
    cbBTC: { num: 1n, den: 100_000n },
    WETH: { num: 1n, den: 3_000n },
  })
  return {
    account: ACCOUNT,
    sessionKey: SESSION_KEY,
    chainId: 8453,
    salt: `0x${'00'.repeat(32)}` as const,
    validAfter: 0,
    validUntil: 1,
    caps,
  }
}

describe('MamoruActionPolicy.Init encoding stays in sync with the Solidity struct', () => {
  test('field order and types match contracts/action-policy/src/MamoruActionPolicy.sol', () => {
    const src = readFileSync(CONTRACT_SRC, 'utf8')
    const m = src.match(/struct Init \{([^}]*)\}/)
    expect(m).not.toBeNull()
    const fields = m![1]!
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter(Boolean)
      .map((l) => {
        const [type, name] = l.replace(/;$/, '').split(/\s+/)
        return { type, name }
      })
    expect(fields).toEqual(MAMORU_INIT_TUPLE[0].components.map((c) => ({ type: c.type, name: c.name })))
    expect(fields.map((f) => f.name)).toEqual(['pool', 'twapWindow', 'twapShortWindow', 'bandTicks', 'generation', 'minLiquidity', 'budgetIn1', 'budgetWindow', 'perWindow', 'total', 'admit'])
  })

  test('encodeMamoruInit round-trips through abi.decode(data, (Init))', () => {
    const init: MamoruInit = {
      pool: address('pool:USDC/cbBTC/500'),
      twapWindow: 1800,
      twapShortWindow: 300,
      bandTicks: 100,
      generation: 1n,
      minLiquidity: 669_000_000_000n,
      budgetIn1: false,
      budgetWindow: 86_400,
      perWindow: 60_000_000_000n,
      total: 180_000_000_000n,
      admit: [7n, 123_456n],
    }
    const encoded = encodeMamoruInit(init)
    const [decoded] = decodeAbiParameters(MAMORU_INIT_TUPLE, encoded)
    expect(decoded).toEqual(init)
    // Dynamic struct: abi.encode(Init) starts with the offset of the tuple (0x20), as Solidity's encoder writes it.
    expect(encoded.slice(0, 66)).toBe(`0x${'0'.repeat(62)}20`)
  })

  test('mamoruInitFor resolves a pool spec + caps into a well-formed Init', () => {
    const caps = computeCaps(conservadorLiveV4, 10_000n * 1_000_000n, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } })
    const init = mamoruInitFor(V4_POOLS.btc, 1n, caps, { admit: [42n] })
    expect(init.pool.toLowerCase()).toBe(address('pool:USDC/cbBTC/500').toLowerCase())
    expect(init.twapWindow).toBe(1800)
    expect(init.twapShortWindow).toBe(300)
    expect(init.bandTicks).toBe(100)
    expect(init.budgetWindow).toBe(86_400)
    expect(init.minLiquidity).toBe(V4_POOLS.btc.minLiquidity)
    expect(init.admit).toEqual([42n])
    // btc: W_p = 2 x C_p per day, T_p = 10 x C_p per approval (T5, Ot 18-Oct): total is 5x the per-window budget.
    expect(init.total).toBe(init.perWindow * 5n)
    // T6 M-2: one value budget in USDC (token0 here): 2 x 40% of 10,000 USDC per day.
    expect(init.budgetIn1).toBe(false)
    expect(init.perWindow).toBe(8_000_000_000n)
  })

  test('T6 M-2: the budget unit is each pool\'s stable token (token1 only on WETH/USDC)', () => {
    expect(budgetIn1(V4_POOLS.stables)).toBe(false)
    expect(budgetIn1(V4_POOLS.btc)).toBe(false)
    expect(budgetIn1(V4_POOLS.risk)).toBe(true)
    for (const p of Object.values(V4_POOLS)) {
      const f = v4CapFormulas('x', p).filter((c) => c.name === 'xBudgetWindow' || c.name === 'xBudgetTotal')
      expect(f.map((c) => c.asset)).toEqual([p.stable, p.stable])
      expect(f.map((c) => c.bpsOfDeposit)).toEqual([p.capShareBps * p.windowMultiple, p.capShareBps * p.totalMultiple])
    }
  })

  test('band ticks follow the spec 007 Parameters table (stables 10, btc 100, risk 100)', () => {
    expect(V4_POOLS.stables.bandTicks).toBe(10)
    expect(V4_POOLS.btc.bandTicks).toBe(100)
    expect(V4_POOLS.risk.bandTicks).toBe(100)
  })
})

describe('v4 grant shapes', () => {
  test('the swap rule sqrtPriceLimitX96 EQUAL 0 is gone from every exactInputSingle action', () => {
    for (const pool of Object.values(V4_POOLS)) {
      for (const g of grantsV4(pool, { enterSwap: 1, enterMint: 1, manageAny: 1 })) {
        for (const a of g.actions.filter((x) => x.signature.startsWith('exactInputSingle('))) {
          expect(a.params.some((p) => p.field === 'sqrtPriceLimitX96')).toBe(false)
          expect(a.params.find((p) => p.field === 'amountOutMinimum')).toMatchObject({ condition: 'GREATER_THAN', ref: 0n })
        }
      }
    }
  })

  test('manage-any merges manage-any + convert-any into one 7-action grant; no per-position manage grant exists', () => {
    const g = manageAnyV4Grant(V4_POOLS.btc, 1)
    expect(g.name).toBe('manage-any')
    // One approve per token, not one per (token, flow): the volatile token's approve is shared by mint and the
    // harvest swap (see manageAnyV4Actions' doc) because SmartSession keys an action by (target, selector) only.
    expect(g.actions.map((a) => a.signature.split('(')[0])).toEqual(['decreaseLiquidity', 'collect', 'burn', 'approve', 'approve', 'mint', 'exactInputSingle'])
    expect(g.actions).toHaveLength(7)
  })

  test('every action of a grant has a unique (target, selector): SmartSession could not key a grant otherwise', () => {
    for (const pool of Object.values(V4_POOLS)) {
      for (const g of grantsV4(pool, { enterSwap: 1, enterMint: 1, manageAny: 1 })) {
        const keys = g.actions.map((a) => `${a.target.toLowerCase()}:${a.signature}`)
        expect(new Set(keys).size).toBe(keys.length)
      }
    }
  })

  test('enter-swap has 2 actions, enter-mint has 3, manage-any has 7 — 12 actions per pool, 36 for three pools', () => {
    for (const pool of Object.values(V4_POOLS)) {
      expect(enterSwapV4Grant(pool, 1).actions).toHaveLength(2)
      expect(enterMintV4Grant(pool, 1).actions).toHaveLength(3)
      expect(manageAnyV4Grant(pool, 1).actions).toHaveLength(7)
    }
    const all = Object.values(V4_POOLS).flatMap((p) => grantsV4(p, { enterSwap: 1, enterMint: 1, manageAny: 1 }))
    expect(all.reduce((n, g) => n + g.actions.length, 0)).toBe(36)
  })

  test('conservadorLiveV4 carries all three pools and is not registered in POLICIES (not wired live)', async () => {
    expect(conservadorLiveV4.session.grants).toHaveLength(9) // 3 grants x 3 pools
    const { POLICIES } = await import('./policies.ts')
    expect(Object.keys(POLICIES)).not.toContain('conservador-live-v4')
  })
})

describe('retargetToPolicy', () => {
  test('enter-mint: both approvals and mint move to the policy address; everything else is untouched', () => {
    const grant = instantiateGrant(conservadorLiveV4, 'enter-mint:pool:USDC/cbBTC/500', ctxFor(V4_POOLS.btc))
    const retargeted = retargetToPolicy(grant, MAMORU_POLICY)
    const mint = retargeted.actions.find((a) => a.signature.startsWith('mint('))!
    expect(mint.targetAddress.toLowerCase()).toBe(MAMORU_POLICY.toLowerCase())
    for (const a of retargeted.actions.filter((a) => a.signature.startsWith('approve('))) {
      const spender = a.params.find((p) => p.field === 'spender')!
      expect(spender.ref).toBe(BigInt(MAMORU_POLICY))
    }
  })

  test('manage-any: mint + the stable-token approval move to the policy; the shared volatile approval has no spender rule to move', () => {
    const grant = instantiateGrant(conservadorLiveV4, 'manage-any:pool:USDC/cbBTC/500', ctxFor(V4_POOLS.btc))
    const retargeted = retargetToPolicy(grant, MAMORU_POLICY)
    const mint = retargeted.actions.find((a) => a.signature.startsWith('mint('))!
    expect(mint.targetAddress.toLowerCase()).toBe(MAMORU_POLICY.toLowerCase())
    const approves = retargeted.actions.filter((a) => a.signature.startsWith('approve('))
    expect(approves).toHaveLength(2)
    const withSpender = approves.filter((a) => a.params.some((p) => p.field === 'spender'))
    expect(withSpender).toHaveLength(1) // the stable token's approve only
    expect(withSpender[0]!.params.find((p) => p.field === 'spender')!.ref).toBe(BigInt(MAMORU_POLICY))
    const noSpender = approves.find((a) => !a.params.some((p) => p.field === 'spender'))!
    expect(noSpender.target).toBe(V4_POOLS.btc.volatile) // the shared volatile-token approve, untouched (no spender rule to retarget)
  })

  test('enter-swap: nothing is retargeted (no mint, approval spender is already the router)', () => {
    const grant = instantiateGrant(conservadorLiveV4, 'enter-swap:pool:USDC/cbBTC/500', ctxFor(V4_POOLS.btc))
    const retargeted = retargetToPolicy(grant, MAMORU_POLICY)
    expect(retargeted).toEqual(grant)
  })
})

describe('gas model + splitter (spec 007 Tasks T2 (b))', () => {
  test('estimateSessionGas is linear in action count under the default (T1-calibrated) model', () => {
    expect(estimateSessionGas(8)).toBe(DEFAULT_GAS_MODEL.perActionGas * 8n)
    expect(estimateSessionGas(2)).toBe(DEFAULT_GAS_MODEL.perActionGas * 2n)
  })

  test('splitBatches: order preserved, every batch under the ceiling, no item lost or duplicated', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ label: `item-${i}`, gas: 1_000_000n + BigInt(i) * 100_000n }))
    const batches = splitBatches(items, (x) => x.gas, 5_000_000n)
    expect(batches.flat()).toEqual(items) // order preserved, nothing lost or duplicated
    for (const b of batches) expect(b.reduce((s, x) => s + x.gas, 0n)).toBeLessThanOrEqual(5_000_000n)
    expect(batches.length).toBeGreaterThan(1)
  })

  test('splitBatches throws when a single item alone is over the ceiling', () => {
    expect(() => splitBatches([{ gas: 20_000_000n }], (x) => x.gas, 14_000_000n)).toThrow(/over the ceiling/)
  })

  test('a full 3-pool v4 grant set (36 actions, 9 sessions) needs more than one enableSessions transaction under the default ceiling', () => {
    const sessions = Object.values(V4_POOLS).flatMap((p) => grantsV4(p, { enterSwap: 1, enterMint: 1, manageAny: 1 }).map((g) => ({ label: `${g.name}:${g.pool}`, actions: g.actions })))
    expect(sessions).toHaveLength(9)
    const batches = splitSessionsByGas(sessions)
    const flatLabels = batches.flat().map((s) => s.label)
    expect(flatLabels).toEqual(sessions.map((s) => s.label)) // order preserved, nothing lost or duplicated
    for (const b of batches) {
      const gas = b.reduce((sum, s) => sum + estimateSessionGas(s.actions.length), 0n)
      expect(gas).toBeLessThanOrEqual(DEFAULT_GAS_CEILING)
    }
    // 36 actions x ~579k ~= 20.8M, over the 14M ceiling in one transaction.
    expect(batches.length).toBeGreaterThan(1)
  })
})

describe('v4CapFormulas', () => {
  test('budgets follow T5 (Ot 18-Oct): W_p per day stables 5x, btc 2x, risk 3x C_p; T_p 10x C_p per approval, one value budget per pool (T6 M-2)', () => {
    expect([V4_POOLS.stables.windowMultiple, V4_POOLS.btc.windowMultiple, V4_POOLS.risk.windowMultiple]).toEqual([5, 2, 3])
    for (const [prefix, pool] of Object.entries(V4_POOLS)) {
      const byName = Object.fromEntries(v4CapFormulas(prefix, pool).map((f) => [f.name, f]))
      expect(byName[`${prefix}BudgetWindow`]!.bpsOfDeposit).toBe(pool.capShareBps * pool.windowMultiple)
      expect(byName[`${prefix}BudgetTotal`]!.bpsOfDeposit).toBe(pool.capShareBps * 10)
      expect(Object.keys(byName).filter((n) => n.includes('Budget'))).toEqual([`${prefix}BudgetWindow`, `${prefix}BudgetTotal`])
    }
  })
})
