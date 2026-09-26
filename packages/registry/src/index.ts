import { getAddress, keccak256, type PublicClient } from 'viem'
import { ReasonError, type Address, type Hex } from '@mamoru/domain'
import base from '../base.json' with { type: 'json' }

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

export const baseRegistry: Registry = {
  ...(base as Omit<Registry, 'entries'>),
  entries: (base.entries as RegistryEntry[]).map((e) => ({ ...e, address: getAddress(e.address) })),
}

export type RegistryName = string

export function entry(name: RegistryName, registry: Registry = baseRegistry): RegistryEntry {
  const found = registry.entries.find((e) => e.name === name)
  if (!found) throw new ReasonError('POLICY_TARGET_NOT_IN_REGISTRY', name)
  return found
}

export function address(name: RegistryName, registry: Registry = baseRegistry): Address {
  return entry(name, registry).address
}

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

export async function assertCodeHashes(client: PublicClient, registry: Registry = baseRegistry): Promise<CodeHashCheck[]> {
  const checks = await checkCodeHashes(client, registry)
  const bad = checks.filter((c) => !c.ok)
  if (bad.length > 0) {
    throw new ReasonError('LAB_REGISTRY_CODE_MISMATCH', bad.map((c) => c.name).join(', '))
  }
  return checks
}
