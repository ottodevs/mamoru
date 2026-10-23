// otto/mamoru#62 on Monad mainnet: TimeFramePolicy and UsageLimitPolicy at their Base addresses, the way the Monad
// lab proved it (harness.ts deployBasePolicies): the Base creation calldata replayed byte for byte against the Arachnid
// CREATE2 deployer, then ModuleRegistry.registerModule under the resolverUID Base has for both. This file holds the
// pure plan (what to send, given what the chain has) and the reads that feed it; scripts/monad/deploy-policies.ts
// signs and sends.
import { getContractAddress, keccak256, slice, encodeFunctionData, type Hex, type PublicClient } from 'viem'
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

/** What the target chain has for one policy. */
export type Observed = {
  /** Runtime code at the Base address on the target chain ('0x' when none). */
  code: Hex
  /** ModuleRegistry.findModule(address).resolverUID on the target chain. */
  resolverUID: Hex
}

export type Step =
  | { kind: 'deploy'; name: string; to: Address; data: Hex; target: Address }
  | { kind: 'register'; name: string; to: Address; data: Hex; target: Address }

export type PolicyPlan = { spec: PolicySpec; deployed: boolean; registered: boolean; steps: Step[] }

export function registerData(target: Address): Hex {
  return encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'registerModule', args: [RESOLVER_UID, target, '0x', '0x'] })
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
  if (!deployed) steps.push({ kind: 'deploy', name: spec.name, to: ARACHNID_DEPLOYER, data: spec.input, target: spec.address })
  if (!registered) steps.push({ kind: 'register', name: spec.name, to: MODULE_REGISTRY, data: registerData(spec.address), target: spec.address })
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

export type CostLine = { step: Step; estimate: bigint; limit: bigint; estimatedWith: 'rpc' | 'rpc+override' }

export function totalCost(lines: CostLine[], pricePerGas: bigint): bigint {
  return lines.reduce((s, l) => s + l.limit * pricePerGas, 0n)
}

/**
 * eth_estimateGas for each step from `from`. A register step whose policy is not deployed yet is estimated with the
 * Base runtime code overridden at the address (ModuleRegistry reads the module's code), which is the state it will
 * see once the deploy step lands.
 */
export async function estimate(client: PublicClient, from: Address, steps: Step[], baseRuntime: Record<string, Hex>): Promise<CostLine[]> {
  const out: CostLine[] = []
  for (const step of steps) {
    const pendingDeploy = step.kind === 'register' && steps.some((s) => s.kind === 'deploy' && s.target === step.target)
    const est = await client.estimateGas({
      account: from,
      to: step.to,
      data: step.data,
      ...(pendingDeploy ? { stateOverride: [{ address: step.target, code: baseRuntime[step.name]! }] } : {}),
    })
    out.push({ step, estimate: est, limit: gasLimitFor(est), estimatedWith: pendingDeploy ? 'rpc+override' : 'rpc' })
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
