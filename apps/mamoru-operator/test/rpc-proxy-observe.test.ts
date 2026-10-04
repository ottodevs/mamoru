import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPublicClient, http, type PublicClient } from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import { historyCursor, observe, type HistoryCursor, type ObserveInput } from '@mamoru/rpc'
import { FakeChain } from '../../../packages/rpc/test/fake-chain.ts'
import { startRpcProxy } from '../src/rpc-proxy.ts'

// observe() through the proxy, with the state on a 10-block-range upstream and the logs routed to a fallback.
const STATE = 'https://base-mainnet.g.alchemy.com/v2/test-key'
const LOGS = 'https://base-rpc.publicnode.com'
const THIRD = 'https://mainnet.base.org'
const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const DEPOSITOR = '0x00000000000000000000000000000000000000cc' as Address

/** One chain view: an account with a managed position, its history and two deposits, the second near the head. */
function view(): FakeChain {
  const c = new FakeChain()
  c.code.set(ACCOUNT.toLowerCase(), '0x6001')
  c.setBalance('USDC', ACCOUNT, 25_000_000n)
  c.addPosition(ACCOUNT, 11n, 'pool:USDC/cbBTC/500', [100n, 2n])
  c.addPositionEvent('DecreaseLiquidity', 11n, 850n, 0, [40n, 1n])
  c.addPositionEvent('Collect', 11n, 850n, 1, [30n, 1n])
  c.addPositionEvent('DecreaseLiquidity', 11n, 998n, 0, [7n, 7n])
  c.addDeposit('USDC', DEPOSITOR, ACCOUNT, 5_000_000n, 890n, 2)
  c.addDeposit('USDC', DEPOSITOR, ACCOUNT, 1_000_000n, 999n, 0)
  return c
}

const input = (cursor: HistoryCursor): ObserveInput => ({
  chainId: 8453,
  account: ACCOUNT,
  nonceKey: 0n,
  depositsAfter: 800n,
  sessions: [],
  allowedTokenIds: [11n],
  historyFromBlock: 800n,
  historyCursor: cursor,
  intents: { paused: false, exitRequested: false },
  slot: null,
  twapWindowSeconds: 1800,
  opGasUnits: 5_100_000n,
  maxPriorityFeePerGas: 1_000_000n,
  savingsAsset: 'USDC',
  ethPricePool: 'pool:WETH/USDC/3000',
})

const stops: (() => void)[] = []
const savedLag = process.env.MAMORU_HEAD_LAG
beforeEach(() => {
  // The fakes are single nodes: no head lag to absorb.
  process.env.MAMORU_HEAD_LAG = '0'
})
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  if (savedLag === undefined) delete process.env.MAMORU_HEAD_LAG
  else process.env.MAMORU_HEAD_LAG = savedLag
})

/** A client on the proxy in front of `state` (upstream) and the fallbacks `logs` and `third`, in that order. */
function through(state: FakeChain, logs: FakeChain, third: FakeChain = view()): PublicClient {
  const served: Record<string, { url: string; stop: () => void }> = { [STATE]: state.serve(), [LOGS]: logs.serve(), [THIRD]: third.serve() }
  const proxy = startRpcProxy(STATE, { fallbacks: [LOGS, THIRD], logRanges: {}, fetch: (url, init) => fetch(served[url]!.url, init) })
  stops.push(proxy.stop, ...Object.values(served).map((x) => x.stop))
  return createPublicClient({ transport: http(proxy.url, { retryCount: 0 }) })
}

/** What a single honest provider gives: the reference. */
async function reference(): Promise<{ obs: Awaited<ReturnType<typeof observe>>; cursor: HistoryCursor }> {
  const cursor = historyCursor()
  return { obs: await observe(view().client, input(cursor)), cursor }
}

const down = (c: FakeChain) => {
  c.onRequest = () => {
    throw Object.assign(new Error('service unavailable'), { code: -32603 })
  }
}
const blockReads = (c: FakeChain) => c.requests.filter((r) => r.method === 'eth_getBlockByNumber' && r.params[0].startsWith('0x')).map((r) => BigInt(r.params[0]))

