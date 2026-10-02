import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  numberToHex,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem'
import type { Address } from '@mamoru/domain'
import { positionEventsAbi } from '@mamoru/projector'
import { address, baseRegistry, entry, entryPointV07Abi, erc20Abi, nonfungiblePositionManagerAbi, smartSessionAbi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { multicall3Abi } from '../src/multicall.ts'

const enumerableAbi = parseAbi(['function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)'])
const observeAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

export const POOLS = baseRegistry.entries.filter((e) => e.kind === 'pool').map((e) => e.name)
export const TOKENS = baseRegistry.entries.filter((e) => e.kind === 'token').map((e) => e.name)

export type FakePosition = { tokenId: bigint; owner: Address; token0: Address; token1: Address; fee: number; tickLower: number; tickUpper: number; liquidity: bigint; collectable: [bigint, bigint] }
export type FakeLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; logIndex: number }
export type Recorded = { method: string; params: any }

/** What a node answers for a call that reverted. */
export class Revert extends Error {
  code = 3
  data: Hex = '0x'
  constructor(why: string) {
    super(`execution reverted: ${why}`)
  }
}

const sel = (sig: string) => toFunctionSelector(sig)

/** An in-memory chain behind a viem client: the registry contracts the observation reads, Multicall3 included, and every request recorded. */
export class FakeChain {
  chainId = 8453
  head = 1000n
  safe = 900n
  /** Blocks whose hash differs from the default (a reorg). */
  readonly forked = new Set<bigint>()
  readonly code = new Map<string, Hex>()
  readonly native = new Map<string, bigint>()
  readonly erc20 = new Map<string, bigint>()
  readonly nonces = new Map<string, bigint>()
  readonly positions: FakePosition[] = []
  readonly logs: FakeLog[] = []
  /** SmartSession permissions removed on chain. */
  readonly disabled = new Set<string>()
  /** `${contract}:${selector}` reads that revert, lowercase. */
  readonly reverting = new Set<string>()
  readonly requests: Recorded[] = []
  /** Called before each request is answered. */
  onRequest: (r: Recorded) => void = () => {}
  readonly client: PublicClient

  constructor() {
    this.client = createPublicClient({ transport: custom({ request: (r: Recorded) => this.request(r) }, { retryCount: 0 }) })
  }

  hashOf(n: bigint): Hex {
    return `0x${(this.forked.has(n) ? 'f' : 'a').repeat(8)}${n.toString(16).padStart(56, '0')}`
  }

  failRead(contract: Address, signature: string): void {
    this.reverting.add(`${contract.toLowerCase()}:${sel(signature)}`)
  }

  setBalance(token: string, holder: Address, amount: bigint): void {
    this.erc20.set(`${address(token).toLowerCase()}:${holder.toLowerCase()}`, amount)
  }

  addPosition(owner: Address, tokenId: bigint, pool: string, collectable: [bigint, bigint] = [0n, 0n]): void {
    const e = entry(pool)
    this.positions.push({ tokenId, owner, token0: address(e.token0!), token1: address(e.token1!), fee: e.fee!, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n + tokenId, collectable })
  }

