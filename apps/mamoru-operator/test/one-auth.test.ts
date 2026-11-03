// otto/mamoru#293 (spec 010): the operator side of one authorization behind `one_auth_v4`. Flag off (or the V4 stack not
// pinned) is byte-identical to today for a v6 account; on, a clean inventory offers approval.whatsNew in the shape #295
// builds against; never while paused; a V4 account never renews; step 1 waits for step 0.
import { describe, expect, test } from 'bun:test'
import { BaseError, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseRegistry } from '@mamoru/registry'
import { grantKey, ONE_AUTH_V4, oneAuthV4Live, staticPool, withRegistryPools, type OneAuthV4Deployment } from '@mamoru/policy'
import { resolveV4Policy, resolveV5Policy, resolveV6Policy } from '../src/boot.ts'
import { encodeFunctionData, erc20Abi } from 'viem'
import { HttpError, movedTo, type Operator } from '../src/operator.ts'
import { MULTICALL3, readEligiblePools, readHeldPools, readPaused, v4StoredGrant, WHATS_NEW_POINTS, RegistryPoolsCache } from '../src/one-auth.ts'
import { mamoruV4HelperAbi, v4Children } from '@mamoru/account/one-auth'
import type { AccountState } from '../src/state.ts'
import { withPinnedV6Base } from '../../../packages/account/remote/fixture.ts'
import { ctx, world } from './owner-world.ts'

const D: OneAuthV4Deployment = { table: '0x00000000000000000000000000000000000000A1', policy: '0x00000000000000000000000000000000000000A2', gasPolicy: '0x00000000000000000000000000000000000000A3', migrationCheck: '0x00000000000000000000000000000000000000A4' }
const env = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: `0x${'11'.repeat(20)}`, MAMORU_ACTION_POLICY_V2_ADDRESS: `0x${'33'.repeat(20)}`, MAMORU_GAS_POLICY_ADDRESS: `0x${'22'.repeat(20)}` }
const reg6 = withPinnedV6Base()
const v4 = resolveV4Policy('base', env)!
const v5 = resolveV5Policy('base', env)!
const v6 = resolveV6Policy('base', env, reg6)!
const KEY = `0x${'5'.repeat(64)}` as Hex

type Priv = { approvalView(a: AccountState): unknown; client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown> } }
const priv = (op: Operator) => op as unknown as Priv

function running(w: ReturnType<typeof world>): AccountState {
  const grants = v6.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ name: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex, grant: { policyId: v6.policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } }))
  const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: v6.policyId, sessionKey: KEY, signedCapUsdc: '1500000000', grants, ops: [], revoked: [], managedTokenIds: [], admittedTokenIds: ['7'], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 0 } as unknown as AccountState
  w.state.accounts.k = acc
  return acc
}

const clean = (acc: AccountState) => {
  const ids = acc.grants.map((g) => g.permissionId)
  acc.oneAuth = { inventory: { ok: true, at: new Date().toISOString(), scannedFrom: '0', scannedTo: '100', events: ids, remove: ids, revoke: ids } }
}

const base = { registry: reg6, v4Policy: v4, v5Policy: v5, v6Policy: v6 }
const on = { ...base, oneAuth: D, opsFlags: () => ({ one_auth_v4: false }), opsScopedFlags: () => ({ one_auth_v4: ['k'] }) }

