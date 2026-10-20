// Spec 007 (otto/mamoru#151), task T7(a). Before the operator trusts a deployed MamoruActionPolicy address (an
// env var, MAMORU_ACTION_POLICY_ADDRESS — see apps/mamoru-operator/src/boot.ts's `resolveNamedPolicy`), verify it
// really is this repo's contracts/action-policy/src/MamoruActionPolicy.sol with the expected constructor args, not
// a same-interface contract swapped in at that address. Checks:
//  (a) the four public immutables (SMART_SESSION, NPM, ROUTER, FACTORY) read on chain match packages/registry's
//      own values for those names — never a second, local copy of the addresses;
//  (b) the deployed bytecode, with each immutable's own byte range masked to zero (so the check does not merely
//      restate (a)), is byte-for-byte identical to the locally compiled artifact's `deployedBytecode` under the
//      same mask — i.e. every branch and every check of the contract is this exact source, compiled with this
//      exact solc version and optimizer settings (contracts/action-policy/foundry.toml), not a look-alike.
//
// Usage (read-only, no transaction):
//   cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//   BASE_RPC_URL=https://mainnet.base.org bun packages/scenarios/action-policy/verify-deployed-policy.ts <address>
// otto/mamoru#151, MamoruActionPolicyV2 (its artifact, and its fifth immutable GUARDIAN, which must equal the key the
// coordinator names; MamoruGuardian has no registry address until it is deployed):
//   ... verify-deployed-policy.ts <address> --v2 --guardian <address>
//
// Exit 0: verified. Exit 1: refused (print the reason; never caught and ignored by a caller — treat as "do not
// trust this address"). Exit 2: usage error (no address given, or the artifact has not been built).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem'
import { baseRegistry, address as registryAddress } from '@mamoru/registry'

const ARTIFACT_PATH = join(import.meta.dir, '../../../contracts/action-policy/out/MamoruActionPolicy.sol/MamoruActionPolicy.json')
/** MamoruActionPolicyV2's artifact: compiled at its own 1,000 optimizer runs (foundry.toml compilation_restrictions). */
const ARTIFACT_PATH_V2 = join(import.meta.dir, '../../../contracts/action-policy/out/MamoruActionPolicyV2.sol/MamoruActionPolicyV2.json')

const READ_ABI = parseAbi([
  'function SMART_SESSION() view returns (address)',
  'function NPM() view returns (address)',
  'function ROUTER() view returns (address)',
  'function FACTORY() view returns (address)',
  'function GUARDIAN() view returns (address)',
])

/**
 * Deliberately not `Pick<PublicClient, ...>`: viem's `readContract` is generic over any ABI/function name, and a
 * plain object fake (for tests) cannot implement that generic signature structurally. This is the exact, narrow
 * shape `verifyDeployedPolicy` calls — a real `createPublicClient(...)` result satisfies it (a generic method is a
 * valid value wherever one of its own instantiations is expected), and a test's fake object can implement it
 * directly with concrete types.
 */
export type PolicyReaderClient = {
  getCode: (args: { address: Address }) => Promise<Hex | undefined>
  readContract: (args: { address: Address; abi: typeof READ_ABI; functionName: 'SMART_SESSION' | 'NPM' | 'ROUTER' | 'FACTORY' | 'GUARDIAN' }) => Promise<Address>
}

type ImmutableRanges = Record<string, { start: number; length: number }[]>
type Artifact = { deployedBytecode: { object: Hex; immutableReferences: ImmutableRanges } }

/** Zeroes every byte range any immutable occupies, in place conceptually (returns a new hex string). */
function maskImmutables(hex: Hex, ranges: ImmutableRanges): Hex {
  const bytes = Buffer.from(hex.slice(2), 'hex')
  for (const group of Object.values(ranges)) for (const { start, length } of group) bytes.fill(0, start, start + length)
  return `0x${bytes.toString('hex')}`
}

export function loadArtifact(v2 = false): Artifact {
  const path = v2 ? ARTIFACT_PATH_V2 : ARTIFACT_PATH
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`${v2 ? 'MamoruActionPolicyV2' : 'MamoruActionPolicy'} artifact not built: ${path} (run: cd contracts/action-policy && ./install.sh && forge build)`)
  }
  return JSON.parse(raw) as Artifact
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/**
 * `client` takes the minimal shape this needs (so a test can fake it): `getCode` and `readContract` from viem's
 * PublicClient. Pass a real one (createPublicClient) for an actual on-chain check.
 */
