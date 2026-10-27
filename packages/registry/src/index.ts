import { getAddress, keccak256, type PublicClient } from 'viem'
import { ReasonError, type Address, type Hex } from '@mamoru/domain'
import base from '../base.json' with { type: 'json' }
import monad from '../monad.json' with { type: 'json' }

export * from './abis.ts'

export type RegistryKind =
  | 'token'
  | 'uniswap'
  | 'pool'
  | 'erc4337'
  | 'safe'
  | 'erc7579'
  | 'erc7484'
  | 'smart-sessions'
  | 'smart-sessions-policy'
  | 'read'
  | 'cctp'
  | 'vault'

export type RegistryEntry = {
  name: string
  kind: RegistryKind
  role: string
  address: Address
  codeHash: Hex | null
  decimals?: number
  token0?: string
  token1?: string
  fee?: number
  tickSpacing?: number
  /** kind 'vault' (otto/mamoru#210): the ERC-4626 `asset()`, a token of the same registry. `decimals` are the share's. */
  asset?: string
  /** kind 'vault': how the app and the owner's summaries name it ("Morpho · Gauntlet USDC Prime"). */
  label?: string
  /** A proxy whose logic sits elsewhere (EIP-1967): the implementation pinned beside the proxy's own code hash. */
  implementation?: { address: Address; codeHash: Hex }
}

export type Registry = {
  chain: string
  chainId: number
  block: number
  blockHash: Hex
  entries: RegistryEntry[]
  /**
   * Names the code needs but that have no address on this chain yet (spec 007: MamoruActionPolicyV2 and its guardian
   * before their deployment). `entry`/`address` refuse them like an unknown name, so nothing can target them;
   * `isDeployed` says which they are. Deploying one moves it into `entries` with its address and code hash.
   */
  undeployed: string[]
}

type RegistryFile = { chain: string; chainId: number; block: number; blockHash: string; entries: unknown[]; undeployed?: { name: string; address: null }[] }

function load(file: RegistryFile): Registry {
  const entries = (file.entries as RegistryEntry[]).map((e) => ({ ...e, address: getAddress(e.address) }))
  const undeployed = (file.undeployed ?? []).map((u) => {
    if (u.address !== null) throw new Error(`${file.chain} registry: undeployed ${u.name} has an address; move it to entries`)
    if (entries.some((e) => e.name === u.name)) throw new Error(`${file.chain} registry: ${u.name} is both deployed and undeployed`)
    return u.name
  })
  return { chain: file.chain, chainId: file.chainId, block: file.block, blockHash: file.blockHash as Hex, entries, undeployed }
}

export const baseRegistry: Registry = load(base)
export const monadRegistry: Registry = load(monad)

/**
 * One registry per chain. Selection is by chain id only; there is no cross-chain fallback. A chain joins by
 * adding its pinned `<chain>.json` and its entry here: nothing else in this package names a chain.
 */
export const registries: readonly Registry[] = [baseRegistry, monadRegistry]

/** The registry of `chainId`, or CHAIN_UNSUPPORTED. */
export function registryFor(chainId: number): Registry {
  const found = registries.find((r) => r.chainId === chainId)
  if (!found) throw new ReasonError('CHAIN_UNSUPPORTED', `no registry for chain id ${chainId}`)
  return found
}

/**
 * REGISTRY_CHAIN_MISMATCH unless `registry` is the one of `sourceChainId`. Compare against the source chain id
 * (the chain whose contracts the piece reads), never the execution chain id: on a lab fork the two differ.
 */
export function assertRegistryChain(registry: Registry, sourceChainId: number): Registry {
  if (registry.chainId !== sourceChainId) {
    throw new ReasonError('REGISTRY_CHAIN_MISMATCH', `registry ${registry.chain} is chain id ${registry.chainId}, expected ${sourceChainId}`)
  }
  return registry
}

export type RegistryName = string

// The registry argument keeps a `baseRegistry` default while callers move to passing the registry of their
// chain. Omitting it is deprecated on every lookup below; the default is retired once no caller relies on it.

/** The entry named `name` in `registry`, or POLICY_TARGET_NOT_IN_REGISTRY. */
export function entry(name: RegistryName, registry: Registry): RegistryEntry
/** @deprecated Omitting `registry` binds the lookup to `baseRegistry`. Pass the registry of the chain. */
export function entry(name: RegistryName): RegistryEntry
export function entry(name: RegistryName, registry: Registry = baseRegistry): RegistryEntry {
  const found = registry.entries.find((e) => e.name === name)
  if (!found) throw new ReasonError('POLICY_TARGET_NOT_IN_REGISTRY', registry.undeployed?.includes(name) ? `${name} is not deployed on ${registry.chain}` : name)
  return found
}

/** The name has an address on `registry`'s chain (false for an `undeployed` name and for an unknown one). */
export function isDeployed(name: RegistryName, registry: Registry): boolean {
  return registry.entries.some((e) => e.name === name)
}

