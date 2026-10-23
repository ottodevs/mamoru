import { createWalletClient, defineChain, http, keccak256, parseAbi, type Chain, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { ReasonError, chainOf, isChainId, type Address } from '@mamoru/domain'
import { Lock } from './lock.ts'
import { logErr } from './metrics.ts'

/** Per-tx gas cap on Base (EIP-7825). */
const TX_GAS_CAP = 16_777_216n
/** OP Stack GasPriceOracle predeploy: the L1 data fee a Base transaction pays on top of its execution fee. */
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const
const gasPriceOracleAbi = parseAbi(['function getL1Fee(bytes) view returns (uint256)'])
/** When the oracle cannot answer: 0.0001 ETH, orders of magnitude above a Base transaction's usual L1 data fee. */
const L1_FEE_FALLBACK_WEI = 100_000_000_000_000n
/** How long the nonce of the last accepted send overrules a provider count that has not caught up with it. */
const LAST_SENT_MS = 120_000
/**
 * otto/mamoru#61: the margin over eth_estimateGas on a chain that charges the gas LIMIT (Monad): every unit of margin is
 * paid whether used or not, so 10% instead of 30%. Elsewhere 30%, as always.
 */
export const GAS_LIMIT_CHAIN_MARGIN = { num: 11n, den: 10n } as const

/**
 * How the relayer sizes and bounds a transaction on `chainId`. A supported chain that charges the gas limit (Monad)
 * gets its own per-tx cap, the tight margin and no OP-stack L1 data fee; every other chain id (Base, Ethereum for
 * bridge-out, a lab fork) keeps exactly what the relayer always did: Base's cap, 30%, and the L1 fee oracle.
 */
export function relayerGasProfile(chainId: number): { cap: bigint; margin: { num: bigint; den: bigint }; l1Fee: boolean; native: string } {
  const d = isChainId(chainId) ? chainOf(chainId) : null
  if (d && d.gasModel === 'gas_limit') return { cap: d.perTxGasCap ?? TX_GAS_CAP, margin: GAS_LIMIT_CHAIN_MARGIN, l1Fee: d.l1DataFee, native: d.native.symbol }
  return { cap: TX_GAS_CAP, margin: { num: 13n, den: 10n }, l1Fee: true, native: 'ETH' }
}

/** The relayer EOA: pays gas for Safe deploys, owner execTransactions, top-ups and handleOps bundles. One send at a time. */
export class Relayer {
  readonly account: PrivateKeyAccount
  private readonly lock = new Lock()
  private readonly chain: Chain
  private readonly gas: ReturnType<typeof relayerGasProfile>
  /** Nonce and time of the last transaction a provider accepted from this process. */
  private lastSent: { nonce: number; at: number } | null = null

  constructor(
    key: Hex,
    private readonly client: PublicClient,
    private readonly rpcUrl: string,
    chainId: number,
    /**
     * otto/mamoru#63: set, the relayer signs nothing and every send is refused with CHAIN_UNSUPPORTED and this text,
     * before any read. boot.ts sets it when the operator reads a chain other than Base (`writeRefusal`).
     */
    private readonly refusal: string | null = null,
  ) {
    this.account = privateKeyToAccount(key)
    this.gas = relayerGasProfile(chainId)
    this.chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: this.gas.native === 'ETH' ? 'Ether' : this.gas.native, symbol: this.gas.native, decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
  }

  get address(): Address {
    return this.account.address
  }

  /**
   * Waits for the receipt of a sent tx. A load-balanced provider can fail a poll outright (e.g. publicnode's
   * "Archive requests require a personal token" from a lagging node): retry until the deadline instead of
   * reporting a tx that landed as failed.
   */
  private async receipt(hash: Hex): Promise<TransactionReceipt> {
    const deadline = Date.now() + 180_000
    for (;;) {
      try {
        return await this.client.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: Math.max(1_000, deadline - Date.now()) })
      } catch (e) {
        if (Date.now() >= deadline) throw e
        logErr(`[relayer] receipt ${hash.slice(0, 10)} poll failed, retrying:`, e)
        await Bun.sleep(2_000)
      }
    }
  }

  /** The L1 data fee of `serialized` now, or a fixed bound above it when the oracle cannot answer. */
  private async l1Fee(serialized: Hex): Promise<bigint> {
    // otto/mamoru#61: a chain without an L1 data fee (Monad) has no oracle to ask and nothing to add.
    if (!this.gas.l1Fee) return 0n
    try {
      return await this.client.readContract({ address: GAS_PRICE_ORACLE, abi: gasPriceOracleAbi, functionName: 'getL1Fee', args: [serialized] })
    } catch (e) {
      logErr('[relayer] L1 fee unreadable, bounded by the fallback:', e)
      return L1_FEE_FALLBACK_WEI
    }
  }

  /**
   * Sends and waits for the receipt. Gas is estimated with a 30% margin unless given. `onSending` runs once the reads
   * are done, right before the signed transaction goes to the provider: from there on a failure may have broadcast it.
   * `onSent` runs with the hash once the provider accepts it. `onSending` gets the most the transaction can cost in fees
   * (its gas limit at its signed maxFeePerGas, plus twice the L1 data fee of its bytes), an upper bound on what the
   * relayer pays for it, and the hash and relayer nonce of the signed transaction, known before anything leaves.
   */
  send(
    tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint },
    onSent?: (hash: Hex) => void,
    /** maxFeeWei: the most the transaction can cost; signed: its hash, relayer nonce and the maxFeePerGas it is signed with (#180). */
    onSending?: (maxFeeWei: bigint, signed: { hash: Hex; nonce: number; maxFeePerGas: bigint }) => void,
    /** #180: the hash of the signed transaction, before it is broadcast, so a caller can persist it first. */
    onSigned?: (hash: Hex, nonce: number) => void,
  ): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    if (this.refusal !== null) return Promise.reject(new ReasonError('CHAIN_UNSUPPORTED', this.refusal))
    return this.lock.run(async () => {
      const wallet = createWalletClient({ account: this.account, chain: this.chain, transport: http(this.rpcUrl, { timeout: 60_000 }) })
      // Base rejects a tx over 2^24 gas (EIP-7825): the 30% margin must not push a fitting estimate over the cap.
      // otto/mamoru#61: on a gas-limit chain the margin is 10% and the cap is that chain's (relayerGasProfile).
      const est = tx.gas ?? ((await this.client.estimateGas({ account: this.account.address, to: tx.to, data: tx.data, value: tx.value })) * this.gas.margin.num) / this.gas.margin.den
      const gas = est > this.gas.cap ? this.gas.cap : est
      // A load-balanced provider can answer the count from a node that has not seen the previous transaction yet, and
      // the node that has would refuse the reused nonce. For LAST_SENT_MS after a send the count is never taken below
      // the one after it; later the count alone decides, so a transaction that was dropped cannot leave a gap for good.
      const counted = await this.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' })
      const last = this.lastSent
      const nonce = last && Date.now() - last.at < LAST_SENT_MS && counted <= last.nonce ? last.nonce + 1 : counted
      // Fees are read and the transaction signed here, so that after onSending the only request left is the send itself.
      const fees = await this.client.estimateFeesPerGas()
      const serializedTransaction = await this.account.signTransaction({
        chainId: this.chain.id,
        type: 'eip1559',
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        gas,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
      // The most it can cost: execution at its signed maxFeePerGas plus the L1 data fee for these bytes, doubled for the L1
      // price moving before inclusion. Only read when someone needs the bound.
      if (onSending) onSending(gas * fees.maxFeePerGas + 2n * (await this.l1Fee(serializedTransaction)), { hash: keccak256(serializedTransaction), nonce, maxFeePerGas: fees.maxFeePerGas })
      onSigned?.(keccak256(serializedTransaction), nonce)
      const hash = await wallet.sendRawTransaction({ serializedTransaction })
      this.lastSent = { nonce, at: Date.now() }
      onSent?.(hash)
      try {
        return { hash, receipt: await this.receipt(hash) }
      } finally {
        // The window runs from the end of the send, receipt wait included: the next send starts right after it.
        this.lastSent = { nonce, at: Date.now() }
      }
    })
  }
}
