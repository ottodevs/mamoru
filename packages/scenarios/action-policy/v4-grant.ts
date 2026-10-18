// Spec 007 (otto/mamoru#151), task T1. Test-only "v4" grant encoding: a SmartSession Session with
// MamoruActionPolicy added as a SECOND action policy next to UniActionPolicy, on the actions the policy binds
// (spec 007 "How SmartSession calls it" / "Grant changes it implies (T2)"). This is scenario-fixture code, not
// production: T2 (packages/policy) owns the real grant builders and must fold this in (or replace it) when the
// v4 grants ship. Nothing here is imported by packages/policy or packages/account.
import { encodeDeployData, encodeFunctionData, encodePacked, parseAbi, type Abi } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address, Hex } from '@mamoru/domain'
import { address, moduleRegistryAbi } from '@mamoru/registry'
import { encodeMamoruInit, type MamoruInit, type ResolvedActionRule, type SessionGrant } from '@mamoru/policy'
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

export { encodeMamoruInit, type MamoruInit }

const registryDeployAbi = parseAbi([
  'function deployModule(bytes32 salt, bytes32 resolverUID, bytes initCode, bytes metadata, bytes resolverContext) payable returns (address)',
])
const poolCardinalityAbi = parseAbi([
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16 observationCardinalityNext, uint8, bool)',
  'function increaseObservationCardinalityNext(uint16 observationCardinalityNext)',
])

/**
 * Deploys MamoruActionPolicy on the fork the way T7 must (spec 007 T6 L-3, contracts/action-policy/script/
 * Deploy.s.sol): ONE `ModuleRegistry.deployModule` transaction creates the contract with CREATE2 and writes its
 * ERC-7484 ModuleRecord under TimeFramePolicy's resolver, so nobody can register it first under another resolver.
 * The salt starts with the deployer's address, which the registry requires of anyone else using it. Constructor
 * args from the registry (same addresses the Foundry PoC uses).
 */
export async function deployMamoruPolicy(lab: Lab, artifact: PolicyArtifact, deployer: PrivateKeyAccount, nonce = 1n): Promise<Address> {
  const initCode = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [address('SmartSession'), address('NonfungiblePositionManager'), address('SwapRouter02'), address('UniswapV3Factory')],
  })
  const salt = encodePacked(['address', 'uint96'], [deployer.address, nonce])
  const resolverUID = await resolverUidOf(lab, address('TimeFramePolicy'))
  const args = [salt, resolverUID, initCode, '0x', '0x'] as const
  const { result: predicted } = await lab.client.simulateContract({ account: deployer.address, address: address('ModuleRegistry'), abi: registryDeployAbi, functionName: 'deployModule', args })
  const tx = await lab.send(deployer, address('ModuleRegistry'), encodeFunctionData({ abi: registryDeployAbi, functionName: 'deployModule', args }), 0n, 8_000_000n)
  if (!tx.ok) throw new Error('ModuleRegistry.deployModule(MamoruActionPolicy) reverted')
  const record = await lab.client.readContract({ address: address('ModuleRegistry'), abi: moduleRegistryAbi, functionName: 'findModule', args: [predicted] })
  if (record.resolverUID !== resolverUID) throw new Error(`MamoruActionPolicy ${predicted}: ModuleRecord resolver ${record.resolverUID}, expected ${resolverUID}`)
  return predicted
}

/**
 * Spec 007 T6 L-4, the deploy step T7 runs once per pool (script/Deploy.s.sol `raiseCardinality`): MamoruActionPolicy
 * refuses to enable a pool whose `observationCardinalityNext` is under the TWAP window. Raised in steps of 600 ring
 * slots (~13.3M gas each) so every transaction stays under Base's 2^24 gas cap. Anyone may call it.
 */
export async function raiseObservationCardinality(lab: Lab, from: PrivateKeyAccount, pool: Address, target: number): Promise<bigint> {
  let gas = 0n
  for (;;) {
    const slot0 = await lab.client.readContract({ address: pool, abi: poolCardinalityAbi, functionName: 'slot0' })
    const next = slot0[4]
    if (next >= target) return gas
    const n = Math.min(next + 600, target)
    const tx = await lab.send(from, pool, encodeFunctionData({ abi: poolCardinalityAbi, functionName: 'increaseObservationCardinalityNext', args: [n] }), 0n, 16_000_000n)
    if (!tx.ok) throw new Error(`increaseObservationCardinalityNext(${n}) on ${pool} reverted`)
    gas += tx.receipt.gasUsed
  }
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

/** Owner call that self-attests MamoruActionPolicy for `account` (once per account), next to the existing
 * `registryTrustCalls` self-attestation of TimeFramePolicy/UsageLimitPolicy (account/sessions/index.ts). Needs
 * the module registered first, which `deployMamoruPolicy` does in its own deploy transaction. */
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
