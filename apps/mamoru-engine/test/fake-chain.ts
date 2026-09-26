// Mocked Base for tests: a viem custom transport over in-memory blocks, code, balances, pool state and logs.
import { baseRegistry, type Registry } from '@mamoru/registry'
import {
  custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, numberToHex, toHex,
  type Address, type Hex, type PublicClient,
} from 'viem'
import { balanceOfAbi, poolEventsAbi, poolReadAbi } from '../src/sync/abis.ts'
import { makeClient } from '../src/sync/client.ts'

const readAbi = [...poolReadAbi, ...balanceOfAbi]
const FAKE_CODE: Hex = '0x6080604052'

export type FakeLog = { address: Address; blockNumber: number; logIndex: number; txHash: Hex; topics: Hex[]; data: Hex }

export type PoolFake = { sqrtPriceX96: bigint; tick: number; liquidity: bigint; tickCumulatives?: [bigint, bigint] }

export class FakeChain {
  chainId = 8453
  latest = 1_000_100
  safe = 1_000_080
  down = false
  code = new Map<string, Hex>()
  pools = new Map<string, PoolFake>()
  balances = new Map<string, bigint>() // `${token}:${owner}`, token 'ETH' for native
  logs: FakeLog[] = []
  calls: string[] = []

  hashOf(n: number): Hex {
    return keccak256(toHex(`block-${n}`))
  }

  timeOf(n: number): number {
    return 1_790_000_000 + n * 2
  }

  /** Registry whose pinned code hashes match this chain's code. */
  registry(): Registry {
    const h = keccak256(FAKE_CODE)
    for (const e of baseRegistry.entries) this.code.set(e.address.toLowerCase(), FAKE_CODE)
    return { ...baseRegistry, entries: baseRegistry.entries.map((e) => ({ ...e, codeHash: h })) }
  }

  setBalance(token: Address | 'ETH', owner: Address, amount: bigint): void {
    this.balances.set(`${token.toLowerCase()}:${owner.toLowerCase()}`, amount)
  }

  addSwap(pool: Address, blockNumber: number, logIndex: number, a: { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number }): void {
    const sender = '0x1111111111111111111111111111111111111111'
    const topics = encodeEventTopics({ abi: poolEventsAbi, eventName: 'Swap', args: { sender, recipient: sender } }) as Hex[]
    const data = encodeAbiParameters(
      [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
      [a.amount0, a.amount1, a.sqrtPriceX96, a.liquidity, a.tick],
    )
    this.logs.push({ address: pool, blockNumber, logIndex, txHash: keccak256(toHex(`tx-${blockNumber}-${logIndex}`)), topics, data })
  }

  addLiquidity(pool: Address, kind: 'Mint' | 'Burn', blockNumber: number, logIndex: number, a: { tickLower: number; tickUpper: number; amount: bigint; amount0: bigint; amount1: bigint }): void {
    const owner = '0x2222222222222222222222222222222222222222'
    const topics = encodeEventTopics({ abi: poolEventsAbi, eventName: kind, args: { owner, tickLower: a.tickLower, tickUpper: a.tickUpper } }) as Hex[]
    const data =
      kind === 'Mint'
        ? encodeAbiParameters([{ type: 'address' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [owner, a.amount, a.amount0, a.amount1])
        : encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [a.amount, a.amount0, a.amount1])
    this.logs.push({ address: pool, blockNumber, logIndex, txHash: keccak256(toHex(`tx-${blockNumber}-${logIndex}`)), topics, data })
  }

  private block(n: number) {
    return {
      number: numberToHex(n), hash: this.hashOf(n), parentHash: this.hashOf(n - 1), timestamp: numberToHex(this.timeOf(n)),
      transactions: [], uncles: [], logsBloom: null, gasLimit: '0x0', gasUsed: '0x0', baseFeePerGas: '0x0', difficulty: '0x0', size: '0x0',
    }
  }

  private blockParam(p: unknown): number {
    if (p === 'latest') return this.latest
    if (p === 'safe') return this.safe
    return Number(p as string)
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    this.calls.push(method)
    if (this.down) throw new Error('connection refused')
    const ps = (params ?? []) as unknown[]
    switch (method) {
      case 'eth_chainId':
        return numberToHex(this.chainId)
      case 'eth_blockNumber':
        return numberToHex(this.latest)
      case 'eth_getBlockByNumber':
        return this.block(this.blockParam(ps[0]))
      case 'eth_getCode':
        return this.code.get((ps[0] as string).toLowerCase()) ?? '0x'
      case 'eth_getBalance':
        return numberToHex(this.balances.get(`eth:${(ps[0] as string).toLowerCase()}`) ?? 0n)
      case 'eth_call': {
        const { to, data } = ps[0] as { to: Address; data: Hex }
        const call = decodeFunctionData({ abi: readAbi, data })
        const pool = this.pools.get(to.toLowerCase())
        if (call.functionName === 'balanceOf') {
          const owner = (call.args[0] as string).toLowerCase()
          return encodeFunctionResult({ abi: readAbi, functionName: 'balanceOf', result: this.balances.get(`${to.toLowerCase()}:${owner}`) ?? 0n })
        }
        if (!pool) throw new Error('execution reverted')
        if (call.functionName === 'slot0') {
          return encodeFunctionResult({ abi: readAbi, functionName: 'slot0', result: [pool.sqrtPriceX96, pool.tick, 0, 1, 1, 0, true] })
        }
        if (call.functionName === 'liquidity') return encodeFunctionResult({ abi: readAbi, functionName: 'liquidity', result: pool.liquidity })
        if (!pool.tickCumulatives) throw new Error('execution reverted: OLD')
        return encodeFunctionResult({ abi: readAbi, functionName: 'observe', result: [pool.tickCumulatives, [0n, 0n]] })
      }
      case 'eth_getLogs': {
        const f = ps[0] as { address: Address; fromBlock: Hex; toBlock: Hex }
        const from = Number(f.fromBlock)
        const to = Number(f.toBlock)
        return this.logs
          .filter((l) => l.address.toLowerCase() === f.address.toLowerCase() && l.blockNumber >= from && l.blockNumber <= to)
          .map((l) => ({
            address: l.address, blockNumber: numberToHex(l.blockNumber), blockHash: this.hashOf(l.blockNumber), logIndex: numberToHex(l.logIndex),
            transactionHash: l.txHash, transactionIndex: '0x0', topics: l.topics, data: l.data, removed: false,
          }))
      }
      default:
        throw new Error(`fake chain: ${method} not supported`)
    }
  }

  client(): PublicClient {
    return makeClient(custom({ request: (a) => this.request(a) }))
  }
}
