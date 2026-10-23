// otto/mamoru#62 on Monad mainnet: TimeFramePolicy and UsageLimitPolicy at their Base addresses, the way the Monad
// lab proved it (harness.ts deployBasePolicies): the Base creation calldata replayed byte for byte against the Arachnid
// CREATE2 deployer, then ModuleRegistry.registerModule under the resolverUID Base has for both. On mainnet the two go
// in ONE transaction (Multicall3.aggregate3, allowFailure false on both): registerModule is permissionless and the
// registry refuses a second registration of an address, so a deploy left unregistered for a block could be registered
// by anyone under another resolver, for good. registerModule stores sender = address(0) (Base's records of both
// policies have sender 0x0), so calling it through Multicall3 changes nothing in the record. This file holds the
// pure plan (what to send, given what the chain has) and the reads that feed it; scripts/monad/deploy-policies.ts
// signs and sends.
import { getContractAddress, keccak256, parseAbi, slice, encodeFunctionData, type Hex, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, entry, moduleRegistryAbi, monadRegistry } from '@mamoru/registry'
import basePolicies from './base-policies.json' with { type: 'json' }

export const MONAD_CHAIN_ID = 143
export const ZERO_UID = `0x${'0'.repeat(64)}` as Hex

export type PolicySpec = {
  name: string
  /** Base registry address, which the CREATE2 of `input` must equal. */
  address: Address
  codeHash: Hex
  /** Full calldata to the Arachnid deployer: salt (32 bytes) ++ init code. */
  input: Hex
  baseTx: Hex
}

/** The policies to put on Monad, each checked here (no network) to CREATE2 to its Base address. */
export function policySpecs(): PolicySpec[] {
  const deployer = basePolicies.deployer as Address
  return basePolicies.contracts.map((c) => {
    const base = entry(c.name, baseRegistry)
    const input = c.input as Hex
    const predicted = predictAddress(deployer, input)
    if (predicted.toLowerCase() !== base.address.toLowerCase()) throw new Error(`${c.name}: Base calldata creates ${predicted}, Base registry says ${base.address}`)
    if (!base.codeHash) throw new Error(`${c.name}: Base registry has no code hash`)
    return { name: c.name, address: base.address, codeHash: base.codeHash, input, baseTx: c.baseTx as Hex }
  })
}

export function predictAddress(deployer: Address, input: Hex): Address {
  return getContractAddress({ opcode: 'CREATE2', from: deployer, salt: slice(input, 0, 32), bytecode: slice(input, 32) })
}

export const ARACHNID_DEPLOYER = basePolicies.deployer as Address
export const RESOLVER_UID = basePolicies.moduleRecord.resolverUID as Hex
export const MODULE_REGISTRY: Address = address('ModuleRegistry', monadRegistry)
export const MULTICALL3: Address = address('Multicall3', monadRegistry)

export const multicall3Abi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)'])

/** What the target chain has for one policy. */
export type Observed = {
  /** Runtime code at the Base address on the target chain ('0x' when none). */
  code: Hex
  /** ModuleRegistry.findModule(address).resolverUID on the target chain. */
  resolverUID: Hex
}

/**
 * `deploy+register`: one Multicall3.aggregate3 tx, both calls allowFailure=false, so either both land or neither.
 * `register`: code already there (Base's), record missing. `deploy`: Base's record there but no code (not reachable
 * through this registry, which refuses to register an address without code; kept so the plan is total).
 */
export type Step = { kind: 'deploy+register' | 'deploy' | 'register'; name: string; to: Address; data: Hex; target: Address }

export type PolicyPlan = { spec: PolicySpec; deployed: boolean; registered: boolean; steps: Step[] }

export function registerData(target: Address): Hex {
  return encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'registerModule', args: [RESOLVER_UID, target, '0x', '0x'] })
}

export function deployAndRegisterData(spec: PolicySpec): Hex {
  return encodeFunctionData({
    abi: multicall3Abi,
    functionName: 'aggregate3',
    args: [[
      { target: ARACHNID_DEPLOYER, allowFailure: false, callData: spec.input },
      { target: MODULE_REGISTRY, allowFailure: false, callData: registerData(spec.address) },
    ]],
  })
}

/**
 * Idempotent plan for one policy: deploy only when the address has no code, register only when no ModuleRecord.
 * Fails closed on anything it cannot fix: foreign code at the address, or a record under another resolver.
 */
export function planPolicy(spec: PolicySpec, seen: Observed): PolicyPlan {
  const deployed = seen.code !== '0x' && seen.code.length > 2
  if (deployed && keccak256(seen.code) !== spec.codeHash) throw new Error(`${spec.name}: ${spec.address} has code of hash ${keccak256(seen.code)}, not Base's ${spec.codeHash}; refusing`)
  const registered = BigInt(seen.resolverUID) !== 0n
  if (registered && seen.resolverUID.toLowerCase() !== RESOLVER_UID.toLowerCase()) throw new Error(`${spec.name}: registered under resolver ${seen.resolverUID}, not Base's ${RESOLVER_UID}; refusing`)
  const steps: Step[] = []
  if (!deployed && !registered) steps.push({ kind: 'deploy+register', name: spec.name, to: MULTICALL3, data: deployAndRegisterData(spec), target: spec.address })
  else if (!deployed) steps.push({ kind: 'deploy', name: spec.name, to: ARACHNID_DEPLOYER, data: spec.input, target: spec.address })
  else if (!registered) steps.push({ kind: 'register', name: spec.name, to: MODULE_REGISTRY, data: registerData(spec.address), target: spec.address })
  return { spec, deployed, registered, steps }
}

export async function observe(client: PublicClient, spec: PolicySpec): Promise<Observed> {
  const code = ((await client.getCode({ address: spec.address })) ?? '0x') as Hex
  const record = await client.readContract({ address: MODULE_REGISTRY, abi: moduleRegistryAbi, functionName: 'findModule', args: [spec.address] })
  return { code, resolverUID: record.resolverUID as Hex }
}

/** Monad charges gas_limit x price, not gas used: the limit is the estimate plus a small margin, never a round guess. */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * 115n) / 100n + 5_000n
}

export type CostLine = { step: Step; estimate: bigint; limit: bigint }

export function totalCost(lines: CostLine[], pricePerGas: bigint): bigint {
  return lines.reduce((s, l) => s + l.limit * pricePerGas, 0n)
}

/** eth_estimateGas for each step from `from`, on the chain as it is (each step is self-contained). */
export async function estimate(client: PublicClient, from: Address, steps: Step[]): Promise<CostLine[]> {
  const out: CostLine[] = []
  for (const step of steps) {
    const est = await client.estimateGas({ account: from, to: step.to, data: step.data })
    out.push({ step, estimate: est, limit: gasLimitFor(est) })
  }
  return out
}

export function formatMon(wei: bigint): string {
  const neg = wei < 0n
  const v = neg ? -wei : wei
  const whole = v / 10n ** 18n
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, 6)
  return `${neg ? '-' : ''}${whole}.${frac}`
}

export const monadscan = {
  tx: (h: Hex) => `https://monadscan.com/tx/${h}`,
  address: (a: Address) => `https://monadscan.com/address/${a}`,
}
