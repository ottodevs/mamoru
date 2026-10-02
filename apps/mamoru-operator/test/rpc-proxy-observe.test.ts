import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPublicClient, http, type PublicClient } from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import { historyCursor, observe, type HistoryCursor, type ObserveInput } from '@mamoru/rpc'
import { FakeChain } from '../../../packages/rpc/test/fake-chain.ts'
import { startRpcProxy } from '../src/rpc-proxy.ts'

// observe() through the proxy, with the state on a 10-block-range upstream and the logs routed to a fallback.
const STATE = 'https://base-mainnet.g.alchemy.com/v2/test-key'
const LOGS = 'https://base-rpc.publicnode.com'
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

/** A client on the proxy in front of `state` (upstream) and `logs` (fallback). */
function through(state: FakeChain, logs: FakeChain): PublicClient {
  const served: Record<string, { url: string; stop: () => void }> = { [STATE]: state.serve(), [LOGS]: logs.serve() }
  const proxy = startRpcProxy(STATE, { fallbacks: [LOGS], logRanges: {}, fetch: (url, init) => fetch(served[url]!.url, init) })
  stops.push(proxy.stop, served[STATE]!.stop, served[LOGS]!.stop)
  return createPublicClient({ transport: http(proxy.url, { retryCount: 0 }) })
}

/** What a single honest provider gives: the reference. */
async function reference(): Promise<{ obs: Awaited<ReturnType<typeof observe>>; cursor: HistoryCursor }> {
  const cursor = historyCursor()
  return { obs: await observe(view().client, input(cursor)), cursor }
}

describe('observe through the proxy: logs and state from one chain view', () => {
  test('a log provider with the same view serves the logs, and the observation is the reference', async () => {
    const [state, logs] = [view(), view()]
    const cursor = historyCursor()
    const obs = await observe(through(state, logs), input(cursor))
    const ref = await reference()
    expect(obs).toEqual(ref.obs)
    expect(cursor).toEqual(ref.cursor)
    expect(state.count('eth_getLogs')).toBe(0)
    expect(logs.count('eth_getLogs')).toBe(3)
    // After each range the log provider is asked for the block that ends it.
    expect(logs.requests.filter((r) => r.method === 'eth_getBlockByNumber').map((r) => BigInt(r.params[0]))).toEqual([900n, 1000n, 1000n])
  })

  test('upstream requests of one steady review: 13 to the state provider, 6 to the log provider', async () => {
    const [state, logs] = [view(), view()]
    const client = through(state, logs)
    const cursor = historyCursor()
    await observe(client, input(cursor))
    for (const c of [state, logs]) {
      c.head = 1150n
      c.safe = 1050n
      c.requests.length = 0
    }
    await observe(client, input(cursor))
    // Three block reads more than the engine asks for: the state provider's hash at the end of each log range.
    expect(state.byMethod()).toEqual({ eth_chainId: 1, eth_blockNumber: 1, eth_getBlockByNumber: 8, eth_getCode: 1, eth_call: 2 })
    expect(logs.byMethod()).toEqual({ eth_getLogs: 3, eth_getBlockByNumber: 3 })
  })

  test('a log provider 3 blocks behind, missing the last deposit and the last decrease: its ranges ending at the head are rejected', async () => {
    const [state, logs] = [view(), view()]
    logs.head = 997n
    logs.logs.splice(logs.logs.findIndex((l) => l.blockNumber === 998n), 1)
    logs.logs.splice(logs.logs.findIndex((l) => l.blockNumber === 999n), 1)
    const cursor = historyCursor()
    const obs = await observe(through(state, logs), input(cursor))
    const ref = await reference()
    expect(obs).toEqual(ref.obs)
    expect(obs.deposits.map((d) => d.block)).toEqual([890n, 999n])
    expect(obs.positions[0]!.principalOwed0).toBe(17n)
    expect(cursor).toEqual(ref.cursor)
    // The upstream served the two ranges that end at the head, in 10-block chunks.
    expect(state.count('eth_getLogs')).toBeGreaterThan(2)
  })

  test('a log provider on another fork, with another history: nothing of it reaches the observation or the cursor', async () => {
    const [state, logs] = [view(), view()]
    for (let n = 840n; n <= 1000n; n++) logs.forked.add(n)
    logs.logs.splice(0)
    logs.addPositionEvent('DecreaseLiquidity', 11n, 860n, 0, [999n, 999n])
    logs.addDeposit('USDC', DEPOSITOR, ACCOUNT, 666n, 870n, 0)
    const cursor = historyCursor()
    const obs = await observe(through(state, logs), input(cursor))
    const ref = await reference()
    expect(obs).toEqual(ref.obs)
    expect(cursor).toEqual(ref.cursor)
    expect(cursor.hash).toBe(state.hashOf(900n))
    expect(cursor.events.some((e) => e.blockNumber === 860n)).toBe(false)
    expect(logs.count('eth_getLogs')).toBe(3)
  })

  test('no provider passes the check: the observation fails with OBS_RPC_UNAVAILABLE and the cursor does not move', async () => {
    const [state, logs] = [view(), view()]
    const client = through(state, logs)
    const cursor = historyCursor()
    await observe(client, input(cursor))
    const held = { through: cursor.through, hash: cursor.hash, events: cursor.events.length }
    for (const c of [state, logs]) {
      c.head = 1150n
      c.safe = 1050n
      c.addPositionEvent('Collect', 11n, 1040n, 0, [1n, 1n])
    }
    // The log provider is on another fork, and the upstream does not serve logs.
    for (let n = 1001n; n <= 1150n; n++) logs.forked.add(n)
    state.onRequest = (r) => {
      if (r.method === 'eth_getLogs') throw Object.assign(new Error('Monthly capacity limit exceeded'), { code: 429 })
    }
    const err = await observe(client, input(cursor)).catch((e) => e)
    expect(err).toBeInstanceOf(ReasonError)
    expect((err as ReasonError).code).toBe('OBS_RPC_UNAVAILABLE')
    expect({ through: cursor.through, hash: cursor.hash, events: cursor.events.length }).toEqual(held)
    // Once a provider has the state provider's view again, the same cursor catches up with nothing lost.
    logs.forked.clear()
    const obs = await observe(client, input(cursor))
    expect(cursor.through).toBe(1050n)
    expect(cursor.events.map((e) => e.blockNumber)).toEqual([850n, 850n, 998n, 1040n])
    expect(obs.block.number).toBe(1150n)
  })
})
