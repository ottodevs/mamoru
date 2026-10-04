import { createWalletClient, defineChain, http, type Chain, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { Lock } from './lock.ts'
import { logErr } from './metrics.ts'

/** Per-tx gas cap on Base (EIP-7825). */
const TX_GAS_CAP = 16_777_216n
/** How long the nonce of the last accepted send overrules a provider count that has not caught up with it. */
const LAST_SENT_MS = 120_000

/** The relayer EOA: pays gas for Safe deploys, owner execTransactions, top-ups and handleOps bundles. One send at a time. */
export class Relayer {
  readonly account: PrivateKeyAccount
  private readonly lock = new Lock()
  private readonly chain: Chain
  /** Nonce and time of the last transaction a provider accepted from this process. */
  private lastSent: { nonce: number; at: number } | null = null

  constructor(
    key: Hex,
    private readonly client: PublicClient,
    private readonly rpcUrl: string,
    chainId: number,
  ) {
    this.account = privateKeyToAccount(key)
    this.chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
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

  /** Sends and waits for the receipt. Gas is estimated with a 30% margin unless given. */
  send(tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint }, onSent?: (hash: Hex) => void): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    return this.lock.run(async () => {
      const wallet = createWalletClient({ account: this.account, chain: this.chain, transport: http(this.rpcUrl, { timeout: 60_000 }) })
      // Base rejects a tx over 2^24 gas (EIP-7825): the 30% margin must not push a fitting estimate over the cap.
      const est = tx.gas ?? ((await this.client.estimateGas({ account: this.account.address, to: tx.to, data: tx.data, value: tx.value })) * 13n) / 10n
      const gas = est > TX_GAS_CAP ? TX_GAS_CAP : est
      // A load-balanced provider can answer the count from a node that has not seen the previous transaction yet, and
      // the node that has would refuse the reused nonce. For LAST_SENT_MS after a send the count is never taken below
      // the one after it; later the count alone decides, so a transaction that was dropped cannot leave a gap for good.
      const counted = await this.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' })
      const last = this.lastSent
      const nonce = last && Date.now() - last.at < LAST_SENT_MS && counted <= last.nonce ? last.nonce + 1 : counted
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, gas, nonce })
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
