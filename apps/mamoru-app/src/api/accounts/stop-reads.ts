import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { smartSessionV4Abi } from '@mamoru/account/one-auth'
import { quoteExactInputSingleAbi, type StopQuote } from '@mamoru/account/stop'
import { address, type Registry } from '@mamoru/registry'
import { rpc } from './chain-funding.ts'
import { MAX_PROVIDERS, type ChainFetch } from './other-chains.ts'

// otto/mamoru#430 review, #434: what the Worker reads itself before a Stop may be signed, so it is not only the
// operator's word: every session SmartSession lists as enabled on the Safe, and QuoterV2's answer for each swap back to USDC.

async function quotesOf(fetcher: ChainFetch, url: string, registry: Registry, swaps: readonly StopQuote[]): Promise<bigint[]> {
  const quoter = address('QuoterV2', registry)
  const out: bigint[] = []
  for (const sw of swaps) {
    const data = encodeFunctionData({ abi: quoteExactInputSingleAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: sw.tokenIn, tokenOut: sw.tokenOut, amountIn: sw.amountIn, fee: sw.fee, sqrtPriceLimitX96: 0n }] })
    const raw = await rpc(fetcher, url, 'eth_call', [{ to: quoter, data }, 'latest'])
    out.push(decodeFunctionResult({ abi: quoteExactInputSingleAbi, functionName: 'quoteExactInputSingle', data: raw as Hex })[0])
  }
  return out
}

/** SmartSession.getPermissionIDs(safe): every session enabled on the Safe now. */
async function enabledOf(fetcher: ChainFetch, url: string, registry: Registry, safe: Address): Promise<Hex[]> {
  const data = encodeFunctionData({ abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [safe] })
  const raw = await rpc(fetcher, url, 'eth_call', [{ to: address('SmartSession', registry), data }, 'latest'])
  return [...decodeFunctionResult({ abi: smartSessionV4Abi, functionName: 'getPermissionIDs', data: raw as Hex })] as Hex[]
}

/**
 * The sessions enabled on `safe` and QuoterV2's answer for each of `swaps`, all from the first provider of `urls` that
 * answers every read (two providers' values are never combined); null when no provider answers.
 */
export async function readStopChain(fetcher: ChainFetch, urls: readonly string[], registry: Registry, safe: Address, swaps: readonly StopQuote[]): Promise<{ enabled: Hex[]; quotes: bigint[] } | null> {
  for (const [i, url] of urls.slice(0, MAX_PROVIDERS).entries()) {
    try {
      return { enabled: await enabledOf(fetcher, url, registry, safe), quotes: swaps.length ? await quotesOf(fetcher, url, registry, swaps) : [] }
    } catch {
      // The URL carries a key and a foreign error may quote it: the provider is named by its place in the list.
      console.error('stop check read failed', registry.chainId, `provider ${i + 1} of ${urls.length}`)
    }
  }
  return null
}
