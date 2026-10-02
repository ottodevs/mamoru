import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  formatLog,
  http,
  numberToHex,
  parseEventLogs,
  maxUint128,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  isAddressEqual,
  toEventSelector,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import type { DepositObs, Observation, PoolObs, PositionObs, SessionObs } from '@mamoru/decide'
import { Batch, balanceRead, chunkCalls, contractRead, multicall3Of } from './multicall.ts'
import { applyPrincipal, positionEventsAbi, type Pair, type PositionEvent } from '@mamoru/projector'
import {
  address,
  baseRegistry,
  entry,
  entryPointV07Abi,
  erc20Abi,
  nameOf,
  nonfungiblePositionManagerAbi,
  uniswapV3FactoryAbi,
  uniswapV3PoolAbi,
  type RegistryName,
} from '@mamoru/registry'

const enumerableAbi = parseAbi(['function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)'])
const observeAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
)

export { BATCH_MAX_BYTES, BATCH_MAX_CALLS, Batch, balanceRead, chunkCalls, contractRead, multicall3Abi, multicall3Of, type Handle, type Read } from './multicall.ts'

/** RpcPort client. Reads are batched into grouped JSON-RPC calls. */
export function rpcClient(url: string): PublicClient {
  return createPublicClient({ transport: http(url, { batch: true, timeout: 60_000 }) })
}

export type ObserveInput = {
  chainId: number
  account: Address
  nonceKey: bigint
  /** Deposits are the savings-asset transfers to the account after this block. */
  depositsAfter: bigint
  sessions: SessionObs[]
  allowedTokenIds: readonly bigint[]
  /**
   * First block of the managed positions' history. The principal owed is
   * folded from every canonical DecreaseLiquidity and Collect of those
   * tokenIds from here to the observation block, whoever sent them.
   */
  historyFromBlock: bigint
  /** When set, history already read is kept here and only new blocks are scanned. */
  historyCursor?: HistoryCursor
  intents: Observation['intents']
  slot: Observation['slot']
  twapWindowSeconds: number
  opGasUnits: bigint
  maxPriorityFeePerGas: bigint
  savingsAsset: RegistryName
  ethPricePool: RegistryName
  /** Multicall3 to batch through; null reads one by one. Default: the registry's. */
  multicall3?: Address | null
  /** Shared by the accounts of one operator: the pool state of a block is read once. */
  poolCache?: PoolStateCache
}

const TOKENS = baseRegistry.entries.filter((e) => e.kind === 'token').map((e) => e.name)
const POOLS = baseRegistry.entries.filter((e) => e.kind === 'pool').map((e) => e.name)
/** Multicall3 of the registry in use, or null: reads are then made one by one. */
export const MULTICALL3 = multicall3Of(baseRegistry)
/** Position ids asked for in the first round, before the position count is known; the ones past the count fail and are ignored. */
const SPECULATIVE_TOKEN_IDS = 8

/** Pool state of one block, shared by every account observed at that block. */
export type PoolStateCache = {
  get(key: string): Promise<PoolObs[]> | undefined
  set(key: string, pools: Promise<PoolObs[]>): void
  delete(key: string): void
}

/** Keeps the last `max` keys (chain, block number, block hash, TWAP window). */
export function poolStateCache(max = 8): PoolStateCache & { readonly size: number } {
  const entries = new Map<string, Promise<PoolObs[]>>()
  return {
    get: (key) => entries.get(key),
    set(key, pools) {
      entries.delete(key)
      entries.set(key, pools)
      while (entries.size > max) entries.delete(entries.keys().next().value!)
    },
    delete: (key) => void entries.delete(key),
    get size() {
      return entries.size
    },
  }
}

/**
 * FR-RPC-001: every read of one observation is pinned to the same block
 * number, and the block hash is checked again at the end. The contract reads
 * go through Multicall3 in a fixed number of requests.
 */
