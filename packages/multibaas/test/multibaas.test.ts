import { describe, expect, test } from 'bun:test'
import { LINKED, MultiBaasClient, MultiBaasError, mbq01Swaps, mbq02Liquidity, mbq03PositionEvents, mbq07SwapAggregates, mbq08AccountSwaps, poolActivity } from '../src/index.ts'

const POOL = '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef'
const KEY = 'test-key-not-real'

type Call = { url: string; init: RequestInit }

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const r = handler(url, init ?? {})
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as typeof fetch
  return { fetch: f, calls }
}

describe('MBQ builders', () => {
  test('MBQ-01 matches the plan §23.4 body', () => {
    expect(mbq01Swaps(POOL, 100, 200)).toEqual({
      events: [
        {
          eventName: 'Swap(address,address,int256,int256,uint160,uint128,int24)',
          select: [
            { type: 'block_number', alias: 'block' },
            { type: 'block_hash', alias: 'blockHash' },
            { type: 'tx_hash', alias: 'txHash' },
            { type: 'triggered_at', alias: 'at' },
            { type: 'input', inputIndex: 0, alias: 'sender' },
            { type: 'input', inputIndex: 1, alias: 'recipient' },
            { type: 'input', inputIndex: 2, alias: 'amount0' },
            { type: 'input', inputIndex: 3, alias: 'amount1' },
            { type: 'input', inputIndex: 4, alias: 'sqrtPriceX96' },
            { type: 'input', inputIndex: 5, alias: 'liquidity' },
            { type: 'input', inputIndex: 6, alias: 'tick' },
          ],
          filter: {
            rule: 'and',
            children: [
              { fieldType: 'contract_address', operator: 'equal', value: POOL.toLowerCase() },
              { fieldType: 'block_number', operator: 'greaterthanorequal', value: '100' },
              { fieldType: 'block_number', operator: 'lessthanorequal', value: '200' },
            ],
          },
        },
      ],
      orderBy: 'block',
      order: 'ASC',
    })
  })

  test('MBQ-02 selects Mint and Burn by input index with the event kind', () => {
    const [mint, burn] = mbq02Liquidity(POOL, 1, 2).events
    expect(mint!.eventName).toBe('Mint(address,address,int24,int24,uint128,uint256,uint256)')
    expect(burn!.eventName).toBe('Burn(address,int24,int24,uint128,uint256,uint256)')
    expect(burn!.select.map((s) => s.alias)).toEqual(['kind', 'block', 'blockHash', 'txHash', 'at', 'owner', 'tickLower', 'tickUpper', 'amount', 'amount0', 'amount1'])
    expect(mint!.select.find((s) => s.alias === 'amount0')).toEqual({ type: 'input', inputIndex: 5, alias: 'amount0' })
    expect(burn!.select.find((s) => s.alias === 'amount0')).toEqual({ type: 'input', inputIndex: 4, alias: 'amount0' })
  })

  test('pool activity joins Swap, Mint and Burn in one ordered body', () => {
    const q = poolActivity(POOL, 1, 2)
    expect(q.events.map((e) => e.eventName.split('(')[0])).toEqual(['Swap', 'Mint', 'Burn'])
    expect(q.events[0]!.select[0]).toEqual({ type: 'event_signature', alias: 'kind' })
    expect(q).toMatchObject({ orderBy: 'block', order: 'ASC' })
  })

  test('MBQ-03 joins tokenIds with or, one event spec per position event', () => {
    const q = mbq03PositionEvents('0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', [1n, 2n], 10, 20)
    expect(q.events.map((e) => e.eventName.split('(')[0])).toEqual(['IncreaseLiquidity', 'DecreaseLiquidity', 'Collect'])
    expect(q.events[0]!.filter.children[1]).toEqual({
      rule: 'or',
      children: [
        { fieldType: 'input', inputIndex: 0, operator: 'equal', value: '1' },
        { fieldType: 'input', inputIndex: 0, operator: 'equal', value: '2' },
      ],
    })
  })

  test('MBQ-07 aggregates and MBQ-08 recipient filter', () => {
    const [ticks, v0, v1] = mbq07SwapAggregates(POOL, 1, 2)
    expect(ticks!.groupBy).toBe('pool')
    expect(ticks!.events[0]!.select.slice(1)).toEqual([
      { type: 'input', inputIndex: 6, alias: 'tickMin', aggregator: 'min' },
      { type: 'input', inputIndex: 6, alias: 'tickMax', aggregator: 'max' },
    ])
    expect(v0!.events[0]!.filter.children).toContainEqual({ fieldType: 'input', inputIndex: 2, operator: 'greaterthan', value: '0' })
    expect(v1!.events[0]!.filter.children).toContainEqual({ fieldType: 'input', inputIndex: 3, operator: 'greaterthan', value: '0' })
    const acct = '0x00000000000000000000000000000000000000Aa'
    expect(mbq08AccountSwaps(POOL, acct, 1, 2).events[0]!.filter.children).toContainEqual({ fieldType: 'input', inputIndex: 1, operator: 'equal', value: acct.toLowerCase() })
  })

  test('ranges must be closed and ordered', () => {
    expect(() => mbq01Swaps(POOL, 5, 4)).toThrow(RangeError)
    expect(() => mbq03PositionEvents(POOL, [], 1, 2)).toThrow(RangeError)
  })

  test('the curated pool is linked with its alias and label', () => {
    expect(LINKED['pool:USDC/cbBTC/500']).toEqual({ alias: 'mamoru-pool-usdc-cbbtc-500', label: 'uniswap-v3-pool' })
  })
})

