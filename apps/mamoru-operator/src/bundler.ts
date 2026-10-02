import type { Server } from 'bun'
import { decodeErrorResult, parseEventLogs, toHex, zeroAddress, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'
import { address, entryPointV07Abi } from '@mamoru/registry'
import { handleOpsData, userOpHash } from '@mamoru/account/sessions'
import { fromRpcUserOp, toRpcUserOp, type RpcUserOperation } from '@mamoru/erc4337'
import { logErr } from './metrics.ts'
import type { Relayer } from './relayer.ts'

type Included = { op: UserOperation<'0.7'>; hash: Hex; receipt: TransactionReceipt; success: boolean; actualGasCost: bigint; actualGasUsed: bigint }
type RpcRequest = { jsonrpc: '2.0'; id: unknown; method: string; params?: unknown[] }

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export type LiveBundler = { url: string; stop: () => void }

/** Gas for one handleOps with one engine userOp (LAB_GAS_LIMITS sum plus EntryPoint overhead). */
const HANDLE_OPS_GAS = 6_000_000n

/**
 * Loopback ERC-4337 endpoint inside the operator: the standard methods the
 * engine uses. Each userOp is validated with a static handleOps eth_call,
 * then bundled alone by the relayer EOA. Adapted from the lab bundler.
 */
export function startLiveBundler(client: PublicClient, relayer: Relayer, chainId: number): LiveBundler {
  const entryPoint = address('EntryPointV07')
  const included = new Map<string, Included>()

  async function send(params: unknown[]): Promise<Hex> {
    const [rpcOp, ep] = params as [RpcUserOperation, string]
    if (!ep || ep.toLowerCase() !== entryPoint.toLowerCase()) throw new RpcFailure(-32602, `unsupported entry point ${ep}`)
    const op = fromRpcUserOp(rpcOp)
    const hash = userOpHash(op, chainId)
    const data = handleOpsData([op], relayer.address)
    // A load-balanced provider can answer from a node a block or two behind (e.g. before the activation that enabled the session): retry validation briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await client.call({ account: relayer.address, to: entryPoint, data, gas: HANDLE_OPS_GAS })
        break
      } catch (e) {
        const reason = entryPointReason(revertData(e)) ?? 'validation reverted'
        if (attempt >= 3) throw new RpcFailure(-32500, reason)
        logErr(`[bundler] ${hash.slice(0, 10)} validation, retry ${attempt + 1}:`, reason)
        await Bun.sleep(2_500)
      }
    }
    const { receipt } = await relayer.send({ to: entryPoint, data, gas: HANDLE_OPS_GAS })
    const events = parseEventLogs({ abi: entryPointV07Abi, logs: receipt.logs, eventName: 'UserOperationEvent' })
    const ev = events.find((l) => l.args.userOpHash === hash)
    if (!ev) throw new RpcFailure(-32500, `handleOps ${receipt.transactionHash} did not emit the UserOperationEvent`)
    included.set(hash.toLowerCase(), { op, hash, receipt, success: ev.args.success, actualGasCost: ev.args.actualGasCost, actualGasUsed: ev.args.actualGasUsed })
    console.log(`[bundler] ${hash.slice(0, 10)} in ${receipt.transactionHash} block ${receipt.blockNumber} success=${ev.args.success}`)
    return hash
  }

  function receipt(params: unknown[]) {
    const r = included.get(String(params[0]).toLowerCase())
    if (!r) return null
    return {
      userOpHash: r.hash,
      entryPoint,
      sender: r.op.sender,
      nonce: toHex(r.op.nonce),
      paymaster: zeroAddress,
      actualGasCost: toHex(r.actualGasCost),
      actualGasUsed: toHex(r.actualGasUsed),
      success: r.success,
      logs: [],
      receipt: { transactionHash: r.receipt.transactionHash, blockNumber: toHex(r.receipt.blockNumber), blockHash: r.receipt.blockHash },
    }
  }

  function byHash(params: unknown[]) {
    const r = included.get(String(params[0]).toLowerCase())
    if (!r) return null
    return { userOperation: toRpcUserOp(r.op), entryPoint, transactionHash: r.receipt.transactionHash, blockNumber: toHex(r.receipt.blockNumber), blockHash: r.receipt.blockHash }
  }

  async function handle(msg: RpcRequest): Promise<unknown> {
    const params = msg.params ?? []
    try {
      const result = await (async () => {
        switch (msg.method) {
          case 'eth_chainId':
            return toHex(chainId)
          case 'eth_supportedEntryPoints':
            return [entryPoint]
          case 'eth_sendUserOperation':
            return send(params)
          case 'eth_getUserOperationReceipt':
            return receipt(params)
          case 'eth_getUserOperationByHash':
            return byHash(params)
          default:
            throw new RpcFailure(-32601, `method ${msg.method} is not served by the operator bundler`)
        }
      })()
      return { jsonrpc: '2.0', id: msg.id, result }
    } catch (e) {
      const f = e instanceof RpcFailure ? e : new RpcFailure(-32603, (e as Error).message.split('\n')[0] ?? 'error')
      logErr(`[bundler] ${msg.method} refused:`, f.message)
      return { jsonrpc: '2.0', id: msg.id, error: { code: f.code, message: f.message } }
    }
  }

  const server: Server<undefined> = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const payload = (await req.json()) as RpcRequest | RpcRequest[]
      return Response.json(Array.isArray(payload) ? await Promise.all(payload.map(handle)) : await handle(payload))
    },
  })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}

function entryPointReason(data: Hex | undefined): string | undefined {
  if (!data || data === '0x') return undefined
  try {
    const d = decodeErrorResult({ abi: entryPointV07Abi, data })
    return String(d.args?.[1] ?? d.errorName)
  } catch {
    return undefined
  }
}

export function revertData(e: unknown): Hex | undefined {
  let cur: any = e
  for (let i = 0; i < 8 && cur; i++) {
    if (typeof cur.data === 'string' && cur.data.startsWith('0x')) return cur.data as Hex
    if (cur.data && typeof cur.data.data === 'string') return cur.data.data as Hex
    cur = cur.cause
  }
  return undefined
}