export async function observe(client: PublicClient, input: ObserveInput): Promise<Observation> {
  const chainId = await client.getChainId().catch((e: Error) => {
    throw new ReasonError('OBS_RPC_UNAVAILABLE', e.message.split('\n')[0])
  })
  if (chainId !== input.chainId) throw new ReasonError('OBS_CHAIN_MISMATCH', `rpc answered ${chainId}, engine is ${input.chainId}`)
  const [block, safe] = await Promise.all([client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockTag: 'safe' })])
  const blockNumber = block.number
  const acct = input.account
  const npm = address('NonfungiblePositionManager')
  const multicall3 = input.multicall3 === undefined ? MULTICALL3 : input.multicall3

  // Round 1: the account's balances, nonce and position ids, and the pool state unless another account read it at this block.
  const first = new Batch(client, multicall3, blockNumber)
  const native = first.add(balanceRead(client, multicall3, acct, blockNumber))
  const nonce = first.add(contractRead(client, { address: address('EntryPointV07'), abi: entryPointV07Abi, functionName: 'getNonce', args: [acct, input.nonceKey], blockNumber }))
  const nftCount = first.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [acct], blockNumber }))
  const balances = TOKENS.map((t) => first.add(contractRead(client, { address: address(t), abi: erc20Abi, functionName: 'balanceOf', args: [acct], blockNumber })))
  const idsOf = tokenIdReads(client, multicall3, first, acct, blockNumber)
  const poolKey = `${chainId}:${blockNumber}:${block.hash}:${input.twapWindowSeconds}`
  const shared = input.poolCache?.get(poolKey)
  const own = shared ? null : POOLS.map((p) => poolReads(first, client, p, blockNumber, input.twapWindowSeconds))
  const priceSlot0 = POOLS.includes(input.ethPricePool) ? null : first.add(contractRead(client, { address: address(input.ethPricePool), abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber }))
  const round = Promise.all([client.getCode({ address: acct, blockNumber }), first.run()])
  const ownPools = own ? round.then(() => Promise.all(own.map((finish) => finish()))) : null
  if (ownPools) {
    // Published before it resolves, so accounts observing this block at the same time wait for it instead of reading again.
    input.poolCache?.set(poolKey, ownPools)
    ownPools.catch(() => input.poolCache?.delete(poolKey))
  }
  const [code] = await round
  // Settled here, inside the block-hash bracket: a read that failed in the batch is asked again on its own.
  const [nativeBalance, accountNonce, tokenBalances] = await Promise.all([native.need(), nonce.need(), Promise.all(balances.map((b) => b.need()))])
  const readAlone = async () => {
    const batch = new Batch(client, multicall3, blockNumber)
    const finish = POOLS.map((p) => poolReads(batch, client, p, blockNumber, input.twapWindowSeconds))
    await batch.run()
    return Promise.all(finish.map((f) => f()))
  }
  // A shared read that failed in the other observation is read again here.
  const pools = (await (shared ? shared.catch(readAlone) : ownPools!)).map((p) => ({ ...p, identity: { ...p.identity } }))

  const tokenIds = await idsOf(Number(await nftCount.need()))

  // Log reads. Each range ends at the safe block (checked inside the cursor) or at the observation block, whose
  // hash is read again below, after them. A log read that fails is a failed observation.
  const logs = <T>(read: Promise<T>) =>
    read.catch((e: Error) => {
      throw e instanceof ReasonError ? e : new ReasonError('OBS_RPC_UNAVAILABLE', `logs: ${e.message.split('\n')[0]}`)
    })
  const cursorRead = input.historyCursor
    ? await logs(readPositionHistoryFrom(client, input.historyCursor, input.allowedTokenIds, input.historyFromBlock, blockNumber, safe.number, safe.hash))
    : null
  const history = cursorRead ? cursorRead.events : await logs(readPositionHistory(client, input.allowedTokenIds, input.historyFromBlock, blockNumber))
  const owed = applyPrincipal(new Map(), history)
  const positions = await readPositions(client, multicall3, acct, tokenIds, blockNumber, input, owed, pools)
  const ethPricePool = pools.find((p) => p.name === input.ethPricePool)
  const ethSqrtPriceX96 = priceSlot0 ? (await priceSlot0.need())[0] : ethPricePool!.sqrtPriceX96
  const deposits = await logs(readDeposits(client, acct, input, blockNumber, safe.number))

  const again = await client.getBlock({ blockNumber })
  if (again.hash !== block.hash) {
    // The pool state this observation published was read around a reorg: no other account may use it.
    if (ownPools) input.poolCache?.delete(poolKey)
    throw new ReasonError('OBS_BLOCK_INCONSISTENT', `block ${blockNumber} changed hash during the observation`)
  }
  // Only a consistent observation moves the history cursor.
  if (cursorRead && input.historyCursor) Object.assign(input.historyCursor, cursorRead.next)

  const baseFee = block.baseFeePerGas ?? 0n
  return {
    chainId,
    block: { number: blockNumber, hash: block.hash, timestamp: block.timestamp },
    safeBlock: { number: safe.number, hash: safe.hash },
    account: { address: acct, deployed: !!code && code !== '0x', nonceKey: input.nonceKey, nonce: accountNonce },
    sessions: input.sessions,
    native: nativeBalance,
    balances: Object.fromEntries(TOKENS.map((t, i) => [t, tokenBalances[i]!])),
    positions,
    pools,
    ethPrice: { pool: input.ethPricePool, sqrtPriceX96: ethSqrtPriceX96, token0: entry(input.ethPricePool).token0! },
    gas: { maxFeePerGas: baseFee * 2n + input.maxPriorityFeePerGas, opGasUnits: input.opGasUnits },
    deposits,
    intents: input.intents,
    slot: input.slot,
  }
}