/** The address of the entry named `name` in `registry`. */
export function address(name: RegistryName, registry: Registry): Address
/** @deprecated Omitting `registry` binds the lookup to `baseRegistry`. Pass the registry of the chain. */
export function address(name: RegistryName): Address
export function address(name: RegistryName, registry: Registry = baseRegistry): Address {
  return entry(name, registry).address
}

/** The name of the entry at `addr` in `registry`, or undefined. */
export function nameOf(addr: Address, registry: Registry): RegistryName | undefined
/** @deprecated Omitting `registry` binds the lookup to `baseRegistry`. Pass the registry of the chain. */
export function nameOf(addr: Address): RegistryName | undefined
export function nameOf(addr: Address, registry: Registry = baseRegistry): RegistryName | undefined {
  const a = addr.toLowerCase()
  return registry.entries.find((e) => e.address.toLowerCase() === a)?.name
}

export type CodeHashCheck = {
  name: RegistryName
  address: Address
  expected: Hex | null
  actual: Hex | null
  ok: boolean
}

export async function readCodeHash(
  client: PublicClient,
  addr: Address,
  blockNumber?: bigint,
): Promise<Hex | null> {
  const code = await client.getCode(blockNumber === undefined ? { address: addr } : { address: addr, blockNumber })
  if (!code || code === '0x') return null
  return keccak256(code)
}

/** EIP-1967 implementation slot: keccak256('eip1967.proxy.implementation') - 1. */
export const EIP1967_IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

/**
 * otto/mamoru#210: a proxy entry (waBasUSDC) still points at its pinned implementation, and that code is unchanged. The
 * proxy's own code hash never moves on an upgrade, so this is the check that sees one. True for an entry without one.
 */
async function implementationHolds(client: PublicClient, e: RegistryEntry, blockNumber?: bigint): Promise<boolean> {
  if (!e.implementation) return true
  const at = blockNumber === undefined ? {} : { blockNumber }
  const slot = await client.getStorageAt({ address: e.address, slot: EIP1967_IMPLEMENTATION_SLOT, ...at })
  if (!slot || `0x${slot.slice(-40)}`.toLowerCase() !== e.implementation.address.toLowerCase()) return false
  return (await readCodeHash(client, e.implementation.address, blockNumber)) === e.implementation.codeHash
}

/**
 * otto/mamoru#210 (review of #152): the code an op is about to send money to is the pinned one, read at `blockNumber`:
 * the vault's own code hash and, behind a proxy, the implementation slot and that code's hash. The boot check runs once;
 * an upgrade after it must still stop every later deposit, so the engine calls this at every vault op's prepare.
 * Throws LAB_REGISTRY_CODE_MISMATCH (or OBS_RPC_UNAVAILABLE when the chain cannot answer).
 */
export async function assertPinnedCode(client: PublicClient, registry: Registry, name: RegistryName, blockNumber: bigint): Promise<void> {
  const e = entry(name, registry)
  let ok: boolean
  try {
    ok = e.codeHash !== null && (await readCodeHash(client, e.address, blockNumber)) === e.codeHash && (await implementationHolds(client, e, blockNumber))
  } catch (err) {
    throw new ReasonError('OBS_RPC_UNAVAILABLE', `${name} code at ${blockNumber}: ${(err as Error).message.split('\n')[0]}`)
  }
  if (!ok) throw new ReasonError('LAB_REGISTRY_CODE_MISMATCH', `${name} at ${blockNumber} is not the pinned code${e.implementation ? ' (or its proxy implementation changed)' : ''}`)
}

/** LAB-05: every registry entry must carry a pinned code hash and match it on the connected chain. */
export function checkCodeHashes(client: PublicClient, registry: Registry): Promise<CodeHashCheck[]>
/** @deprecated Omitting `registry` checks `baseRegistry`. Pass the registry of the chain. */
export function checkCodeHashes(client: PublicClient): Promise<CodeHashCheck[]>
export async function checkCodeHashes(
  client: PublicClient,
  registry: Registry = baseRegistry,
): Promise<CodeHashCheck[]> {
  const checks = await Promise.all(
    registry.entries.map(async (e) => {
      const actual = await readCodeHash(client, e.address)
      const ok = e.codeHash !== null && actual === e.codeHash && (await implementationHolds(client, e))
      return { name: e.name, address: e.address, expected: e.codeHash, actual, ok }
    }),
  )
  return checks
}

/** `checkCodeHashes`, throwing LAB_REGISTRY_CODE_MISMATCH with the names that fail. */
export function assertCodeHashes(client: PublicClient, registry: Registry): Promise<CodeHashCheck[]>
/** @deprecated Omitting `registry` checks `baseRegistry`. Pass the registry of the chain. */
export function assertCodeHashes(client: PublicClient): Promise<CodeHashCheck[]>
export async function assertCodeHashes(client: PublicClient, registry: Registry = baseRegistry): Promise<CodeHashCheck[]> {
  const checks = await checkCodeHashes(client, registry)
  const bad = checks.filter((c) => !c.ok)
  if (bad.length > 0) {
    throw new ReasonError('LAB_REGISTRY_CODE_MISMATCH', bad.map((c) => c.name).join(', '))
  }
  return checks
}
