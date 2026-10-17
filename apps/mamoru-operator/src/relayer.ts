import { createWalletClient, defineChain, http, keccak256, type Chain, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { Lock } from './lock.ts'
import { logErr } from './metrics.ts'
import { NOT_AFTER_HEADER, SEND_VERDICT_HEADER, isLoopback } from './rpc-proxy.ts'

/** Per-tx gas cap on Base (EIP-7825). */
const TX_GAS_CAP = 16_777_216n
/** How long the nonce of the last accepted send overrules a provider count that has not caught up with it. */
const LAST_SENT_MS = 120_000

/**
 * A job with a `notAfter` that could no longer be broadcast in time: dropped instead of sent. `code` is the job's own
 * (e.g. RESERVE_SWAP_EXPIRED). `maybeSent`: the proxy stopped it only after a provider had been handed the signed
 * transaction (and refused or did not answer), so it may be out and only the chain can say; otherwise nothing of
 * it reached a provider.
 */
export class SendExpired extends Error {
  constructor(
    readonly code: string,
    readonly notAfter: bigint,
    readonly now: bigint,
    readonly maybeSent = false,
  ) {
    super(`${code}: ${maybeSent ? 'stopped after a provider was asked, may be out' : 'not sent'}, unix time ${now} is at or past the job's limit ${notAfter}`)
  }
}

/**
 * Whether a send verdict header from `rpcUrl` can be the local proxy's own: only on loopback. A relayer pointed at
 * anything else (a provider directly) reads none, so no provider header can say "not sent".
 */
export function trustsVerdict(rpcUrl: string): boolean {
  try {
    return isLoopback(rpcUrl)
  } catch {
    return false
  }
}

/**
 * A send with a time limit that failed with no verdict from the proxy: whatever a provider answered, the transaction
 * may be out (a provider can say anything, the proxy's error code included). Only the chain can settle it.
 */
export class SendUnsettled extends Error {
  readonly maybeSent = true
  constructor(readonly code: string, cause: unknown) {
    super(`${code}: the send failed with no verdict from the proxy, it may be out: ${(cause as Error)?.message?.split('\n')[0] ?? cause}`, { cause })
  }
}

/** When a job may no longer go out: unix seconds (the caller's margin already taken off), and the code it fails with. */
export type NotAfter = { at: bigint; code: string }

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

  /**
   * Throws SendExpired when the later of the wall clock and the chain head is at or past `n.at`. A head that cannot be
   * read leaves the wall clock alone to decide: a head behind it changes nothing, so only a clock running late could
   * let a job through, and then by no more than its lag.
   */
  private async assertInTime(n: NotAfter): Promise<void> {
    let head = 0n
    try {
      head = (await this.client.getBlock()).timestamp
    } catch (e) {
      logErr('[relayer] chain head unavailable for a job with a time limit, wall clock only:', e)
    }
    // The clock is read after the head: however long that read took, it is counted.
    const wall = BigInt(Math.floor(Date.now() / 1000))
    const now = head > wall ? head : wall
    if (now >= n.at) throw new SendExpired(n.code, n.at, now)
  }

  /**
   * Sends and waits for the receipt. Gas is estimated with a 30% margin unless given. `onSending` runs once the reads
   * are done, right before the signed transaction goes to the provider: from there on a failure may have broadcast it.
   * `onSent` runs with the hash once the provider accepts it. `onSending` gets the hash and nonce of the signed
   * transaction, so a caller can keep them before anything leaves this process.
   * `notAfter`: the job carries a time limit (a swap deadline inside it). It is checked last, after the queue and every
   * read, right before the provider gets the transaction, against the later of this clock and the chain head; at or
   * past it the job throws SendExpired and nothing is broadcast. Every call is checked again, so a retry is too.
   * After the hand-over, only the proxy's verdict header says it stopped the send (SendExpired, `maybeSent` as it
   * says); any other failure of a job with a time limit is SendUnsettled.
   */
  send(tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint; notAfter?: NotAfter }, onSent?: (hash: Hex) => void, onSending?: (signed: { hash: Hex; nonce: number }) => void): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    return this.lock.run(async () => {
      // A job with a time limit: no transport retries (it is repeated only through this method, whose checks run
      // again), the limit in a header only the local proxy reads, and the proxy's verdict read from its answer.
      // Any other job keeps the transport's own retries.
      let verdict: string | null = null
      const wallet = createWalletClient({
        account: this.account,
        chain: this.chain,
        transport: tx.notAfter
          ? http(this.rpcUrl, {
              timeout: 60_000,
              retryCount: 0,
              fetchOptions: { headers: { [NOT_AFTER_HEADER]: tx.notAfter.at.toString() } },
              onFetchResponse: (res) => void (verdict = trustsVerdict(this.rpcUrl) ? res.headers.get(SEND_VERDICT_HEADER) : null),
            })
          : http(this.rpcUrl, { timeout: 60_000 }),
      })
      // Base rejects a tx over 2^24 gas (EIP-7825): the 30% margin must not push a fitting estimate over the cap.
      const est = tx.gas ?? ((await this.client.estimateGas({ account: this.account.address, to: tx.to, data: tx.data, value: tx.value })) * 13n) / 10n
      const gas = est > TX_GAS_CAP ? TX_GAS_CAP : est
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
      // The last step before the send: nothing but the send itself comes after it.
      if (tx.notAfter) await this.assertInTime(tx.notAfter)
      onSending?.({ hash: keccak256(serializedTransaction), nonce })
      let hash: Hex
      try {
        hash = await wallet.sendRawTransaction({ serializedTransaction })
      } catch (e) {
        if (!tx.notAfter) throw e
        const now = BigInt(Math.floor(Date.now() / 1000))
        if (verdict === 'not-sent') throw new SendExpired(tx.notAfter.code, tx.notAfter.at, now, false)
        if (verdict === 'maybe-sent') throw new SendExpired(tx.notAfter.code, tx.notAfter.at, now, true)
        throw new SendUnsettled(tx.notAfter.code, e)
      }
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