/**
 * Position ids of `owner`. The first ids are asked for in `first`, before the count is known (the ones past
 * the count fail and are ignored); ids that round did not bring are read in one more request.
 */
export function tokenIdReads(client: PublicClient, multicall3: Address | null, first: Batch, owner: Address, blockNumber: bigint): (count: number) => Promise<bigint[]> {
  const at = (i: number) => contractRead(client, { address: address('NonfungiblePositionManager'), abi: enumerableAbi, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)], blockNumber })
  const ahead = multicall3 === null ? [] : Array.from({ length: SPECULATIVE_TOKEN_IDS }, (_, i) => first.add(at(i)))
  return async (count) => {
    const rest = new Batch(client, multicall3, blockNumber)
    const ids = Array.from({ length: count }, (_, i) => ahead[i]?.maybe() ?? rest.add(at(i)))
    if (rest.size > 0) await rest.run()
    return Promise.all(ids.map((id) => (typeof id === 'bigint' ? id : id.need())))
  }
}

/** The account's positions in two requests at most: `positions` and `collect` of every id in one NonfungiblePositionManager.multicall from the account. */
async function readPositions(
  client: PublicClient,
  multicall3: Address | null,
  acct: Address,
  tokenIds: readonly bigint[],
  blockNumber: bigint,
  input: ObserveInput,
  principal: ReadonlyMap<bigint, Pair>,
  pools: readonly PoolObs[],
): Promise<PositionObs[]> {
  if (tokenIds.length === 0) return []
  const oneByOne = () => Promise.all(tokenIds.map((id) => readPosition(client, acct, id, blockNumber, input, principal)))
  if (multicall3 === null) return oneByOne()
  const npm = address('NonfungiblePositionManager')
  const calls = [
    ...tokenIds.map((tokenId) => ({ data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] }) })),
    ...tokenIds.map((tokenId) => ({
      data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', args: [{ tokenId, recipient: acct, amount0Max: maxUint128, amount1Max: maxUint128 }] }),
    })),
  ]
  let results: readonly Hex[]
  try {
    const chunks = await Promise.all(
      chunkCalls(calls).map(async (chunk) => {
        const raw = await client.call({ account: acct, to: npm, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'multicall', args: [chunk.map((c) => c.data)] }), blockNumber })
        return decodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'multicall', data: raw.data ?? '0x' })
      }),
    )
    results = chunks.flat()
    if (results.length !== calls.length) throw new Error('multicall answered another number of results')
  } catch {
    // The manager's multicall reverts as a whole: each position on its own reports which read failed, as before batching.
    return oneByOne()
  }
  const n = tokenIds.length
  const rows = tokenIds.map((tokenId, i) => ({
    tokenId,
    p: decodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'positions', data: results[i]! }),
    collectable: decodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', data: results[n + i]! }),
  }))
  // A registry pool's factory address was read in round 1 for the same token pair and fee; anything else asks the factory.
  const known = (token0: Address, token1: Address, fee: number): Address | null => {
    const hit = pools.find((pool) => {
      const [a, b] = [address(pool.token0), address(pool.token1)]
      return pool.fee === fee && ((isAddressEqual(a, token0) && isAddressEqual(b, token1)) || (isAddressEqual(a, token1) && isAddressEqual(b, token0)))
    })
    return hit && hit.identity.factoryPool !== zeroAddress ? hit.identity.factoryPool : null
  }
  const asked = new Batch(client, multicall3, blockNumber)
  const poolAddrs = rows.map(({ p }) => known(p[2], p[3], p[4]) ?? asked.add(contractRead(client, { address: address('UniswapV3Factory'), abi: uniswapV3FactoryAbi, functionName: 'getPool', args: [p[2], p[3], p[4]], blockNumber })))
  if (asked.size > 0) await asked.run()
  return Promise.all(
    rows.map(async ({ tokenId, p, collectable }, i) => {
      const at = poolAddrs[i]!
      const name = nameOf(typeof at === 'string' ? at : await at.need())
      const owed = principal.get(tokenId) ?? [0n, 0n]
      return {
        tokenId,
        pool: name && entry(name).kind === 'pool' ? name : null,
        tickLower: p[5],
        tickUpper: p[6],
        liquidity: p[7],
        collectable0: collectable[0],
        collectable1: collectable[1],
        principalOwed0: owed[0],
        principalOwed1: owed[1],
        managed: input.allowedTokenIds.includes(tokenId),
      }
    }),
  )
}

