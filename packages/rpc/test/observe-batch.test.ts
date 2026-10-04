import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, zeroAddress, type Hex } from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import { address, baseRegistry, monadRegistry } from '@mamoru/registry'
import { BATCH_MAX_BYTES, BATCH_MAX_CALLS, chunkCalls, historyCursor, multicall3Abi, multicall3Of, observe, poolStateCache, type ObserveInput, isDeployed } from '../src/index.ts'
import { FakeChain, POOLS, Revert } from './fake-chain.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const OTHER = '0x00000000000000000000000000000000000000bb' as Address
const DEPOSITOR = '0x00000000000000000000000000000000000000cc' as Address
const MC3 = address('Multicall3')

/** An account with three managed positions, a deposit and some position history, mid-life (the cursor already holds a safe block). */
function chain(): FakeChain {
  const c = new FakeChain()
  c.code.set(ACCOUNT.toLowerCase(), '0x6001')
  c.native.set(ACCOUNT.toLowerCase(), 7n * 10n ** 15n)
  c.nonces.set(ACCOUNT.toLowerCase(), 4n)
  c.setBalance('USDC', ACCOUNT, 25_000_000n)
  c.setBalance('cbBTC', ACCOUNT, 1_234n)
  c.addPosition(ACCOUNT, 11n, 'pool:USDC/cbBTC/500', [100n, 2n])
  c.addPosition(ACCOUNT, 12n, 'pool:WETH/USDC/3000', [0n, 300n])
  c.addPosition(ACCOUNT, 13n, 'pool:USDC/USDT/100', [5n, 6n])
  c.addPosition(OTHER, 99n, 'pool:USDC/cbBTC/500')
  c.addPositionEvent('DecreaseLiquidity', 11n, 850n, 0, [40n, 1n])
  c.addPositionEvent('Collect', 11n, 850n, 1, [30n, 1n])
  c.addPositionEvent('Collect', 12n, 950n, 3, [9n, 9n])
  c.addPositionEvent('Collect', 99n, 950n, 4)
  c.addDeposit('USDC', DEPOSITOR, ACCOUNT, 5_000_000n, 890n, 2)
  c.addDeposit('USDC', DEPOSITOR, ACCOUNT, 1_000_000n, 990n, 0)
  c.addDeposit('USDC', address('pool:USDC/cbBTC/500'), ACCOUNT, 777n, 991n, 0)
  return c
}

function input(over: Partial<ObserveInput> = {}): ObserveInput {
  return {
    chainId: 8453,
    account: ACCOUNT,
    nonceKey: 0n,
    depositsAfter: 800n,
    sessions: [],
    allowedTokenIds: [11n, 12n, 13n],
    historyFromBlock: 800n,
    intents: { paused: false, exitRequested: false },
    slot: null,
    twapWindowSeconds: 1800,
    opGasUnits: 5_100_000n,
    maxPriorityFeePerGas: 1_000_000n,
    savingsAsset: 'USDC',
    ethPricePool: 'pool:WETH/USDC/3000',
    ...over,
  }
}

/** Inner calls of every aggregate3 request, in order. */
function aggregates(c: FakeChain): { target: Address; callData: Hex }[][] {
  return c.requests
    .filter((r) => r.method === 'eth_call' && r.params[0].to.toLowerCase() === MC3.toLowerCase())
    .map((r) => decodeFunctionData({ abi: multicall3Abi, data: r.params[0].data }))
    .filter((d) => d.functionName === 'aggregate3')
    .map((d) => [...(d.args[0] as readonly { target: Address; callData: Hex }[])])
}

