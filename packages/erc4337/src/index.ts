import { toHex, type Hex } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'
import { BASE_CHAIN_ID, FORBIDDEN_LAB_CHAIN_IDS, ReasonError, type Address } from '@mamoru/domain'
import { address } from '@mamoru/registry'

/** FR-AA-002: the only bundler methods on the critical path. */
export const STANDARD_METHODS = [
  'eth_sendUserOperation',
  'eth_estimateUserOperationGas',
  'eth_getUserOperationReceipt',
  'eth_getUserOperationByHash',
  'eth_supportedEntryPoints',
  'eth_chainId',
] as const
export type BundlerMethod = (typeof STANDARD_METHODS)[number]

/** ERC-4337 v0.7 JSON-RPC shape of a userOp: unpacked, quantities in hex. */
export type RpcUserOperation = {
  sender: Address
  nonce: Hex
  callData: Hex
  callGasLimit: Hex
  verificationGasLimit: Hex
  preVerificationGas: Hex
  maxFeePerGas: Hex
  maxPriorityFeePerGas: Hex
  signature: Hex
}

export function toRpcUserOp(op: UserOperation<'0.7'>): RpcUserOperation {
  return {
    sender: op.sender,
    nonce: toHex(op.nonce),
    callData: op.callData,
    callGasLimit: toHex(op.callGasLimit),
    verificationGasLimit: toHex(op.verificationGasLimit),
    preVerificationGas: toHex(op.preVerificationGas),
    maxFeePerGas: toHex(op.maxFeePerGas),
    maxPriorityFeePerGas: toHex(op.maxPriorityFeePerGas),
    signature: op.signature,
  }
}

export function fromRpcUserOp(op: RpcUserOperation): UserOperation<'0.7'> {
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    callData: op.callData,
    callGasLimit: BigInt(op.callGasLimit),
    verificationGasLimit: BigInt(op.verificationGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    maxFeePerGas: BigInt(op.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
    signature: op.signature,
  }
}

export type BundlerReceipt = {
  userOpHash: Hex
  sender: Address
  nonce: bigint
  success: boolean
  actualGasCost: bigint
  txHash: Hex
  blockNumber: bigint
  blockHash: Hex
}

export class BundlerRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message)
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** FR-AA-005: in the lab the bundler must listen on loopback. */
export function assertLabBundler(url: string): void {
  if (!LOOPBACK_HOSTS.has(new URL(url).hostname)) throw new ReasonError('LAB_BUNDLER_NOT_LOCAL', 'the lab bundler must listen on loopback')
}

export type BundlerConfig = { url: string; mode: 'production' | 'lab' | 'live'; chainId: number; signingChainIds: readonly number[] }

/**
 * BundlerPort over JSON-RPC, standard methods only. Sending refuses
 * production mode and any chain outside the signing list: the second guard
 * of the dry-run (FR-ENG-014).
 */
export class BundlerClient {
  private id = 0

  constructor(private readonly cfg: BundlerConfig) {
    if (cfg.mode === 'lab') assertLabBundler(cfg.url)
  }

  private async call<T>(method: BundlerMethod, params: unknown[]): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.cfg.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }) })
    } catch (e) {
      throw new ReasonError('BUNDLER_UNAVAILABLE', (e as Error).message)
    }
    const json = (await res.json()) as { result?: T; error?: { code: number; message: string } }
    if (json.error) throw new BundlerRpcError(json.error.code, json.error.message)
    return json.result as T
  }

  async supportedEntryPoints(): Promise<Address[]> {
    return this.call('eth_supportedEntryPoints', [])
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.call<Hex>('eth_chainId', [])))
  }

  async sendUserOperation(op: UserOperation<'0.7'>): Promise<Hex> {
    if (this.cfg.mode === 'production') throw new ReasonError('DRY_RUN_STOP', 'production never sends')
    if (this.cfg.mode === 'live') {
      // Live sends only on Base, only with MAMORU_LIVE=1 in this process.
      const allowed = this.cfg.chainId === BASE_CHAIN_ID && process.env.MAMORU_LIVE === '1' && this.cfg.signingChainIds.includes(this.cfg.chainId)
      if (!allowed) throw new ReasonError('SIGN_CHAIN_NOT_ALLOWED', `live send on chain ${this.cfg.chainId}`)
    } else if (FORBIDDEN_LAB_CHAIN_IDS.includes(this.cfg.chainId) || !this.cfg.signingChainIds.includes(this.cfg.chainId)) {
      throw new ReasonError('SIGN_CHAIN_NOT_ALLOWED', `chain ${this.cfg.chainId}`)
    }
    return this.call('eth_sendUserOperation', [toRpcUserOp(op), address('EntryPointV07')])
  }

  async getUserOperationReceipt(hash: Hex): Promise<BundlerReceipt | null> {
    const r = await this.call<{
      userOpHash: Hex
      sender: Address
      nonce: Hex
      success: boolean
      actualGasCost: Hex
      receipt: { transactionHash: Hex; blockNumber: Hex; blockHash: Hex }
    } | null>('eth_getUserOperationReceipt', [hash])
    if (!r) return null
    return {
      userOpHash: r.userOpHash,
      sender: r.sender,
      nonce: BigInt(r.nonce),
      success: r.success,
      actualGasCost: BigInt(r.actualGasCost),
      txHash: r.receipt.transactionHash,
      blockNumber: BigInt(r.receipt.blockNumber),
      blockHash: r.receipt.blockHash,
    }
  }
}
