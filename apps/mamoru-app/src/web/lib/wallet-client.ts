import { createPublicClient, createWalletClient, custom, erc20Abi, getAddress, http, isAddressEqual, parseEventLogs, parseUnits, type EIP1193Provider, type Hex, type Log } from 'viem'
import { base } from 'viem/chains'

// Loaded on demand by the Connect wallet flow, so viem stays out of the first paint.
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const BASE_HEX = '0x2105'

type Rpc = {
  request: (a: { method: string; params?: unknown }) => Promise<unknown>
}

export async function connect(provider: EIP1193Provider): Promise<Hex> {
  const p = provider as unknown as Rpc
  const accounts = (await p.request({
    method: 'eth_requestAccounts',
  })) as string[]
  if (!accounts?.[0]) throw new Error('No account shared')
  try {
    await p.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_HEX }],
    })
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: BASE_HEX,
          chainName: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org'],
        },
      ],
    })
  }
  return getAddress(accounts[0]) as Hex
}

export async function usdcBalance(provider: EIP1193Provider, owner: Hex): Promise<bigint> {
  const pc = createPublicClient({ chain: base, transport: custom(provider) })
  return pc.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })
}

export async function sendUsdc(provider: EIP1193Provider, from: Hex, to: Hex, raw: bigint): Promise<Hex> {
  const wc = createWalletClient({
    account: from,
    chain: base,
    transport: custom(provider),
  })
  return wc.writeContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, raw],
  })
}

/**
 * otto/mamoru#191: waits for Base to include the transfer, read from Base itself (the wallet may have moved to
 * another network since). Returns the hash that landed when its receipt moves exactly `raw` USDC from `from` to `to`
 * (a sped-up transaction lands under a new hash); false when it reverted or was replaced by anything else (a cancel).
 */
export async function confirmed(hash: Hex, from: Hex, to: Hex, raw: bigint): Promise<Hex | false> {
  const pc = createPublicClient({ chain: base, transport: http() })
  const r = await pc.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 180_000 })
  return r.status === 'success' && movedUsdc(r.logs, from, to, raw) ? r.transactionHash : false
}

/** Whether the logs hold a USDC-on-Base Transfer of exactly `raw` from `from` to `to`. */
export function movedUsdc(logs: Log[], from: Hex, to: Hex, raw: bigint): boolean {
  return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs }).some(
    (l) => isAddressEqual(l.address, USDC_BASE) && isAddressEqual(l.args.from, from) && isAddressEqual(l.args.to, to) && l.args.value === raw,
  )
}

export function parseUsdc(s: string): bigint | null {
  const t = s.trim().replace(/,/g, '')
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return null
  return parseUnits(t, 6)
}
