import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type Log } from 'viem'
import { address, baseRegistry, entryPointV07Abi } from '@mamoru/registry'
import { LIVE_POOL } from '../src/chain.ts'
import type { StoredOp } from '../src/state.ts'
import type { Snapshot } from '../src/snapshot.ts'
import { dayReceipts, factsFromLogs, FACTS_PER_TICK, priceFees, withReceipts, type OpFacts } from '../src/yield-receipts.ts'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const NPM = address('NonfungiblePositionManager', baseRegistry)
const EP = address('EntryPointV07', baseRegistry)
const POOL = address(LIVE_POOL, baseRegistry)

const poolAbi = parseAbi(['event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)'])
const npmAbi = parseAbi([
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
])

let idx = 0
const log = (addr: Address, topics: Hex[], data: Hex): Log => ({ address: addr, topics: topics as [Hex, ...Hex[]], data, logIndex: idx++, blockNumber: 1n, blockHash: '0x01', transactionHash: '0x02', transactionIndex: 0, removed: false }) as Log

const userOp = (sender: Address, gas: bigint) =>
  log(EP, encodeEventTopics({ abi: entryPointV07Abi, eventName: 'UserOperationEvent', args: { userOpHash: `0x${'ab'.repeat(32)}`, sender, paymaster: '0x0000000000000000000000000000000000000000' } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [0n, true, gas, 100_000n]))
const poolCollect = (a0: bigint, a1: bigint) =>
  log(POOL, encodeEventTopics({ abi: poolAbi, eventName: 'Collect', args: { owner: NPM, tickLower: -10, tickUpper: 10 } }) as Hex[], encodeAbiParameters([{ type: 'address' }, { type: 'uint128' }, { type: 'uint128' }], [NPM, a0, a1]))
const npmCollect = (tokenId: bigint, recipient: Address, a0: bigint, a1: bigint) =>
  log(NPM, encodeEventTopics({ abi: npmAbi, eventName: 'Collect', args: { tokenId } }) as Hex[], encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [recipient, a0, a1]))
const decrease = (tokenId: bigint, a0: bigint, a1: bigint) =>
  log(NPM, encodeEventTopics({ abi: npmAbi, eventName: 'DecreaseLiquidity', args: { tokenId } }) as Hex[], encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [1n, a0, a1]))

const T = 1_792_655_000n // 2026-10-22T07:43:20Z, inside the snapshot's RECEIPT_DAYS window
const op = (opId: string, facts?: OpFacts, txHash: Hex | null = '0xaa'): StoredOp => ({ opId, kind: 'reduce', state: 'confirmed', updatedAt: '2026-10-22T00:00:00Z', ...(txHash ? { txHash } : {}), ...(facts ? { facts } : {}) }) as StoredOp

describe('factsFromLogs (otto/mamoru#129)', () => {
  test('gas is this Safe\'s actualGasCost only; a harvest-only collect is all fees', () => {
    const f = factsFromLogs([userOp(SAFE, 7_000n), userOp(OTHER, 9_000n), poolCollect(5n, 6n), npmCollect(42n, SAFE, 5n, 6n)], SAFE, T)
    expect(f.gasWei).toBe('7000')
    expect(f.at).toBe(new Date(Number(T) * 1000).toISOString())
    expect(f.fees).toEqual([{ tokenId: '42', pool: LIVE_POOL, fee0: '5', fee1: '6' }])
  })

  test('a collect after a decrease in the same tx counts only what it paid above the freed principal', () => {
    const f = factsFromLogs([userOp(SAFE, 1n), decrease(7n, 100n, 200n), poolCollect(103n, 199n), npmCollect(7n, SAFE, 103n, 199n)], SAFE, T)
    expect(f.fees).toEqual([{ tokenId: '7', pool: LIVE_POOL, fee0: '3', fee1: '0' }])
  })

  test('a full unwind with no fees and a collect to another recipient record no fee', () => {
    const f = factsFromLogs([userOp(SAFE, 1n), decrease(7n, 100n, 200n), poolCollect(100n, 200n), npmCollect(7n, SAFE, 100n, 200n), poolCollect(1n, 1n), npmCollect(8n, OTHER, 1n, 1n)], SAFE, T)
    expect(f.fees).toEqual([])
  })
})