export async function verifyDeployedPolicy(client: PolicyReaderClient, deployed: Address, artifact: Artifact = loadArtifact(), opts: { guardian?: Address } = {}): Promise<VerifyResult> {
  // Never throw out of this function: a bad RPC answer, a revert, or an address with no code must all come back as
  // a clean `{ ok: false }`, exactly like a genuine mismatch — this is the one function an operator trusts before
  // trusting a contract, and "crashed, caller decides what that means" is not an acceptable answer for it.
  let onChainCode: Hex | undefined
  try {
    onChainCode = await client.getCode({ address: deployed })
  } catch (e) {
    return { ok: false, reason: `eth_getCode(${deployed}) failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!onChainCode || onChainCode === '0x') return { ok: false, reason: `no code at ${deployed}` }

  const expected: Record<'SMART_SESSION' | 'NPM' | 'ROUTER' | 'FACTORY', Address> = {
    SMART_SESSION: registryAddress('SmartSession', baseRegistry),
    NPM: registryAddress('NonfungiblePositionManager', baseRegistry),
    ROUTER: registryAddress('SwapRouter02', baseRegistry),
    FACTORY: registryAddress('UniswapV3Factory', baseRegistry),
  }
  let read: Record<'SMART_SESSION' | 'NPM' | 'ROUTER' | 'FACTORY', Address>
  try {
    // A tuple literal, not `[...].map(...)`: `Promise.all` on a fixed-length tuple keeps each element's own type
    // (no `| undefined` from a generic array's indexed access).
    const [smartSession, npm, router, factory] = await Promise.all([
      client.readContract({ address: deployed, abi: READ_ABI, functionName: 'SMART_SESSION' }),
      client.readContract({ address: deployed, abi: READ_ABI, functionName: 'NPM' }),
      client.readContract({ address: deployed, abi: READ_ABI, functionName: 'ROUTER' }),
      client.readContract({ address: deployed, abi: READ_ABI, functionName: 'FACTORY' }),
    ])
    read = { SMART_SESSION: smartSession, NPM: npm, ROUTER: router, FACTORY: factory }
  } catch (e) {
    return { ok: false, reason: `${deployed} does not answer SMART_SESSION()/NPM()/ROUTER()/FACTORY() as a MamoruActionPolicy would: ${e instanceof Error ? e.message : String(e)}` }
  }
  for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
    if (read[k].toLowerCase() !== expected[k].toLowerCase()) return { ok: false, reason: `${k}: on-chain ${read[k]}, expected ${expected[k]} (packages/registry)` }
  }
  // otto/mamoru#151: V2's guardian is an immutable too; masked below like the others, so it is checked here, by value.
  if (opts.guardian !== undefined) {
    let guardian: Address
    try {
      guardian = await client.readContract({ address: deployed, abi: READ_ABI, functionName: 'GUARDIAN' })
    } catch (e) {
      return { ok: false, reason: `${deployed} does not answer GUARDIAN() as MamoruActionPolicyV2 would: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (guardian.toLowerCase() !== opts.guardian.toLowerCase()) return { ok: false, reason: `GUARDIAN: on-chain ${guardian}, expected ${opts.guardian}` }
  }

  const ranges = artifact.deployedBytecode.immutableReferences
  const maskedChain = maskImmutables(onChainCode, ranges)
  const maskedLocal = maskImmutables(artifact.deployedBytecode.object, ranges)
  if (maskedChain.length !== maskedLocal.length) return { ok: false, reason: `deployed bytecode length ${maskedChain.length / 2 - 1} bytes, compiled artifact ${maskedLocal.length / 2 - 1} bytes -- different contract` }
  if (maskedChain.toLowerCase() !== maskedLocal.toLowerCase()) return { ok: false, reason: 'deployed bytecode (immutables masked) does not match the locally compiled artifact -- different source or compiler settings' }
  return { ok: true }
}

if (import.meta.main) {
  const addr = process.argv[2] as Address | undefined
  const v2 = process.argv.includes('--v2')
  const g = process.argv.indexOf('--guardian')
  const guardian = g > 0 ? (process.argv[g + 1] as Address | undefined) : undefined
  if (!addr || (v2 && !guardian)) {
    console.error('usage: BASE_RPC_URL=... bun packages/scenarios/action-policy/verify-deployed-policy.ts <address> [--v2 --guardian <address>]')
    process.exit(2)
  }
  const client = createPublicClient({ transport: http(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org') })
  const result = await verifyDeployedPolicy(client, addr, loadArtifact(v2), guardian ? { guardian } : {})
  if (result.ok) {
    console.log(`OK: ${addr} is ${v2 ? 'MamoruActionPolicyV2' : 'MamoruActionPolicy'} with the expected constructor args and unmodified bytecode`)
    process.exit(0)
  }
  console.error(`REFUSED: ${addr} -- ${result.reason}`)
  process.exit(1)
}