describe('observe through Multicall3', () => {
  test('one review of an account with 3 positions: 12 requests, 2 of them eth_call, and no account code once it is settled', async () => {
    const c = chain()
    const cursor = historyCursor()
    // First review: the cursor reads the history from the activation block.
    await observe(c.client, input({ historyCursor: cursor }))
    c.head = 1150n
    c.safe = 1050n
    c.requests.length = 0
    const obs = await observe(c.client, input({ historyCursor: cursor, depositsAfter: 900n }))
    expect(obs.positions.map((p) => p.tokenId)).toEqual([11n, 12n, 13n])
    // Logs: the history up to the new safe block, the history above it, the deposits.
    // The account code is read here at the safe block, which settles that it is deployed: the next review does not ask.
    expect(c.byMethod()).toEqual({ eth_chainId: 1, eth_getBlockByNumber: 5, eth_getCode: 1, eth_call: 2, eth_getLogs: 3 })
    expect(c.count()).toBe(12)
    c.requests.length = 0
    await observe(c.client, input({ historyCursor: cursor, depositsAfter: 900n }))
    expect(c.count('eth_getCode')).toBe(0)
    // Unbatched, the same review: every contract read is a request of its own.
    c.requests.length = 0
    const plain = historyCursor()
    Object.assign(plain, { ...cursor, ids: new Set(cursor.ids), events: [...cursor.events], through: 900n, hash: c.hashOf(900n) })
    await observe(c.client, input({ historyCursor: plain, depositsAfter: 900n, multicall3: null }))
    expect(c.count('eth_call')).toBe(1 + 1 + 6 + POOLS.length * 8 + 3 + 3 * 3)
    expect(c.count('eth_getBalance')).toBe(1)
  })

  test('with a safe head that did not move, a review is 9 requests: the account code is read until safe passes the block it was seen at', async () => {
    const c = chain()
    const cursor = historyCursor()
    await observe(c.client, input({ historyCursor: cursor }))
    c.head = 1010n
    c.requests.length = 0
    await observe(c.client, input({ historyCursor: cursor, depositsAfter: 900n }))
    expect(c.byMethod()).toEqual({ eth_chainId: 1, eth_getBlockByNumber: 3, eth_getCode: 1, eth_call: 2, eth_getLogs: 2 })
  })

  test('the account code is read until the account is seen deployed, never taken as deployed before', async () => {
    const c = chain()
    await observe(c.client, input({ historyCursor: historyCursor() }))
    expect(c.count('eth_getCode')).toBe(1)
    const OTHER_UNDEPLOYED = '0x00000000000000000000000000000000000000bb' as Address
    c.requests.length = 0
    const first = await observe(c.client, input({ account: OTHER_UNDEPLOYED, allowedTokenIds: [] }))
    const second = await observe(c.client, input({ account: OTHER_UNDEPLOYED, allowedTokenIds: [] }))
    expect([first.account.deployed, second.account.deployed]).toEqual([false, false])
    expect(c.count('eth_getCode')).toBe(2)
    c.code.set(OTHER_UNDEPLOYED.toLowerCase(), '0x01')
    expect((await observe(c.client, input({ account: OTHER_UNDEPLOYED, allowedTokenIds: [] }))).account.deployed).toBe(true)
    // Seen deployed, but above the safe block: it is read again.
    expect((await observe(c.client, input({ account: OTHER_UNDEPLOYED, allowedTokenIds: [] }))).account.deployed).toBe(true)
    expect(c.count('eth_getCode')).toBe(4)
    // The safe head reaches the block it was seen at: one read at safe settles it, and it is not read again.
    c.safe = c.head
    expect((await observe(c.client, input({ account: OTHER_UNDEPLOYED, allowedTokenIds: [] }))).account.deployed).toBe(true)
    expect(c.count('eth_getCode')).toBe(5)
    expect((await observe(c.client, input({ account: OTHER_UNDEPLOYED, allowedTokenIds: [] }))).account.deployed).toBe(true)
    expect(c.count('eth_getCode')).toBe(5)
    // The chain id is still checked on every observation.
    expect(c.count('eth_chainId')).toBe(6)
  })

  test('isDeployed: read every time until the code is read at a safe block, then not again', async () => {
    const asked: bigint[] = []
    const client = { getCode: async ({ blockNumber }: { blockNumber: bigint }) => (asked.push(blockNumber), blockNumber >= 95n ? '0x6001' : '0x') } as unknown as Parameters<typeof isDeployed>[0]
    // Seen at 100 and 101 while safe is 90: nothing is certain yet.
    expect(await isDeployed(client, ACCOUNT, 100n, 90n)).toBe(true)
    expect(await isDeployed(client, ACCOUNT, 101n, 90n)).toBe(true)
    expect(asked).toEqual([100n, 101n])
    // Safe has reached the sighting: the code is read at safe (120), and that settles it.
    expect(await isDeployed(client, ACCOUNT, 150n, 120n)).toBe(true)
    expect(asked).toEqual([100n, 101n, 120n])
    expect(await isDeployed(client, ACCOUNT, 250n, 200n)).toBe(true)
    expect(await isDeployed(client, ACCOUNT, 120n, 200n)).toBe(true)
    expect(asked).toEqual([100n, 101n, 120n])
    // A block before the one it was confirmed at (a provider that is behind): read, and not deployed there.
    expect(await isDeployed(client, ACCOUNT, 90n, 200n)).toBe(false)
    expect(asked).toEqual([100n, 101n, 120n, 90n])
    // Another client knows nothing of it.
    const other = { getCode: async () => '0x' } as unknown as Parameters<typeof isDeployed>[0]
    expect(await isDeployed(other, ACCOUNT, 300n, 300n)).toBe(false)
  })

  test('isDeployed: a deployment reorged out is never taken as deployed, whenever the next review comes', async () => {
    let deployedFrom = 100n
    const asked: bigint[] = []
    const client = { getCode: async ({ blockNumber }: { blockNumber: bigint }) => (asked.push(blockNumber), blockNumber >= deployedFrom ? '0x6001' : '0x') } as unknown as Parameters<typeof isDeployed>[0]
    expect(await isDeployed(client, ACCOUNT, 100n, 90n)).toBe(true)
    // The fork with the deployment is replaced. The next review comes after safe has passed block 100.
    deployedFrom = 10_000n
    expect(await isDeployed(client, ACCOUNT, 130n, 110n)).toBe(false)
    // Asked at safe (no code), then at the block of the observation (no code): nothing remembered.
    expect(asked).toEqual([100n, 110n, 130n])
    expect(await isDeployed(client, ACCOUNT, 300n, 250n)).toBe(false)
    expect(asked).toEqual([100n, 110n, 130n, 300n])
  })

  test('isDeployed: a sighting reorged out while still above safe is forgotten on the next read', async () => {
    let deployedFrom = 100n
    const client = { getCode: async ({ blockNumber }: { blockNumber: bigint }) => (blockNumber >= deployedFrom ? '0x6001' : '0x') } as unknown as Parameters<typeof isDeployed>[0]
    expect(await isDeployed(client, ACCOUNT, 100n, 90n)).toBe(true)
    deployedFrom = 10_000n
    expect(await isDeployed(client, ACCOUNT, 102n, 91n)).toBe(false)
    expect(await isDeployed(client, ACCOUNT, 300n, 250n)).toBe(false)
  })

  test('a client that answers another chain id is refused, on every observation', async () => {
    const c = chain()
    await observe(c.client, input({ historyCursor: historyCursor() }))
    c.chainId = 1
    expect(await observe(c.client, input({})).catch((e: { code?: string }) => e.code)).toBe('OBS_CHAIN_MISMATCH')
  })

  test('batched and unbatched reads give the same observation', async () => {
    const batched = await observe(chain().client, input({ historyCursor: historyCursor() }))
    const plain = await observe(chain().client, input({ historyCursor: historyCursor(), multicall3: null }))
    expect(batched).toEqual(plain)
    expect(batched.native).toBe(7n * 10n ** 15n)
    expect(batched.account).toEqual({ address: ACCOUNT, deployed: true, nonceKey: 0n, nonce: 4n })
    expect(batched.balances.USDC).toBe(25_000_000n)
    expect(batched.positions.map((p) => [p.tokenId, p.pool, p.collectable0, p.collectable1, p.principalOwed0])).toEqual([
      [11n, 'pool:USDC/cbBTC/500', 100n, 2n, 10n],
      [12n, 'pool:WETH/USDC/3000', 0n, 300n, 0n],
      [13n, 'pool:USDC/USDT/100', 5n, 6n, 0n],
    ])
    expect(batched.pools.map((p) => p.name)).toEqual(POOLS)
    expect(batched.pools.every((p) => p.twapTick !== null && p.identity.factoryPool === p.address)).toBe(true)
    // The pool's own deposit to the account is not a deposit; the one above the safe block is not safe yet.
    expect(batched.deposits.map((d) => [d.amount, d.safe])).toEqual([[5_000_000n, true], [1_000_000n, false]])
    expect(batched.ethPrice.sqrtPriceX96).toBe(batched.pools.find((p) => p.name === 'pool:WETH/USDC/3000')!.sqrtPriceX96)
  })

  test('every state read is pinned to the observation block', async () => {
    const c = chain()
    const obs = await observe(c.client, input({ historyCursor: historyCursor() }))
    const head = `0x${obs.block.number.toString(16)}`
    for (const r of c.requests.filter((x) => x.method === 'eth_call' || x.method === 'eth_getCode')) expect(r.params[1]).toBe(head)
    for (const r of c.requests.filter((x) => x.method === 'eth_getLogs')) expect(BigInt(r.params[0].toBlock) <= obs.block.number).toBe(true)
    expect(c.count('eth_getBalance')).toBe(0)
  })

  test('a log read that fails is a failed observation, and the history cursor does not move', async () => {
    const c = chain()
    const cursor = historyCursor()
    await observe(c.client, input({ historyCursor: cursor }))
    const held = { through: cursor.through, hash: cursor.hash, events: cursor.events.length }
    c.head = 1150n
    c.safe = 1050n
    // Deposits are the last log read: the history was read, and its cursor must still not be committed.
    c.onRequest = (r) => {
      if (r.method === 'eth_getLogs' && r.params[0].address.toLowerCase() === address('USDC').toLowerCase()) throw Object.assign(new Error('no provider has the chain view of block 1150'), { code: -32603 })
    }
    const err = await observe(c.client, input({ historyCursor: cursor, depositsAfter: 900n })).catch((e) => e)
    expect(err).toBeInstanceOf(ReasonError)
    expect((err as ReasonError).code).toBe('OBS_RPC_UNAVAILABLE')
    expect({ through: cursor.through, hash: cursor.hash, events: cursor.events.length }).toEqual(held)
    // The history read fails: same outcome.
    c.onRequest = (r) => {
      if (r.method === 'eth_getLogs') throw Object.assign(new Error('no provider has the chain view of block 1050'), { code: -32603 })
    }
    const again = await observe(c.client, input({ historyCursor: cursor, depositsAfter: 900n })).catch((e) => e)
    expect((again as ReasonError).code).toBe('OBS_RPC_UNAVAILABLE')
    expect({ through: cursor.through, hash: cursor.hash, events: cursor.events.length }).toEqual(held)
  })

  test('a block that changes hash during the observation is OBS_BLOCK_INCONSISTENT', async () => {
    const c = chain()
    c.onRequest = (r) => {
      if (r.method === 'eth_call') c.forked.add(c.head)
    }
    const err = await observe(c.client, input()).catch((e) => e)
    expect(err).toBeInstanceOf(ReasonError)
    expect((err as ReasonError).code).toBe('OBS_BLOCK_INCONSISTENT')
  })

  test('a pool that cannot answer `observe` has a null TWAP, batched or not; nothing else changes', async () => {
    const pool = address('pool:USDC/cbBTC/500')
    const twaps = []
    for (const multicall3 of [undefined, null]) {
      const c = chain()
      c.failRead(pool, 'observe(uint32[])')
      const obs = await observe(c.client, input({ multicall3 }))
      twaps.push(obs.pools.map((p) => p.twapTick))
      expect(obs.pools.find((p) => p.address === pool)!.twapTick).toBeNull()
      expect(obs.pools.filter((p) => p.twapTick === null).length).toBe(1)
    }
    expect(twaps[0]).toEqual(twaps[1])
  })

  test('a factory that cannot answer for a registry pool gives the zero address, and its positions ask the factory again', async () => {
    const c = chain()
    c.failRead(address('UniswapV3Factory'), 'getPool(address,address,uint24)')
    const err = await observe(c.client, input()).catch((e) => e)
    // As before batching: the identity read tolerates the failure, the position's own getPool does not.
    expect(err.name).toBe('ContractFunctionExecutionError')
    const none = chain()
    none.positions.splice(0)
    none.failRead(address('UniswapV3Factory'), 'getPool(address,address,uint24)')
    const obs = await observe(none.client, input({ allowedTokenIds: [] }))
    expect(obs.pools.every((p) => p.identity.factoryPool === zeroAddress)).toBe(true)
  })

  test('a required read that fails in the batch throws as the unbatched read does, never a zero', async () => {
    const errors = []
    for (const multicall3 of [undefined, null]) {
      const c = chain()
      c.failRead(address('USDC'), 'balanceOf(address)')
      const err = await observe(c.client, input({ multicall3 })).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      errors.push({ name: err.name, short: err.shortMessage, fn: err.functionName, contract: err.contractAddress })
    }
    expect(errors[0]).toEqual(errors[1])
    expect(errors[0]!.name).toBe('ContractFunctionExecutionError')
    expect(errors[0]!.fn).toBe('balanceOf')
  })

  test('a read that fails only inside the batch is asked again on its own, before the block is checked again', async () => {
    const c = chain()
    const usdc = address('USDC').toLowerCase()
    const execute = (c as any).execute.bind(c)
    ;(c as any).execute = (from: Address, to: Address, data: Hex) => {
      if (to.toLowerCase() === usdc && from.toLowerCase() === MC3.toLowerCase()) throw new Revert('only in the batch')
      return execute(from, to, data)
    }
    const obs = await observe(c.client, input())
    expect(obs.balances.USDC).toBe(25_000_000n)
    const direct = c.requests.findIndex((r) => r.method === 'eth_call' && r.params[0].to.toLowerCase() === usdc)
    expect(direct).toBeGreaterThan(0)
    expect(c.requests[direct]!.params[1]).toBe(`0x${obs.block.number.toString(16)}`)
    expect(c.requests.findLastIndex((r) => r.method === 'eth_getBlockByNumber')).toBeGreaterThan(direct)
    expect(c.requests.at(-1)!.method).toBe('eth_getBlockByNumber')
  })

  test('a token with no contract behind it throws, never reads as zero', async () => {
    const c = chain()
    const usdc = address('USDC').toLowerCase()
    const execute = (c as any).execute.bind(c)
    ;(c as any).execute = (from: Address, to: Address, data: Hex) => (to.toLowerCase() === usdc ? '0x' : execute(from, to, data))
    const err = await observe(c.client, input()).catch((e) => e)
    expect(err.name).toBe('ContractFunctionExecutionError')
  })

  test('a collect that reverts is reported by the position reads one by one', async () => {
    const c = chain()
    c.failRead(address('NonfungiblePositionManager'), 'collect((uint256,address,uint128,uint128))')
    const err = await observe(c.client, input()).catch((e) => e)
    expect(err.name).toBe('CallExecutionError')
    // The batched attempt, then positions/getPool/collect per position as before batching.
    expect(c.count('eth_call')).toBe(2 + 3 * 3)
  })

  test('a position outside the registry pools asks the factory and has no pool', async () => {
    const c = chain()
    c.positions.push({ tokenId: 14n, owner: ACCOUNT, token0: address('USDC'), token1: address('cbBTC'), fee: 10_000, tickLower: -10, tickUpper: 10, liquidity: 1n, collectable: [0n, 0n] })
    const obs = await observe(c.client, input())
    expect(obs.positions.find((p) => p.tokenId === 14n)!.pool).toBeNull()
    expect(c.count('eth_call')).toBe(3)
  })

  test('more positions than the first round asks for: one more request reads the rest', async () => {
    const c = chain()
    for (let i = 0; i < 7; i++) c.addPosition(ACCOUNT, 100n + BigInt(i), 'pool:USDC/cbBTC/500')
    const obs = await observe(c.client, input())
    expect(obs.positions.length).toBe(10)
    expect(c.count('eth_call')).toBe(3)
    const plain = await observe(chain10().client, input({ multicall3: null }))
    expect(obs.positions).toEqual(plain.positions)
    function chain10(): FakeChain {
      const d = chain()
      for (let i = 0; i < 7; i++) d.addPosition(ACCOUNT, 100n + BigInt(i), 'pool:USDC/cbBTC/500')
      return d
    }
  })

  test('a registry without Multicall3 reads one by one', async () => {
    expect(multicall3Of(baseRegistry)).toBe(MC3)
    expect(multicall3Of(monadRegistry)).toBe(address('Multicall3', monadRegistry))
    const without = { ...baseRegistry, entries: baseRegistry.entries.filter((e) => e.name !== 'Multicall3') }
    expect(multicall3Of(without)).toBeNull()
    const c = chain()
    const obs = await observe(c.client, input({ multicall3: multicall3Of(without) }))
    expect(aggregates(c).length).toBe(0)
    expect(obs.native).toBe(7n * 10n ** 15n)
    expect(c.count('eth_getBalance')).toBe(1)
  })
})

