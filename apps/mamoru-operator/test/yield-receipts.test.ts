import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type Log } from 'viem'
import { address, baseRegistry, entryPointV07Abi, monadRegistry } from '@mamoru/registry'
import { livePool } from '../src/chain.ts'
import type { StoredOp } from '../src/state.ts'
import type { Snapshot } from '../src/snapshot.ts'
import { dayReceipts, factsFromLogs, FACTS_PER_TICK, FACTS_VERSION, incomeEvents, keepPrices, needsFacts, priceFees, vaultWire, withReceipts, type OpFacts } from '../src/yield-receipts.ts'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const NPM = address('NonfungiblePositionManager', baseRegistry)
const EP = address('EntryPointV07', baseRegistry)
const LIVE_POOL = livePool(baseRegistry)
const POOL = address(LIVE_POOL, baseRegistry)

const poolAbi = parseAbi(['event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)'])
const npmAbi = parseAbi([
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
])

let idx = 0
const log = (addr: Address, topics: Hex[], data: Hex): Log => ({ address: addr, topics: topics as [Hex, ...Hex[]], data, logIndex: idx++, blockNumber: 1n, blockHash: '0x01', transactionHash: '0x02', transactionIndex: 0, removed: false }) as Log

const userOp = (sender: Address, gas: bigint, hash: Hex = `0x${'ab'.repeat(32)}`) =>
  log(EP, encodeEventTopics({ abi: entryPointV07Abi, eventName: 'UserOperationEvent', args: { userOpHash: hash, sender, paymaster: '0x0000000000000000000000000000000000000000' } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [0n, true, gas, 100_000n]))
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
    expect(f.fees).toEqual([{ tokenId: '42', pool: LIVE_POOL, fee0: '5', fee1: '6', logIndex: expect.any(Number) }])
    expect(f.v).toBe(FACTS_VERSION)
  })

  test('a collect after a decrease in the same tx counts only what it paid above the freed principal', () => {
    const f = factsFromLogs([userOp(SAFE, 1n), decrease(7n, 100n, 200n), poolCollect(103n, 199n), npmCollect(7n, SAFE, 103n, 199n)], SAFE, T)
    expect(f.fees).toEqual([{ tokenId: '7', pool: LIVE_POOL, fee0: '3', fee1: '0', logIndex: expect.any(Number) }])
  })

  test('with a userOpHash, only that userOp\'s gas and the logs it emitted count (a bundle of two ops of the same Safe)', () => {
    const h1 = `0x${'01'.repeat(32)}` as Hex
    const h2 = `0x${'02'.repeat(32)}` as Hex
    const logs = [poolCollect(5n, 0n), npmCollect(1n, SAFE, 5n, 0n), userOp(SAFE, 100n, h1), poolCollect(7n, 0n), npmCollect(2n, SAFE, 7n, 0n), userOp(SAFE, 200n, h2)]
    expect(factsFromLogs(logs, SAFE, T, h1)).toMatchObject({ gasWei: '100', fees: [{ tokenId: '1', fee0: '5' }] })
    expect(factsFromLogs(logs, SAFE, T, h2)).toMatchObject({ gasWei: '200', fees: [{ tokenId: '2', fee0: '7' }] })
    expect(factsFromLogs(logs, SAFE, T, `0x${'03'.repeat(32)}`)).toMatchObject({ gasWei: '0', fees: [] })
    expect(factsFromLogs(logs, SAFE, T).gasWei).toBe('300')
  })

  test('a full unwind with no fees and a collect to another recipient record no fee', () => {
    const f = factsFromLogs([userOp(SAFE, 1n), decrease(7n, 100n, 200n), poolCollect(100n, 200n), npmCollect(7n, SAFE, 100n, 200n), poolCollect(1n, 1n), npmCollect(8n, OTHER, 1n, 1n)], SAFE, T)
    expect(f.fees).toEqual([])
  })
})

