// Spec 007 (otto/mamoru#151), task T1. Test-only "v4" grant encoding: a SmartSession Session with
// MamoruActionPolicy added as a SECOND action policy next to UniActionPolicy, on the actions the policy binds
// (spec 007 "How SmartSession calls it" / "Grant changes it implies (T2)"). This is scenario-fixture code, not
// production: T2 (packages/policy) owns the real grant builders and must fold this in (or replace it) when the
// v4 grants ship. Nothing here is imported by packages/policy or packages/account.
import { createWalletClient, encodeAbiParameters, encodeDeployData, encodeFunctionData, http, type Abi } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address, Hex } from '@mamoru/domain'
import { address, moduleRegistryAbi } from '@mamoru/registry'
import type { ResolvedActionRule, SessionGrant } from '@mamoru/policy'
import { ATTESTATION_SCHEMA_UID, toSmartSession, uniActionInitData, type ActionData, type SmartSessionStruct } from '@mamoru/account/sessions'
import type { Lab } from '../fixtures/lab.ts'
import { repoPath } from '../runner/manifest.ts'

// Signatures as grants.ts (packages/policy/src/grants.ts) spells them. Kept local: that file does not export them.
export const APPROVE_SIG = 'approve(address,uint256)'
export const EXACT_INPUT_SINGLE_SIG = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'
export const MINT_SIG = 'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))'
export const DECREASE_SIG = 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))'
export const COLLECT_SIG = 'collect((uint256,address,uint128,uint128))'
export const BURN_SIG = 'burn(uint256)'

export const ARTIFACT_PATH = repoPath('contracts/action-policy/out/MamoruActionPolicy.sol/MamoruActionPolicy.json')

export type PolicyArtifact = { abi: Abi; bytecode: Hex }

/** Reads the Foundry build artifact. Needs `cd contracts/action-policy && ./install.sh && forge build` first. */
export async function loadPolicyArtifact(path = ARTIFACT_PATH): Promise<PolicyArtifact> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`no build artifact at ${path}: run (cd contracts/action-policy && ./install.sh && forge build) first`)
  }
  const json = (await file.json()) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: json.abi, bytecode: json.bytecode.object }
}

/** Deploys MamoruActionPolicy on the fork, constructor args from the registry (same addresses the Foundry PoC uses). */
export async function deployMamoruPolicy(lab: Lab, artifact: PolicyArtifact, deployer: PrivateKeyAccount): Promise<Address> {
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [address('SmartSession'), address('NonfungiblePositionManager'), address('SwapRouter02'), address('UniswapV3Factory')],
  })
  const wallet = createWalletClient({ account: deployer, chain: lab.chain, transport: http(lab.url, { timeout: 120_000 }) })
  const hash = await wallet.sendTransaction({ data, gas: 6_000_000n })
  const receipt = await lab.client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`MamoruActionPolicy deployment failed (tx ${hash})`)
  return receipt.contractAddress
}

/** Mirrors `MamoruActionPolicy.Init` (contracts/action-policy/src/MamoruActionPolicy.sol). */
export type MamoruInit = {
  pool: Address
  twapWindow: number
  bandTicks: number
  generation: bigint
  budgetWindow: number
  perWindow0: bigint
  perWindow1: bigint
  total0: bigint
  total1: bigint
}

const INIT_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'pool', type: 'address' },
      { name: 'twapWindow', type: 'uint32' },
      { name: 'bandTicks', type: 'uint24' },
      { name: 'generation', type: 'uint64' },
      { name: 'budgetWindow', type: 'uint32' },
      { name: 'perWindow0', type: 'uint128' },
      { name: 'perWindow1', type: 'uint128' },
      { name: 'total0', type: 'uint128' },
      { name: 'total1', type: 'uint128' },
    ],
  },
] as const

/** `abi.encode(Init)`: a static struct, so this is exactly what Solidity's `abi.decode(data, (Init))` expects. */
export function encodeMamoruInit(i: MamoruInit): Hex {
  return encodeAbiParameters(INIT_TUPLE, [i])
}

/**
 * The ERC-7484 resolverUID that Mamoru's already-registered policy modules (TimeFramePolicy, UsageLimitPolicy,
 * UniActionPolicy) are registered under on Base. T1 found empirically that `attest` reverts for a module address
 * with no `ModuleRecord` (custom error `0x4eb2dcd7`, the module address as its only argument): a brand-new
 * contract must be `registerModule`'d before any account can attest it. The resolver this reads back
 * (`0xF0f468571e764664c93308504642aF941d9f77F1` at the pinned fork block, owned by the RhinestoneAttester
 * contract itself) accepted `registerModule` from an ordinary, unprivileged account in the Lab — that is worth a
 * second look before T7 deploys for real; it is not established that this resolver is meant to take arbitrary
 * third-party modules, only that it did not revert here.
 */
export async function resolverUidOf(lab: Lab, reference: Address): Promise<Hex> {
  const found = await lab.client.readContract({ address: address('ModuleRegistry'), abi: moduleRegistryAbi, functionName: 'findModule', args: [reference] })
  return found.resolverUID
}

