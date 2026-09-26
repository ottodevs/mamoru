import type { Server } from 'bun'
import { parseEventLogs, toHex, zeroAddress, type Hex, type TransactionReceipt } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { UserOperation } from 'viem/account-abstraction'
import { address, entryPointV07Abi } from '@mamoru/registry'
import { handleOpsData, userOpHash } from '@mamoru/account/sessions'
import { fromRpcUserOp, toRpcUserOp, type RpcUserOperation } from '@mamoru/erc4337'
import { decodeEntryPointError, type Lab } from '../fixtures/lab.ts'

type Included = { op: UserOperation<'0.7'>; hash: Hex; receipt: TransactionReceipt; success: boolean; actualGasCost: bigint; actualGasUsed: bigint }

export type LabBundler = {
  url: string
  /** Every userOp hash the bundler accepted, in order (INV-PERSIST-FIRST). */
  received: () => Hex[]
  stop: () => void
}

type RpcRequest = { jsonrpc: '2.0'; id: unknown; method: string; params?: unknown[] }

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Loopback ERC-4337 endpoint for the fork. It speaks only the standard
 * methods the engine uses, validates each userOp with a static
 * `handleOps`, then bundles it alone from an anvil development account.
 * It is not Alto: the manifest pins Alto, which is not installed yet.
 */
export function startLabBundler(lab: Lab, executor: PrivateKeyAccount): LabBundler {
  const entryPoint = address('EntryPointV07')
  const included = new Map<string, Included>()
  const received: Hex[] = []

  async function send(params: unknown[]): Promise<Hex> {
    const [rpcOp, ep] = params as [RpcUserOperation, string]
    if (!ep || ep.toLowerCase() !== entryPoint.toLowerCase()) throw new RpcFailure(-32602, `unsupported entry point ${ep}`)
    const op = fromRpcUserOp(rpcOp)
    const hash = userOpHash(op, lab.chainId)
    const data = handleOpsData([op], executor.address)
    try {
      await lab.client.call({ account: executor.address, to: entryPoint, data, gas: 15_000_000n })
    } catch (e) {
      const d = decodeEntryPointError(revertData(e))
      throw new RpcFailure(-32500, d?.reason ?? 'validation reverted')
    }
    received.push(hash)
    const sent = await lab.send(executor, entryPoint, data)
    const ev = parseEventLogs({ abi: entryPointV07Abi, logs: sent.receipt.logs, eventName: 'UserOperationEvent' }).find((l) => l.args.userOpHash === hash)
    if (!ev) throw new RpcFailure(-32500, 'handleOps did not emit the UserOperationEvent')
    included.set(hash.toLowerCase(), { op, hash, receipt: sent.receipt, success: ev.args.success, actualGasCost: ev.args.actualGasCost, actualGasUsed: ev.args.actualGasUsed })
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
            return toHex(lab.chainId)
          case 'eth_supportedEntryPoints':
            return [entryPoint]
          case 'eth_sendUserOperation':
            return send(params)
          case 'eth_getUserOperationReceipt':
            return receipt(params)
          case 'eth_getUserOperationByHash':
            return byHash(params)
          default:
            throw new RpcFailure(-32601, `method ${msg.method} is not served by the lab bundler`)
        }
      })()
      return { jsonrpc: '2.0', id: msg.id, result }
    } catch (e) {
      const f = e instanceof RpcFailure ? e : new RpcFailure(-32603, (e as Error).message)
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
  return { url: `http://127.0.0.1:${server.port}/`, received: () => [...received], stop: () => server.stop(true) }
}

function revertData(e: unknown): Hex | undefined {
  let cur: any = e
  for (let i = 0; i < 8 && cur; i++) {
    if (typeof cur.data === 'string' && cur.data.startsWith('0x')) return cur.data as Hex
    if (cur.data && typeof cur.data.data === 'string') return cur.data.data as Hex
    cur = cur.cause
  }
  return undefined
}