/** One position with unbatched reads: the path without Multicall3, and the one that reports a failing read. */
async function readPosition(client: PublicClient, acct: Address, tokenId: bigint, blockNumber: bigint, input: ObserveInput, principal: ReadonlyMap<bigint, Pair>): Promise<PositionObs> {
  const npm = address('NonfungiblePositionManager')
  const p = await client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId], blockNumber })
  const poolAddr = await client.readContract({ address: address('UniswapV3Factory'), abi: uniswapV3FactoryAbi, functionName: 'getPool', args: [p[2], p[3], p[4]], blockNumber })
  const name = nameOf(poolAddr)
  const pool = name && entry(name).kind === 'pool' ? name : null
  const collectData = encodeFunctionData({
    abi: nonfungiblePositionManagerAbi,
    functionName: 'collect',
    args: [{ tokenId, recipient: acct, amount0Max: maxUint128, amount1Max: maxUint128 }],
  })
  const raw = await client.call({ account: acct, to: npm, data: collectData, blockNumber })
  const [collectable0, collectable1] = decodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', data: raw.data ?? '0x' })
  const owed = principal.get(tokenId) ?? [0n, 0n]
  return {
    tokenId,
    pool,
    tickLower: p[5],
    tickUpper: p[6],
    liquidity: p[7],
    collectable0,
    collectable1,
    principalOwed0: owed[0],
    principalOwed1: owed[1],
    managed: input.allowedTokenIds.includes(tokenId),
  }
}

