import { decodeFunctionResult, encodeFunctionData } from 'viem'
import { quoteExactInputSingleAbi, type StopNeeds } from '@mamoru/account/stop-check'
import { address, type Registry } from '@mamoru/registry'
import { rpc } from './chain-funding.ts'
import { MAX_PROVIDERS, type ChainFetch } from './other-chains.ts'

// otto/mamoru#430: what the Worker reads itself before a Stop may be signed, so its amounts are not only the operator's
// word: QuoterV2's answer for each swap back to USDC and, for a Stop the Safe pays for, the chain's gas price.

/** One provider's answer for every read `needs` asks; throws when any of them fails. */
async function readOne(fetcher: ChainFetch, url: string, registry: Registry, needs: StopNeeds): Promise<{ quotes: bigint[]; gasPrice: bigint | null }> {
  const quoter = address('QuoterV2', registry)
  const quotes: bigint[] = []
  for (const sw of needs.swaps) {
    const data = encodeFunctionData({ abi: quoteExactInputSingleAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: sw.tokenIn, tokenOut: sw.tokenOut, amountIn: sw.amountIn, fee: sw.fee, sqrtPriceLimitX96: 0n }] })
    const out = await rpc(fetcher, url, 'eth_call', [{ to: quoter, data }, 'latest'])
    quotes.push(decodeFunctionResult({ abi: quoteExactInputSingleAbi, functionName: 'quoteExactInputSingle', data: out as `0x${string}` })[0])
  }
  const gasPrice = needs.refundGasPrice === null ? null : BigInt(await rpc(fetcher, url, 'eth_gasPrice', [], true))
  return { quotes, gasPrice }
}

/**
 * The reads of `needs` from the first provider of `urls` that answers all of them (values of two providers are never
 * combined); `{ quotes: [], gasPrice: null }` without a read when nothing needs one; null when no provider answers.
 */
export async function readStopBounds(fetcher: ChainFetch, urls: readonly string[], registry: Registry, needs: StopNeeds): Promise<{ quotes: bigint[]; gasPrice: bigint | null } | null> {
  if (!needs.swaps.length && needs.refundGasPrice === null) return { quotes: [], gasPrice: null }
  for (const [i, url] of urls.slice(0, MAX_PROVIDERS).entries()) {
    try {
      return await readOne(fetcher, url, registry, needs)
    } catch {
      // The URL carries a key and a foreign error may quote it: the provider is named by its place in the list.
      console.error('stop check read failed', registry.chainId, `provider ${i + 1} of ${urls.length}`)
    }
  }
  return null
}
