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
}

export type Registry = {
  chain: string
  chainId: number
  block: number
  blockHash: Hex
  entries: RegistryEntry[]
}

type RegistryFile = { chain: string; chainId: number; block: number; blockHash: string; entries: unknown[] }

function load(file: RegistryFile): Registry {
  return {
    chain: file.chain,
    chainId: file.chainId,
    block: file.block,
    blockHash: file.blockHash as Hex,
    entries: (file.entries as RegistryEntry[]).map((e) => ({ ...e, address: getAddress(e.address) })),
  }
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
  if (!found) throw new ReasonError('POLICY_TARGET_NOT_IN_REGISTRY', name)
  return found
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
      return { name: e.name, address: e.address, expected: e.codeHash, actual, ok: e.codeHash !== null && actual === e.codeHash }
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