describe('MultiBaasClient', () => {
  test('reads status with the bearer key under /api/v0', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { status: 200, message: 'ok', result: { chainID: 8453, blockNumber: 42 } } }))
    const mb = new MultiBaasClient({ url: 'https://x.multibaas.com/', apiKey: KEY, fetch })
    expect(await mb.chainStatus()).toEqual({ chainID: 8453, blockNumber: 42 })
    expect(calls[0]!.url).toBe('https://x.multibaas.com/api/v0/chains/ethereum/status')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    await mb.contractStatus('mamoru-pool-usdc-cbbtc-500', 'uniswap-v3-pool')
    expect(calls[1]!.url).toEndWith('/chains/ethereum/addresses/mamoru-pool-usdc-cbbtc-500/contracts/uniswap-v3-pool/status')
  })

  test('pages a query until a short page', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'))
      const n = offset < 4 ? 2 : 1
      return { body: { status: 200, message: 'ok', result: { rows: Array.from({ length: n }, (_, i) => ({ block: offset + i })) } } }
    })
    const mb = new MultiBaasClient({ url: 'https://x', apiKey: KEY, fetch, pageLimit: 2 })
    const rows = await mb.query(mbq01Swaps(POOL, 1, 2))
    expect(rows.map((r) => r.block)).toEqual([0, 1, 2, 3, 4])
    expect(calls.map((c) => new URL(c.url).search)).toEqual(['?limit=2&offset=0', '?limit=2&offset=2', '?limit=2&offset=4'])
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(mbq01Swaps(POOL, 1, 2))
  })

  test('an HTTP error or a non-200 envelope is MB_QUERY_FAILED without the key', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: { status: 404, message: 'contract not found', result: null } }))
    const mb = new MultiBaasClient({ url: 'https://x', apiKey: KEY, fetch })
    const err = await mb.contractStatus('a', 'b').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MultiBaasError)
    expect((err as MultiBaasError).code).toBe('MB_QUERY_FAILED')
    expect((err as MultiBaasError).httpStatus).toBe(404)
    expect(String((err as Error).message)).not.toContain(KEY)
    const bad = fakeFetch(() => ({ body: { status: 500, message: 'boom', result: null } }))
    await expect(new MultiBaasClient({ url: 'https://x', apiKey: KEY, fetch: bad.fetch }).chainStatus()).rejects.toBeInstanceOf(MultiBaasError)
  })

  test('too many pages is a failed query, not a silent cut', async () => {
    const { fetch } = fakeFetch(() => ({ body: { status: 200, message: 'ok', result: { rows: [{}, {}] } } }))
    const mb = new MultiBaasClient({ url: 'https://x', apiKey: KEY, fetch, pageLimit: 2, maxPages: 3 })
    await expect(mb.query(mbq01Swaps(POOL, 1, 2))).rejects.toBeInstanceOf(MultiBaasError)
  })

  test('transaction events by hash', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { status: 200, message: 'ok', result: [] } }))
    await new MultiBaasClient({ url: 'https://x', apiKey: KEY, fetch, pageLimit: 50 }).txEvents('0xabc')
    expect(new URL(calls[0]!.url).pathname + new URL(calls[0]!.url).search).toBe('/api/v0/events?tx_hash=0xabc&limit=50')
  })
})
