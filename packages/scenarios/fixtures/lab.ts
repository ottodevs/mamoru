import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, entryPointV07Abi, erc20Abi } from '@mamoru/registry'

/** anvil's public development keys (mnemonic "test test ... junk"). Never real funds. */
export const ANVIL_DEV_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
] as const satisfies readonly Hex[]

export function devAccount(index: number): PrivateKeyAccount {
  const key = ANVIL_DEV_KEYS[index]
  if (!key) throw new Error(`no anvil dev key ${index}`)
  return privateKeyToAccount(key)
}

export function forkChain(chainId: number, url: string): Chain {
  return defineChain({
    id: chainId,
    name: `fork-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  })
}

export type TxResult = { hash: Hex; receipt: TransactionReceipt; ok: boolean }

/**
 * Lab-side access to one anvil: public reads, signed sends from dev accounts,
 * impersonated sends and anvil_* methods. The engine never gets this object.
 */
export class Lab {
  readonly chain: Chain
  readonly client: PublicClient

  constructor(
    readonly url: string,
    readonly chainId: number,
  ) {
    this.chain = forkChain(chainId, url)
    this.client = createPublicClient({ chain: this.chain, transport: http(url, { timeout: 120_000 }) })
  }

  rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.client.request({ method: method as never, params: params as never }) as Promise<T>
  }

  async send(from: PrivateKeyAccount, to: Address, data: Hex, value = 0n, gas?: bigint): Promise<TxResult> {
    const wallet = createWalletClient({ account: from, chain: this.chain, transport: http(this.url, { timeout: 120_000 }) })
    const hash = await wallet.sendTransaction({ to, data, value, gas: gas ?? 15_000_000n })
    const receipt = await this.client.waitForTransactionReceipt({ hash })
    return { hash, receipt, ok: receipt.status === 'success' }
  }

  async sendAs(from: Address, to: Address, data: Hex, value = 0n): Promise<TxResult> {
    await this.rpc('anvil_impersonateAccount', [from])
    try {
      const hash = await this.rpc<Hex>('eth_sendTransaction', [
        { from, to, data, value: `0x${value.toString(16)}`, gas: '0xe4e1c0' },
      ])
      const receipt = await this.client.waitForTransactionReceipt({ hash })
      return { hash, receipt, ok: receipt.status === 'success' }
    } finally {
      await this.rpc('anvil_stopImpersonatingAccount', [from])
    }
  }

  async setBalance(who: Address, wei: bigint): Promise<void> {
    await this.rpc('anvil_setBalance', [who, `0x${wei.toString(16)}`])
  }

  async balanceOf(token: string, who: Address): Promise<bigint> {
    return this.client.readContract({ address: address(token), abi: erc20Abi, functionName: 'balanceOf', args: [who] })
  }

  /** ERC-20 transfer from an impersonated holder: a real Transfer event on the fork. */
  async whaleTransfer(token: string, whale: Address, to: Address, amount: bigint): Promise<TxResult> {
    await this.setBalance(whale, 10n ** 18n)
    const r = await this.sendAs(whale, address(token), encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }))
    if (!r.ok) throw new Error(`whale transfer of ${token} failed`)
    return r
  }

  async snapshot(): Promise<Hex> {
    return this.rpc<Hex>('evm_snapshot')
  }

  async revert(id: Hex): Promise<boolean> {
    return this.rpc<boolean>('evm_revert', [id])
  }

  async timestamp(): Promise<bigint> {
    return (await this.client.getBlock()).timestamp
  }

  async warp(seconds: number): Promise<void> {
    await this.rpc('evm_increaseTime', [seconds])
    await this.rpc('evm_mine')
  }

  async entryPointNonce(sender: Address, key: bigint): Promise<bigint> {
    return this.client.readContract({ address: address('EntryPointV07'), abi: entryPointV07Abi, functionName: 'getNonce', args: [sender, key] })
  }
}

/** Decodes the EntryPoint FailedOp family from revert data. */
export function decodeEntryPointError(data: Hex | undefined): { name: string; reason?: string; inner?: Hex } | null {
  if (!data || data === '0x') return null
  try {
    const d = decodeErrorResult({ abi: entryPointV07Abi, data })
    if (d.errorName === 'FailedOp') return { name: 'FailedOp', reason: d.args[1] }
    if (d.errorName === 'FailedOpWithRevert') return { name: 'FailedOpWithRevert', reason: d.args[1], inner: d.args[2] }
    return { name: d.errorName }
  } catch {
    return { name: 'unknown' }
  }
}