describe('priceFees and dayReceipts', () => {
  const pools = { [LIVE_POOL]: { sqrtPriceX96: 2n ** 96n, tick: 0, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n } } as unknown as Snapshot['pools']

  test('prices gas once from the WETH/USDC pool (#219)', () => {
    const weth = { 'pool:WETH/USDC/3000': { sqrtPriceX96: 2n ** 96n, tick: 0, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n } } as unknown as Snapshot['pools']
    const facts: OpFacts = { at: '2026-10-26T21:01:00.000Z', gasWei: '1000', fees: [] }
    expect(priceFees(facts, {} as Snapshot['pools'])).toBe(false)
    expect(priceFees(facts, weth)).toBe(true)
    expect(facts.gasUsdc).toBe('1000')
    expect(priceFees(facts, weth)).toBe(false)
  })

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
  })
})

describe('needsFacts', () => {
  test('any engine op with a transaction, whatever its stored state (finality is checked on the receipt)', () => {
    expect(needsFacts(op('eng-1'))).toBe(true)
    expect(needsFacts({ ...op('eng-1'), state: 'submitted' } as StoredOp)).toBe(true)
    expect(needsFacts({ ...op('eng-1'), state: 'failed', code: 'EXEC_INNER_REVERT' } as StoredOp)).toBe(true)
    expect(needsFacts(op('own-1'))).toBe(true)
    expect(needsFacts(op('eng-1', undefined, null))).toBe(false)
  })

  test('facts of another transaction are read again', () => {
    expect(needsFacts(op('eng-1', { txHash: '0xAA', at: '2026-10-22T00:00:00.000Z', gasWei: '1', fees: [], v: FACTS_VERSION }, '0xaa'))).toBe(false)
    expect(needsFacts(op('eng-1', { txHash: '0xbb', at: '2026-10-22T00:00:00.000Z', gasWei: '1', fees: [] }, '0xaa'))).toBe(true)
  })
})

