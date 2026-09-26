import { createPublicClient, http } from 'viem'
import type { Hex } from '@mamoru/domain'
import { anvilBinaryVersion, assertAnvilVersion, postStartChecks, startAnvil, type AnvilHandle, type PostStartFacts } from './anvil.ts'
import type { Manifest } from '../runner/manifest.ts'
import { chainIdRewrite } from '../perturb/index.ts'

export type LabForkOptions = {
  manifest: Manifest
  forkUrl: string
  logPath: string
  chainId?: number
  forkBlock?: number | undefined | null
  /** LAB-01: answer eth_chainId with this value through a port in front of anvil. */
  rewriteChainId?: number
}

/**
 * The runner's only way to start a fork: pinned anvil binary, loopback fork
 * URL, never Base's chain id, then chain id, block hash and served version
 * checked before any step.
 */
export async function startLabFork(opts: LabForkOptions): Promise<{ handle: AnvilHandle; facts: PostStartFacts }> {
  const m = opts.manifest
  assertAnvilVersion(m.anvil, await anvilBinaryVersion())
  const chainId = opts.chainId ?? m.fork.chainId
  const handle = await startAnvil({
    forkUrl: opts.forkUrl,
    forkBlock: opts.forkBlock === null ? undefined : (opts.forkBlock ?? m.fork.block),
    chainId,
    slotsInAnEpoch: m.anvil.slotsInAnEpoch,
    logPath: opts.logPath,
  })
  const rewrite = opts.rewriteChainId !== undefined ? chainIdRewrite(handle.url, opts.rewriteChainId) : undefined
  try {
    const client = rewrite ? createPublicClient({ transport: http(rewrite.url) }) : handle.client
    const facts = await postStartChecks(client, { chainId: m.fork.chainId, block: m.fork.block, blockHash: m.fork.blockHash as Hex, anvil: m.anvil })
    return { handle, facts }
  } catch (e) {
    await handle.stop()
    throw e
  } finally {
    rewrite?.stop()
  }
}