describe('pool state shared per block', () => {
  test('the second account at the same block does not read the pools again', async () => {
    const c = chain()
    const poolCache = poolStateCache()
    const a = await observe(c.client, input({ poolCache }))
    const firstRound = aggregates(c)[0]!
    const poolTargets = new Set(POOLS.map((p) => address(p).toLowerCase()))
    expect(firstRound.filter((x) => poolTargets.has(x.target.toLowerCase())).length).toBe(POOLS.length * 7)
    c.requests.length = 0
    const b = await observe(c.client, input({ poolCache, account: OTHER, allowedTokenIds: [99n] }))
    expect(aggregates(c).flat().filter((x) => poolTargets.has(x.target.toLowerCase())).length).toBe(0)
    expect(b.pools).toEqual(a.pools)
    expect(b.pools[0]).not.toBe(a.pools[0])
    expect(b.ethPrice).toEqual(a.ethPrice)
  })

  test('accounts observing the same block at once read the pools once', async () => {
    const c = chain()
    const poolCache = poolStateCache()
    const [a, b] = await Promise.all([observe(c.client, input({ poolCache })), observe(c.client, input({ poolCache, account: OTHER, allowedTokenIds: [99n] }))])
    const poolTargets = new Set(POOLS.map((p) => address(p).toLowerCase()))
    expect(aggregates(c).flat().filter((x) => poolTargets.has(x.target.toLowerCase())).length).toBe(POOLS.length * 7)
    expect(b.pools).toEqual(a.pools)
  })

  test('another block, another hash or another TWAP window is another read', async () => {
    const c = chain()
    const poolCache = poolStateCache()
    await observe(c.client, input({ poolCache }))
    expect(poolCache.size).toBe(1)
    await observe(c.client, input({ poolCache, twapWindowSeconds: 600 }))
    expect(poolCache.size).toBe(2)
    c.forked.add(c.head)
    await observe(c.client, input({ poolCache }))
    expect(poolCache.size).toBe(3)
    c.head += 1n
    await observe(c.client, input({ poolCache }))
    expect(poolCache.size).toBe(4)
  })

  test('the cache keeps the last few blocks only', async () => {
    const c = chain()
    const poolCache = poolStateCache(3)
    for (let i = 0; i < 6; i++) {
      c.head += 1n
      await observe(c.client, input({ poolCache }))
    }
    expect(poolCache.size).toBe(3)
  })

  test('an observation whose block changed hash leaves no pool state behind', async () => {
    const c = chain()
    const poolCache = poolStateCache()
    c.onRequest = (r) => {
      if (r.method === 'eth_getLogs') c.forked.add(c.head)
    }
    const err = await observe(c.client, input({ poolCache })).catch((e) => e)
    expect((err as ReasonError).code).toBe('OBS_BLOCK_INCONSISTENT')
    expect(poolCache.size).toBe(0)
  })

  test('a failed shared read is not kept, and the account waiting on it reads the pools itself', async () => {
    const c = chain()
    const poolCache = poolStateCache()
    c.failRead(address('pool:USDC/cbBTC/500'), 'liquidity()')
    const results = await Promise.allSettled([observe(c.client, input({ poolCache })), observe(c.client, input({ poolCache, account: OTHER, allowedTokenIds: [99n] }))])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(poolCache.size).toBe(0)
  })
})