describe('withReceipts', () => {
  const snapshot = (): Snapshot => ({ chainId: 8453, block: 10n, readAt: '2026-10-22T08:00:00.000Z', pools: {}, safes: [], calls: 1 })
  const SAFE_BLOCK = async () => 100n
  const one = (ops: StoredOp[], save = () => {}) => ({ accounts: () => [{ accountKey: 'acct-1-full-key', safe: SAFE, ops }], save })

  test('reads each receipt once, keeps facts on the row, saves, and retries a missing one later', async () => {
    const ops = [op('eng-1', undefined, '0x01'), op('eng-2', undefined, '0x02'), op('own-1', undefined, null), op('eng-3', undefined, null)]
    let saves = 0
    const reads: Hex[] = []
    const readReceipt = async (h: Hex) => {
      reads.push(h)
      return h === '0x02' ? null : { logs: [userOp(SAFE, 4n)], blockNumber: 9n }
    }
    const tried = new Map<string, number>()
    const out = await withReceipts(snapshot(), one(ops, () => void saves++), readReceipt, async () => T, SAFE_BLOCK, tried)
    expect(reads).toEqual(['0x01', '0x02'])
    expect(saves).toBe(1)
    expect(ops[0]!.facts).toMatchObject({ txHash: '0x01', gasWei: '4' })
    expect(ops[1]!.facts).toBeUndefined()
    // eng-2 still waits for its receipt: the vault wire says the explained shares are unknown, not zero.
    expect(out.receipts).toEqual([{ safe: SAFE, days: [{ day: '2026-10-22', gasWei: '4', collectedUsdc: '0', positions: [] }], vault: { flows: [], explained: null } }])

    await withReceipts(snapshot(), one(ops), readReceipt, async () => T, SAFE_BLOCK, tried)
    expect(reads).toEqual(['0x01', '0x02', '0x02'])
  })

  test('a receipt above the safe block is not frozen: read again once it is safe; a submitted op of a stopped engine counts', async () => {
    const pending = { ...op('eng-1', undefined, '0x01'), state: 'submitted' } as StoredOp
    let safe = 5n
    const read = async () => ({ logs: [userOp(SAFE, 6n)], blockNumber: 9n })
    const tried = new Map<string, number>()
    await withReceipts(snapshot(), one([pending]), read, async () => T, async () => safe, tried)
    expect(pending.facts).toBeUndefined()
    safe = 9n
    const out = await withReceipts(snapshot(), one([pending]), read, async () => T, async () => safe, tried)
    expect(pending.facts?.gasWei).toBe('6')
    expect(out.receipts[0]!.days[0]!.gasWei).toBe('6')
  })

  test('the safe block not readable: nothing is read or frozen this tick', async () => {
    const o = op('eng-1', undefined, '0x01')
    let reads = 0
    await withReceipts(snapshot(), one([o]), async () => (reads++, { logs: [], blockNumber: 1n }), async () => T, async () => {
      throw new Error('rpc down')
    })
    expect(reads).toBe(0)
    expect(o.facts).toBeUndefined()
  })

  test('the whole history is published, however old the day', async () => {
    const old: OpFacts = { txHash: '0xaa', at: '2025-01-01T00:00:00.000Z', gasWei: '1', fees: [] }
    const out = await withReceipts(snapshot(), one([op('eng-1', old)]), async () => null, async () => T, SAFE_BLOCK)
    expect(out.receipts[0]!.days.map((d) => d.day)).toEqual(['2025-01-01'])
  })

  test('an account the snapshot did not read (stopped) still gets its ops read and published', async () => {
    const ops = [op('eng-1', undefined, '0x01')]
    const out = await withReceipts(snapshot(), one(ops), async () => ({ logs: [userOp(SAFE, 3n)], blockNumber: 1n }), async () => T, SAFE_BLOCK)
    expect(out.safes).toEqual([])
    expect(out.receipts[0]!.days[0]!.gasWei).toBe('3')
  })

  test('receipts that keep failing go to the back: newer ops get read within the next ticks', async () => {
    const stuck = Array.from({ length: FACTS_PER_TICK }, (_, i) => op(`eng-old-${i}`, undefined, `0x${(i + 1).toString(16).padStart(2, '0')}` as Hex))
    const fresh = op('eng-new', undefined, '0xff')
    const ops = [...stuck, fresh]
    const tried = new Map<string, number>()
    const read = async (h: Hex) => {
      if (h !== '0xff') throw new Error('rpc down')
      return { logs: [], blockNumber: 1n }
    }
    let n = 0
    const counting = async (h: Hex) => (n++, read(h))
    await withReceipts(snapshot(), one(ops), counting, async () => T, SAFE_BLOCK, tried)
    expect(n).toBe(FACTS_PER_TICK)
    expect(fresh.facts).toBeUndefined()
    await withReceipts(snapshot(), one(ops), counting, async () => T, SAFE_BLOCK, tried)
    expect(fresh.facts).toBeDefined()
  })
})

