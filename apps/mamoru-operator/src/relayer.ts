import { createWalletClient, defineChain, http, type Chain, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { Lock } from './lock.ts'

/** The relayer EOA: pays gas for Safe deploys, owner execTransactions, top-ups and handleOps bundles. One send at a time. */
export class Relayer {
  readonly account: PrivateKeyAccount
  private readonly lock = new Lock()
  private readonly chain: Chain

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
        console.log(`[relayer] receipt ${hash.slice(0, 10)} poll failed (${(e as Error).message.split('\n')[0]}), retrying`)
        await Bun.sleep(2_000)
      }
    }
  }

  /** Sends and waits for the receipt. Gas is estimated with a 30% margin unless given. */
  send(tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint }): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    return this.lock.run(async () => {
      const wallet = createWalletClient({ account: this.account, chain: this.chain, transport: http(this.rpcUrl, { timeout: 60_000 }) })
      const gas = tx.gas ?? ((await this.client.estimateGas({ account: this.account.address, to: tx.to, data: tx.data, value: tx.value })) * 13n) / 10n
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, gas })
      return { hash, receipt: await this.receipt(hash) }
    })
  }
}