/** Adds the reads of one pool to `batch`; the returned function builds the pool once the batch ran. */
function poolReads(batch: Batch, client: PublicClient, name: RegistryName, blockNumber: bigint, windowSeconds: number): () => Promise<PoolObs> {
  const e = entry(name)
  const at = { address: e.address, abi: uniswapV3PoolAbi, blockNumber } as const
  const slot0 = batch.add(contractRead(client, { ...at, functionName: 'slot0' }))
  const liquidity = batch.add(contractRead(client, { ...at, functionName: 'liquidity' }))
  const token0 = batch.add(contractRead(client, { ...at, functionName: 'token0' }))
  const token1 = batch.add(contractRead(client, { ...at, functionName: 'token1' }))
  const fee = batch.add(contractRead(client, { ...at, functionName: 'fee' }))
  const tickSpacing = batch.add(contractRead(client, { ...at, functionName: 'tickSpacing' }))
  const factoryPool = batch.add(
    contractRead(client, { address: address('UniswapV3Factory'), abi: uniswapV3FactoryAbi, functionName: 'getPool', args: [address(e.token0!), address(e.token1!), e.fee!], blockNumber }),
  )
  // FR-UNI-009: `observe` may fail when the pool cannot answer for the window; the TWAP is then null.
  const cumulatives = batch.add(contractRead(client, { address: e.address, abi: observeAbi, functionName: 'observe', args: [[windowSeconds, 0]], blockNumber }))
  return async () => {
    const s0 = await slot0.need()
    return {
      name,
      address: e.address,
      token0: e.token0!,
      token1: e.token1!,
      fee: e.fee!,
      tickSpacing: e.tickSpacing!,
      sqrtPriceX96: s0[0],
      tick: s0[1],
      liquidity: await liquidity.need(),
      twapTick: twapTick(cumulatives.maybe()?.[0], windowSeconds),
      identity: { factoryPool: factoryPool.maybe() ?? zeroAddress, token0: await token0.need(), token1: await token1.need(), fee: await fee.need(), tickSpacing: await tickSpacing.need() },
    }
  }
}

/** FR-UNI-009: time-weighted tick from the `observe` cumulatives, or null when the pool could not answer for the window. */
function twapTick(cumulatives: readonly bigint[] | undefined, windowSeconds: number): number | null {
  if (!cumulatives || cumulatives[0] === undefined || cumulatives[1] === undefined) return null
  const delta = cumulatives[1] - cumulatives[0]
  const w = BigInt(windowSeconds)
  let t = delta / w
  if (delta < 0n && delta % w !== 0n) t -= 1n
  return Number(t)
}

async function readDeposits(client: PublicClient, acct: Address, input: ObserveInput, blockNumber: bigint, safeNumber: bigint): Promise<DepositObs[]> {
  if (input.depositsAfter >= blockNumber) return []
  const logs = await client.getLogs({ address: address(input.savingsAsset), event: transferEvent, args: { to: acct }, fromBlock: input.depositsAfter + 1n, toBlock: blockNumber })
  const pools = new Set(POOLS.map((p) => address(p).toLowerCase()))
  const npm = address('NonfungiblePositionManager').toLowerCase()
  return logs
    .filter((l) => !pools.has(l.args.from!.toLowerCase()) && l.args.from!.toLowerCase() !== npm)
    .map((l) => ({ token: input.savingsAsset, amount: l.args.value!, block: l.blockNumber!, txHash: l.transactionHash!, logIndex: l.logIndex!, safe: l.blockNumber! <= safeNumber }))
}

export type ChainPositionEvent = PositionEvent & { blockNumber: bigint; txHash: Hex }

const POSITION_EVENT_TOPICS = positionEventsAbi.map((e) => toEventSelector(e))

/**
 * FR-PRJ-003: every canonical DecreaseLiquidity and Collect of these
 * tokenIds in [fromBlock, toBlock], engine or not, in chain order.
 */
export async function readPositionHistory(client: PublicClient, tokenIds: readonly bigint[], fromBlock: bigint, toBlock: bigint): Promise<ChainPositionEvent[]> {
  if (tokenIds.length === 0 || fromBlock > toBlock) return []
  // Both events carry the tokenId as their first indexed topic: one eth_getLogs serves the two.
  const raw = await client.request({
    method: 'eth_getLogs',
    params: [{ address: address('NonfungiblePositionManager'), topics: [POSITION_EVENT_TOPICS, tokenIds.map((id) => numberToHex(id, { size: 32 }))], fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }],
  })
  const events = parseEventLogs({ abi: positionEventsAbi, logs: raw.map((l) => formatLog(l)) }).map((l) => ({
    kind: l.eventName === 'Collect' ? ('collect' as const) : ('decrease' as const),
    tokenId: l.args.tokenId,
    amount0: l.args.amount0,
    amount1: l.args.amount1,
    logIndex: l.logIndex!,
    blockNumber: l.blockNumber!,
    txHash: l.transactionHash!,
  }))
  return events.sort(byChainOrder)
}