describe('flag off: byte-identical to today (otto/mamoru#293)', () => {
  test("a v6 account's approval row is the same with the flag off, with V4 unpinned, and with neither", () => {
    const views = [
      world(0n, base),
      world(0n, { ...base, oneAuth: D }),
      world(0n, { ...base, oneAuth: D, opsFlags: () => ({ one_auth_v4: false }), opsScopedFlags: () => ({}) }),
      world(0n, { ...base, opsFlags: () => ({ one_auth_v4: true }), opsScopedFlags: () => ({ one_auth_v4: null }) }),
    ].map((w) => {
      const acc = running(w)
      clean(acc)
      return JSON.stringify(priv(w.op).approvalView(acc))
    })
    expect(new Set(views).size).toBe(1)
    expect(JSON.parse(views[0]!)).toEqual({ validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v6' })
  })
})

describe('approval.whatsNew (the contract #295 builds against)', () => {
  test('in scope, V4 pinned, clean inventory: the exact shape, one signature, step 0', () => {
    const w = world(0n, on)
    const acc = running(w)
    clean(acc)
    const v = priv(w.op).approvalView(acc) as { whatsNew: unknown }
    expect(v.whatsNew).toEqual({ policy: 'one-auth-v4', points: [...WHATS_NEW_POINTS], signatures: 1, currentStep: 0, steps: [{ chain: 'base', summary: expect.any(Array) }] })
    const w2 = v.whatsNew as { points: string[]; steps: { summary: string[] }[] }
    expect(w2.points.length).toBeGreaterThanOrEqual(1)
    expect(w2.points.length).toBeLessThanOrEqual(4)
    expect(w2.steps[0]!.summary.every((l) => typeof l === 'string' && l.length > 0)).toBe(true)
    expect(Object.keys(v).sort()).toEqual(['expired', 'policyId', 'renewDue', 'validUntil', 'whatsNew'])
  })

  test('a design-C Safe on Monad: two signatures, the Monad step names where the funds move', () => {
    const w = world(0n, on)
    const acc = running(w)
    clean(acc)
    acc.remote = { chainId: 143, address: `0x${'9'.repeat(40)}`, spec: { chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: privateKeyToAccount(KEY).address, validAfter: 1, validUntil: 2, capUsdc: '1' }, permissionIds: ['0x01'] }
    const v = (priv(w.op).approvalView(acc) as { whatsNew: { signatures: number; steps: { chain: string; moveTo?: string }[] } }).whatsNew
    expect(v.signatures).toBe(2)
    expect(v.steps.map((s) => s.chain)).toEqual(['base', 'monad'])
  })

  test('never offered while paused, nor without a clean inventory (fail closed), nor out of scope', () => {
    const w = world(0n, on)
    const acc = running(w)
    clean(acc)
    acc.oneAuth!.paused = true
    expect((priv(w.op).approvalView(acc) as { whatsNew?: unknown }).whatsNew).toBeUndefined()
    acc.oneAuth = { inventory: { ok: false, at: new Date().toISOString(), scannedFrom: '0', scannedTo: '1', events: [], code: 'INVENTORY_MISMATCH', detail: 'x', unknown: ['0x01'] } }
    expect((priv(w.op).approvalView(acc) as { whatsNew?: unknown }).whatsNew).toBeUndefined()
    const out = world(0n, { ...on, opsScopedFlags: () => ({ one_auth_v4: ['someone-else'] }) })
    const a2 = running(out)
    clean(a2)
    expect((priv(out.op).approvalView(a2) as { whatsNew?: unknown }).whatsNew).toBeUndefined()
  })
})

describe('migrate-v4 refusals are typed', () => {
  test('step 1 before step 0 is confirmed: ONE_AUTH_STEP_ORDER', async () => {
    const w = world(0n, on)
    running(w)
    const e = await w.op.prepareMigrateV4(ctx, { step: 1 }).catch((x) => x)
    expect(e).toBeInstanceOf(HttpError)
    expect((e as HttpError).code).toBe('ONE_AUTH_STEP_ORDER')
    const s = await w.op.submitMigrateV4(ctx, { prepareId: 'x', authenticatorData: '', clientDataJSON: '', signature: '', step: 1 }).catch((x) => x)
    expect((s as HttpError).code).toBe('ONE_AUTH_STEP_ORDER')
  })

  test('paused (the V3 guardian of a v6 account): ONE_AUTH_PAUSED, prepare and submit', async () => {
    const w = world(0n, on)
    running(w)
    const client = priv(w.op).client
    const real = client.readContract.bind(client)
    client.readContract = async (a) => (a.functionName === 'isPaused' ? true : real(a))
    const e = await w.op.prepareMigrateV4(ctx, { step: 0 }).catch((x) => x)
    expect((e as HttpError).code).toBe('ONE_AUTH_PAUSED')
    const s = await w.op.submitMigrateV4(ctx, { prepareId: 'x', authenticatorData: '', clientDataJSON: '', signature: '', step: 0 }).catch((x) => x)
    expect((s as HttpError).code).toBe('ONE_AUTH_PAUSED')
  })

  test('not offered (flag off): ONE_AUTH_NOT_OFFERED; a bad step: 400', async () => {
    const w = world(0n, { ...base, oneAuth: D })
    running(w)
    expect(((await w.op.prepareMigrateV4(ctx, { step: 0 }).catch((x) => x)) as HttpError).code).toBe('ONE_AUTH_NOT_OFFERED')
    expect((() => w.op.prepareMigrateV4(ctx, { step: 2 }))).toThrow()
  })
})

describe('a V4 account stops renewing', () => {
  function onV4(w: ReturnType<typeof world>): AccountState {
    const acc = running(w)
    const g = v4StoredGrant({ account: ctx.address, chainId: 8453, sessionKey: privateKeyToAccount(KEY).address, permissionId: `0x${'ee'.repeat(32)}`, salt: `0x${'00'.repeat(32)}`, deployment: D, registry: baseRegistry })
    acc.policyId = ONE_AUTH_V4
    acc.grants = [{ name: 'one-auth-v4', grant: g, permissionId: `0x${'ee'.repeat(32)}` }]
    acc.ops = [{ opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'confirmed', updatedAt: '', migrateStep: 0 } as never]
    return acc
  }

  test('no renew, extend or upgrade: refused, typed; the row carries no renewal fields', async () => {
    const w = world(0n, on)
    const acc = onV4(w)
    const e = await w.op.prepareRenew(ctx).catch((x) => x)
    expect((e as HttpError).code).toBe('ONE_AUTH_NO_RENEWAL')
    expect(priv(w.op).approvalView(acc)).toEqual({ validUntil: 0, renewDue: false, expired: false, policyId: 'one-auth-v4' })
    expect(w.op.usageView(acc)).toBeNull()
  })

  test('a design-C account on V4 is offered step 1 only (currentStep 1)', () => {
    const w = world(0n, on)
    const acc = onV4(w)
    acc.remote = { chainId: 143, address: `0x${'9'.repeat(40)}`, spec: { chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: privateKeyToAccount(KEY).address, validAfter: 1, validUntil: 2, capUsdc: '1' }, permissionIds: ['0x01'] }
    const v = (priv(w.op).approvalView(acc) as { whatsNew: { currentStep: number; signatures: number } }).whatsNew
    expect(v.currentStep).toBe(1)
    expect(v.signatures).toBe(2)
  })
})

describe('engine pools from V4 eligibility (spec 010 A1)', () => {
  const pool = (name: string, ratioBps = 5000) => ({ ...staticPool(name, baseRegistry), entry: { twapWindow: 1800, twapShortWindow: 300, bandTicks: 100, anchorTick: 0, anchorBand: name.includes('USDT') ? 40 : 0, ratioBps, active: true } })

  test('stable pairs to stables, the rest to Balance; a pool eligible after creation joins with no signature', () => {
    const before = withRegistryPools(oneAuthV4Live, D, [pool('pool:USDC/USDT/100'), pool('pool:WETH/USDC/3000')], baseRegistry)
    expect(before.policy.buckets.map((b) => [b.id, b.pools])).toEqual([['stables', ['pool:USDC/USDT/100']], ['risk', ['pool:WETH/USDC/3000']]])
    const after = withRegistryPools(oneAuthV4Live, D, [pool('pool:USDC/USDT/100'), pool('pool:WETH/USDC/3000'), pool('pool:USDC/cbBTC/500')], baseRegistry)
    expect(after.policy.buckets[1]!.pools).toEqual(['pool:WETH/USDC/3000', 'pool:USDC/cbBTC/500'])
    expect(after.policy.actionPolicy).toMatchObject({ address: D.policy, contractVersion: 4, bandTicksByPool: { 'pool:USDC/cbBTC/500': 100 }, twapByPool: { 'pool:USDC/cbBTC/500': { long: 1800, short: 300 } } })
    expect(after.policy.actionPolicy!.anchorByPool).toEqual({ 'pool:USDC/USDT/100': { tick: 0, band: 40 } })
    expect(after.policy.session.grants.map(grantKey)).toEqual(['manage-any:pool:USDC/USDT/100', 'manage-any:pool:WETH/USDC/3000', 'manage-any:pool:USDC/cbBTC/500', 'bridge-out'])
  })

  test('a removed (inactive) pool, or one of an unpinned token, is not entered', () => {
    const eurc = { ...pool('pool:WETH/USDC/3000'), address: '0x00000000000000000000000000000000000E0C00' as const, token0: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42' as const }
    const r = withRegistryPools(oneAuthV4Live, D, [{ ...pool('pool:USDC/USDT/100'), entry: { ...pool('pool:USDC/USDT/100').entry, active: false } }, eurc], baseRegistry)
    expect(r.pools).toEqual([])
  })

  test('readEligiblePools: every factory pool of each class fee tier that MamoruV4Helper.priced accepts, with its entry', async () => {
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const USDT = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'
    const WETH = '0x4200000000000000000000000000000000000006'
    const FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
    const P = { stable: '0x00000000000000000000000000000000000000b1', weth500: '0x00000000000000000000000000000000000000b2', weth3000: '0x00000000000000000000000000000000000000b3' } as const
    const helper = v4Children(D.policy).helper
    const entry = { twapWindow: 1800, twapShortWindow: 300, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 1500, active: true }
    const calls: string[] = []
    let transportDown = false
    const priced = (pool: string) => {
      const [t0, t1, fee] = pool === P.stable ? [USDC, USDT, 100] : [WETH, USDC, 3000]
      return encodeFunctionResult({ abi: mamoruV4HelperAbi, functionName: 'priced', result: [{ token0: t0, token1: t1, fee, in1: t0 === WETH, stablePair: pool === P.stable }, { ...entry, anchorBand: pool === P.stable ? 40 : 0 }, t0 === WETH ? WETH : `0x${'5'.repeat(40)}`] as never })
    }
    const client = {
      readContract: async (a: { address: string; functionName: string; args?: readonly unknown[] }) => {
        calls.push(`${a.functionName}@${a.address}`)
        if (a.functionName === 'chain') return { chainId: 8453n, factory: FACTORY }
        if (a.functionName === 'pairsOf') return [[USDC, USDT], [USDC, WETH]]
        if (a.functionName === 'classOf') return a.args![2] === USDT ? { ref: P.stable, feeMask: 1 } : { ref: P.weth3000, feeMask: 2 | 4 }
        if (a.functionName === 'getPool') return a.args![2] === 100 ? P.stable : a.args![2] === 500 ? P.weth500 : a.args![2] === 3000 ? P.weth3000 : '0x0000000000000000000000000000000000000000'
        if (a.functionName === 'aggregate3') {
          expect(a.address).toBe(MULTICALL3)
          if (transportDown) throw new BaseError('fetch failed')
          return (a.args![0] as { target: string; allowFailure: boolean; callData: Hex }[]).map((c) => {
            expect(c.allowFailure).toBe(true)
            if (c.target === helper) {
              const pool = (decodeFunctionData({ abi: mamoruV4HelperAbi, data: c.callData }).args![0] as string).toLowerCase()
              calls.push(`priced@${c.target}`)
              // the 0.05 % pool disagrees with the reference pool now: priced reverts there, told by Multicall3's flag
              return pool === P.weth500 ? { success: false, returnData: '0x' } : { success: true, returnData: priced(pool) }
            }
            return { success: true, returnData: encodeAbiParameters([{ type: 'int24' }], [c.target === P.stable ? 1 : 60]) }
          })
        }
        throw new Error(`unexpected ${a.functionName}`)
      },
    } as unknown as PublicClient
    const pools = await readEligiblePools(client, D, 8453)
    expect(pools.map((p) => [p.address, p.fee, p.tickSpacing, p.entry.anchorBand])).toEqual([
      [P.stable, 100, 1, 40],
      [P.weth3000, 3000, 60, 0],
    ])
    // only the class's fee tiers are asked of the factory (no 0.3 % for the stable pair, no 1 % for WETH/USDC), and every
    // eligibility read is MamoruV4Helper's (V4's child), never a registry, all in one Multicall3 read
    expect(calls.filter((c) => c.startsWith('getPool'))).toHaveLength(3)
    expect(calls.filter((c) => c.startsWith('priced')).every((c) => c.endsWith(helper))).toBe(true)
    expect(calls.filter((c) => c.startsWith('aggregate3'))).toHaveLength(1)
    expect(calls.some((c) => c.startsWith('activePools') || c.startsWith('poolOf'))).toBe(false)
    // a failure of the read itself (an RPC down) is not "not eligible": it throws, and the cache keeps the last good set
    transportDown = true
    await expect(readEligiblePools(client, D, 8453)).rejects.toThrow('fetch failed')
  })

  test('rule 7 (review of #245): a pool joins or leaves only after 3 reads in a row', async () => {
    const A = pool('pool:USDC/USDT/100')
    const B = pool('pool:WETH/USDC/3000')
    let next: ReturnType<typeof pool>[] = [A, B]
    let t = 0
    const c = new RegistryPoolsCache(async () => next, 1000, () => t)
    const names = async () => {
      t += 1000
      return (await c.get()).pools.map((p) => p.address)
    }
    expect(await names()).toEqual([A.address, B.address]) // the first read is taken as is
    next = [A]
    expect(await names()).toEqual([A.address, B.address]) // B missed once
    next = [A, B]
    expect(await names()).toEqual([A.address, B.address]) // back: the streak restarts
    next = [A]
    expect(await names()).toEqual([A.address, B.address])
    expect(await names()).toEqual([A.address, B.address])
    expect(await names()).toEqual([A.address]) // third miss in a row: B leaves
    // a new pool needs 3 reads in a row too
    next = [A, B]
    expect(await names()).toEqual([A.address])
    expect(await names()).toEqual([A.address])
    expect(await names()).toEqual([A.address, B.address])
  })

  test('review of #247: the read is chunked; no candidate, or every priced failing, is a failed read', async () => {
    const helper = v4Children(D.policy).helper
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const WETH = '0x4200000000000000000000000000000000000006'
    let chunks: number[] = []
    let pricedOk = true
    let pairs: string[][] = []
    const client = {
      readContract: async (a: { functionName: string; args?: readonly unknown[] }) => {
        if (a.functionName === 'chain') return { chainId: 8453n, factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' }
        if (a.functionName === 'pairsOf') return pairs
        if (a.functionName === 'classOf') return { ref: `0x${'7'.repeat(40)}`, feeMask: 15 }
        // a distinct pool per (pair, fee): 4 per pair
        if (a.functionName === 'getPool') return `0x${(pairs.findIndex((p) => p[1] === a.args![1]) * 4 + [100, 500, 3000, 10_000].indexOf(a.args![2] as number) + 1).toString(16).padStart(40, '0')}`
        if (a.functionName === 'aggregate3') {
          const cs = a.args![0] as { target: string; callData: Hex }[]
          chunks.push(cs.length)
          return cs.map((c) => (c.target === helper ? (pricedOk ? { success: true, returnData: encodeFunctionResult({ abi: mamoruV4HelperAbi, functionName: 'priced', result: [{ token0: WETH, token1: USDC, fee: 3000, in1: true, stablePair: false }, { twapWindow: 1800, twapShortWindow: 300, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 1500, active: true }, WETH] as never }) } : { success: false, returnData: '0x' }) : { success: true, returnData: encodeAbiParameters([{ type: 'int24' }], [60]) }))
        }
        throw new Error(a.functionName)
      },
    } as unknown as PublicClient
    // 30 pairs x 4 fee tiers = 120 candidates, 240 calls: three aggregate3 of at most 100
    pairs = Array.from({ length: 30 }, (_, i) => [USDC, `0x${(i + 1).toString(16).padStart(40, 'a')}`])
    expect(await readEligiblePools(client, D, 8453)).toHaveLength(120)
    expect(chunks).toEqual([100, 100, 40])
    pricedOk = false
    await expect(readEligiblePools(client, D, 8453)).rejects.toThrow('priced failed for all')
    pairs = []
    await expect(readEligiblePools(client, D, 8453)).rejects.toThrow('no candidate pool')
    chunks = []
  })

  test('review of #247: readHeldPools reads the positions the account still owns with value, and V4\'s exit entry', async () => {
    const ACCOUNT = ctx.address
    const helper = v4Children(D.policy).helper
    const NPM = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1'
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const WETH = '0x4200000000000000000000000000000000000006'
    const POOL = '0x00000000000000000000000000000000000000e1'
    const pos = (liquidity: bigint) => encodeFunctionResult({ abi: parseAbi(['function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)']), functionName: 'positions', result: [0n, ACCOUNT, WETH, USDC, 500, -10, 10, liquidity, 0n, 0n, 0n, 0n] })
    const owner = (a: string) => encodeAbiParameters([{ type: 'address' }], [a as Hex])
    const client = {
      readContract: async (a: { functionName: string; args?: readonly unknown[] }) => {
        if (a.functionName === 'chain') return { chainId: 8453n, factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', npm: NPM }
        if (a.functionName === 'getPool') return POOL
        if (a.functionName === 'aggregate3') {
          return (a.args![0] as { target: string; callData: Hex }[]).map((c) => {
            const sel = c.callData.slice(0, 10)
            if (c.target === NPM) {
              const id = BigInt(`0x${c.callData.slice(10)}`)
              if (id === 3n) return { success: false, returnData: '0x' } // burned
              if (sel === '0x6352211e') return { success: true, returnData: owner(id === 2n ? `0x${'9'.repeat(40)}` : ACCOUNT) } // ownerOf: 2 was transferred away
              return { success: true, returnData: pos(id === 4n ? 0n : 1_000n) } // 4 is empty
            }
            if (c.target === helper) return { success: true, returnData: encodeFunctionResult({ abi: parseAbi(['struct E { uint32 a; uint32 b; uint24 c; int24 d; uint24 e; uint16 f; bool g; }', 'function exitEntry(address) view returns (E)']), functionName: 'exitEntry', result: { a: 1800, b: 300, c: 100, d: 0, e: 0, f: 1500, g: false } }) }
            return { success: true, returnData: encodeAbiParameters([{ type: 'int24' }], [10]) }
          })
        }
        throw new Error(a.functionName)
      },
    } as unknown as PublicClient
    const held = await readHeldPools(client, D, 8453, ACCOUNT, [1n, 2n, 3n, 4n])
    expect(held).toEqual([{ address: POOL, token0: WETH, token1: USDC, fee: 500, tickSpacing: 10, entry: { twapWindow: 1800, twapShortWindow: 300, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 1500, active: true } }])
  })

  test('review of #247 (P1): N accounts asking at once move a streak by one read, not N', async () => {
    const A = pool('pool:USDC/USDT/100')
    const B = pool('pool:WETH/USDC/3000')
    let next: ReturnType<typeof pool>[] = [A, B]
    let reads = 0
    let t = 0
    const c = new RegistryPoolsCache(async () => (reads++, await Bun.sleep(5), next), 1000, () => t)
    await c.get() // the first read, taken as is
    next = [A]
    t += 1000
    const all = await Promise.all(Array.from({ length: 10 }, () => c.get()))
    expect(reads).toBe(2)
    // one miss of B, however many accounts asked: B stays (it needs 3 reads in a row)
    for (const r of all) expect(r.pools.map((p) => p.address)).toEqual([A.address, B.address])
    t += 1000
    await Promise.all(Array.from({ length: 10 }, () => c.get()))
    t += 1000
    expect((await Promise.all(Array.from({ length: 10 }, () => c.get())))[0]!.pools.map((p) => p.address)).toEqual([A.address])
    expect(reads).toBe(4)
  })

  test('V4 has no pause (A1): a V4 account never reads one; readPaused is the V2/V3 guardian read only', async () => {
    const seen: string[] = []
    const client = { readContract: async (a: { functionName: string }) => (seen.push(a.functionName), false) } as unknown as PublicClient
    expect(await readPaused(client, `0x${'33'.repeat(20)}`, ctx.address)).toBe(false)
    expect(seen).toEqual(['isPaused'])
  })

  test('the cache reads once per TTL and keeps the last good read', async () => {
    let n = 0
    let fail = false
    let t = 0
    const c = new RegistryPoolsCache(async () => {
      n++
      if (fail) throw new Error('down')
      return [pool('pool:USDC/USDT/100')]
    }, 1000, () => t)
    await c.get()
    await c.get()
    expect(n).toBe(1)
    t = 2000
    fail = true
    expect((await c.get()).pools).toHaveLength(1)
    expect(n).toBe(2)
  })
})

describe('the migrate-v4 contract of #201 (currentStep, OpView.step, prepare fields)', () => {
  test('currentStep advances only on a confirmed step 0, never on a submitted one', () => {
    const w = world(0n, on)
    const acc = running(w)
    clean(acc)
    acc.ops = [{ opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'submitted', updatedAt: '', migrateStep: 0 } as never]
    expect((priv(w.op).approvalView(acc) as { whatsNew: { currentStep: number } }).whatsNew.currentStep).toBe(0)
    acc.ops = [{ opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'confirmed', updatedAt: '', migrateStep: 0 } as never]
    expect((priv(w.op).approvalView(acc) as { whatsNew: { currentStep: number } }).whatsNew.currentStep).toBe(1)
  })

  test('a migrate-v4 op carries its step in the OpView', () => {
    const w = world(0n, on)
    const acc = running(w)
    const op = { opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'proposed', updatedAt: '' }
    ;(w.op as unknown as { stash(a: AccountState, o: unknown, p: unknown): void }).stash(acc, op, { kind: 'migrate-v4', step: 0, safeTxHash: '0x01', tx: { nonce: 3n } })
    expect((op as { migrateStep?: number }).migrateStep).toBe(0)
    expect((op as { step?: unknown }).step).toBeUndefined()
  })

  test('moveTo is read from the built calls: the one transfer recipient, or none', () => {
    const to = '0x000000000000000000000000000000000000dEaD'
    const t = (a: string) => ({ data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [a as never, 5n] }) })
    expect(movedTo([{ data: '0x1234' }, t(to), t(to)])).toBe(to)
    expect(movedTo([{ data: '0x1234' }])).toBeUndefined()
    expect(() => movedTo([t(to), t('0x000000000000000000000000000000000000bEEF')])).toThrow()
  })

  test('submit refuses a step other than the prepared one (ONE_AUTH_STEP_MISMATCH)', async () => {
    const w = world(0n, on)
    running(w)
    const prepared = (w.op as unknown as { prepared: Map<string, unknown> }).prepared
    prepared.set('p1', { prepareId: 'p1', accountKey: 'k', kind: 'migrate-v4', step: 1, expires: Date.now() + 60_000, safeTxHash: '0x01', tx: { nonce: 0n } })
    const e = await w.op.submit(ctx, 'migrate-v4', { prepareId: 'p1', authenticatorData: '', clientDataJSON: '', signature: '', step: 0 } as never).catch((x) => x)
    expect((e as HttpError).code).toBe('ONE_AUTH_STEP_MISMATCH')
  })
})

describe('repeat prepares and submits of a step are refused (typed)', () => {
  test('a confirmed step: ONE_AUTH_DONE; a step on its way: ONE_AUTH_STEP_IN_FLIGHT', async () => {
    const w = world(0n, on)
    const acc = running(w)
    clean(acc)
    acc.ops = [{ opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'submitted', updatedAt: '', migrateStep: 0 } as never]
    expect(((await w.op.prepareMigrateV4(ctx, { step: 0 }).catch((x) => x)) as HttpError).code).toBe('ONE_AUTH_STEP_IN_FLIGHT')
    expect(((await w.op.submitMigrateV4(ctx, { prepareId: 'x', authenticatorData: '', clientDataJSON: '', signature: '', step: 0 }).catch((x) => x)) as HttpError).code).toBe('ONE_AUTH_STEP_IN_FLIGHT')
    acc.ops = [{ opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'confirmed', updatedAt: '', migrateStep: 0 } as never]
    expect(((await w.op.prepareMigrateV4(ctx, { step: 0 }).catch((x) => x)) as HttpError).code).toBe('ONE_AUTH_DONE')
  })
})

describe('GET /ops?kind=migrate-v4', () => {
  test('every migrate-v4 op, unwindowed, with migrateStep and state', () => {
    const w = world(0n, on)
    const acc = running(w)
    acc.ops = [
      { opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'confirmed', updatedAt: '2026-01-01T00:00:00Z', migrateStep: 0 },
      { opId: 'eng-1-x', kind: 'enter', state: 'confirmed', updatedAt: '2026-01-02T00:00:00Z' },
      { opId: 'own-2-migrate-v4', kind: 'migrate-v4', state: 'submitted', updatedAt: '2026-01-03T00:00:00Z', migrateStep: 1 },
    ] as never
    const r = w.op.ops(ctx, 'own-2-migrate-v4', false, 'migrate-v4').ops
    expect(r.map((o) => [o.opId, o.migrateStep, o.state])).toEqual([['own-1-migrate-v4', 0, 'confirmed'], ['own-2-migrate-v4', 1, 'submitted']])
  })
})
