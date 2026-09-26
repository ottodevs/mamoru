import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  maxUint128,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import type { DepositObs, Observation, PoolObs, PositionObs, SessionObs } from '@mamoru/decide'
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
  principalOwed: ReadonlyMap<bigint, readonly [bigint, bigint]>
  intents: Observation['intents']
  slot: Observation['slot']
  twapWindowSeconds: number
  opGasUnits: bigint
  maxPriorityFeePerGas: bigint
  savingsAsset: RegistryName
  ethPricePool: RegistryName
}

const TOKENS = baseRegistry.entries.filter((e) => e.kind === 'token').map((e) => e.name)
const POOLS = baseRegistry.entries.filter((e) => e.kind === 'pool').map((e) => e.name)

/**
 * FR-RPC-001: every read of one observation is pinned to the same block
 * number, and the block hash is checked again at the end.
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

  const [code, native, nonce, nftCount, ...balances] = await Promise.all([
    client.getCode({ address: acct, blockNumber }),
    client.getBalance({ address: acct, blockNumber }),
    client.readContract({ address: address('EntryPointV07'), abi: entryPointV07Abi, functionName: 'getNonce', args: [acct, input.nonceKey], blockNumber }),
    client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [acct], blockNumber }),
    ...TOKENS.map((t) => client.readContract({ address: address(t), abi: erc20Abi, functionName: 'balanceOf', args: [acct], blockNumber })),
  ])

  const tokenIds = await Promise.all(
    Array.from({ length: Number(nftCount) }, (_, i) => client.readContract({ address: npm, abi: enumerableAbi, functionName: 'tokenOfOwnerByIndex', args: [acct, BigInt(i)], blockNumber })),
  )
  const positions = await Promise.all(tokenIds.map((id) => readPosition(client, acct, id, blockNumber, input)))
  const pools = await Promise.all(POOLS.map((p) => readPool(client, p, blockNumber, input.twapWindowSeconds)))
  const priceSlot0 = await client.readContract({ address: address(input.ethPricePool), abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber })
  const deposits = await readDeposits(client, acct, input, blockNumber, safe.number)

  const again = await client.getBlock({ blockNumber })
  if (again.hash !== block.hash) throw new ReasonError('OBS_BLOCK_INCONSISTENT', `block ${blockNumber} changed hash during the observation`)

  const baseFee = block.baseFeePerGas ?? 0n
  return {
    chainId,
    block: { number: blockNumber, hash: block.hash, timestamp: block.timestamp },
    safeBlock: { number: safe.number, hash: safe.hash },
    account: { address: acct, deployed: !!code && code !== '0x', nonceKey: input.nonceKey, nonce },
    sessions: input.sessions,
    native,
    balances: Object.fromEntries(TOKENS.map((t, i) => [t, balances[i] as bigint])),
    positions,
    pools,
    ethPrice: { pool: input.ethPricePool, sqrtPriceX96: priceSlot0[0], token0: entry(input.ethPricePool).token0! },
    gas: { maxFeePerGas: baseFee * 2n + input.maxPriorityFeePerGas, opGasUnits: input.opGasUnits },
    deposits,
    intents: input.intents,
    slot: input.slot,
  }
}

async function readPosition(client: PublicClient, acct: Address, tokenId: bigint, blockNumber: bigint, input: ObserveInput): Promise<PositionObs> {
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
  const owed = input.principalOwed.get(tokenId) ?? [0n, 0n]
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

async function readPool(client: PublicClient, name: RegistryName, blockNumber: bigint, windowSeconds: number): Promise<PoolObs> {
  const e = entry(name)
  const at = { address: e.address, abi: uniswapV3PoolAbi, blockNumber } as const
  const [slot0, liquidity, token0, token1, fee, tickSpacing, factoryPool, twapTick] = await Promise.all([
    client.readContract({ ...at, functionName: 'slot0' }),
    client.readContract({ ...at, functionName: 'liquidity' }),
    client.readContract({ ...at, functionName: 'token0' }),
    client.readContract({ ...at, functionName: 'token1' }),
    client.readContract({ ...at, functionName: 'fee' }),
    client.readContract({ ...at, functionName: 'tickSpacing' }),
    client
      .readContract({ address: address('UniswapV3Factory'), abi: uniswapV3FactoryAbi, functionName: 'getPool', args: [address(e.token0!), address(e.token1!), e.fee!], blockNumber })
      .catch(() => zeroAddress),
    readTwap(client, e.address, blockNumber, windowSeconds),
  ])
  return {
    name,
    address: e.address,
    token0: e.token0!,
    token1: e.token1!,
    fee: e.fee!,
    tickSpacing: e.tickSpacing!,
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
    liquidity,
    twapTick,
    identity: { factoryPool, token0, token1, fee, tickSpacing },
  }
}

/** FR-UNI-009: time-weighted tick from `observe`, or null when the pool cannot answer for the window. */
async function readTwap(client: PublicClient, pool: Address, blockNumber: bigint, windowSeconds: number): Promise<number | null> {
  try {
    const [cumulatives] = await client.readContract({ address: pool, abi: observeAbi, functionName: 'observe', args: [[windowSeconds, 0]], blockNumber })
    const delta = cumulatives[1]! - cumulatives[0]!
    const w = BigInt(windowSeconds)
    let t = delta / w
    if (delta < 0n && delta % w !== 0n) t -= 1n
    return Number(t)
  } catch {
    return null
  }
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

export type UserOpEventRead = { blockNumber: bigint; blockHash: Hex; txHash: Hex; success: boolean; actualGasCost: bigint; nonce: bigint; logs: Log[] }

/** FR-AA-004 and FR-ENG-008: the UserOperationEvent of a hash, read from the RPC, with the logs of its transaction. */
export async function readUserOpEvent(client: PublicClient, userOpHash: Hex, fromBlock: bigint): Promise<UserOpEventRead | null> {
  const logs = await client.getLogs({ address: address('EntryPointV07'), event: userOperationEvent, args: { userOpHash }, fromBlock, toBlock: 'latest' })
  const ev = logs[0]
  if (!ev) return null
  const receipt = await client.getTransactionReceipt({ hash: ev.transactionHash! })
  return {
    blockNumber: ev.blockNumber!,
    blockHash: ev.blockHash!,
    txHash: ev.transactionHash!,
    success: ev.args.success!,
    actualGasCost: ev.args.actualGasCost!,
    nonce: ev.args.nonce!,
    logs: receipt.logs,
  }
}

/** Whether `blockNumber` is at or below `safe` and still has `blockHash`. */
export async function isSafeAndCanonical(client: PublicClient, blockNumber: bigint, blockHash: Hex): Promise<{ safe: boolean; canonical: boolean; safeBlock: bigint }> {
  const [safe, b] = await Promise.all([client.getBlock({ blockTag: 'safe' }), client.getBlock({ blockNumber })])
  return { safe: safe.number >= blockNumber, canonical: b.hash === blockHash, safeBlock: safe.number }
}
