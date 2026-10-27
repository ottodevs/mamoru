import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, toFunctionSelector } from 'viem'
import type { FundingView, OwnerResponse } from '@mamoru/domain'
import { address as addressOf, baseRegistry, erc20Abi, nonfungiblePositionManagerAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import {
  amountsForLiquidity,
  FUNDING_CACHE_MS,
  FUNDING_FAIL_MS,
  FundingGate,
  idleTokens,
  inUsdc,
  MAX_LISTED_POSITIONS,
  positionUsdc,
  type ChainPosition,
} from '../../src/api/accounts/chain-funding.ts'
import { FUNDING_TIMEOUT_MS } from '../../src/api/accounts/operator.ts'
import * as operatorChain from '../../../mamoru-operator/src/chain.ts'
import { idleTokens as operatorIdleTokens } from '../../../mamoru-operator/src/operator.ts'
import { harness, register, PASSKEY_A, PASSKEY_B, sessionCookie } from './helpers.ts'

// otto/mamoru#238: the funding route answers from the chain when the operator cannot.

const OPERATOR_URL = 'https://operator.test'
const LIVE = { LIVE_FUNDS: '1', OPERATOR_URL, OPERATOR_SECRET: 'operator-secret-for-tests-only-0123456789' }
const RPC = 'https://base.example/rpc-key'
const RPC_B = 'https://base-b.example/other-key'
const T0 = new Date('2026-10-07T10:00:00Z')

const reg = baseRegistry
const USDC_CBBTC = 'pool:USDC/cbBTC/500'
const WETH_USDC = 'pool:WETH/USDC/3000'
const NPM = addressOf('NonfungiblePositionManager', reg)
const MULTICALL3 = reg.entries.find((e) => e.name === 'Multicall3')!.address

// ---- prices. 1 cbBTC = 100,000 USDC -> 1 sat = 1000 raw USDC; 1 WETH = 4,000 USDC.
const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}
/** sqrtPriceX96 for a pool with `ratio1Per0` = raw token1 per raw token0, as a fraction num/den. */
const sqrtPrice = (num: bigint, den: bigint) => isqrt((num << 192n) / den)
const tickOf = (sqrtPriceX96: bigint) => Math.floor(Math.log(Number(sqrtPriceX96) ** 2 / 2 ** 192) / Math.log(1.0001))
const PRICES: Record<string, bigint> = {
  [USDC_CBBTC]: sqrtPrice(1n, 1000n), // token0 USDC, token1 cbBTC: 1 raw USDC = 1/1000 sat
  [WETH_USDC]: sqrtPrice(4000n * 10n ** 6n, 10n ** 18n), // token0 WETH, token1 USDC: raw USDC per raw wei
  'pool:EURC/USDC/500': 1n << 96n,
  'pool:WETH/USDC/500': sqrtPrice(4000n * 10n ** 6n, 10n ** 18n),
  'pool:USDC/JPYT/3000': 1n << 96n,
  'pool:USDC/USDT/100': 1n << 96n,
}
const CENTER = tickOf(PRICES[USDC_CBBTC]!)

