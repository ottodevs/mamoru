import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Abi,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type ReadContractParameters,
  type ReadContractReturnType,
} from 'viem'
import type { Address } from '@mamoru/domain'
import type { Registry } from '@mamoru/registry'

export const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
])

/** Provider limits: one aggregate3 carries at most this many calls and this much inner calldata. */
export const BATCH_MAX_CALLS = 100
export const BATCH_MAX_BYTES = 50_000
/** ABI overhead of one Call3 around its calldata: target, allowFailure, offset and length words. */
const CALL_OVERHEAD_BYTES = 160

/** Multicall3 of a chain, or null when its registry does not pin one: reads then go one by one. */
export function multicall3Of(registry: Registry): Address | null {
  return registry.entries.find((e) => e.name === 'Multicall3')?.address ?? null
}

/** One read: its calldata for the batch, and the same read on its own (what the engine did before batching). */
export type Read<T> = { to: Address; data: Hex; decode: (returnData: Hex) => T; direct: () => Promise<T> }

type Mutability = 'pure' | 'view'

/** A contract read pinned by `p.blockNumber`, usable in a batch or on its own. */
export function contractRead<const abi extends Abi | readonly unknown[], fn extends ContractFunctionName<abi, Mutability>, const args extends ContractFunctionArgs<abi, Mutability, fn>>(
  client: PublicClient,
  p: ReadContractParameters<abi, fn, args>,
): Read<ReadContractReturnType<abi, fn, args>> {
  const call = { abi: p.abi, functionName: p.functionName, args: p.args } as never
  return {
    to: p.address as Address,
    data: encodeFunctionData(call) as Hex,
    decode: (returnData) => decodeFunctionResult({ abi: p.abi, functionName: p.functionName, data: returnData } as never) as never,
    direct: () => client.readContract(p),
  }
}

/** eth_getBalance through Multicall3.getEthBalance; on its own it is the plain eth_getBalance. */
export function balanceRead(client: PublicClient, multicall3: Address | null, holder: Address, blockNumber?: bigint): Read<bigint> {
  return {
    to: multicall3 ?? holder,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: 'getEthBalance', args: [holder] }),
    decode: (returnData) => decodeFunctionResult({ abi: multicall3Abi, functionName: 'getEthBalance', data: returnData }),
    direct: () => client.getBalance(blockNumber === undefined ? { address: holder } : { address: holder, blockNumber }),
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error?: unknown }

/** The result of one read of a batch, available once the batch ran. */
export type Handle<T> = {
  /** The value. A read that failed in the batch is run again on its own: it throws, or answers, exactly as an unbatched read. */
  need: () => Promise<T>
  /** The value, or null when the read failed (reads that are allowed to fail). */
  maybe: () => T | null
}

/** Splits calls into chunks within BATCH_MAX_CALLS and BATCH_MAX_BYTES; a single oversized call gets its own chunk. */
export function chunkCalls<C extends { data: Hex }>(calls: readonly C[]): C[][] {
  const chunks: C[][] = []
  let current: C[] = []
  let bytes = 0
  for (const c of calls) {
    const size = (c.data.length - 2) / 2 + CALL_OVERHEAD_BYTES
    if (current.length > 0 && (current.length >= BATCH_MAX_CALLS || bytes + size > BATCH_MAX_BYTES)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(c)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Reads that share one block, sent as explicit Multicall3.aggregate3 calls (allowFailure on every call):
 * the number of requests depends only on the number of reads, never on timing. With no Multicall3 every
 * read runs on its own.
 */
export class Batch {
  private readonly reads: Read<unknown>[] = []
  private settled: Settled<unknown>[] | null = null

  constructor(
    private readonly client: PublicClient,
    private readonly multicall3: Address | null,
    /** Every read of the batch is pinned here; undefined is `latest`. */
    private readonly blockNumber?: bigint,
  ) {}

  get size(): number {
    return this.reads.length
  }

  add<T>(read: Read<T>): Handle<T> {
    if (this.settled) throw new Error('batch already ran')
    const i = this.reads.push(read as Read<unknown>) - 1
    const at = (): Settled<T> => {
      if (!this.settled) throw new Error('batch not run yet')
      return this.settled[i] as Settled<T>
    }
    return {
      need: async () => {
        const s = at()
        if (s.ok) return s.value
        // Unbatched: the read already ran on its own, its error is the answer.
        if (this.multicall3 === null) throw s.error
        return read.direct()
      },
      maybe: () => {
        const s = at()
        return s.ok ? s.value : null
      },
    }
  }

  async run(): Promise<void> {
    if (this.settled) throw new Error('batch already ran')
    if (this.multicall3 === null) {
      this.settled = await Promise.all(this.reads.map((r) => r.direct().then((value): Settled<unknown> => ({ ok: true, value }), (error): Settled<unknown> => ({ ok: false, error }))))
      return
    }
    const multicall3 = this.multicall3
    const chunks = chunkCalls(this.reads)
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const data = encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [chunk.map((r) => ({ target: r.to, allowFailure: true, callData: r.data }))] })
        const raw = await this.client.call(this.blockNumber === undefined ? { to: multicall3, data } : { to: multicall3, data, blockNumber: this.blockNumber })
        const out = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: raw.data ?? '0x' })
        if (out.length !== chunk.length) throw new Error(`Multicall3 answered ${out.length} results for ${chunk.length} calls`)
        return out.map((r, i): Settled<unknown> => {
          if (!r.success) return { ok: false }
          try {
            return { ok: true, value: chunk[i]!.decode(r.returnData) }
          } catch {
            // Empty or malformed return data (no contract at the target): the direct read reports it.
            return { ok: false }
          }
        })
      }),
    )
    this.settled = results.flat()
  }
}