describe('chunkCalls', () => {
  const call = (bytes: number) => ({ data: `0x${'00'.repeat(bytes)}` as Hex })

  test('no more than BATCH_MAX_CALLS calls per request', () => {
    const chunks = chunkCalls(Array.from({ length: 250 }, () => call(36)))
    expect(chunks.map((c) => c.length)).toEqual([BATCH_MAX_CALLS, BATCH_MAX_CALLS, 50])
  })

  test('no more than BATCH_MAX_BYTES of calldata per request, order kept', () => {
    const calls = Array.from({ length: 10 }, () => call(20_000))
    const chunks = chunkCalls(calls)
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 2, 2, 2])
    expect(chunks.flat()).toEqual(calls)
    expect(chunks.every((c) => c.reduce((n, x) => n + (x.data.length - 2) / 2, 0) <= BATCH_MAX_BYTES)).toBe(true)
  })

  test('a call over the limit travels alone', () => {
    expect(chunkCalls([call(10), call(80_000), call(10)]).map((c) => c.length)).toEqual([1, 1, 1])
  })

  test('an observation over the call limit is split and still complete', async () => {
    const c = chain()
    for (let i = 0; i < 120; i++) c.addPosition(ACCOUNT, 1000n + BigInt(i), 'pool:USDC/cbBTC/500')
    const obs = await observe(c.client, input())
    expect(obs.positions.length).toBe(123)
    expect(aggregates(c).every((a) => a.length <= BATCH_MAX_CALLS)).toBe(true)
  })
})
