import type { PublicClient } from 'viem'
import { BASE_CHAIN_ID, ReasonError } from '@mamoru/domain'
import { address, assertCodeHashes, baseRegistry, entry, isDeployed, moduleRegistryAbi, readCodeHash, type Registry, type RegistryEntry } from '@mamoru/registry'
import { SELF_ATTESTED_POLICIES } from '@mamoru/account/sessions'

/**
 * otto/mamoru#61: every name the account, session and Safe encoders of @mamoru/account resolve on an owner or engine
 * write. They now read the chain's registry; on a chain other than Base each one must still be the very contract Base
 * runs (same CREATE2 address): the app derives a Safe's counterfactual address with Base's, and a Safe whose address
 * the operator computes differently is refused (ACCOUNT_MISMATCH) rather than written to.
 */
export const ACCOUNT_STACK = [
  'EntryPointV07',
  'SafeL2_141',
  'SafeProxyFactory_141',
  'Safe7579',
  'Safe7579Launchpad',
  'ModuleRegistry',
  'RhinestoneAttester',
  'SmartSession',
  'OwnableValidator',
  'UniActionPolicy',
  'TimeFramePolicy',
  'UsageLimitPolicy',
  'SafeWebAuthnSharedSigner',
  'P256Verifier',
  'MultiSend_141',
  'MultiSendCallOnly_141',
  'Multicall3',
] as const

/**
 * otto/mamoru#61: the registry an operator opted into writing to a chain other than Base writes with, or a refusal
 * (the operator does not start). Read at boot, against the chain itself:
 * 1. Every ACCOUNT_STACK name the chain's registry lists has Base's address.
 * 2. The session userOp policies the account self-attests (TimeFramePolicy, UsageLimitPolicy) that the chain's pinned
 *    registry does not list (Monad: not deployed when monad.json was pinned) must be on the chain at Base's address
 *    with Base's pinned code hash (deployed the way Base deployed them, #62): they join the registry with that hash.
 *    Missing or different code: SESSION_POLICY_UNAVAILABLE_ON_CHAIN.
 * 3. Every ACCOUNT_STACK name then resolves, and every entry of the result has its pinned code hash on the chain
 *    (LAB_REGISTRY_CODE_MISMATCH otherwise): nothing is written to an address whose code is not the one pinned.
 * 4. Each of those policies has a ModuleRecord in the chain's ERC-7484 registry (the activation self-attests them; the
 *    registry refuses to attest a module without one): SESSION_ATTESTATION_UNAVAILABLE_ON_CHAIN otherwise.
 * Base's own registry is returned as it is: none of this runs for it.
 */
export async function writeRegistry(client: PublicClient, registry: Registry): Promise<Registry> {
  if (registry.chainId === BASE_CHAIN_ID) return registry
  const differ = ACCOUNT_STACK.filter((n) => isDeployed(n, registry) && address(n, registry).toLowerCase() !== address(n, baseRegistry).toLowerCase())
  if (differ.length) throw new ReasonError('REGISTRY_CHAIN_MISMATCH', `account stack on ${registry.chain} differs from Base: ${differ.join(', ')}`)
  const extra: RegistryEntry[] = []
  for (const name of SELF_ATTESTED_POLICIES) {
    if (isDeployed(name, registry)) continue
    const base = entry(name, baseRegistry)
    const hash = await readCodeHash(client, base.address)
    if (hash === null) throw new ReasonError('SESSION_POLICY_UNAVAILABLE_ON_CHAIN', `${name} has no code at ${base.address} on ${registry.chain}: deploy it as on Base before opting into writes`)
    if (hash !== base.codeHash) throw new ReasonError('SESSION_POLICY_UNAVAILABLE_ON_CHAIN', `${name} at ${base.address} on ${registry.chain} is not Base's code (${hash})`)
    extra.push({ ...base })
  }
  const out: Registry = { ...registry, entries: [...registry.entries, ...extra], undeployed: registry.undeployed.filter((n) => !extra.some((e) => e.name === n)) }
  for (const name of ACCOUNT_STACK) entry(name, out)
  await assertCodeHashes(client, out)
  for (const name of SELF_ATTESTED_POLICIES) {
    // The registry's own test for a ModuleRecord (ModuleNotFoundInRegistry): a zero resolver UID.
    const rec = (await client.readContract({ address: address('ModuleRegistry', out), abi: moduleRegistryAbi, functionName: 'findModule', args: [address(name, out)] })) as { resolverUID: string }
    if (BigInt(rec.resolverUID) === 0n) throw new ReasonError('SESSION_ATTESTATION_UNAVAILABLE_ON_CHAIN', `${name} has no ModuleRecord in ${registry.chain}'s ModuleRegistry: the activation could not attest it`)
  }
  return out
}