// ---- a chain behind JSON-RPC
const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
const SEL = {
  chainId: toFunctionSelector('function getChainId()'),
  block: toFunctionSelector('function getBlockNumber()'),
  eth: toFunctionSelector('function getEthBalance(address)'),
}
const word = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, '0')}` as const

type Pos = { owner: string | 'burned'; token0: string; token1: string; fee: number; tickLower: number; tickUpper: number; liquidity: bigint; owed0?: bigint; owed1?: bigint }
type Node = {
  chainId: number
  block: number
  eth: bigint
  balances: Record<string, bigint> // by token name
  positions: Record<string, Pos> // by tokenId
  code: string
  http?: number
  fail?: boolean
  /** Throws as an aborted fetch does. */
  timeout?: boolean
  requests: { url: string; method: string; params: unknown[] }[]
  inners: string[]
}

function chain(over: Partial<Node> = {}) {
  const n: Node = { chainId: 8453, block: 36_000_000, eth: 0n, balances: {}, positions: {}, code: '0x6080', requests: [], inners: [], ...over }
  const tokenByAddress = new Map(reg.entries.filter((e) => e.kind === 'token').map((e) => [e.address.toLowerCase(), e.name]))
  const poolByAddress = new Map(reg.entries.filter((e) => e.kind === 'pool').map((e) => [e.address.toLowerCase(), e.name]))
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }
    n.requests.push({ url: input, method: req.method, params: req.params })
    if (n.timeout) throw new DOMException('aborted', 'TimeoutError')
    if (n.http) return new Response('nope', { status: n.http })
    if (n.fail) return Response.json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'boom' } })
    if (req.method === 'eth_getCode') return Response.json({ jsonrpc: '2.0', id: req.id, result: n.code })
    const { args } = decodeFunctionData({ abi: multicallAbi, data: (req.params[0] as { data: `0x${string}` }).data })
    const results = args[0].map((call) => {
      const sel = call.callData.slice(0, 10)
      const target = call.target.toLowerCase()
      n.inners.push(`${target}:${sel}`)
      const ok = (returnData: `0x${string}`) => ({ success: true, returnData })
      const revert = { success: false, returnData: '0x' as const }
      if (sel === SEL.chainId) return ok(word(n.chainId))
      if (sel === SEL.block) return ok(word(n.block))
      if (sel === SEL.eth) return ok(word(n.eth))
      if (tokenByAddress.has(target)) return ok(word(n.balances[tokenByAddress.get(target)!] ?? 0n))
      if (poolByAddress.has(target)) {
        const sqrtPriceX96 = PRICES[poolByAddress.get(target)!]!
        return ok(encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'slot0', result: [sqrtPriceX96, tickOf(sqrtPriceX96), 0, 1, 1, 0, true] }))
      }
      if (target === NPM.toLowerCase()) {
        const d = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: call.callData })
        const id = String((d.args as readonly [bigint])[0])
        const p = n.positions[id]
        if (d.functionName === 'ownerOf') return !p || p.owner === 'burned' ? revert : ok(encodeAbiParameters([{ type: 'address' }], [p.owner as `0x${string}`]))
        if (d.functionName === 'positions') {
          if (!p) return revert
          return ok(
            encodeFunctionResult({
              abi: nonfungiblePositionManagerAbi,
              functionName: 'positions',
              result: [0n, '0x0000000000000000000000000000000000000000', addressOf(p.token0, reg), addressOf(p.token1, reg), p.fee, p.tickLower, p.tickUpper, p.liquidity, 0n, 0n, p.owed0 ?? 0n, p.owed1 ?? 0n],
            }),
          )
        }
      }
      return revert
    })
    return Response.json({ jsonrpc: '2.0', id: req.id, result: encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results }) })
  }
  return Object.assign(n, { fetch })
}

// ---- the maths against the operator's
const fixtures: ChainPosition[] = [
  // in range, with fees owed
  { tokenId: 1n, pool: USDC_CBBTC, token0: 'USDC', token1: 'cbBTC', fee: 500, liquidity: 5_000_000_000n, tickLower: CENTER - 200, tickUpper: CENTER + 200, inRange: true, amount0: 0n, amount1: 0n, tokensOwed0: 1_234_567n, tokensOwed1: 321n },
  // out of range, price below the lower tick: all token0 (USDC)
  { tokenId: 2n, pool: USDC_CBBTC, token0: 'USDC', token1: 'cbBTC', fee: 500, liquidity: 5_000_000_000n, tickLower: CENTER + 100, tickUpper: CENTER + 500, inRange: false, amount0: 0n, amount1: 0n, tokensOwed0: 0n, tokensOwed1: 0n },
  // out of range, price above the upper tick: all token1 (cbBTC), valued at the pool price
  { tokenId: 3n, pool: USDC_CBBTC, token0: 'USDC', token1: 'cbBTC', fee: 500, liquidity: 5_000_000_000n, tickLower: CENTER - 500, tickUpper: CENTER - 100, inRange: false, amount0: 0n, amount1: 0n, tokensOwed0: 0n, tokensOwed1: 0n },
  // a pool where USDC is token1
  { tokenId: 4n, pool: WETH_USDC, token0: 'WETH', token1: 'USDC', fee: 3000, liquidity: 10n ** 15n, tickLower: tickOf(PRICES[WETH_USDC]!) - 600, tickUpper: tickOf(PRICES[WETH_USDC]!) + 600, inRange: true, amount0: 0n, amount1: 0n, tokensOwed0: 7n, tokensOwed1: 9n },
]
const withAmounts = (p: ChainPosition): ChainPosition => ({ ...p, ...amountsForLiquidity(PRICES[p.pool]!, p.tickLower, p.tickUpper, p.liquidity) })

describe('the Worker maths is the operator maths', () => {
  test('amountsForLiquidity, inUsdc, positionUsdc and idleTokens agree on in-range, out-of-range and tokensOwed fixtures', () => {
    for (const f of fixtures) {
      const mine = amountsForLiquidity(PRICES[f.pool]!, f.tickLower, f.tickUpper, f.liquidity)
      expect(mine).toEqual(operatorChain.amountsForLiquidity(PRICES[f.pool]!, f.tickLower, f.tickUpper, f.liquidity))
      const p = withAmounts(f)
      expect(positionUsdc(p, PRICES[p.pool]!, reg)).toBe(operatorChain.positionUsdc(p, PRICES[p.pool]!, reg))
      for (const [token, amount] of [['USDC', 5_000_000n], ['cbBTC', 12_345n], ['WETH', 10n ** 15n], ['USDT', 99n]] as const) {
        const pool = token === 'cbBTC' ? USDC_CBBTC : token === 'WETH' ? WETH_USDC : p.pool
        expect(inUsdc(pool, token, amount, PRICES[pool]!, reg)).toBe(operatorChain.inUsdc(pool, token, amount, PRICES[pool]!, reg))
      }
    }
    const tokens = { USDC: 12_000_000n, cbBTC: 20_000n, WETH: 10n ** 15n, EURC: 0n, USDT: 1_500_000n, JPYT: 0n }
    const prices = Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { sqrtPriceX96: v, tick: tickOf(v) }]))
    expect(idleTokens(tokens, prices, reg)).toEqual(operatorIdleTokens({ tokens, prices } as never, reg))
  })

  test('a position below its range is all token0, above it all token1; tokensOwed is added on top', () => {
    const [inRange, below, above] = fixtures.map(withAmounts) as [ChainPosition, ChainPosition, ChainPosition]
    expect(inRange.amount0 > 0n && inRange.amount1 > 0n).toBe(true)
    // lower tick above the price: the price is below the range, so it holds only USDC (token0)
    expect(below.amount1).toBe(0n)
    expect(below.amount0 > 0n).toBe(true)
    expect(above.amount0).toBe(0n)
    expect(above.amount1 > 0n).toBe(true)
    // the cbBTC side is valued at the pool price: 1 sat = 1000 raw USDC
    expect(inUsdc(USDC_CBBTC, 'cbBTC', 1000n, PRICES[USDC_CBBTC]!, reg)).toBe(1_000_000n)
    expect(positionUsdc(above, PRICES[USDC_CBBTC]!, reg)).toBe(inUsdc(USDC_CBBTC, 'cbBTC', above.amount1, PRICES[USDC_CBBTC]!, reg))
    const owed = withAmounts(fixtures[0]!)
    expect(positionUsdc(owed, PRICES[USDC_CBBTC]!, reg)).toBe(
      positionUsdc({ ...owed, tokensOwed0: 0n, tokensOwed1: 0n }, PRICES[USDC_CBBTC]!, reg) + 1_234_567n + inUsdc(USDC_CBBTC, 'cbBTC', 321n, PRICES[USDC_CBBTC]!, reg),
    )
  })
})

// ---- the route
async function onboard(h: ReturnType<typeof harness>) {
  const res = await register(h, PASSKEY_A)
  return { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
}

function operator(reply: () => Response | Promise<Response>) {
  const seen: string[] = []
  return { seen, fetch: async (input: string) => (seen.push(input), reply()) }
}
const down = () => Response.json({ error: 'The operator is not reachable.', code: 'OPERATOR_UNAVAILABLE' }, { status: 503 })

function setup(opts: { node: ReturnType<typeof chain>; reply?: () => Response | Promise<Response>; env?: Record<string, unknown>; now?: () => Date; node2?: ReturnType<typeof chain> }) {
  const op = operator(opts.reply ?? down)
  const nodes = [opts.node, ...(opts.node2 ? [opts.node2] : [])]
  const chainFetch = (input: string, init: RequestInit) => (input === RPC_B && opts.node2 ? opts.node2.fetch(input, init) : opts.node.fetch(input, init))
  const h = harness(opts.now ?? (() => T0), { env: { ...LIVE, BASE_RPC_URLS: RPC, ...opts.env } as never, operatorFetch: op.fetch, chainFetch })
  return { h, op, nodes }
}

async function funding(h: ReturnType<typeof harness>, cookie: string, key: string) {
  return h.request(`/api/accounts/${key}/funding`, { cookie })
}

/** The snapshot the operator wrote, as the Worker later reads it. */
function snapshot(h: ReturnType<typeof harness>, owner: OwnerResponse, tokenIds: string[], positionsJson?: string, readAt = '2026-10-07T09:20:00.000Z') {
  h.db.raw
    .query(
      `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
       VALUES (8453, ?, ?, 'unknown', 1, ?, 1, 0, 0, 0, 0, 0, ?, ?)`,
    )
    .run(owner.address.toLowerCase(), owner.accountKey, readAt, positionsJson ?? JSON.stringify(tokenIds.map((tokenId) => ({ tokenId, pool: USDC_CBBTC }))), readAt)
}

const pos = (owner: string, over: Partial<Pos> = {}): Pos => ({ owner, token0: 'USDC', token1: 'cbBTC', fee: 500, tickLower: CENTER - 200, tickUpper: CENTER + 200, liquidity: 5_000_000_000n, ...over })
const valueOf = (p: Pos, id: bigint): bigint => {
  const c: ChainPosition = { tokenId: id, pool: USDC_CBBTC, token0: p.token0, token1: p.token1, fee: p.fee, liquidity: p.liquidity, tickLower: p.tickLower, tickUpper: p.tickUpper, inRange: true, amount0: 0n, amount1: 0n, tokensOwed0: p.owed0 ?? 0n, tokensOwed1: p.owed1 ?? 0n }
  return positionUsdc(withAmounts(c), PRICES[USDC_CBBTC]!, reg)
}
const totalOf = (f: FundingView) => BigInt(f.usdc) + f.positions.reduce((s, p) => s + BigInt(p.valueUsdc!), 0n)

describe('funding: the fallback trigger', () => {
  test('operator unreachable, 503, 500, 502 and a timeout each answer from the chain', async () => {
    for (const reply of [down, () => new Response('bad gateway', { status: 502 }), () => new Response('boom', { status: 500 }), () => { throw new TypeError('connect ECONNREFUSED') }, () => { throw new DOMException('aborted', 'TimeoutError') }]) {
      const node = chain({ balances: { USDC: 12_340_000n }, eth: 5n })
      const { h } = setup({ node, reply })
      const { cookie, owner } = await onboard(h)
      const res = await funding(h, cookie, owner.accountKey)
      expect(res.status).toBe(200)
      const f = (await res.json()) as FundingView
      expect(f).toMatchObject({ source: 'chain', address: owner.address, usdc: '12340000', eth: '5', block: 36_000_000, active: false, overCap: null, deployed: true })
      expect(f.engine).toBeUndefined()
      expect(f.approval).toBeUndefined()
      expect(f.progress).toBeUndefined()
      expect(f.exposure).toBeUndefined()
      expect(f.positions).toEqual([])
      // no snapshot: idle only, and it says so
      expect(f.chainRead).toEqual({ positions: 'unknown', listedAt: null })
    }
  })

  test('401, 403, 404 and 400 from the operator keep their status; the chain is not read', async () => {
    for (const status of [400, 401, 403, 404]) {
      const node = chain({ balances: { USDC: 1_000_000n } })
      const { h } = setup({ node, reply: () => Response.json({ error: 'nope', code: 'X' }, { status }) })
      const { cookie, owner } = await onboard(h)
      const res = await funding(h, cookie, owner.accountKey)
      expect(res.status).toBe(status)
      expect(await res.json()).toMatchObject({ error: 'nope' })
      expect(node.requests).toHaveLength(0)
    }
  })

  test('a good operator answer passes through untouched and the chain is not read', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h } = setup({ node, reply: () => Response.json({ usdc: '7', source: undefined }) })
    const { cookie, owner } = await onboard(h)
    const res = await funding(h, cookie, owner.accountKey)
    expect(await res.json()).toEqual({ usdc: '7' })
    expect(node.requests).toHaveLength(0)
  })

  test('another route (ops) never falls back', async () => {
    const node = chain()
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    expect((await h.request(`/api/accounts/${owner.accountKey}/ops`, { cookie })).status).toBe(503)
    expect(node.requests).toHaveLength(0)
  })

  test('no RPC secret: the operator answer is what the owner gets, as before', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h } = setup({ node, env: { BASE_RPC_URLS: '' } })
    const { cookie, owner } = await onboard(h)
    const res = await funding(h, cookie, owner.accountKey)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })
    expect(node.requests).toHaveLength(0)
  })

  test('every provider failing keeps today\'s error', async () => {
    const node = chain({ http: 500 })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    const res = await funding(h, cookie, owner.accountKey)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })
  })

  test('live funds off: no operator was tried, nothing is read from chain either', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const op = operator(down)
    const h = harness(() => T0, { env: { BASE_RPC_URLS: RPC }, operatorFetch: op.fetch, chainFetch: node.fetch })
    const { cookie, owner } = await onboard(h)
    expect((await funding(h, cookie, owner.accountKey)).status).toBe(503)
    expect(node.requests).toHaveLength(0)
  })

  test('the funding route waits less than the owner actions do', () => {
    expect(FUNDING_TIMEOUT_MS).toBe(20_000)
  })
})

describe('funding from the chain: what counts', () => {
  test('idle USDC, another token valued at the pool price, and the snapshot\'s positions, all at one block', async () => {
    const p1 = pos('SAFE', { owed0: 1_000_000n, owed1: 100n })
    const p2 = pos('SAFE', { tickLower: CENTER - 600, tickUpper: CENTER - 300 }) // price above the range: all cbBTC
    const node = chain({ balances: { USDC: 3_000_000n, cbBTC: 2_000n, USDT: 500_000n }, eth: 10n ** 18n, positions: {} })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    node.positions = { '101': { ...p1, owner: owner.address }, '102': { ...p2, owner: owner.address } }
    snapshot(h, owner, ['101', '102'])
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView

    expect(f.chainRead).toEqual({ positions: 'listed', listedAt: '2026-10-07T09:20:00.000Z' })
    expect(f.positions.map((p) => p.tokenId).sort()).toEqual(['101', '102'])
    expect(BigInt(f.positions.find((p) => p.tokenId === '101')!.valueUsdc!)).toBe(valueOf(p1, 101n))
    expect(BigInt(f.positions.find((p) => p.tokenId === '102')!.valueUsdc!)).toBe(valueOf(p2, 102n))
    // idle: USDC, 2000 sats * 1000 = 2.000000 USDC, USDT at 1:1; ETH is not in it
    expect(f.idle).toEqual([
      { token: 'USDC', amount: '3000000', decimals: 6, valueUsdc: '3000000' },
      { token: 'cbBTC', amount: '2000', decimals: 8, valueUsdc: '2000000' },
      { token: 'USDT', amount: '500000', decimals: 6, valueUsdc: '500000' },
    ])
    expect(f.eth).toBe('1000000000000000000')
    expect(f.cbbtc).toBe('2000')
    // one request for every balance, price and position, and one getCode, pinned to the block the call ran at
    expect(node.requests.map((r) => r.method)).toEqual(['eth_call', 'eth_getCode'])
    expect(node.requests[0]!.url).toBe(RPC)
    expect(node.requests[1]!.params[1]).toBe(`0x${(36_000_000).toString(16)}`)
    // the total the app adds up: every idle token at its value, every position at its value, nothing else
    const idleSum = f.idle!.reduce((a, t) => a + BigInt(t.valueUsdc), 0n)
    expect(idleSum + f.positions.reduce((a, p) => a + BigInt(p.valueUsdc!), 0n)).toBe(3_000_000n + 2_000_000n + 500_000n + valueOf(p1, 101n) + valueOf(p2, 102n))
  })

  test('an NFT the Safe holds that is not in the snapshot is ignored, and never even read', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    node.positions = { '101': { ...pos(owner.address) }, '999': { ...pos(owner.address), liquidity: 10n ** 18n } }
    snapshot(h, owner, ['101'])
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
    expect(f.positions.map((p) => p.tokenId)).toEqual(['101'])
    // 999 was not asked for: positions(999) / ownerOf(999) are not among the calls
    const asked = node.requests[0]!.params[0] as { data: string }
    const calls = decodeFunctionData({ abi: multicallAbi, data: asked.data as `0x${string}` }).args[0]
    const npmCalls = calls.filter((c) => c.target.toLowerCase() === NPM.toLowerCase()).map((c) => decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: c.callData }))
    expect(npmCalls.map((c) => String((c.args as readonly bigint[])[0]))).toEqual(['101', '101'])
  })

  test('a listed id whose ownerOf is not the Safe is ignored; so is a burned one', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    node.positions = { '101': pos(owner.address), '102': pos('0x000000000000000000000000000000000000dEaD'), '103': { ...pos(owner.address), owner: 'burned' } }
    snapshot(h, owner, ['101', '102', '103'])
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
    expect(f.positions.map((p) => p.tokenId)).toEqual(['101'])
    expect(f.chainRead?.positions).toBe('listed')
  })

  test('ownerOf is compared without regard to case', async () => {
    const node = chain({ balances: { USDC: 0n } })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    node.positions = { '101': pos(owner.address.toLowerCase()) }
    snapshot(h, owner, ['101'])
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
    expect(f.positions).toHaveLength(1)
  })

  test('no snapshot: idle only, and the view says positions were not read', async () => {
    const node = chain({ balances: { USDC: 4_000_000n } })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    node.positions = { '101': pos(owner.address) }
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
    expect(f.positions).toEqual([])
    expect(f.usdc).toBe('4000000')
    expect(f.chainRead).toEqual({ positions: 'unknown', listedAt: null })
  })

  test('an unreadable snapshot (bad JSON, a bad id, too many ids) is no snapshot', async () => {
    for (const json of ['not json', '{"a":1}', JSON.stringify([{ tokenId: '0x10' }]), JSON.stringify(Array.from({ length: MAX_LISTED_POSITIONS + 1 }, (_, i) => ({ tokenId: String(i + 1) })))]) {
      const node = chain({ balances: { USDC: 1_000_000n } })
      const { h } = setup({ node })
      const { cookie, owner } = await onboard(h)
      node.positions = { '1': pos(owner.address) }
      snapshot(h, owner, [], json)
      const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
      expect(f.positions).toEqual([])
      expect(f.chainRead?.positions).toBe('unknown')
    }
  })

  test('a snapshot with no positions is a complete answer: nothing is placed', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    snapshot(h, owner, [])
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
    expect(f.chainRead).toEqual({ positions: 'listed', listedAt: '2026-10-07T09:20:00.000Z' })
  })

  test('the snapshot of another address is not used', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    node.positions = { '101': pos(owner.address) }
    h.db.raw
      .query(`INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at) VALUES (8453, '0x00000000000000000000000000000000000000aa', 'other', 'unknown', 1, ?, 1, 0, 0, 0, 0, 0, ?, ?)`)
      .run('2026-10-07T09:20:00.000Z', JSON.stringify([{ tokenId: '101' }]), '2026-10-07T09:20:00.000Z')
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
    expect(f.positions).toEqual([])
    expect(f.chainRead?.positions).toBe('unknown')
  })

  test('an owned listed position outside the registry\'s USDC pools cannot be valued: positions are unknown, not skipped', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    node.positions = { '101': { ...pos(owner.address), token1: 'WETH', fee: 100 } }
    snapshot(h, owner, ['101'])
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
    expect(f.positions).toEqual([])
    expect(f.chainRead?.positions).toBe('unknown')
  })

  test('a Safe with no code yet reads deployed false', async () => {
    const node = chain({ balances: { USDC: 1_000_000n }, code: '0x' })
    const { h } = setup({ node })
    const { cookie, owner } = await onboard(h)
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
    expect(f.deployed).toBe(false)
  })
})

describe('funding from the chain: providers, cache and rate', () => {
  test('a provider on another chain id is refused and the next one answers', async () => {
    const wrong = chain({ chainId: 1, balances: { USDC: 99_000_000n } })
    const right = chain({ balances: { USDC: 5_000_000n } })
    const { h } = setup({ node: wrong, node2: right, env: { BASE_RPC_URLS: `${RPC}, ${RPC_B}` } })
    const { cookie, owner } = await onboard(h)
    const f = (await (await funding(h, cookie, owner.accountKey)).json()) as FundingView
    expect(f.usdc).toBe('5000000')
    expect(wrong.requests).toHaveLength(1)
    expect(right.requests.map((r) => r.url)).toEqual([RPC_B, RPC_B])
  })

  test('a provider that fails in the middle (the getCode) is dropped whole; values of two providers are never mixed', async () => {
    const half = chain({ balances: { USDC: 99_000_000n } })
    half.fetch = (async (input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      return body.method === 'eth_getCode' ? new Response('x', { status: 500 }) : chain({ balances: { USDC: 99_000_000n } }).fetch(input, init)
    }) as never
    const right = chain({ balances: { USDC: 5_000_000n } })
    const { h } = setup({ node: half, node2: right, env: { BASE_RPC_URLS: `${RPC} ${RPC_B}` } })
    const { cookie, owner } = await onboard(h)
    expect(((await (await funding(h, cookie, owner.accountKey)).json()) as FundingView).usdc).toBe('5000000')
  })

  test('the pool is capped at three https providers', async () => {
    const node = chain({ http: 500 })
    const { h } = setup({ node, env: { BASE_RPC_URLS: 'https://a.example/1,https://b.example/2,https://c.example/3,https://d.example/4,http://plain.example/5' } })
    const { cookie, owner } = await onboard(h)
    expect((await funding(h, cookie, owner.accountKey)).status).toBe(503)
    expect(node.requests.map((r) => r.url)).toEqual(['https://a.example/1', 'https://b.example/2', 'https://c.example/3'])
  })

  test('a down operator does not turn into an RPC storm: one read per 30 s, then a fresh one', async () => {
    let now = T0.getTime()
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h, op } = setup({ node, now: () => new Date(now) })
    const { cookie, owner } = await onboard(h)
    for (let i = 0; i < 5; i++) expect((await funding(h, cookie, owner.accountKey)).status).toBe(200)
    expect(node.requests.filter((r) => r.method === 'eth_call')).toHaveLength(1)
    expect(op.seen).toHaveLength(5) // the operator is still tried first each time
    now += FUNDING_CACHE_MS + 1
    node.balances.USDC = 2_000_000n
    expect(((await (await funding(h, cookie, owner.accountKey)).json()) as FundingView).usdc).toBe('2000000')
    expect(node.requests.filter((r) => r.method === 'eth_call')).toHaveLength(2)
  })

  test('a failed read is not repeated for a few seconds', async () => {
    let now = T0.getTime()
    const node = chain({ http: 500 })
    const { h } = setup({ node, now: () => new Date(now) })
    const { cookie, owner } = await onboard(h)
    for (let i = 0; i < 4; i++) expect((await funding(h, cookie, owner.accountKey)).status).toBe(503)
    expect(node.requests).toHaveLength(1)
    now += FUNDING_FAIL_MS + 1
    await funding(h, cookie, owner.accountKey)
    expect(node.requests).toHaveLength(2)
  })

  test('the rate limiter says no: nothing is read', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h } = setup({ node, env: { FUNDING_CHAIN_LIMIT: { limit: async () => ({ success: false }) } as never } })
    const { cookie, owner } = await onboard(h)
    expect((await funding(h, cookie, owner.accountKey)).status).toBe(503)
    expect(node.requests).toHaveLength(0)
  })

  test('the cache is per account: another account is read on its own', async () => {
    const node = chain({ balances: { USDC: 1_000_000n } })
    const { h } = setup({ node })
    const a = await onboard(h)
    const res = await register(h, PASSKEY_B)
    const b = { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
    await funding(h, a.cookie, a.owner.accountKey)
    await funding(h, b.cookie, b.owner.accountKey)
    expect(node.requests.filter((r) => r.method === 'eth_call')).toHaveLength(2)
    // and a full table does not evict a read under way
    const gate = new FundingGate(1)
    expect(gate.admit('a', 0).kind).toBe('read')
    expect(gate.admit('b', 1).kind).toBe('full')
    expect(gate.admit('a', 1).kind).toBe('busy')
  })
})
