import { baseRegistry, readCodeHash } from '@mamoru/registry'
import { startForkProxy } from '../proxy/index.ts'
import { postStartChecks, startAnvil } from '../fork/anvil.ts'
import { loadManifest, repoPath } from './manifest.ts'

/**
 * Reads the runtime code of every registry entry from the fork at the catalog
 * block and writes its keccak256 into packages/registry/base.json. Refuses to
 * run if the fork does not serve the catalog block hash.
 */
export async function pinRegistry(): Promise<void> {
  const manifest = await loadManifest()
  const proxy = startForkProxy()
  const anvil = await startAnvil({
    forkUrl: proxy.url,
    forkBlock: manifest.fork.block,
    chainId: manifest.fork.chainId,
    slotsInAnEpoch: manifest.anvil.slotsInAnEpoch,
    logPath: '/dev/null',
  })
  try {
    await postStartChecks(anvil.client, {
      chainId: manifest.fork.chainId,
      block: manifest.fork.block,
      blockHash: manifest.fork.blockHash,
      anvil: manifest.anvil,
    })
    const path = repoPath('packages/registry/base.json')
    const json = await Bun.file(path).json()
    for (const e of json.entries as { name: string; address: `0x${string}`; codeHash: string | null }[]) {
      const hash = await readCodeHash(anvil.client, e.address, BigInt(manifest.fork.block))
      if (!hash) throw new Error(`${e.name} has no code at ${manifest.fork.block}`)
      e.codeHash = hash
    }
    await Bun.write(path, JSON.stringify(json, null, 2) + '\n')
    const manifestPath = repoPath('scenarios/manifest.json')
    const m = await Bun.file(manifestPath).json()
    m.registry.codeHashes = Object.fromEntries(json.entries.map((e: { name: string; codeHash: string }) => [e.name, e.codeHash]))
    await Bun.write(manifestPath, JSON.stringify(m, null, 2) + '\n')
    console.log(`pinned ${json.entries.length} code hashes from block ${manifest.fork.block} (${baseRegistry.chain})`)
  } finally {
    await anvil.stop()
    proxy.stop()
  }
}