describe('Monad (otto/mamoru#358): the chain registry decides the position manager, the pool name and the gas price', () => {
  const MNPM = address('NonfungiblePositionManager', monadRegistry)
  const MPOOL_NAME = 'pool:WMON/USDC/3000'
  const MPOOL = address(MPOOL_NAME, monadRegistry)
  const mPoolCollect = (a0: bigint, a1: bigint) =>
    log(MPOOL, encodeEventTopics({ abi: poolAbi, eventName: 'Collect', args: { owner: MNPM, tickLower: -10, tickUpper: 10 } }) as Hex[], encodeAbiParameters([{ type: 'address' }, { type: 'uint128' }, { type: 'uint128' }], [MNPM, a0, a1]))
  const mNpmCollect = (tokenId: bigint, a0: bigint, a1: bigint) =>
    log(MNPM, encodeEventTopics({ abi: npmAbi, eventName: 'Collect', args: { tokenId } }) as Hex[], encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [SAFE, a0, a1]))

  test("a Monad harvest's Collect counts with the Monad registry, and is missed with Base's", () => {
    const logs = [userOp(SAFE, 7_000n), mPoolCollect(5n, 6n), mNpmCollect(49417n, 5n, 6n)]
    expect(factsFromLogs(logs, SAFE, T).fees).toEqual([])
    expect(factsFromLogs(logs, SAFE, T, undefined, monadRegistry)).toMatchObject({ gasWei: '7000', fees: [{ tokenId: '49417', pool: MPOOL_NAME, fee0: '5', fee1: '6' }] })
  })

  test('gas in MON is priced by WMON/USDC, the fees by their own Monad pool', () => {
    const pools = { [MPOOL_NAME]: { sqrtPriceX96: 2n ** 96n, tick: 0, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n } } as unknown as Snapshot['pools']
    const facts: OpFacts = { at: '2026-11-04T21:00:38.000Z', gasWei: '1000', fees: [{ tokenId: '49417', pool: MPOOL_NAME, fee0: '5', fee1: '6' }] }
    expect(priceFees(facts, pools, monadRegistry)).toBe(true)
    expect(facts.gasUsdc).toBeDefined()
    expect(facts.fees[0]!.usdc).toBeDefined()
    // With Base's registry nothing on Monad is priced (no WETH/USDC in the Monad snapshot, no such pool on Base).
    const base: OpFacts = { at: '2026-11-04T21:00:38.000Z', gasWei: '1000', fees: [{ tokenId: '49417', pool: MPOOL_NAME, fee0: '5', fee1: '6' }] }
    expect(priceFees(base, pools)).toBe(false)
  })
})

describe('feeable (otto/mamoru#371): facts taken while the account is in the yield fee scope', () => {
  test('marked only when the source says the account is in scope at the time of the read', async () => {
    const mk = (scoped: boolean) => ({ opId: 'eng-1', kind: 'reduce', state: 'confirmed', updatedAt: '2026-11-05T10:00:00Z', txHash: '0xaa', ...(scoped ? { feeScoped: true } : {}) }) as unknown as StoredOp
    const run = async (inScope: boolean | undefined, scoped = true) => {
      const o = mk(scoped)
      const source = { accounts: () => [{ accountKey: 'k', safe: SAFE, ops: [o] }], save: () => {}, ...(inScope === undefined ? {} : { feeScope: () => inScope }) }
      await withReceipts({ pools: {} } as unknown as Snapshot, source, async () => ({ logs: [userOp(SAFE, 1n)], blockNumber: 1n }), async () => T, async () => 10n)
      return o.facts
    }
    expect((await run(true))?.feeable).toBe(true)
    expect((await run(false))?.feeable).toBeUndefined()
    expect((await run(undefined))?.feeable).toBeUndefined()
    // Out of scope when the op was recorded, in scope by the time its facts are read: never charged.
    expect((await run(true, false))?.feeable).toBeUndefined()
  })
})