describe('priceFees and dayReceipts', () => {
  const pools = { [LIVE_POOL]: { sqrtPriceX96: 2n ** 96n, tick: 0, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n } } as unknown as Snapshot['pools']

  test('prices once and never again; an unpriceable pool leaves the day without collectedUsdc', () => {
    const facts: OpFacts = { at: '2026-10-21T10:00:00.000Z', gasWei: '5', fees: [{ tokenId: '1', pool: LIVE_POOL, fee0: '10', fee1: '0' }] }
    expect(priceFees(facts, pools)).toBe(true)
    const priced = facts.fees[0]!.usdc
    expect(priced).toBeDefined()
    expect(priceFees(facts, {} as Snapshot['pools'])).toBe(false)
    expect(facts.fees[0]!.usdc).toBe(priced)

    const unpriced: OpFacts = { at: '2026-10-22T01:00:00.000Z', gasWei: '2', fees: [{ tokenId: '2', pool: 'pool:none', fee0: '1', fee1: '1' }] }
    const days = dayReceipts([op('eng-a', facts), op('eng-b', { at: '2026-10-21T23:59:59.000Z', gasWei: '3', fees: [] }), op('eng-c', unpriced), op('eng-d')])
    expect(days.map((d) => d.day)).toEqual(['2026-10-21', '2026-10-22'])
    expect(days[0]).toEqual({ day: '2026-10-21', gasWei: '8', collectedUsdc: priced!, positions: [{ tokenId: '1', collected0: '10', collected1: '0', collectedUsdc: priced! }] })
    expect(days[1]!.collectedUsdc).toBeUndefined()
    expect(days[1]!.positions[0]!.collectedUsdc).toBeUndefined()
    expect(dayReceipts([op('eng-a', facts), op('eng-c', unpriced)], '2026-10-22').map((d) => d.day)).toEqual(['2026-10-22'])
  })
})

describe('withReceipts', () => {
  const snapshot = (): Snapshot => ({ chainId: 8453, block: 10n, readAt: '2026-10-22T08:00:00.000Z', pools: {}, safes: [{ accountKey: 'acct-1-full-key', safe: SAFE } as Snapshot['safes'][number]], calls: 1 })

  test('reads each receipt once, keeps facts on the row, saves, and retries a missing one next tick', async () => {
    const ops = [op('eng-1', undefined, '0x01'), op('eng-2', undefined, '0x02'), op('own-1', undefined, '0x03'), op('eng-3', undefined, null)]
    let saves = 0
    const reads: Hex[] = []
    const source = { opsOf: () => ops, save: () => void saves++ }
    const readReceipt = async (h: Hex) => {
      reads.push(h)
      return h === '0x02' ? null : { logs: [userOp(SAFE, 4n)], blockNumber: 9n }
    }
    const out = await withReceipts(snapshot(), source, readReceipt, async () => T)
    expect(reads).toEqual(['0x01', '0x02'])
    expect(saves).toBe(1)
    expect(ops[0]!.facts?.gasWei).toBe('4')
    expect(ops[1]!.facts).toBeUndefined()
    expect(out.safes[0]!.receipts).toHaveLength(1)

    await withReceipts(snapshot(), source, readReceipt, async () => T)
    expect(reads).toEqual(['0x01', '0x02', '0x02'])
  })

  test('a receipt that throws is logged and skipped, never thrown into the loop; reads are capped per tick', async () => {
    const ops = Array.from({ length: FACTS_PER_TICK + 5 }, (_, i) => op(`eng-${i}`, undefined, `0x${(i + 1).toString(16).padStart(2, '0')}` as Hex))
    let n = 0
    const out = await withReceipts(snapshot(), { opsOf: () => ops, save: () => {} }, async () => {
      n++
      if (n === 1) throw new Error('rpc down')
      return { logs: [], blockNumber: 1n }
    }, async () => T)
    expect(n).toBe(FACTS_PER_TICK)
    expect(ops.filter((o) => o.facts).length).toBe(FACTS_PER_TICK - 1)
    expect(out.safes[0]!.receipts[0]!.gasWei).toBe('0')
  })
})