  addPositionEvent(eventName: 'Collect' | 'DecreaseLiquidity', tokenId: bigint, blockNumber: bigint, logIndex: number, amounts: [bigint, bigint] = [1n, 2n]): void {
    const topics = encodeEventTopics({ abi: positionEventsAbi, eventName, args: { tokenId } }) as Hex[]
    const data =
      eventName === 'Collect'
        ? encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [zeroAddress, ...amounts])
        : encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [5n, ...amounts])
    this.logs.push({ address: address('NonfungiblePositionManager'), topics, data, blockNumber, logIndex })
  }

  addDeposit(token: string, from: Address, to: Address, value: bigint, blockNumber: bigint, logIndex: number): void {
    const topics = encodeEventTopics({ abi: transferAbi, eventName: 'Transfer', args: { from, to } }) as Hex[]
    this.logs.push({ address: address(token), topics, data: encodeAbiParameters([{ type: 'uint256' }], [value]), blockNumber, logIndex })
  }

  count(method?: string): number {
    return method ? this.requests.filter((r) => r.method === method).length : this.requests.length
  }

  byMethod(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.requests) out[r.method] = (out[r.method] ?? 0) + 1
    return out
  }

  private block(tag: string) {
    const n = tag === 'latest' ? this.head : tag === 'safe' ? this.safe : BigInt(tag)
    if (n > this.head) return null
    return {
      number: numberToHex(n),
      hash: this.hashOf(n),
      parentHash: this.hashOf(n - 1n),
      timestamp: numberToHex(1_790_000_000n + n * 2n),
      baseFeePerGas: '0x64',
      nonce: '0x0000000000000000',
      difficulty: '0x0',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      miner: zeroAddress,
      extraData: '0x',
      logsBloom: `0x${'00'.repeat(256)}`,
      mixHash: this.hashOf(0n),
      receiptsRoot: this.hashOf(0n),
      sha3Uncles: this.hashOf(0n),
      stateRoot: this.hashOf(0n),
      transactionsRoot: this.hashOf(0n),
      size: '0x1',
      totalDifficulty: '0x0',
      transactions: [],
      uncles: [],
    }
  }

  /** A loopback JSON-RPC endpoint over this chain, for code that builds its own client from a URL. */
  serve(): { url: string; stop: () => void } {
    const answer = async (m: { id: unknown; method: string; params: any }) => {
      try {
        return { jsonrpc: '2.0', id: m.id, result: await this.request({ method: m.method, params: m.params }) }
      } catch (e) {
        return { jsonrpc: '2.0', id: m.id, error: { code: (e as { code?: number }).code ?? -32603, message: (e as Error).message, data: (e as { data?: Hex }).data } }
      }
    }
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as any
        return Response.json(Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body))
      },
    })
    return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
  }

  private async request(r: Recorded): Promise<unknown> {
    this.requests.push(r)
    this.onRequest(r)
    const { method, params } = r
    if (method === 'eth_chainId') return numberToHex(this.chainId)
    if (method === 'eth_blockNumber') return numberToHex(this.head)
    if (method === 'eth_getBlockByNumber') return this.block(params[0])
    if (method === 'eth_getCode') return this.code.get(params[0].toLowerCase()) ?? '0x'
    if (method === 'eth_getBalance') return numberToHex(this.native.get(params[0].toLowerCase()) ?? 0n)
    if (method === 'eth_call') return this.execute((params[0].from ?? zeroAddress) as Address, params[0].to, params[0].data ?? params[0].input)
    if (method === 'eth_getLogs') return this.getLogs(params[0])
    throw Object.assign(new Error(`the method ${method} does not exist`), { code: -32601 })
  }

  private getLogs(filter: { address?: Address; topics?: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }) {
    const [from, to] = [BigInt(filter.fromBlock), BigInt(filter.toBlock)]
    const matches = (l: FakeLog) =>
      (!filter.address || l.address.toLowerCase() === filter.address.toLowerCase()) &&
      l.blockNumber >= from &&
      l.blockNumber <= to &&
      (filter.topics ?? []).every((want, i) => want === null || (Array.isArray(want) ? want : [want]).some((t) => t.toLowerCase() === l.topics[i]?.toLowerCase()))
    return this.logs
      .filter(matches)
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
      .map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: numberToHex(l.blockNumber),
        blockHash: this.hashOf(l.blockNumber),
        logIndex: numberToHex(l.logIndex),
        transactionHash: `0x${l.blockNumber.toString(16).padStart(62, '0')}${l.logIndex.toString(16).padStart(2, '0')}`,
        transactionIndex: '0x0',
        removed: false,
      }))
  }

  /** One message call. Throws Revert like a node answering `execution reverted`. */
  private execute(from: Address, to: Address, data: Hex): Hex {
    const at = to.toLowerCase()
    if (this.reverting.has(`${at}:${data.slice(0, 10)}`)) throw new Revert('forced')
    if (at === address('Multicall3').toLowerCase()) {
      const call = decodeFunctionData({ abi: multicall3Abi, data })
      if (call.functionName === 'getEthBalance') return encodeFunctionResult({ abi: multicall3Abi, functionName: 'getEthBalance', result: this.native.get(call.args[0].toLowerCase()) ?? 0n })
      const results = call.args[0].map((c) => {
        try {
          return { success: true, returnData: this.execute(to, c.target, c.callData) }
        } catch (e) {
          if (!c.allowFailure || !(e instanceof Revert)) throw e
          return { success: false, returnData: '0x' as Hex }
        }
      })
      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
    }
    if (at === address('EntryPointV07').toLowerCase()) {
      const call = decodeFunctionData({ abi: entryPointV07Abi, data })
      if (call.functionName !== 'getNonce') throw new Revert('unknown EntryPoint call')
      return encodeFunctionResult({ abi: entryPointV07Abi, functionName: 'getNonce', result: this.nonces.get(call.args[0].toLowerCase()) ?? 0n })
    }
    if (at === address('SmartSession').toLowerCase()) {
      const call = decodeFunctionData({ abi: smartSessionAbi, data })
      if (call.functionName !== 'isPermissionEnabled') throw new Revert('unknown SmartSession call')
      return encodeFunctionResult({ abi: smartSessionAbi, functionName: 'isPermissionEnabled', result: !this.disabled.has((call.args[0] as Hex).toLowerCase()) })
    }
    if (at === address('NonfungiblePositionManager').toLowerCase()) return this.npm(from, to, data)
    if (at === address('UniswapV3Factory').toLowerCase()) {
      const call = decodeFunctionData({ abi: uniswapV3FactoryAbi, data })
      const [a, b, fee] = call.args
      const pool = POOLS.map((p) => entry(p)).find((e) => e.fee === fee && [address(e.token0!), address(e.token1!)].every((t) => [a.toLowerCase(), b.toLowerCase()].includes(t.toLowerCase())))
      return encodeFunctionResult({ abi: uniswapV3FactoryAbi, functionName: 'getPool', result: pool?.address ?? zeroAddress })
    }
    const pool = POOLS.map((p) => entry(p)).find((e) => e.address.toLowerCase() === at)
    if (pool) {
      const i = BigInt(POOLS.indexOf(pool.name) + 1)
      if (data.startsWith(sel('observe(uint32[])'))) return encodeFunctionResult({ abi: observeAbi, functionName: 'observe', result: [[-7n * i * 1000n, -7n * i * 1000n - 1805n * i], [0n, 0n]] })
      const call = decodeFunctionData({ abi: uniswapV3PoolAbi, data })
      if (call.functionName === 'slot0') return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'slot0', result: [(1n << 96n) * i, Number(i) * 10, 0, 1, 1, 0, true] })
      if (call.functionName === 'liquidity') return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'liquidity', result: 10n ** 18n * i })
      if (call.functionName === 'token0') return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'token0', result: address(pool.token0!) })
      if (call.functionName === 'token1') return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'token1', result: address(pool.token1!) })
      if (call.functionName === 'fee') return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'fee', result: pool.fee! })
      return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'tickSpacing', result: pool.tickSpacing! })
    }
    if (TOKENS.some((t) => address(t).toLowerCase() === at)) {
      const call = decodeFunctionData({ abi: erc20Abi, data })
      if (call.functionName !== 'balanceOf') throw new Revert('unknown token call')
      return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: this.erc20.get(`${at}:${call.args[0].toLowerCase()}`) ?? 0n })
    }
    // No contract here: a call succeeds with no data, as on a real chain.
    return '0x'
  }

  private npm(from: Address, to: Address, data: Hex): Hex {
    if (data.startsWith(sel('tokenOfOwnerByIndex(address,uint256)'))) {
      const { args } = decodeFunctionData({ abi: enumerableAbi, data })
      const owned = this.positions.filter((p) => p.owner.toLowerCase() === args[0].toLowerCase())
      const hit = owned[Number(args[1])]
      if (!hit) throw new Revert('ERC721Enumerable: owner index out of bounds')
      return encodeFunctionResult({ abi: enumerableAbi, functionName: 'tokenOfOwnerByIndex', result: hit.tokenId })
    }
    const call = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data })
    if (call.functionName === 'balanceOf') {
      return encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', result: BigInt(this.positions.filter((p) => p.owner.toLowerCase() === call.args[0].toLowerCase()).length) })
    }
    if (call.functionName === 'multicall') {
      // delegatecall to itself: msg.sender is kept, and one failure reverts the whole call.
      const results = (call.args[0] as readonly Hex[]).map((d) => this.execute(from, to, d))
      return encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'multicall', result: results })
    }
    if (call.functionName === 'positions') {
      const p = this.positions.find((x) => x.tokenId === call.args[0])
      if (!p) throw new Revert('Invalid token ID')
      return encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'positions', result: [0n, zeroAddress, p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, p.liquidity, 0n, 0n, 0n, 0n] })
    }
    if (call.functionName === 'collect') {
      const p = this.positions.find((x) => x.tokenId === call.args[0].tokenId)
      if (!p) throw new Revert('Invalid token ID')
      if (p.owner.toLowerCase() !== from.toLowerCase()) throw new Revert('Not approved')
      return encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', result: p.collectable })
    }
    throw new Revert('unknown NonfungiblePositionManager call')
  }
}