/** One-time, per deployed MamoruActionPolicy CONTRACT (not per account): registers the module address in the
 * ERC-7484 registry so any account can later self-attest it. Production (T7) would do this once at deploy time. */
export function registerMamoruPolicyCall(policy: Address, resolverUID: Hex): { to: Address; value: bigint; data: Hex } {
  return {
    to: address('ModuleRegistry'),
    value: 0n,
    data: encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'registerModule', args: [resolverUID, policy, '0x', '0x'] }),
  }
}

/** Owner call that self-attests MamoruActionPolicy for `account` (once per account), next to the existing
 * `registryTrustCalls` self-attestation of TimeFramePolicy/UsageLimitPolicy (account/sessions/index.ts). Needs
 * the module registered first (`registerMamoruPolicyCall`), once per policy contract. */
export function attestMamoruPolicyCall(policy: Address): { to: Address; value: bigint; data: Hex } {
  return {
    to: address('ModuleRegistry'),
    value: 0n,
    data: encodeFunctionData({
      abi: moduleRegistryAbi,
      functionName: 'attest',
      args: [ATTESTATION_SCHEMA_UID, [{ moduleAddress: policy, expirationTime: 0, data: '0x', moduleTypes: [] }]],
    }),
  }
}

function find(actions: ResolvedActionRule[], signature: string): ResolvedActionRule {
  const a = actions.find((x) => x.signature === signature)
  if (!a) throw new Error(`grant has no action ${signature}`)
  return a
}

function dualPolicy(action: ResolvedActionRule, mamoruPolicy: Address, mamoruInit: Hex, targetOverride?: Address): ActionData {
  return {
    actionTargetSelector: action.selector,
    actionTarget: targetOverride ?? action.targetAddress,
    actionPolicies: [
      { policy: address('UniActionPolicy'), initData: uniActionInitData(action) },
      { policy: mamoruPolicy, initData: mamoruInit },
    ],
  }
}

function withoutParam(action: ResolvedActionRule, field: string): ResolvedActionRule {
  return { ...action, params: action.params.filter((p) => p.field !== field) }
}

function withSpender(action: ResolvedActionRule, spender: Address): ResolvedActionRule {
  return { ...action, params: action.params.map((p) => (p.field === 'spender' ? { ...p, ref: BigInt(spender) } : p)) }
}

/**
 * v4 `enter-swap`: the approve is unchanged; the swap drops UniActionPolicy's `sqrtPriceLimitX96 EQUAL 0` rule
 * (spec 007 "Grant changes it implies (T2)": that rule goes, `amountOutMinimum GREATER_THAN 0` stays) because a
 * policy-compliant swap needs a non-zero limit at the band edge. MamoruActionPolicy is added to both actions.
 */
export function buildV4EnterSwap(base: SessionGrant, mamoruPolicy: Address, mamoruInit: Hex): SmartSessionStruct {
  const scaffold = toSmartSession(base)
  const approveAction = find(base.actions, APPROVE_SIG)
  const swapAction = find(base.actions, EXACT_INPUT_SINGLE_SIG)
  return {
    ...scaffold,
    actions: [dualPolicy(approveAction, mamoruPolicy, mamoruInit), dualPolicy(withoutParam(swapAction, 'sqrtPriceLimitX96'), mamoruPolicy, mamoruInit)],
  }
}

/**
 * v4 `manage-any`: decrease/collect/burn unchanged (UniActionPolicy's own rules already allow any tokenId;
 * MamoruActionPolicy adds the admitted-set check). The two approvals move from the position manager to the
 * policy address (spec 007: "approves the policy, not the manager" — mint pulls from msg.sender). `mint`'s
 * target moves from the position manager to the policy (same selector: both are
 * `mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))`).
 */
export function buildV4ManageAny(base: SessionGrant, mamoruPolicy: Address, mamoruInit: Hex): SmartSessionStruct {
  const scaffold = toSmartSession(base)
  const decrease = find(base.actions, DECREASE_SIG)
  const collect = find(base.actions, COLLECT_SIG)
  const burn = find(base.actions, BURN_SIG)
  const approves = base.actions.filter((a) => a.signature === APPROVE_SIG)
  if (approves.length !== 2) throw new Error(`manage-any: expected 2 approve actions, found ${approves.length}`)
  const [approve0, approve1] = approves as [ResolvedActionRule, ResolvedActionRule]
  const mint = find(base.actions, MINT_SIG)
  return {
    ...scaffold,
    actions: [
      dualPolicy(decrease, mamoruPolicy, mamoruInit),
      dualPolicy(collect, mamoruPolicy, mamoruInit),
      dualPolicy(burn, mamoruPolicy, mamoruInit),
      dualPolicy(withSpender(approve0, mamoruPolicy), mamoruPolicy, mamoruInit),
      dualPolicy(withSpender(approve1, mamoruPolicy), mamoruPolicy, mamoruInit),
      dualPolicy(mint, mamoruPolicy, mamoruInit, mamoruPolicy),
    ],
  }
}
