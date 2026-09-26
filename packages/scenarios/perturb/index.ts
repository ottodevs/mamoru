import { toHex } from 'viem'
import type { Hex } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import type { Lab } from '../fixtures/lab.ts'
import { startAnvil, postStartChecks, type AnvilHandle } from '../fork/anvil.ts'
import { startEnginePort, type EnginePort } from '../proxy/index.ts'
import type { Manifest } from '../runner/manifest.ts'

/** `time-warp`: advances the clock and mines. */
export async function timeWarp(lab: Lab, seconds: number): Promise<void> {
  await lab.warp(seconds)
}

/** Preparation-phase write: replaces the runtime code of a registry entry (LAB-05). */
export async function setRegistryCode(lab: Lab, name: string, code: Hex = '0x00'): Promise<void> {
  await lab.rpc('anvil_setCode', [address(name), code])
}

/** A port in front of anvil whose eth_chainId answers another chain id (LAB-01). */
export function chainIdRewrite(anvilUrl: string, chainId: number): EnginePort {
  return startEnginePort(anvilUrl, (method, result) => (method === 'eth_chainId' ? toHex(chainId) : result))
}

/** Dumps the fork state to a file and returns its sha256. */
export async function dumpState(lab: Lab, path: string): Promise<string> {
  const hex = await lab.rpc<Hex>('anvil_dumpState')
  const bytes = Buffer.from(hex.slice(2), 'hex')
  await Bun.write(path, bytes)
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

/**
 * A second anvil of the same version on the catalog block, loading a dumped
 * state. Used for SESS-19 (chain id 31338) and M05 (reproduction).
 */
export async function secondFork(
  manifest: Manifest,
  forkUrl: string,
  opts: { chainId: number; statePath: string; logPath: string },
): Promise<AnvilHandle> {
  const handle = await startAnvil({
    forkUrl,
    forkBlock: manifest.fork.block,
    chainId: opts.chainId,
    slotsInAnEpoch: manifest.anvil.slotsInAnEpoch,
    loadStatePath: opts.statePath,
    logPath: opts.logPath,
  })
  await postStartChecks(handle.client, { chainId: opts.chainId, block: manifest.fork.block, blockHash: manifest.fork.blockHash, anvil: manifest.anvil })
  return handle
}