/** Position history already read for `fromBlock`, up to `through` (a safe block whose hash is `hash`), and for which tokenIds. Owned by one engine. */
export type HistoryCursor = { fromBlock: bigint; through: bigint; hash: Hex | null; ids: Set<string>; events: ChainPositionEvent[] }

export function historyCursor(): HistoryCursor {
  return { fromBlock: -1n, through: -1n, hash: null, ids: new Set(), events: [] }
}

const byChainOrder = (a: ChainPositionEvent, b: ChainPositionEvent) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1)

function resetCursor(cursor: HistoryCursor, fromBlock: bigint): void {
  Object.assign(cursor, { fromBlock, through: fromBlock - 1n, hash: null, ids: new Set<string>(), events: [] })
}

/**
 * readPositionHistory over [fromBlock, toBlock] without re-reading what `cursor` holds.
 * Only blocks at or below `safeBlock` are kept; everything after the cursor is read again on every call.
 * A new origin, or a cursor block whose hash changed (reorg), starts over. `cursor` is not touched:
 * the caller commits `next` only once its whole observation is consistent.
 */
export async function readPositionHistoryFrom(
  client: PublicClient,
  cursor: HistoryCursor,
  tokenIds: readonly bigint[],
  fromBlock: bigint,
  toBlock: bigint,
  safeBlock: bigint,
  /** Hash of `safeBlock`, when the caller already read that block. */
  safeHash?: Hex,
): Promise<{ events: ChainPositionEvent[]; next: HistoryCursor }> {
  const next: HistoryCursor = { ...cursor, ids: new Set(cursor.ids), events: [...cursor.events] }
  if (tokenIds.length === 0 || fromBlock > toBlock) return { events: [], next }
  if (next.fromBlock !== fromBlock) resetCursor(next, fromBlock)
  // A head behind the cursor (lagging node or rollback): its blocks cannot be checked here, so read in full and keep the cursor.
  if (next.through > toBlock) return { events: await readPositionHistory(client, tokenIds, fromBlock, toBlock), next: cursor }
  // The caller's read of the safe block answers for that height without another request.
  const hashAt = async (n: bigint) => (safeHash && n === safeBlock ? safeHash : (await client.getBlock({ blockNumber: n })).hash)
  if (next.hash && (await hashAt(next.through)) !== next.hash) resetCursor(next, fromBlock)
  // A tokenId the cursor has not seen: backfill its history up to the cursor once.
  const fresh = tokenIds.filter((id) => !next.ids.has(String(id)))
  if (fresh.length > 0) {
    if (next.through >= fromBlock && next.hash) {
      const backfill = await historyEndingAt(client, fresh, fromBlock, next.through, next.hash)
      if (backfill) next.events.push(...backfill)
      // The cursor block changed while its history was being read: start over, for every tokenId.
      else resetCursor(next, fromBlock)
    }
    for (const id of next.ids.size === 0 ? tokenIds : fresh) next.ids.add(String(id))
  }
  const stable = safeBlock < toBlock ? safeBlock : toBlock
  if (stable > next.through) {
    // The cursor only moves to a block whose hash is the same before the read and after it.
    const before = await hashAt(stable)
    const events = await historyEndingAt(client, [...next.ids].map(BigInt), next.through + 1n, stable, before)
    if (events) {
      next.events.push(...events)
      next.through = stable
      next.hash = before
    }
  }
  // The tail starts after the cursor, never below it: a safe head that moved back cannot read a block twice.
  // It ends at `toBlock`, whose hash the caller checks after this read (observe: the final block check).
  const tailFrom = next.through + 1n
  const tail = tailFrom <= toBlock ? await readPositionHistory(client, tokenIds, tailFrom, toBlock) : []
  const wanted = new Set(tokenIds.map(String))
  return { events: [...next.events.filter((e) => wanted.has(String(e.tokenId)) && e.blockNumber <= toBlock), ...tail].sort(byChainOrder), next }
}

