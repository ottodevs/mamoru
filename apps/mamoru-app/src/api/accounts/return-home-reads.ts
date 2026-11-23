import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { smartSessionV4Abi } from '@mamoru/account/one-auth'
import { address, erc20Abi, type Registry } from '@mamoru/registry'
import { rpc } from './chain-funding.ts'
import { MAX_PROVIDERS, type ChainFetch } from './other-chains.ts'

// otto/mamoru#428 (spec 014, RH-03): what the Worker reads itself on the remote chain before a return home may be signed, so
// the amount and the sessions are not only the operator's word: the Safe's USDC balance and every session SmartSession
// lists as enabled on it.

async function call(fetcher: ChainFetch, url: string, to: Address, data: Hex): Promise<Hex> {
  return (await rpc(fetcher, url, 'eth_call', [{ to, data }, 'latest'])) as Hex
}

/** `token.balanceOf(safe)` from one provider. */
export async function balanceOf(fetcher: ChainFetch, url: string, token: Address, safe: Address): Promise<bigint> {
  const raw = await call(fetcher, url, token, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [safe] }))
  return decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: raw })
}

/** SmartSession.getPermissionIDs(safe): every session enabled on the Safe now. */
export async function enabledSessions(fetcher: ChainFetch, url: string, registry: Registry, safe: Address): Promise<Hex[]> {
  const raw = await call(fetcher, url, address('SmartSession', registry), encodeFunctionData({ abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [safe] }))
  return [...decodeFunctionResult({ abi: smartSessionV4Abi, functionName: 'getPermissionIDs', data: raw })] as Hex[]
}

/** The first provider of `urls` that answers every read of `read` (two providers' values are never combined); null when none does. */
export async function fromOneProvider<T>(urls: readonly string[], chainId: number, read: (url: string) => Promise<T>): Promise<T | null> {
  for (const [i, url] of urls.slice(0, MAX_PROVIDERS).entries()) {
    try {
      return await read(url)
    } catch {
      // The URL carries a key and a foreign error may quote it: the provider is named by its place in the list.
      console.error('return-home check read failed', chainId, `provider ${i + 1} of ${urls.length}`)
    }
  }
  return null
}

/** The Safe's USDC and its enabled sessions, from one provider; null when no provider answers both. */
export function readReturnHomeChain(fetcher: ChainFetch, urls: readonly string[], registry: Registry, safe: Address): Promise<{ usdc: bigint; enabled: Hex[] } | null> {
  return fromOneProvider(urls, registry.chainId, async (url) => ({ usdc: await balanceOf(fetcher, url, address('USDC', registry), safe), enabled: await enabledSessions(fetcher, url, registry, safe) }))
}

/**
 * Null when `removeIds` is exactly the set SmartSession lists as enabled on the Safe; else why not. A return home that
 * leaves a session enabled would leave its holder acting on the Safe after the owner signs; one that removes a session the
 * Safe never enabled is not the transaction this flow builds.
 */
export function sessionSetMismatch(removeIds: readonly string[], enabled: readonly Hex[]): string | null {
  const removed = new Set(removeIds.map((id) => id.toLowerCase()))
  const on = new Set(enabled.map((id) => id.toLowerCase()))
  const left = [...on].filter((id) => !removed.has(id)).length
  if (left) return `${left} enabled session(s) not revoked`
  const extra = [...removed].filter((id) => !on.has(id)).length
  return extra ? `${extra} session(s) revoked that the Safe does not have enabled` : null
}
