import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import { quoteExactInputSingleAbi, type StopQuote } from '@mamoru/account/stop'
import { address, type Registry } from '@mamoru/registry'
import { rpc } from './chain-funding.ts'
import { MAX_PROVIDERS, type ChainFetch } from './other-chains.ts'

// otto/mamoru#430 review: what the Worker reads itself before a Stop may be signed, so each swap's minimum out is not
// only the operator's word: QuoterV2's answer for each swap back to USDC.

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

/**
 * QuoterV2's answer for each of `swaps`, from the first provider of `urls` that answers all of them (two providers' values
 * are never combined); `[]` without a read when there is no swap; null when no provider answers.
 */
export async function readStopQuotes(fetcher: ChainFetch, urls: readonly string[], registry: Registry, swaps: readonly StopQuote[]): Promise<bigint[] | null> {
  if (!swaps.length) return []
  for (const [i, url] of urls.slice(0, MAX_PROVIDERS).entries()) {
    try {
      return await quotesOf(fetcher, url, registry, swaps)
    } catch {
      // The URL carries a key and a foreign error may quote it: the provider is named by its place in the list.
      console.error('stop quote read failed', registry.chainId, `provider ${i + 1} of ${urls.length}`)
    }
  }
  return null
}