/**
 * Position history of [fromBlock, toBlock] that is kept: it counts only if, asked after the log read, the
 * provider has block `toBlock` with the hash the caller holds for it. Null when it has another hash. A log
 * provider that is behind or on another fork cannot put events, or their absence, into the cursor this way;
 * the operator's proxy applies the same rule to each provider it reads logs from.
 */
async function historyEndingAt(client: PublicClient, tokenIds: readonly bigint[], fromBlock: bigint, toBlock: bigint, expected: Hex): Promise<ChainPositionEvent[] | null> {
  const events = await readPositionHistory(client, tokenIds, fromBlock, toBlock)
  const after = (await client.getBlock({ blockNumber: toBlock })).hash
  return after === expected ? events : null
}

/** Principal owed per tokenId just before (block, logIndex): the fold of the canonical history up to there. */
export async function principalOwedBefore(client: PublicClient, tokenIds: readonly bigint[], fromBlock: bigint, at: { block: bigint; logIndex: number }): Promise<Map<bigint, Pair>> {
  // Nothing at or after (block, 0) is used: do not ask for a block that may not exist yet.
  const history = await readPositionHistory(client, tokenIds, fromBlock, at.logIndex === 0 ? at.block - 1n : at.block)
  return applyPrincipal(new Map(), history.filter((e) => e.blockNumber < at.block || e.logIndex < at.logIndex))
}

export type SimCall = { from?: Address; to: Address; data: Hex }
export type SimCallResult = { status: 'success' | 'reverted'; returnData: Hex; gasUsed: bigint; logs: Log[]; error?: string }

/** One eth_simulateV1 block on top of `blockNumber`, without validation. */
export async function simulateCalls(client: PublicClient, calls: SimCall[], blockNumber: bigint): Promise<SimCallResult[]> {
  let out: { calls: { status: Hex; returnData: Hex; gasUsed: Hex; logs: Log[]; error?: { message: string } }[] }[]
  try {
    out = (await client.request({
      method: 'eth_simulateV1' as never,
      params: [{ blockStateCalls: [{ calls: calls.map((c) => ({ ...c, gas: '0x1c9c380' })) }], validation: false }, `0x${blockNumber.toString(16)}`] as never,
    })) as typeof out
  } catch (e) {
    throw new ReasonError('EHG_SIM_UNAVAILABLE', (e as Error).message.split('\n')[0])
  }
  return out[0]!.calls.map((c) => ({
    status: c.status === '0x1' ? 'success' : 'reverted',
    returnData: c.returnData,
    gasUsed: BigInt(c.gasUsed),
    logs: c.logs,
    error: c.error?.message,
  }))
}

export type Simulation = {
  block: bigint
  ok: boolean
  revert?: string
  deltas: Record<RegistryName, bigint>
  nftDelta: bigint
  gasUsed: bigint
  logs: Log[]
}

/**
 * FR-RPC-002: runs the account callData from the EntryPoint, between two
 * rounds of balance reads, and returns the deltas per registry token and
 * the change in the account's position count.
 */
export async function simulateFromEntryPoint(client: PublicClient, account: Address, callData: Hex, blockNumber: bigint): Promise<Simulation> {
  const npm = address('NonfungiblePositionManager')
  const reads: SimCall[] = [
    ...TOKENS.map((t) => ({ to: address(t), data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [account] }) })),
    { to: npm, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [account] }) },
  ]
  const res = await simulateCalls(client, [...reads, { from: address('EntryPointV07'), to: account, data: callData }, ...reads], blockNumber)
  const n = reads.length
  const exec = res[n]!
  const word = (r: SimCallResult) => BigInt(r.returnData === '0x' ? 0 : r.returnData)
  const deltas: Record<RegistryName, bigint> = {}
  TOKENS.forEach((t, i) => {
    deltas[t] = word(res[n + 1 + i]!) - word(res[i]!)
  })
  return {
    block: blockNumber,
    ok: exec.status === 'success',
    revert: exec.status === 'success' ? undefined : (exec.error ?? exec.returnData),
    deltas,
    nftDelta: word(res[2 * n]!) - word(res[n - 1]!),
    gasUsed: exec.gasUsed,
    logs: exec.logs,
  }
}