describe('observe through the proxy: logs and state from one chain view', () => {
  test('a log provider with the same view serves the logs, witnessed by the upstream, and the observation is the reference', async () => {
    const [state, logs, third] = [view(), view(), view()]
    const cursor = historyCursor()
    const obs = await observe(through(state, logs, third), input(cursor))
    const ref = await reference()
    expect(obs).toEqual(ref.obs)
    expect(cursor).toEqual(ref.cursor)
    expect(state.count('eth_getLogs')).toBe(0)
    expect(logs.count('eth_getLogs')).toBe(3)
    // After each range the log provider is asked for the block that ends it.
    expect(blockReads(logs)).toEqual([900n, 1000n, 1000n])
    expect(third.count()).toBe(0)
  })

  test('upstream requests of one steady review: 10 to the state provider, 6 to the log provider', async () => {
    const [state, logs, third] = [view(), view(), view()]
    const client = through(state, logs, third)
    const cursor = historyCursor()
    await observe(client, input(cursor))
    for (const c of [state, logs]) {
      c.head = 1150n
      c.safe = 1050n
      c.requests.length = 0
    }
    await observe(client, input(cursor))
    // No block read beyond what the engine asks for: the blocks it just read from the upstream witness the end of each log range.
    expect(state.byMethod()).toEqual({ eth_chainId: 1, eth_blockNumber: 1, eth_getBlockByNumber: 5, eth_getCode: 1, eth_call: 2 })
    expect(logs.byMethod()).toEqual({ eth_getLogs: 3, eth_getBlockByNumber: 3 })
    expect(third.count()).toBe(0)
  })

  test('a log provider 3 blocks behind, missing the last deposit and the last decrease: its ranges ending at the head are rejected', async () => {
    const [state, logs, third] = [view(), view(), view()]
    logs.head = 997n
    logs.logs.splice(logs.logs.findIndex((l) => l.blockNumber === 998n), 1)
    logs.logs.splice(logs.logs.findIndex((l) => l.blockNumber === 999n), 1)
    const cursor = historyCursor()
    const obs = await observe(through(state, logs, third), input(cursor))
    const ref = await reference()
    expect(obs).toEqual(ref.obs)
    expect(obs.deposits.map((d) => d.block)).toEqual([890n, 999n])
    expect(obs.positions[0]!.principalOwed0).toBe(17n)
    expect(cursor).toEqual(ref.cursor)
    // The next fallback served the two ranges that end at the head; the upstream only witnessed.
    expect(third.count('eth_getLogs')).toBe(2)
    expect(state.count('eth_getLogs')).toBe(0)
  })

  test('a log provider on another fork, with another history: nothing of it reaches the observation or the cursor', async () => {
    const [state, logs, third] = [view(), view(), view()]
    for (let n = 840n; n <= 1000n; n++) logs.forked.add(n)
    logs.logs.splice(0)
    logs.addPositionEvent('DecreaseLiquidity', 11n, 860n, 0, [999n, 999n])
    logs.addDeposit('USDC', DEPOSITOR, ACCOUNT, 666n, 870n, 0)
    const cursor = historyCursor()
    const obs = await observe(through(state, logs, third), input(cursor))
    const ref = await reference()
    expect(obs).toEqual(ref.obs)
    expect(cursor).toEqual(ref.cursor)
    expect(cursor.hash).toBe(state.hashOf(900n))
    expect(cursor.events.some((e) => e.blockNumber === 860n)).toBe(false)
    expect(logs.count('eth_getLogs')).toBe(3)
    expect(third.count('eth_getLogs')).toBe(3)
  })

  test('the upstream would agree with itself but no other provider answers: the observation fails and the cursor does not move', async () => {
    const [state, logs, third] = [view(), view(), view()]
    const client = through(state, logs, third)
    const cursor = historyCursor()
    await observe(client, input(cursor))
    const held = { through: cursor.through, hash: cursor.hash, events: cursor.events.length }
    for (const c of [state, logs, third]) {
      c.head = 1150n
      c.safe = 1050n
      c.addPositionEvent('Collect', 11n, 1040n, 0, [1n, 1n])
    }
    down(logs)
    down(third)
    state.requests.length = 0
    const err = await observe(client, input(cursor)).catch((e) => e)
    expect(err).toBeInstanceOf(ReasonError)
    expect((err as ReasonError).code).toBe('OBS_RPC_UNAVAILABLE')
    expect((err as ReasonError).detail).toContain('witness')
    // The upstream read the range itself, in chunks, and has the block: it is still not accepted.
    expect(state.count('eth_getLogs')).toBeGreaterThan(0)
    expect({ through: cursor.through, hash: cursor.hash, events: cursor.events.length }).toEqual(held)
    // Once another provider answers again, the same cursor catches up with nothing lost.
    logs.onRequest = () => {}
    const obs = await observe(client, input(cursor))
    expect(cursor.through).toBe(1050n)
    expect(cursor.events.map((e) => e.blockNumber)).toEqual([850n, 850n, 998n, 1040n])
    expect(obs.block.number).toBe(1150n)
  })

  test('every log provider is on another view than the upstream: the observation fails and the cursor does not move', async () => {
    const [state, logs, third] = [view(), view(), view()]
    const client = through(state, logs, third)
    const cursor = historyCursor()
    await observe(client, input(cursor))
    const held = { through: cursor.through, hash: cursor.hash, events: cursor.events.length }
    for (const c of [state, logs, third]) {
      c.head = 1150n
      c.safe = 1050n
    }
    for (let n = 1001n; n <= 1150n; n++) for (const c of [logs, third]) c.forked.add(n)
    const err = await observe(client, input(cursor)).catch((e) => e)
    expect((err as ReasonError).code).toBe('OBS_RPC_UNAVAILABLE')
    expect({ through: cursor.through, hash: cursor.hash, events: cursor.events.length }).toEqual(held)
  })
})