describe('spec 012 HRV-R5: income events and vault flows (HT6)', () => {
  const VAULT = address('vault:gtUSDCp', baseRegistry)
  const vaultAbi = parseAbi([
    'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
    'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
  ])
  const deposit = (owner: Address, assets: bigint, shares: bigint) =>
    log(VAULT, encodeEventTopics({ abi: vaultAbi, eventName: 'Deposit', args: { sender: owner, owner } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [assets, shares]))
  const withdraw = (owner: Address, assets: bigint, shares: bigint) =>
    log(VAULT, encodeEventTopics({ abi: vaultAbi, eventName: 'Withdraw', args: { sender: owner, receiver: owner, owner } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [assets, shares]))

  test('the Safe\'s own ERC-4626 Deposit and Withdraw are kept with their log index; another owner\'s are not', () => {
    const f = factsFromLogs([userOp(SAFE, 1n), deposit(SAFE, 1_000_000n, 900_000n), deposit(OTHER, 5n, 5n), withdraw(SAFE, 500_000n, 440_000n)], SAFE, T)
    expect(f.vaultFlows).toEqual([
      { vault: 'vault:gtUSDCp', kind: 'deposit', assets: '1000000', shares: '900000', logIndex: expect.any(Number) },
      { vault: 'vault:gtUSDCp', kind: 'withdraw', assets: '500000', shares: '440000', logIndex: expect.any(Number) },
    ])
  })

  test('facts of an older layout are read again; the frozen prices and fee scope survive the re-read', () => {
    const old: OpFacts = { txHash: '0xaa', at: '2026-10-22T00:00:00.000Z', gasWei: '7', gasUsdc: '3', fees: [{ tokenId: '42', pool: LIVE_POOL, fee0: '5', fee1: '6', usdc: '11' }], feeable: true }
    expect(needsFacts(op('eng-1', old, '0xaa'))).toBe(true)
    const next = keepPrices({ txHash: '0xaa', at: old.at, gasWei: '7', fees: [{ tokenId: '42', pool: LIVE_POOL, fee0: '5', fee1: '6', logIndex: 3 }], v: FACTS_VERSION }, old)
    expect(next.gasUsdc).toBe('3')
    expect(next.fees[0]).toEqual({ tokenId: '42', pool: LIVE_POOL, fee0: '5', fee1: '6', logIndex: 3, usdc: '11' })
  })

  test('each collect is its own fee and event; the freed principal is taken in log order', () => {
    // A decrease freed 5 of token0; the first collect pays 5 (all principal), the second pays 6 (all fees).
    const f = factsFromLogs([userOp(SAFE, 1n), decrease(42n, 5n, 0n), poolCollect(5n, 0n), npmCollect(42n, SAFE, 5n, 0n), poolCollect(6n, 0n), npmCollect(42n, SAFE, 6n, 0n)], SAFE, T)
    expect(f.fees).toHaveLength(1)
    expect(f.fees[0]).toMatchObject({ tokenId: '42', fee0: '6', fee1: '0', logIndex: idx - 1 })
    const g = factsFromLogs([userOp(SAFE, 1n), poolCollect(5n, 0n), npmCollect(43n, SAFE, 5n, 0n), poolCollect(6n, 0n), npmCollect(43n, SAFE, 6n, 0n)], SAFE, T)
    expect(g.fees.map((x) => [x.fee0, x.logIndex])).toEqual([['5', idx - 3], ['6', idx - 1]])
    expect(dayReceipts([op('eng-1', { ...g, txHash: '0xaa' })])[0]!.positions).toEqual([{ tokenId: '43', collected0: '11', collected1: '0' }])
  })

  test('a collect before a decrease is all fee; principal counts only from the decrease that frees it', () => {
    const f = factsFromLogs([userOp(SAFE, 1n), poolCollect(5n, 0n), npmCollect(44n, SAFE, 5n, 0n), decrease(44n, 5n, 0n), poolCollect(5n, 0n), npmCollect(44n, SAFE, 5n, 0n)], SAFE, T)
    expect(f.fees).toEqual([{ tokenId: '44', pool: LIVE_POOL, fee0: '5', fee1: '0', logIndex: idx - 4 }])
  })

  test('a legacy fee split by the re-read keeps its frozen value whole on the first piece, 0 on the rest', () => {
    const old: OpFacts = { txHash: '0xaa', at: '2026-10-22T00:00:00.000Z', gasWei: '1', fees: [{ tokenId: '43', pool: LIVE_POOL, fee0: '11', fee1: '0', usdc: '11' }] }
    const next = keepPrices({ txHash: '0xaa', at: old.at, gasWei: '1', fees: [{ tokenId: '43', pool: LIVE_POOL, fee0: '5', fee1: '0', logIndex: 2 }, { tokenId: '43', pool: LIVE_POOL, fee0: '6', fee1: '0', logIndex: 4 }], v: FACTS_VERSION }, old)
    expect(next.fees.map((x) => x.usdc)).toEqual(['11', '0'])
  })

  test('an account with no receipt day yet but receipts pending still reports its vault state as unknown', async () => {
    const out = await withReceipts({ chainId: 8453, block: 10n, readAt: '2026-10-22T08:00:00.000Z', pools: {}, safes: [], calls: 1 }, { accounts: () => [{ accountKey: 'acct-2', safe: SAFE, ops: [op('eng-1', undefined, '0x01')] }], save: () => {} }, async () => null, async () => T, async () => 100n)
    expect(out.receipts).toEqual([{ safe: SAFE, days: [], vault: { flows: [], explained: null } }])
  })

  test('one income event per collect, id txHash:logIndex, source from the op step; old-layout facts give none', () => {
    const harvest = { ...op('eng-1', { txHash: '0xAA', at: '2026-10-22T00:00:00.000Z', gasWei: '1', fees: [{ tokenId: '1', pool: LIVE_POOL, fee0: '1', fee1: '0', logIndex: 4, usdc: '10' }, { tokenId: '2', pool: LIVE_POOL, fee0: '1', fee1: '0', logIndex: 9 }], v: FACTS_VERSION }), step: 'harvest' } as StoredOp
    const rerange = { ...op('eng-2', { txHash: '0xbb', at: '2026-10-22T01:00:00.000Z', gasWei: '1', fees: [{ tokenId: '3', pool: LIVE_POOL, fee0: '1', fee1: '0', logIndex: 2, usdc: '5' }], v: FACTS_VERSION }, '0xbb'), step: 'rerange' } as StoredOp
    const legacy = op('eng-3', { txHash: '0xcc', at: '2026-10-22T02:00:00.000Z', gasWei: '1', fees: [{ tokenId: '4', pool: LIVE_POOL, fee0: '1', fee1: '0', usdc: '7' }] }, '0xcc')
    const t0 = Date.parse('2026-10-22T00:00:00.000Z') / 1000
    expect(incomeEvents([rerange, harvest, legacy])).toEqual([
      { id: '0xaa:4', t: t0, source: 'harvest', usdc: '10' },
      { id: '0xaa:9', t: t0, source: 'harvest' },
      { id: '0xbb:2', t: t0 + 3600, source: 're-range', usdc: '5' },
    ])
  })

  test('explained shares are deposits minus withdraws per vault, and null while an op still waits for its receipt', () => {
    const d = op('eng-1', { txHash: '0xaa', at: '2026-10-22T00:00:00.000Z', gasWei: '1', fees: [], v: FACTS_VERSION, vaultFlows: [{ vault: 'vault:gtUSDCp', kind: 'deposit', assets: '100', shares: '90', logIndex: 1 }] })
    const w = op('own-2', { txHash: '0xbb', at: '2026-10-23T00:00:00.000Z', gasWei: '1', fees: [], v: FACTS_VERSION, vaultFlows: [{ vault: 'vault:gtUSDCp', kind: 'withdraw', assets: '60', shares: '50', logIndex: 1 }] }, '0xbb')
    expect(vaultWire([w, d])).toMatchObject({ explained: { 'vault:gtUSDCp': '40' }, flows: [{ kind: 'deposit', id: '0xaa:1' }, { kind: 'withdraw', id: '0xbb:1' }] })
    expect(vaultWire([d, w, op('eng-3')])?.explained).toBeNull()
    expect(vaultWire([op('eng-4', { txHash: '0xaa', at: '2026-10-22T00:00:00.000Z', gasWei: '1', fees: [], v: FACTS_VERSION })])).toBeUndefined()
    expect(vaultWire([op('eng-5')])).toEqual({ flows: [], explained: null })
  })
})