export type UserOpEventRead = {
  userOpHash: Hex
  sender: Address
  nonce: bigint
  blockNumber: bigint
  blockHash: Hex
  txHash: Hex
  logIndex: number
  success: boolean
  actualGasCost: bigint
  /** Only the logs this userOp produced, not the whole bundle's. */
  logs: Log[]
}

const BEFORE_EXECUTION = toEventSelector('BeforeExecution()')
const USER_OPERATION_EVENT = toEventSelector(userOperationEvent)

/**
 * EntryPoint v0.7 runs the ops of a bundle after one BeforeExecution, each
 * closed by its UserOperationEvent. The logs of the op whose event sits at
 * `eventLogIndex` are the ones after the previous boundary and before it.
 */
export function userOpLogs<L extends Log>(txLogs: readonly L[], eventLogIndex: number): L[] {
  const ep = address('EntryPointV07')
  const ordered = [...txLogs].sort((a, b) => a.logIndex! - b.logIndex!)
  const boundary = (topic: Hex) => (l: L) => isAddressEqual(l.address, ep) && l.topics[0] === topic
  const event = ordered.find((l) => l.logIndex === eventLogIndex)
  if (!event || !boundary(USER_OPERATION_EVENT)(event)) throw new Error(`no UserOperationEvent at log ${eventLogIndex}`)
  const before = ordered.filter((l) => l.logIndex! < eventLogIndex)
  const start = before.findLast((l) => boundary(USER_OPERATION_EVENT)(l) || boundary(BEFORE_EXECUTION)(l))
  if (!before.some(boundary(BEFORE_EXECUTION))) throw new Error('the transaction has no BeforeExecution: not a handleOps bundle')
  return before.filter((l) => l.logIndex! > start!.logIndex!)
}

/** FR-AA-004 and FR-ENG-008: the UserOperationEvent of a hash, read from the RPC, with the logs of that userOp only. */
export async function readUserOpEvent(client: PublicClient, userOpHash: Hex, fromBlock: bigint): Promise<UserOpEventRead | null> {
  const logs = await client.getLogs({ address: address('EntryPointV07'), event: userOperationEvent, args: { userOpHash }, fromBlock, toBlock: 'latest' })
  if (logs.length > 1) throw new Error(`${logs.length} UserOperationEvents for ${userOpHash}`)
  const ev = logs[0]
  if (!ev) return null
  const receipt = await client.getTransactionReceipt({ hash: ev.transactionHash! })
  return {
    userOpHash: ev.args.userOpHash!,
    sender: ev.args.sender!,
    nonce: ev.args.nonce!,
    blockNumber: ev.blockNumber!,
    blockHash: ev.blockHash!,
    txHash: ev.transactionHash!,
    logIndex: ev.logIndex!,
    success: ev.args.success!,
    actualGasCost: ev.args.actualGasCost!,
    logs: userOpLogs(receipt.logs, ev.logIndex!),
  }
}

/** Whether `blockNumber` is at or below `safe` and still has `blockHash`. */
export async function isSafeAndCanonical(client: PublicClient, blockNumber: bigint, blockHash: Hex): Promise<{ safe: boolean; canonical: boolean; safeBlock: bigint }> {
  const [safe, b] = await Promise.all([client.getBlock({ blockTag: 'safe' }), client.getBlock({ blockNumber })])
  return { safe: safe.number >= blockNumber, canonical: b.hash === blockHash, safeBlock: safe.number }
}
