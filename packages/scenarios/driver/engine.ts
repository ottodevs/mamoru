import { encodeFunctionData, isAddressEqual, pad, parseAbi, parseEventLogs, toFunctionSelector, zeroHash, type Hex, type Log, type PublicClient } from 'viem'
import type { LocalAccount } from 'viem/accounts'
import { ReasonError, type Address, type ReasonCode } from '@mamoru/domain'
import { amountsOf, decide, outOfRangeSinceOf, placedOf, safeSavings, twapFloor, withOutOfRangeSince, type Decision, type Observation, type Proposal, type SessionObs } from '@mamoru/decide'
import { signBlocker } from '@mamoru/journal'
import { hasIncrease, hasManageAny, TWAP_SHORT_WINDOW_SECONDS, type GasCaps, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { baseRegistry, address, entry, entryPointV07Abi, erc20Abi, isDeployed, mamoruActionPolicyV2Abi, nonfungiblePositionManagerAbi, smartSessionAbi, tokenMessengerV2Abi, uniswapV3PoolAbi, type Registry, type RegistryName } from '@mamoru/registry'
import {
  Batch,
  contractRead,
  multicall3Of,
  historyCursor,
  isSafeAndCanonical,
  observe,
  observeGuardHistory,
  SharedGuardReads,
  principalOwedBefore,
  readUserOpEvent,
  rpcClient,
  simulateFromEntryPoint,
  type GuardSeries,
  type PoolStateCache,
  type Simulation,
} from '@mamoru/rpc'
import { BundlerClient, BundlerRpcError } from '@mamoru/erc4337'
import { SessionLedger, precheck, type ActionPolicyPoolConfig } from '@mamoru/account/precheck'
import { draftUserOp, executeCallData, handleOpsData, sessionNonceKey, signSessionUserOp, useModeSignature, userOpHash, type GasSettings } from '@mamoru/account/sessions'
import type { Execution } from '@mamoru/account/safe'
import { policyIncrease, uniswapV3, type UniswapV3, type V3Call } from '@mamoru/uniswap-v3'
import { minOut, quoteMint } from '@mamoru/uniswap-v3/quote'
import { diverges, swapMinimum, twapFloor as deviationFloor, twapTickAt } from '@mamoru/uniswap-v3/twap'
import { DEFAULT_BAND_FACTOR_BPS, decreaseMinsInRange, oracleFromObserve, priceRange, swapBoundsInRange, type OracleRead, type PriceAnchor, type PriceRange } from '@mamoru/uniswap-v3/policy-bounds'
import { harvestRow, ledgerTotal, positionEvents, type Pair, type SavingsLogRow } from '@mamoru/projector'
import { MemoryJournal, type DecisionRecord, type OpRecord } from './journal.ts'

/** Spec 007 (#151) T4: the two MamoruActionPolicy views precheck's mirror needs that are not already read for T3's
 * bounds (`swapBounds`/`decreaseMins`, which the engine never calls directly — see `@mamoru/uniswap-v3/policy-bounds`'s
 * TS port). `spendOf` returns the `Spend` struct as one named tuple, same pattern as `findModule` elsewhere in this
 * codebase (`packages/scenarios/action-policy/v4-grant.ts`). T6: the token-bucket `Spend`. */
const mamoruActionPolicyReadAbi = parseAbi([
  'struct Spend { uint64 generation; uint64 updatedAt; bool in1; uint128 debt; uint128 total; }',
  'function spendOf(address account, address pool) view returns (Spend)',
  'function generationOf(address account) view returns (uint64)',
  'function admittedPool(address account, uint256 tokenId) view returns (address)',
])

/** Spec 007 T6: `observe` with the raw `secondsPerLiquidityCumulativeX128s`, which `twapTickAt` (one window, no
 * liquidity) does not return — `poolOracle` below needs both windows' harmonic-mean liquidity. */
const observeAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])
import { reconcileReceipt } from './receipt.ts'

/** Gas limits of every engine userOp. Their sum is the budget `decide` prices for the harvest cost. */
export const LAB_GAS_LIMITS = { verificationGasLimit: 3_000_000n, callGasLimit: 2_000_000n, preVerificationGas: 100_000n } as const
export const MAX_PRIORITY_FEE_PER_GAS = 1_000_000n
/**
 * The gas of an engine userOp at `baseFee`: maxFeePerGas = 2 x basefee + priority, as always. Spec 007 T7: under a
 * v4 session's MamoruGasPolicy `caps`, maxFeePerGas is clamped to the cap while basefee + priority still fits under
 * it, and `null` (wait) when it does not; the fixed limits and priority fee are under the caps by construction.
 * Without caps (every live policy): exactly today's settings.
 */
export function engineGas(baseFee: bigint, caps?: GasCaps): GasSettings | null {
  const want = baseFee * 2n + MAX_PRIORITY_FEE_PER_GAS
  const gas: GasSettings = { ...LAB_GAS_LIMITS, maxFeePerGas: want, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS }
  if (!caps) return gas
  if (
    LAB_GAS_LIMITS.verificationGasLimit > caps.maxVerificationGasLimit || LAB_GAS_LIMITS.callGasLimit > caps.maxCallGasLimit ||
    LAB_GAS_LIMITS.preVerificationGas > caps.maxPreVerificationGas || MAX_PRIORITY_FEE_PER_GAS > caps.maxPriorityFeePerGas
  ) return null
  if (want <= caps.maxFeePerGas) return gas
  if (baseFee + MAX_PRIORITY_FEE_PER_GAS > caps.maxFeePerGas) return null
  return { ...gas, maxFeePerGas: caps.maxFeePerGas }
}
const OP_GAS_UNITS = LAB_GAS_LIMITS.verificationGasLimit + LAB_GAS_LIMITS.callGasLimit + LAB_GAS_LIMITS.preVerificationGas

/**
 * otto/mamoru#61: on a chain that charges the gas LIMIT (Monad, `gasModel: 'gas_limit'`) the bundler's handleOps pays
 * for every unit the userOp declares, used or not, and the EntryPoint keeps 10% of unused execution gas. There the
 * limits come from the simulation the engine already runs, plus this stated margin, never from LAB_GAS_LIMITS:
 * - callGasLimit: the gas the account's execute used from the EntryPoint (`simulateFromEntryPoint`), x 5/4 + 30,000
 *   (the 63/64 rule over the nested calls of a mint or a swap, and state that moves between simulation and inclusion);
 * - verificationGasLimit: TIGHT_VERIFICATION_GAS, the SmartSession use-mode validation of one Mamoru session (UniAction,
 *   TimeFrame and UsageLimit policies, OwnableValidator) plus the prefund transfer: 310k-330k gas for an account's
 *   first userOp on the Monad fork (e2e-monad-writes.ts prints the figures), so 500k is a 60% margin. It only bounds
 *   the prefund: the bundle's own gas comes from its estimate (the operator's bundler), not from this limit;
 * - preVerificationGas: what the EntryPoint does not meter, from the bytes of the packed userOp: 21,000 intrinsic, the
 *   calldata at 16 gas a byte (4 for a zero byte) of a handleOps carrying this op, and 30,000 for handleOps' own loop,
 *   the UserOperationEvent and the beneficiary payment.
 * Never above LAB_GAS_LIMITS: a limit that would be is refused (AA_GAS_MARGIN_EXCEEDED), not raised.
 */
export const TIGHT_CALL_GAS = { num: 5n, den: 4n, plus: 30_000n } as const
export const TIGHT_VERIFICATION_GAS = 500_000n
export const TIGHT_PRE_VERIFICATION_OVERHEAD = 21_000n + 30_000n

/** Calldata gas of `data` at the pre-EIP-7623 schedule: 16 per non-zero byte, 4 per zero byte. */
function calldataGas(data: Hex): bigint {
  let gas = 0n
  for (let i = 2; i < data.length; i += 2) gas += data.slice(i, i + 2) === '00' ? 4n : 16n
  return gas
}

/** otto/mamoru#61: the userOp limits on a gas-limit chain (see TIGHT_CALL_GAS), or null when they exceed LAB_GAS_LIMITS. */
export function tightUserOpGas(op: { sender: Address; nonce: bigint; callData: Hex } & GasSettings, simulatedCallGas: bigint): GasSettings | null {
  if (simulatedCallGas <= 0n) return null
  const callGasLimit = (simulatedCallGas * TIGHT_CALL_GAS.num) / TIGHT_CALL_GAS.den + TIGHT_CALL_GAS.plus
  const verificationGasLimit = TIGHT_VERIFICATION_GAS
  // The signature is not known yet: a use-mode signature of the same length, every byte non-zero (the dearest case).
  const signature = useModeSignature(`0x${'11'.repeat(32)}`, `0x${'11'.repeat(65)}`)
  const draft = draftUserOp(op.sender, op.nonce, op.callData, { ...op, callGasLimit, verificationGasLimit })
  const preVerificationGas = TIGHT_PRE_VERIFICATION_OVERHEAD + calldataGas(handleOpsData([{ ...draft, signature }], op.sender))
  if (callGasLimit > LAB_GAS_LIMITS.callGasLimit || verificationGasLimit > LAB_GAS_LIMITS.verificationGasLimit || preVerificationGas > LAB_GAS_LIMITS.preVerificationGas) return null
  return { verificationGasLimit, callGasLimit, preVerificationGas, maxFeePerGas: op.maxFeePerGas, maxPriorityFeePerGas: op.maxPriorityFeePerGas }
}
const ETH_PRICE_POOL = 'pool:WETH/USDC/3000'

/**
 * otto/mamoru#215: the CCTP V2 domain of each chain a bridge-out may go to (MessageTransmitterV2.localDomain() there).
 * Monad's is 15 (read on chain 143, 2026-10-27). A chain not listed here is never bridged to.
 */
export const CCTP_DOMAIN_BY_CHAIN: Readonly<Record<number, number>> = { 143: 15 }
/** CCTP V2 Standard finality: attested at finality, no fee. The only threshold the bridge-out grant allows (>= 2000). */
export const CCTP_STANDARD_FINALITY = 2000

/**
 * otto/mamoru#215: what the engine hands the operator's bridge journal right before it signs a bridge-out, so the burn
 * is counted in flight from before it can exist on chain. `userOpHash`, `nonceKey`/`nonce` and `prepareBlock` are how
 * the operator settles it from the chain later (its UserOperationEvent, or the nonce taken without it).
 */
export type BridgeSigning = {
  opId: string
  account: Address
  chainId: number
  pool: RegistryName
  bucket: string
  amount: bigint
  destinationDomain: number
  userOpHash: Hex
  nonceKey: bigint
  nonce: bigint
  prepareBlock: bigint
}
/** Bounded waits for the bundler receipt and for `safe`, in blocks the lab lets pass. */
const MAX_WAIT_BLOCKS = 32
/** Live: after a bundler rejection that left the nonce unmoved, the same premise or kind+pool is not proposed again for this long. */
export const UNINCLUDABLE_BACKOFF_SECONDS = 600n

export type EngineSession = {
  name: string
  grant: SessionGrant
  permissionId: Hex
  /**
   * Spec 007 T6 (M-4): tokenIds this session's own owner-signed `Init.admit` admitted at enable (positions minted
   * outside this deployment — the contract's `admittedPool` already has them the moment the session is enabled,
   * never only from this engine's own later `enter_mint`). Whoever builds the Init and calls `addSession` passes
   * the same list it signed, so precheck's mirror (`SessionLedger.isAdmitted`) agrees with the chain from the
   * start, the same way `afterConfirmed` admits a tokenId this engine itself later mints.
   */
  admit?: readonly bigint[]
}

export type EngineConfig = {
  /** 'live' signs and sends on Base only with MAMORU_LIVE=1 (journal signBlocker and the bundler client both check). */
  mode: 'production' | 'lab' | 'live'
  chainId: number
  signingChainIds: readonly number[]
  rpcUrl: string
  bundlerUrl: string
  policy: PolicyVersion
  account: Address
  /** Generated in the test process, never written anywhere. */
  sessionKey: LocalAccount
  nonceLane: number
  depositsAfter: bigint
  sessions: EngineSession[]
  /** Blocks to wait for the UserOperationEvent and for `safe`. Default 32; live Base needs more for its safe head. */
  maxWaitBlocks?: number
  /**
   * otto/mamoru#61: the registry of the chain the engine runs on: tokens, pools, the position manager, the router, the
   * quoter, SmartSession and the EntryPoint all come from it. Absent: Base's, as every engine before Monad.
   */
  registry?: Registry
  /** The pool that prices the native asset in the savings asset (decide's gas cost). Absent: Base's WETH/USDC 0.3%. */
  nativePricePool?: RegistryName
  /**
   * How the chain charges gas (`ChainDescriptor.gasModel`). 'gas_limit' (Monad): the userOp limits are sized from the
   * simulation (`tightUserOpGas`), never the fixed LAB_GAS_LIMITS. Absent or 'gas_used': LAB_GAS_LIMITS, as always.
   */
  gasModel?: 'gas_used' | 'gas_limit'
  /** First block of the managed positions' history on a restarted engine. Default: depositsAfter. */
  historyFromBlock?: bigint
  /** Session uses already confirmed on chain before this engine started (restart): replayed into the ledger so caps and usage limits count them. */
  priorIncluded?: { permissionId: Hex; calls: Execution[] }[]
  /**
   * otto/mamoru#140 (Sol review round 2 of #64): ops a previous engine of this account signed whose bytes may still be
   * included (see `carried()`): watched from the start like `released`, so a restart or a renewal never drops them.
   */
  carried?: OpRecord[]
  /** Pool state per block, shared with the other engines of the process. */
  poolCache?: PoolStateCache
  /**
   * Spec 004 (#101) LC-T6: builds `Observation.guard.pools` for these pools every review, one more Multicall3
   * batch pinned to the same block as the rest of the observation (`@mamoru/rpc`'s `observeGuardHistory`).
   * Absent, or `pools` empty: `Observation.guard` is never set, byte-identical to before this field existed
   * (FR-LC-001). `series` seeds the rolling fallback for a pool whose on-chain oracle cannot answer the full
   * 24.5 h window (restores it after a restart, when the caller persisted `Engine.guardSeries`); omitted, every
   * such pool starts cold and abstains until its series is long enough (FR-LC-007, fail safe, never a guess).
   * Enabling a policy's guard rules to act on this is a later decision (LC-T9); conservador-live-v2 itself does
   * not change here.
   */
  guardHistory?: {
    pools: readonly RegistryName[]
    series?: ReadonlyMap<RegistryName, GuardSeries>
    /**
     * otto/mamoru#172: the lazy re-range's cost test also needs each pool's fee growth over the last 24 h. Given, the
     * guard history comes from this process-wide reader instead (one read per pool per TTL for every engine, fee
     * growth included; see `SharedGuardReads`), and `series` above is not used. Absent: this engine's own reads,
     * pinned to its block, without fee growth, as before.
     */
    shared?: SharedGuardReads
  }
  /**
   * The owner's intents, read at every observation (plan §9 step 4, US6). Absent: neither paused nor exiting.
   * Paused, decide holds with DECIDE_PAUSED; an operation already out is still reconciled.
   */
  intents?: () => Observation['intents']
  /**
   * otto/mamoru#184: every other Mamoru account's positions on the chain, read at every review for depth sizing
   * (`Observation.peerPositions`, `peerEntering`). Absent: a single-account run.
   */
  peerPositions?: () => Pick<Observation, 'peerPositions' | 'peerEntering'>
  /**
   * otto/mamoru#184 (Sol review round 2): an operation that adds liquidity to `pool` was just proposed. Called in the
   * same synchronous step as `peerPositions` and `decide`, before any await, so no other account's review can size
   * against the room this one is taking.
   */
  onEntering?: (pool: RegistryName) => void
  /**
   * otto/mamoru#212: the account's cap and what it has placed on its other chains (`Observation.cap`), read at every
   * review. Absent: no cap (backtest, lab); the operator always sets it.
   */
  cap?: () => Observation['cap']

  /**
   * otto/mamoru#215: the account's value on other chains for the policy's `remoteBuckets` (its sleeve there valued at the
   * TWAP, plus every bridge burned here and not yet minted there), read at every review as `Observation.remote`. Throws
   * (any error): the review holds as an observation failure. Absent: no `remote` (a remote bucket then waits with
   * DECIDE_WAIT_BRIDGE and nothing is bridged). `block` is the observation's block on this chain: a bridge signed but
   * not yet landed there is still in the local balances read at it, and is not counted in flight a second time.
   */
  remote?: (block: bigint) => Promise<NonNullable<Observation['remote']>>
  /**
   * otto/mamoru#218: this account's confirmed re-ranges from before this engine started (block timestamp and pool),
   * for the weekly cap and the cooldown across a restart. The newest also seeds `lastRerangeAt`. Absent: none.
   */
  rerangeHistory?: { pool: string; at: bigint }[]
}

/** Live op states whose signed bytes may still land or have landed without being settled here (Engine.carried). */
const CARRIED_STATES = new Set<OpRecord['state']>(['signed', 'submitted', 'included', 'pending_reconciliation'])

export type EngineHooks = {
  /** Lets one block pass on the fork. The engine itself never calls anvil methods. */
  waitBlock: () => Promise<void>
  /**
   * The owner activates `manage:<tokenId>` for a position that enter-mint minted (plan §12.4).
   * Not called under a policy with the live `manage-any` grants, enabled at activation.
   */
  requestManageGrant?: (tokenId: bigint, pool: string) => Promise<EngineSession>
  /**
   * A position this engine minted for the account, once its mint is confirmed (otto/mamoru#140 part2 #4: the live
   * operator records it as admitted), with the block it was minted in.
   */
  onMinted?: (tokenId: bigint, block?: bigint) => void
  /** Whether one more position may be minted (the live operator: under MAX_INVENTORY admitted). Absent: always. */
  mintAllowed?: () => boolean
  /**
   * otto/mamoru#215: a bridge-out is about to be signed. The operator records it in its bridge journal (state
   * 'sending', on disk) before this returns; a throw discards the op unsigned (BRIDGE_JOURNAL_UNAVAILABLE). Absent: the
   * engine never signs a bridge-out.
   */
  beforeBridgeSign?: (b: BridgeSigning) => void
  /**
   * Review of #144: a bridge-out journaled by `beforeBridgeSign` whose signing then failed: no signed bytes exist, so it
   * can never burn. The journal stops counting it in flight. Errors here are ignored (the chain settles it later).
   */
  bridgeUnsigned?: (userOpHash: Hex) => void
  /**
   * Review round 2 of #144: a bridge-out op ended discarded or failed (refusal, precheck, simulation, revert). The
   * operator holds bridging for a while (the remote reads not ready), so the same failing bridge does not take every
   * review from the local entries. Called once per op; errors here are ignored.
   */
  bridgeFailed?: (opId: string, code: string) => void
  /** otto/mamoru#218: a re-range was confirmed: its pool, block timestamp and block (the live operator stores it). */
  onReranged?: (pool: string, at: bigint, block: bigint) => void
}

/** The block of the latest operation that reached the chain: no review may observe before it. */
export function observationFloor(ops: readonly Pick<OpRecord, 'included'>[]): bigint {
  return ops.reduce((floor, o) => (o.included && o.included.blockNumber > floor ? o.included.blockNumber : floor), 0n)
}

export type ReviewResult =
  | { kind: 'observation-failed'; code: ReasonCode; detail?: string }
  | { kind: 'decided'; observation: Observation; record: DecisionRecord; op: OpRecord | null }

type Prepared = {
  calls: Execution[]
  quote?: OpRecord['quote']
  /** Harvest: principal owed for the tokenId at the prepare block. */
  owed?: Pair
  /** See OpRecord.expiresAt. */
  expiresAt: bigint | null
}

/** Spec 007, #151 review P1-3: how many times a swap under the action policy is halved to fill within its price limit (down to 1/16). */
export const V4_SWAP_SIZE_DOWN_STEPS = 4

/** SwapRouter02.multicall(uint256,bytes[]): the action a session grant holds for an on-chain swap expiry. */
const DEADLINE_SELECTOR = toFunctionSelector('function multicall(uint256,bytes[])').toLowerCase()

/** The grant has the SwapRouter02 deadline action (grants from before otto/mamoru#140 do not). */
export function grantHasSwapDeadline(grant: SessionGrant, registry: Registry = baseRegistry): boolean {
  return grant.actions.some((a) => a.selector.toLowerCase() === DEADLINE_SELECTOR && isAddressEqual(a.targetAddress, address('SwapRouter02', registry)))
}

/**
 * otto/mamoru#140: what a signed userOp the bundler did not include (rejected, or accepted and not seen) becomes.
 * An unmoved nonce does not mean the op cannot land: the bundler (or anyone it gave the bytes to) may still include
 * it. A terminal verdict is taken only on reads at the `safe` block, which no reorg undoes (Sol review of #64):
 * - its UserOperationEvent is on chain (at any height): `included`; confirmation then waits for `safe` as usual;
 * - the nonce moved at `safe` and there is no event: another op took the nonce, ours can never land;
 * - the nonce did not move at `safe` and `safe` is past the op's on-chain expiry: every block it could still land in
 *   is past the expiry too, so its priced calls revert (it may still spend the nonce: see `Engine.released`);
 * - the nonce did not move at `safe` and its permission is not enabled there: it cannot validate any more;
 * - an op that prices nothing (`expiresAt` null) and that the bundler rejected is freed at once, as before: run late,
 *   it only collects to the account (and is still watched, `Engine.released`).
 * Anything else stays pending and holds the slot.
 */
export function settleUnincluded(p: {
  opNonce: bigint
  /** EntryPoint nonce of the op's key at the `safe` block. */
  nonceAtSafe: bigint
  /** The op's UserOperationEvent, read up to `latest`. */
  eventFound: boolean
  safeTimestamp: bigint
  expiresAt: bigint | null
  permissionEnabledAtSafe: boolean
  rejected: boolean
}): { to: 'included' } | { to: 'failed'; code: 'RECON_UNINCLUDABLE' | 'RECON_NONCE_CONSUMED_BY_OTHER'; detail: string } | null {
  if (p.eventFound) return { to: 'included' }
  if (p.nonceAtSafe !== p.opNonce) return { to: 'failed', code: 'RECON_NONCE_CONSUMED_BY_OTHER', detail: `nonce ${p.opNonce} spent by another userOp (${p.nonceAtSafe} at safe)` }
  if (p.expiresAt === null) return p.rejected ? { to: 'failed', code: 'RECON_UNINCLUDABLE', detail: `bundler rejected; nonce ${p.opNonce} unmoved, the op prices nothing` } : null
  if (p.safeTimestamp > p.expiresAt) return { to: 'failed', code: 'RECON_UNINCLUDABLE', detail: `nonce ${p.opNonce} unmoved at a safe block past the on-chain expiry ${p.expiresAt}` }
  if (!p.permissionEnabledAtSafe) return { to: 'failed', code: 'RECON_UNINCLUDABLE', detail: `nonce ${p.opNonce} unmoved and its permission not enabled at a safe block` }
  return null
}

/** Kind and pool of a proposal: the unit a live backoff holds back. */
function proposalKey(p: Proposal): string {
  // otto/mamoru#215: a bridge's pool is on the other chain; its chain keeps it apart from any pool of this one.
  if (p.kind === 'bridge_out') return `${p.kind}|${p.chainId}|${p.pool}`
  return `${p.kind}|${p.pool}`
}

function exec(c: V3Call): Execution {
  return { target: c.to, value: c.value, callData: c.data }
}

/**
 * The engine in one process (plan §13.1 without the Durable Object and the
 * Workflow): observe, decide, then take one operation from `proposed` to a
 * terminal state through the plan §10 machine. Same packages as production;
 * only the configuration differs (FR-LAB-006).
 */
export class Engine {
  readonly journal = new MemoryJournal()
  readonly ledger = new SessionLedger()
  readonly sessions: EngineSession[] = []
  readonly allowedTokenIds: bigint[] = []
  readonly savingsLog: SavingsLogRow[] = []
  /** Managed positions are minted by this engine after this block (plan §12.4), so their whole history is on chain from here. */
  readonly historyFromBlock: bigint
  /** Position history read so far: each review scans only the blocks after it. */
  private readonly historyCursor = historyCursor()
  depositsAfter: bigint
  lastObservation?: Observation
  /** Live: premises the bundler rejected as unincludable, held back until `until` (block timestamp, seconds). */
  private readonly backoff: { premiseHash: string; key: string; until: bigint }[] = []
  /** Block timestamp of the last confirmed re-range, for the policy cooldown. */
  lastRerangeAt: bigint | null = null
  /** otto/mamoru#218: confirmed re-ranges (seeded, then appended on inclusion); handed to `decide` only when not empty. */
  readonly reranges: { pool: string; at: bigint; block?: bigint }[] = []
  /**
   * otto/mamoru#172: since when each position has been out of range, as this engine saw it (`outOfRangeSinceOf`).
   * Kept at every review; handed to `decide` only under a policy with `range.lazy`, so an eager observation stays
   * byte for byte what it was, and a switch to lazy already knows how long a position has been out.
   */
  private outOfRange = new Map<bigint, bigint>()
  /**
   * Spec 004 (#101) LC-T6: the rolling fallback series `cfg.guardHistory` feeds from each review (per pool),
   * updated after every `observe()`. Read this after a review and persist it (`state.ts`-style, atomic write)
   * so a restart passes `cfg.guardHistory.series` back in instead of starting cold.
   */
  readonly guardSeries = new Map<RegistryName, GuardSeries>()
  private readonly client: PublicClient
  private readonly bundler: BundlerClient
  private readonly nonceKey: bigint
  /** otto/mamoru#61: the chain's registry (`cfg.registry`, else Base's), its Uniswap calls and its Multicall3. */
  private readonly registry: Registry
  private readonly v3: UniswapV3
  private readonly multicall3: Address | null

  constructor(
    readonly cfg: EngineConfig,
    private readonly hooks: EngineHooks,
  ) {
    this.client = rpcClient(cfg.rpcUrl)
    this.registry = cfg.registry ?? baseRegistry
    this.v3 = uniswapV3(this.registry)
    this.multicall3 = multicall3Of(this.registry)
    this.bundler = new BundlerClient({ url: cfg.bundlerUrl, mode: cfg.mode, chainId: cfg.chainId, signingChainIds: cfg.signingChainIds, ...(cfg.registry ? { registry: cfg.registry } : {}) })
    this.nonceKey = sessionNonceKey(cfg.nonceLane, address('SmartSession', this.registry))
    this.depositsAfter = cfg.depositsAfter
    this.historyFromBlock = cfg.historyFromBlock ?? cfg.depositsAfter
    for (const s of cfg.sessions) this.addSession(s)
    for (const u of cfg.priorIncluded ?? []) this.ledger.recordIncluded(u.permissionId, u.calls)
    for (const op of cfg.carried ?? []) if (op.userOpHash && op.nonce !== undefined && op.prepareBlock !== undefined) this.released.push(op)
    for (const [name, series] of cfg.guardHistory?.series ?? []) this.guardSeries.set(name, series)
    // #218: a restart keeps the cooldown and the weekly count.
    for (const r of cfg.rerangeHistory ?? []) {
      this.reranges.push({ pool: r.pool, at: r.at })
      if (this.lastRerangeAt === null || r.at > this.lastRerangeAt) this.lastRerangeAt = r.at
    }
  }

  /** Live: a session the owner removed on chain (SmartSession) is revoked in the ledger, so decide never proposes an op it cannot authorize. */
  /**
   * The sessions' on-chain state, read with the observation: one isPermissionEnabled per session in its first
   * batch, at its block (the provider's head minus its lag, a few seconds behind `latest`: a permission removed
   * in between is still listed for one review, and its userOp is refused on chain by the SmartSession validator).
   * A session the chain no longer has enabled is revoked in the ledger before the observation lists the sessions.
   */
  private readEnabled(batch: Batch, blockNumber: bigint): (() => Promise<void>) | void {
    if (this.cfg.mode !== 'live') return
    // A provider that is behind the activation does not have the grants yet: every permission would read as
    // not enabled and be revoked here for good. That view is no observation of this account.
    if (blockNumber <= this.historyFromBlock) throw new ReasonError('OBS_BLOCK_INCONSISTENT', `rpc block ${blockNumber} is not past the activation block ${this.historyFromBlock}`)
    // The same for any later point the engine must not look before: the block a renewal enabled the current grants
    // in, or its own last operation. Checked here, before a session is read: a view from before a renewal shows
    // the renewed grants as not enabled, and they would be revoked in the ledger for good.
    const floor = this.observationFloorNow()
    if (blockNumber < floor) throw new ReasonError('EHG_OBSERVATION_STALE', `observed at block ${blockNumber}, not before block ${floor}`)
    const sessions = this.sessions.filter((s) => !this.ledger.get(s.permissionId)?.revoked)
    if (sessions.length === 0) return
    const enabled = sessions.map((s) => batch.add(contractRead(this.client, { address: address('SmartSession', this.registry), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [s.permissionId, this.cfg.account], blockNumber })))
    return async () => {
      // Every answer first: a read that fails revokes nothing.
      const answers = await Promise.all(enabled.map((h) => h.need()))
      for (const [i, s] of sessions.entries()) if (!answers[i]) this.ledger.revoke(s.permissionId)
    }
  }

  addSession(s: EngineSession): void {
    this.sessions.push(s)
    this.ledger.activate(s.permissionId, s.grant)
    if (s.grant.tokenId !== undefined && !this.allowedTokenIds.includes(s.grant.tokenId)) this.allowedTokenIds.push(s.grant.tokenId)
    // Spec 007 T6 (M-4): this session's own Init.admit, mirrored into the ledger right away — same admitted set the
    // contract already has the moment the session is enabled, not only from this engine's own later mints.
    if (s.admit?.length && s.grant.pool) for (const tokenId of s.admit) this.ledger.admitTokenId(tokenId, s.grant.pool)
  }

  savingsTotal(): bigint {
    return ledgerTotal(this.savingsLog)
  }

  private sessionObs(): SessionObs[] {
    return this.sessions.map((s) => ({
      grant: s.name,
      permissionId: s.permissionId,
      tokenId: s.grant.tokenId,
      validUntil: s.grant.userOp.validUntil,
      active: !this.ledger.get(s.permissionId)?.revoked,
      usesLeft: Math.max(0, s.grant.userOp.usageLimit - this.ledger.usesOf(s.permissionId)),
    }))
  }

  /**
   * Set by whoever restores this engine after a restart: the block of the last operation it ran before. The journal
   * starts empty then, and the first review must not look at the chain from before that operation either.
   */
  minObservationBlock = 0n

  /** The block no observation may be before: the latest of the engine's own operations and what its restorer set. */
  private observationFloorNow(): bigint {
    const inJournal = observationFloor(this.journal.ops)
    return inJournal > this.minObservationBlock ? inJournal : this.minObservationBlock
  }

  async observe(): Promise<Observation> {
    return this.withAdmission(await this.observeChain())
  }

  /**
   * otto/mamoru#171: under a policy that increases through MamoruActionPolicyV2 (`hasIncrease`), which of the account's
   * positions the policy admitted, read at the observation block, so `decide` never proposes an increase the policy
   * refuses (a v2/v3 or V1 position it never admitted). Any other policy: the observation is returned unchanged, and
   * no read is made.
   */
  private async withAdmission(obs: Observation): Promise<Observation> {
    const ap = this.cfg.policy.actionPolicy
    if (!ap || !obs.positions.length) return obs
    const pools = this.cfg.policy.buckets.flatMap((b) => b.pools).filter((p) => hasIncrease(this.cfg.policy, p))
    if (!pools.length) return obs
    const asked = obs.positions.filter((p) => p.pool !== null && pools.includes(p.pool))
    let at: Address[]
    try {
      at = await Promise.all(asked.map((p) => this.client.readContract({ address: ap.address, abi: mamoruActionPolicyV2Abi, functionName: 'admittedPool', args: [this.cfg.account, p.tokenId], blockNumber: obs.block.number })))
    } catch (e) {
      throw new ReasonError('OBS_RPC_UNAVAILABLE', `MamoruActionPolicy.admittedPool at ${obs.block.number}: ${(e as Error).message.split('\n')[0]}`)
    }
    const admitted = new Map(asked.map((p, i) => [p.tokenId, isAddressEqual(at[i]!, entry(p.pool!, this.registry).address)]))
    return { ...obs, positions: obs.positions.map((p) => (admitted.has(p.tokenId) ? { ...p, admitted: admitted.get(p.tokenId)! } : p)) }
  }

  private async observeChain(): Promise<Observation> {
    const live = this.journal.live
    const obs = await observe(this.client, {
      chainId: this.cfg.chainId,
      account: this.cfg.account,
      nonceKey: this.nonceKey,
      depositsAfter: this.depositsAfter,
      sessions: () => this.sessionObs(),
      firstBatch: (batch, blockNumber) => this.readEnabled(batch, blockNumber),
      allowedTokenIds: this.allowedTokenIds,
      historyFromBlock: this.historyFromBlock,
      historyCursor: this.historyCursor,
      poolCache: this.cfg.poolCache,
      intents: this.cfg.intents?.() ?? { paused: false, exitRequested: false },
      slot: live ? { opId: live.opId, state: live.state } : null,
      twapWindowSeconds: this.cfg.policy.execution.twapWindowSeconds,
      opGasUnits: OP_GAS_UNITS,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
      savingsAsset: this.cfg.policy.savingsAsset,
      ethPricePool: this.cfg.nativePricePool ?? ETH_PRICE_POOL,
      // otto/mamoru#101 (shadow): the pools' TVL is read, in the same batch, only for a policy that lists it.
      ...(this.cfg.policy.shadow.includes('packaging:tvl') ? { poolTvl: true } : {}),
      ...(this.cfg.registry ? { registry: this.cfg.registry } : {}),
    })
    const gh = this.cfg.guardHistory
    if (!gh || gh.pools.length === 0) return obs
    // Pinned to the same block as the rest of the observation (FR-RPC-001): a second Multicall3 batch, never a second block.
    const targets = gh.pools.map((name) => ({ name, address: entry(name, this.registry).address }))
    if (gh.shared) return { ...obs, guard: { pools: await gh.shared.read(this.client, this.multicall3, targets, obs.block.number, Number(obs.block.timestamp), this.cfg.policy.execution.twapWindowSeconds) } }
    const result = await observeGuardHistory(this.client, this.multicall3, targets, obs.block.number, Number(obs.block.timestamp), this.cfg.policy.execution.twapWindowSeconds, this.guardSeries)
    this.guardSeries.clear()
    for (const [name, series] of result.series) this.guardSeries.set(name, series)
    return { ...obs, guard: { pools: result.pools } }
  }

  /** One review: observe at a fixed block, decide, and run at most one operation. */
  private pendingRetune: { policy: PolicyVersion; guardHistory: EngineConfig['guardHistory'] } | null = null

  /**
   * Spec 006 (otto/mamoru#147): new engine settings for the next review. Applied at the start of a review, never in
   * the middle of one, so a review decides and executes under one policy. Only the decision side may change (depth
   * sizing, guards): the policy id, buckets and session templates must be the ones the engine started with, since
   * its sessions were granted for them.
   */
  retune(policy: PolicyVersion, guardHistory: EngineConfig['guardHistory']): void {
    const cur = this.cfg.policy
    if (policy.policyId !== cur.policyId || policy.session !== cur.session || policy.buckets !== cur.buckets) throw new Error(`retune: ${policy.policyId} is not a retuning of ${cur.policyId}`)
    this.pendingRetune = { policy, guardHistory }
  }

  async review(): Promise<ReviewResult> {
    if (this.pendingRetune) {
      this.cfg.policy = this.pendingRetune.policy
      this.cfg.guardHistory = this.pendingRetune.guardHistory
      this.pendingRetune = null
    }
    await this.watchReleased()
    await this.resumePending()
    await this.resumeIncluded()
    // A bridge-out settled failed by the resumes above (a late revert, unincludable) holds bridging before this review decides.
    this.reportBridgeFailures()
    let obs: Observation
    try {
      obs = await this.observe()
    } catch (e) {
      if (e instanceof ReasonError) return { kind: 'observation-failed', code: e.code, detail: e.detail }
      throw e
    }
    // otto/mamoru#215: what the account holds on its other chains. A hook that cannot answer holds the review: a
    // decision without it would size the local buckets on part of the account.
    if (this.cfg.remote) {
      try {
        obs = { ...obs, remote: await this.cfg.remote(obs.block.number) }
      } catch (e) {
        if (e instanceof ReasonError) return { kind: 'observation-failed', code: e.code, detail: e.detail }
        return { kind: 'observation-failed', code: 'OBS_RPC_UNAVAILABLE', detail: `remote value: ${(e as Error).message?.split('\n')[0] ?? String(e)}` }
      }
    }
    // Never decide on a view older than the engine's own last operation: a provider serving a head behind it shows
    // the account as it was before that operation, and the same step would be proposed again. The reviews used to be
    // minutes apart, which hid this; they can now follow each other in seconds.
    const floor = this.observationFloorNow()
    if (obs.block.number < floor) {
      return { kind: 'observation-failed', code: 'EHG_OBSERVATION_STALE', detail: `observed at block ${obs.block.number}, the last operation is in block ${floor}` }
    }
    const cap = this.cfg.cap?.()
    const weekAgo = obs.block.timestamp - 7n * 86_400n
    const recent = this.reranges.filter((r) => r.at > weekAgo)
    obs = { ...obs, lastRerangeAt: this.lastRerangeAt, ...(recent.length ? { recentReranges: recent } : {}), ...this.cfg.peerPositions?.(), ...(cap ? { cap: { ...cap, reinvestUsdc: this.reinvestOf(obs) } } : {}) }
    this.outOfRange = outOfRangeSinceOf(this.outOfRange, obs)
    if (this.cfg.policy.range.lazy) obs = withOutOfRangeSince(obs, this.outOfRange)
    this.lastObservation = obs
    const decision = decide(obs, this.cfg.policy)
    this.depositsAfter = obs.safeBlock.number > this.depositsAfter ? obs.safeBlock.number : this.depositsAfter
    const key = decision.proposal ? proposalKey(decision.proposal) : ''
    const backedOff = !!decision.proposal && this.backoff.some((b) => b.until > obs.block.timestamp && (b.premiseHash === decision.premiseHash || b.key === key))
    const deduped = (!!decision.proposal && this.journal.lastDiscarded()?.premiseHash === decision.premiseHash) || backedOff
    const record = this.journal.recordDecision(decision, deduped ? 'REVIEW_DEDUPED' : undefined)
    if (!decision.proposal || deduped) return { kind: 'decided', observation: obs, record, op: null }
    const op = this.journal.propose(record, decision.proposal.grant)
    const p = decision.proposal
    this.capFreeing = p.kind === 'rerange' || p.kind === 'reduce' || p.kind === 'harvest' || (p.kind === 'enter_swap' && p.tokenIn !== this.cfg.policy.savingsAsset)
    this.capSpending = !this.capFreeing
    if (p.kind === 'enter_mint' || p.kind === 'increase_liquidity' || p.kind === 'rerange') this.cfg.onEntering?.(p.pool)
    // An op settled RECON_UNINCLUDABLE is backed off where it is settled (`settlePending`).
    try {
      await this.run(op, obs, decision)
    } finally {
      this.reportBridgeFailures()
    }
    return { kind: 'decided', observation: obs, record, op }
  }

  /**
   * otto/mamoru#212: what was placed and idle at the last review, what the operation since did (took money out of the
   * positions, or spent savings on an entry), and what may be put back.
   */
  private capPlaced: bigint | null = null
  private capIdle: bigint | null = null
  private capFreeing = false
  private capSpending = false
  private reinvest = 0n

  /**
   * otto/mamoru#212: savings the engine's own operation freed (a re-range, a reduce, a sale of idle volatile, a
   * converting harvest), which it may put back whatever the cap says: completing a re-range is not new money. Credited
   * only with the idle savings that operation actually added, never more than what left the positions: a price drop,
   * a deposit or an owner operation credits nothing. Placing uses it up; idle savings that fall without an entry (the
   * owner took money out) clear it, and so does any owner operation (resetCapReinvest). In memory: a restart forgets it.
   */
  private reinvestOf(obs: Observation): bigint {
    const placed = placedOf(obs, this.cfg.policy)
    const idle = safeSavings(obs, this.cfg.policy)
    if (this.capPlaced !== null && this.capIdle !== null) {
      const dPlaced = placed - this.capPlaced
      const dIdle = idle - this.capIdle
      if (this.capFreeing && dIdle > 0n && dPlaced < 0n) this.reinvest += dIdle < -dPlaced ? dIdle : -dPlaced
      else if (dPlaced > 0n) this.reinvest = this.reinvest > dPlaced ? this.reinvest - dPlaced : 0n
      if (dIdle < 0n && !this.capSpending && !this.capFreeing) this.reinvest = 0n
    }
    this.capPlaced = placed
    this.capIdle = idle
    this.capFreeing = false
    this.capSpending = false
    if (this.reinvest > idle) this.reinvest = idle
    return this.reinvest
  }

  /** otto/mamoru#212: an owner operation (a withdrawal, a stop) ran: nothing it moved is the engine's to put back. */
  resetCapReinvest(): void {
    this.reinvest = 0n
    this.capPlaced = null
    this.capIdle = null
  }

  /** Bridge-out ops already handed to `bridgeFailed`. */
  private readonly bridgeFailuresReported = new Set<string>()

  /**
   * Review round 2 of #144: every bridge-out op that ended discarded or failed, once, to `bridgeFailed`. Not one whose
   * nonce another op took (nothing was wrong with the bridge).
   */
  private reportBridgeFailures(): void {
    if (!this.hooks.bridgeFailed) return
    for (const o of this.journal.ops) {
      if (o.intent.kind !== 'bridge_out' || (o.state !== 'discarded' && o.state !== 'failed') || this.bridgeFailuresReported.has(o.opId)) continue
      this.bridgeFailuresReported.add(o.opId)
      if (o.stateCode === 'RECON_NONCE_CONSUMED_BY_OTHER') continue
      try {
        this.hooks.bridgeFailed(o.opId, o.stateCode ?? 'failed')
      } catch {}
    }
  }

  private session(name: string): EngineSession | undefined {
    return [...this.sessions].reverse().find((s) => s.name === name)
  }

  private async run(op: OpRecord, obs: Observation, decision: Decision): Promise<void> {
    const j = this.journal
    const proposal = decision.proposal!
    const session = this.session(proposal.grant)
    if (!session) return void j.move(op.opId, 'discarded', 'SESSION_MISSING')
    if (proposal.kind === 'enter_mint' && this.hooks.mintAllowed && !this.hooks.mintAllowed()) return void j.move(op.opId, 'discarded', 'INVENTORY_FULL')

    // prepare: fresh block, quotes, calls, pre-check and the unsigned userOp.
    const block = await this.client.getBlock({ blockTag: 'latest' })
    let prepared: Prepared
    try {
      prepared = await this.prepareCalls(proposal, block.number, block.timestamp, session)
    } catch (e) {
      if (e instanceof ReasonError) return void j.move(op.opId, 'discarded', e.code, {}, e.detail)
      throw e
    }
    const callData = executeCallData(prepared.calls)
    // otto/mamoru#215: a bridge's pool is on the other chain; no MamoruActionPolicy of this one covers it.
    if (proposal.kind !== 'bridge_out') await this.syncActionPolicyLedger(proposal.pool, block.number, 'tokenId' in proposal && typeof proposal.tokenId === 'bigint' ? proposal.tokenId : undefined)
    const pre = precheck(
      { sender: this.cfg.account, callData, signature: useModeSignature(session.permissionId, '0x') },
      { chainId: this.cfg.chainId, now: Number(block.timestamp), ledger: this.ledger },
    )
    if (!pre.ok && pre.code.startsWith('SESSION_')) return void j.move(op.opId, 'discarded', pre.code, {}, pre.detail)
    const nonce = await this.entryPointNonce(block.number)
    const baseFee = block.baseFeePerGas ?? 0n
    const gas = engineGas(baseFee, this.cfg.policy.actionPolicy?.gasPolicy?.caps)
    // Spec 007 T7: a v4 session's MamoruGasPolicy refuses an op over its owner-signed caps; at a basefee that leaves no
    // room under maxFeePerGas the engine waits instead of sending one that cannot validate.
    if (!gas) return void j.move(op.opId, 'discarded', 'GAS_PRICE_OVER_CAP', {}, `basefee ${baseFee}`)
    let userOp = draftUserOp(this.cfg.account, nonce, callData, gas)
    j.move(op.opId, 'prepared', 'EHG_OK', {
      prepareBlock: block.number,
      permissionId: session.permissionId,
      calls: prepared.calls,
      callData,
      quote: prepared.quote,
      expiresAt: prepared.expiresAt,
      precheck: pre.ok ? 'SESSION_ACTIVE' : pre.code,
      nonceKey: this.nonceKey,
      nonce,
      userOp,
      ehg: [{ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' }],
    })
    if (!pre.ok) return void j.move(op.opId, 'discarded', pre.code, {}, pre.detail)

    // simulate: eth_simulateV1 from the EntryPoint, deltas against the intent.
    let sim: Simulation
    try {
      sim = await simulateFromEntryPoint(this.client, this.cfg.account, callData, block.number, this.registry)
    } catch (e) {
      if (e instanceof ReasonError) return void j.move(op.opId, 'discarded', e.code, {}, e.detail)
      throw e
    }
    if (!sim.ok) return void j.move(op.opId, 'discarded', 'EHG_SIM_REVERT', { simulation: sim }, sim.revert)
    const mismatch = this.deltaMismatch(proposal, prepared, sim)
    if (mismatch) return void j.move(op.opId, 'discarded', 'EHG_SIM_DELTA_MISMATCH', { simulation: sim }, mismatch)
    // otto/mamoru#61: a chain that charges the gas limit gets limits sized from this simulation (tightUserOpGas).
    if (this.cfg.gasModel === 'gas_limit') {
      const tight = tightUserOpGas(userOp, sim.gasUsed)
      if (!tight) return void j.move(op.opId, 'discarded', 'AA_GAS_MARGIN_EXCEEDED', { simulation: sim }, `simulated ${sim.gasUsed} gas: the tight limits would exceed the engine's`)
      userOp = draftUserOp(this.cfg.account, nonce, callData, tight)
    }
    j.move(op.opId, 'simulated', 'EHG_OK', { simulation: sim, ...(this.cfg.gasModel === 'gas_limit' ? { userOp } : {}), ehg: [...op.ehg, { gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' }] })
    if (proposal.kind === 'harvest' && !this.harvestCollectsFees(proposal, prepared, sim)) {
      return void j.move(op.opId, 'discarded', 'OP_DECISION_STALE', {}, 'the harvest no longer collects any fees')
    }

    // sign: nonce, userOp, hash and signature in one step, only from `simulated`.
    const now = await this.client.getBlock({ blockTag: 'latest' })
    const premise = await this.client.getBlock({ blockNumber: obs.block.number })
    const blocker = signBlocker({
      mode: this.cfg.mode,
      chainId: this.cfg.chainId,
      signingChainIds: this.cfg.signingChainIds,
      observationAgeSeconds: Number(now.timestamp - obs.block.timestamp),
      observationTtlSeconds: this.cfg.policy.execution.observationTtlSeconds,
      observationCanonical: premise.hash === obs.block.hash,
      preparedNonce: nonce,
      chainNonce: await this.entryPointNonce(now.number),
    })
    if (blocker) return void j.move(op.opId, 'discarded', blocker)
    const hash = userOpHash(userOp, this.cfg.chainId, this.registry)
    // otto/mamoru#215: a bridge-out is in the operator's bridge journal (on disk, counted in flight) before it is signed;
    // without the journal it is never signed.
    if (proposal.kind === 'bridge_out') {
      const refusal = this.journalBridge(op.opId, proposal, hash, nonce, block.number)
      if (refusal) return void j.move(op.opId, 'discarded', 'BRIDGE_JOURNAL_UNAVAILABLE', {}, refusal)
    }
    const signed = await this.signUserOp(proposal, userOp, hash, session.permissionId)
    j.move(op.opId, 'signed', 'OP_SIGNED', { userOp: signed, userOpHash: hash })

    // send: the same bytes to a standard ERC-4337 endpoint.
    try {
      const accepted = await this.bundler.sendUserOperation(signed)
      if (accepted.toLowerCase() !== hash.toLowerCase()) throw new Error(`bundler answered hash ${accepted}, journal has ${hash}`)
    } catch (e) {
      if (e instanceof BundlerRpcError) {
        j.move(op.opId, 'pending_reconciliation', 'BUNDLER_REJECTED', {}, e.message)
        // Live (otto/mamoru#140): a rejection is not a cancellation. The signed bytes may still land while the nonce is
        // unused; the op is settled from the chain (nonce, expiry, permission) now and at every later review.
        if (this.cfg.mode === 'live') await this.settlePending(this.journal.op(op.opId))
        return
      }
      if (e instanceof ReasonError && e.code === 'BUNDLER_UNAVAILABLE') return void j.move(op.opId, 'pending_reconciliation', 'BUNDLER_UNAVAILABLE', {}, e.detail)
      throw e
    }
    j.move(op.opId, 'submitted', 'BUNDLER_ACCEPTED')

    // await: the RPC's UserOperationEvent is the proof; the bundler receipt is checked against it.
    let ev = null
    const maxWait = this.cfg.maxWaitBlocks ?? MAX_WAIT_BLOCKS
    for (let i = 0; i < maxWait && !ev; i++) {
      ev = await readUserOpEvent(this.client, hash, block.number, this.registry)
      if (!ev) await this.hooks.waitBlock()
    }
    if (!ev) return void j.move(op.opId, 'pending_reconciliation', 'RECON_TIMEOUT')
    // The RPC event stays the authority; the bundler receipt is reconciled against it and the journal, and any conflict is kept.
    const receipt = await this.bundler.getUserOperationReceipt(hash)
    const receiptCheck = reconcileReceipt({ userOpHash: hash, sender: this.cfg.account, nonce }, ev, receipt)
    if (ev.sender.toLowerCase() !== this.cfg.account.toLowerCase() || ev.nonce !== nonce) throw new Error(`${op.opId}: UserOperationEvent of ${ev.sender} nonce ${ev.nonce} for our hash`)
    j.move(
      op.opId,
      'included',
      'OP_INCLUDED',
      {
        included: { blockNumber: ev.blockNumber, blockHash: ev.blockHash, txHash: ev.txHash, success: ev.success, actualGasCost: ev.actualGasCost },
        bundlerReceipt: receipt ?? undefined,
        receiptCheck,
      },
      receiptCheck.status === 'match' ? undefined : `bundler receipt ${receiptCheck.status}${receiptCheck.status === 'mismatch' ? `: ${receiptCheck.fields.join(', ')}` : ''}; RPC event kept`,
    )

    // confirm: only in a block at or below `safe` whose hash is still canonical (FR-ENG-008).
    for (let i = 0; i < maxWait; i++) {
      const s = await isSafeAndCanonical(this.client, ev.blockNumber, ev.blockHash)
      if (!s.canonical) return void j.move(op.opId, 'pending_reconciliation', 'RECON_REORGED')
      if (s.safe) {
        if (!ev.success) return void j.move(op.opId, 'failed', 'EXEC_INNER_REVERT', { confirmedSafeBlock: s.safeBlock })
        j.move(op.opId, 'confirmed', 'EXEC_OK', { confirmedSafeBlock: s.safeBlock })
        await this.afterConfirmed(op, proposal, pre.calls, ev.logs)
        return
      }
      await this.hooks.waitBlock()
    }
    // Still above `safe`: stays `included`; the next review holds on the busy slot.
  }

  /** Signs the userOp; a bridge-out whose signing fails is handed back to the journal as never signed (review of #144). */
  private async signUserOp(proposal: Proposal, userOp: Parameters<typeof signSessionUserOp>[0], hash: Hex, permissionId: Hex): ReturnType<typeof signSessionUserOp> {
    try {
      return await signSessionUserOp(userOp, this.cfg.chainId, permissionId, this.cfg.sessionKey, this.registry)
    } catch (e) {
      // Journaled but never signed: nothing can land, so the journal must not keep it in flight.
      if (proposal.kind === 'bridge_out') {
        try {
          this.hooks.bridgeUnsigned?.(hash)
        } catch {}
      }
      throw e
    }
  }

  /**
   * otto/mamoru#215: hands a bridge-out about to be signed to the operator's bridge journal (`beforeBridgeSign`). Returns
   * why it may not be signed (no journal, or the journal refused or failed to write it), or null once it is recorded.
   */
  private journalBridge(opId: string, p: Extract<Proposal, { kind: 'bridge_out' }>, hash: Hex, nonce: bigint, prepareBlock: bigint): string | null {
    if (!this.hooks.beforeBridgeSign) return 'no bridge journal: a bridge-out is never signed without one'
    const destinationDomain = CCTP_DOMAIN_BY_CHAIN[p.chainId]
    if (destinationDomain === undefined) return `no CCTP domain for chain ${p.chainId}`
    try {
      this.hooks.beforeBridgeSign({ opId, account: this.cfg.account, chainId: p.chainId, pool: p.pool, bucket: p.bucket, amount: p.amount, destinationDomain, userOpHash: hash, nonceKey: this.nonceKey, nonce, prepareBlock })
      return null
    } catch (e) {
      return `bridge journal: ${(e as Error).message?.split('\n')[0] ?? String(e)}`
    }
  }

  /** A live op left `pending_reconciliation` with signed bytes: settled from the chain when it can be (`settleUnincluded`). */
  private async resumePending(): Promise<void> {
    const op = this.journal.live
    // RECON_REORGED too: an op whose block was reorged out is looked for again, like any other (Sol review of #64).
    if (this.cfg.mode !== 'live' || !op || op.state !== 'pending_reconciliation') return
    await this.settlePending(op)
  }

  private async settlePending(op: OpRecord): Promise<void> {
    if (!op.userOpHash || op.nonce === undefined || !op.permissionId || op.prepareBlock === undefined) return
    const safe = await this.client.getBlock({ blockTag: 'safe' })
    const [nonceAtSafe, permissionEnabledAtSafe, ev] = await Promise.all([
      this.entryPointNonce(safe.number),
      this.client.readContract({ address: address('SmartSession', this.registry), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [op.permissionId, this.cfg.account], blockNumber: safe.number }),
      readUserOpEvent(this.client, op.userOpHash, op.prepareBlock, this.registry),
    ])
    const verdict = settleUnincluded({
      opNonce: op.nonce,
      nonceAtSafe,
      eventFound: !!ev,
      safeTimestamp: safe.timestamp,
      expiresAt: op.expiresAt ?? null,
      permissionEnabledAtSafe,
      rejected: op.stateCode === 'BUNDLER_REJECTED',
    })
    if (!verdict) return
    if (verdict.to === 'included') {
      if (ev!.sender.toLowerCase() !== this.cfg.account.toLowerCase() || ev!.nonce !== op.nonce) throw new Error(`${op.opId}: UserOperationEvent of ${ev!.sender} nonce ${ev!.nonce} for our hash`)
      return void this.journal.move(op.opId, 'included', 'OP_INCLUDED', { included: { blockNumber: ev!.blockNumber, blockHash: ev!.blockHash, txHash: ev!.txHash, success: ev!.success, actualGasCost: ev!.actualGasCost } }, 'found on chain after the bundler did not report it')
    }
    this.journal.move(op.opId, 'failed', verdict.code, {}, verdict.detail)
    if (verdict.code === 'RECON_UNINCLUDABLE') {
      this.backoff.push({ premiseHash: op.premiseHash, key: proposalKey(op.intent), until: safe.timestamp + UNINCLUDABLE_BACKOFF_SECONDS })
      // Its bytes can still be included (past the expiry they revert, but they spend the nonce): watched until then.
      this.released.push(op)
    }
  }

  /**
   * otto/mamoru#140 (Sol review of #64): ops freed as RECON_UNINCLUDABLE whose signed bytes may still be included. Past
   * its expiry a swap, mint or decrease reverts inside the batch, but the userOp still validates, spends the nonce and
   * counts against the session's usage; a collect-only op still collects. The next op signed on that nonce then sees it
   * spent by another (RECON_NONCE_CONSUMED_BY_OTHER, handled). This keeps the account's own books right: once such an
   * op lands at a safe, canonical block it is recorded on its op (`lateIncluded`), its uses go into the ledger and, if
   * it executed, its effects (a harvest's savings row, a burn) are applied. An op is dropped from here once the nonce
   * at `safe` is past its own without its event: it can never land.
   */
  private readonly released: OpRecord[] = []

  /**
   * What the account must keep watching past this engine (a restart, a renewal, a stop): every released op, and the
   * live op whenever it is unsettled with signed bytes: signed, submitted, included but not yet safe (Sol review of the
   * rebase onto #60: a grant sweep can stop the engine before it confirms an included mint), or in
   * pending_reconciliation (a bundler rejection, a reorg). The operator stores these and hands them to the next engine
   * (`carried`), which applies a landing's effects.
   */
  carried(): OpRecord[] {
    const live = this.journal.live
    const unsettled = live && CARRIED_STATES.has(live.state) && live.userOpHash && live.nonce !== undefined && live.prepareBlock !== undefined
    const pending = unsettled ? [live] : []
    return [...this.released, ...pending.filter((o) => !this.released.includes(o))]
  }

  private async watchReleased(): Promise<void> {
    if (!this.released.length) return
    const safe = await this.client.getBlock({ blockTag: 'safe' })
    const nonceAtSafe = await this.entryPointNonce(safe.number)
    for (const op of [...this.released]) {
      const ev = await readUserOpEvent(this.client, op.userOpHash!, op.prepareBlock!, this.registry)
      if (!ev) {
        if (nonceAtSafe !== op.nonce) {
          this.released.splice(this.released.indexOf(op), 1)
          // The operator's stored copy goes too.
          try {
            this.journal.onMove?.(op)
          } catch {
            // dropped here all the same
          }
        }
        continue
      }
      if (ev.sender.toLowerCase() !== this.cfg.account.toLowerCase() || ev.nonce !== op.nonce) throw new Error(`${op.opId}: UserOperationEvent of ${ev.sender} nonce ${ev.nonce} for our hash`)
      const s = await isSafeAndCanonical(this.client, ev.blockNumber, ev.blockHash)
      if (!s.canonical || !s.safe) continue
      // Sol review round 3 of #64: the op stays watched until its effects are applied and the operator has stored it.
      // Effects that throw (an RPC read inside afterConfirmed) leave it here for the next tick; applied once
      // (`lateApplied`), they are not applied again when only the store failed.
      if (!op.lateApplied) {
        op.included = { blockNumber: ev.blockNumber, blockHash: ev.blockHash, txHash: ev.txHash, success: ev.success, actualGasCost: ev.actualGasCost }
        op.confirmedSafeBlock = s.safeBlock
        if (ev.success) await this.afterConfirmed(op, op.intent, op.calls ?? [], ev.logs)
        else this.recordUse(op, op.calls ?? [])
        op.lateIncluded = true
        op.lateApplied = true
      }
      this.released.splice(this.released.indexOf(op), 1)
      try {
        this.journal.onMove?.(op)
      } catch {
        // Not stored: watched again, so the next tick stores it (its effects are not applied twice).
        this.released.push(op)
      }
    }
  }

  /** An op left `included` when the wait ran out (slow `safe` head): confirm it once `safe` reaches its block. */
  private async resumeIncluded(): Promise<void> {
    const op = this.journal.live
    if (!op || op.state !== 'included' || !op.included || !op.userOpHash) return
    const s = await isSafeAndCanonical(this.client, op.included.blockNumber, op.included.blockHash)
    if (!s.canonical) return void this.journal.move(op.opId, 'pending_reconciliation', 'RECON_REORGED')
    if (!s.safe) return
    if (!op.included.success) return void this.journal.move(op.opId, 'failed', 'EXEC_INNER_REVERT', { confirmedSafeBlock: s.safeBlock })
    const ev = await readUserOpEvent(this.client, op.userOpHash, op.included.blockNumber, this.registry)
    if (!ev) return
    this.journal.move(op.opId, 'confirmed', 'EXEC_OK', { confirmedSafeBlock: s.safeBlock })
    await this.afterConfirmed(op, op.intent, op.calls ?? [], ev.logs)
  }

  private async afterConfirmed(op: OpRecord, proposal: Proposal, calls: Execution[], logs: Log[]): Promise<void> {
    // Once per op: a late landing whose later effects failed (a history read) is retried, its use is not counted again
    // (Sol review round 4 of #64).
    this.recordUse(op, calls)
    if (proposal.kind === 'enter_mint') {
      const minted = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs, eventName: 'Transfer' }).find(
        (l) => isAddressEqual(l.address, address('NonfungiblePositionManager', this.registry)) && isAddressEqual(l.args.to, this.cfg.account),
      )
      if (!minted) throw new Error(`${op.opId}: confirmed mint without a position transfer to the account`)
      op.mintedTokenId = minted.args.tokenId
      if (!this.allowedTokenIds.includes(minted.args.tokenId)) this.allowedTokenIds.push(minted.args.tokenId)
      this.hooks.onMinted?.(minted.args.tokenId, op.included?.blockNumber)
      // Spec 007 (#151) T4: a tokenId minted under a pool MamoruActionPolicy covers went through the policy's own
      // `mint` (T3's `prepareCalls`), which is exactly what `admittedPool` on chain records — mirror it here so a
      // later decrease/collect/burn of this tokenId passes precheck's admission check.
      if (this.actionPolicyConfigFor(proposal.pool)) this.ledger.admitTokenId(minted.args.tokenId, proposal.pool)
      if (!hasManageAny(this.cfg.policy)) {
        if (!this.hooks.requestManageGrant) throw new Error(`${op.opId}: policy ${this.cfg.policy.policyId} needs a manage grant per position`)
        this.addSession(await this.hooks.requestManageGrant(minted.args.tokenId, proposal.pool))
      }
    }
    if (proposal.kind === 'rerange') {
      const inc = op.included!
      this.lastRerangeAt = (await this.client.getBlock({ blockNumber: inc.blockNumber })).timestamp
      this.reranges.push({ pool: proposal.pool, at: this.lastRerangeAt, block: inc.blockNumber })
      this.hooks.onReranged?.(proposal.pool, this.lastRerangeAt, inc.blockNumber)
      const i = this.allowedTokenIds.indexOf(proposal.tokenId)
      if (i >= 0) this.allowedTokenIds.splice(i, 1)
    }
    if (proposal.kind === 'harvest') {
      const inc = op.included!
      const pool = entry(proposal.pool, this.registry)
      const collect = positionEvents(logs, this.registry).find((e) => e.kind === 'collect' && e.tokenId === proposal.tokenId)
      if (!collect) throw new Error(`${op.opId}: confirmed harvest without a Collect of ${proposal.tokenId}`)
      // FR-PRJ-003: the principal owed right before this Collect, folded from the canonical history, owner actions included.
      const owed = await principalOwedBefore(this.client, [proposal.tokenId], this.historyFromBlock, { block: inc.blockNumber, logIndex: collect.logIndex }, this.registry)
      this.savingsLog.push(
        harvestRow({
          opId: op.opId,
          tokenId: proposal.tokenId,
          chainId: this.cfg.chainId,
          block: inc.blockNumber,
          blockHash: inc.blockHash,
          txHash: inc.txHash,
          at: new Date(Number((await this.client.getBlock({ blockNumber: inc.blockNumber })).timestamp) * 1000).toISOString(),
          logs,
          account: this.cfg.account,
          pool: pool.address,
          pendingBefore: owed.get(proposal.tokenId) ?? [0n, 0n],
          savingsIsToken0: pool.token0 === this.cfg.policy.savingsAsset,
          // otto/mamoru#140: a harvest only collects; the volatile fees stay in the account.
          converted: false,
        }),
      )
    }
  }

  /** The op's session use, into the ledger once (`useRecorded`). */
  private recordUse(op: OpRecord, calls: Execution[]): void {
    if (op.useRecorded) return
    this.ledger.recordIncluded(op.permissionId!, calls)
    op.useRecorded = true
  }

  private async entryPointNonce(blockNumber: bigint): Promise<bigint> {
    return this.client.readContract({
      address: address('EntryPointV07', this.registry),
      abi: entryPointV07Abi,
      functionName: 'getNonce',
      args: [this.cfg.account, this.nonceKey],
      blockNumber,
    })
  }

  /**
   * otto/mamoru#140. `decide` checked spot against the TWAP at the observation block; the calls are priced at a later
   * block, where a swap in that block could have moved slot0 and QuoterV2. The same check runs again here, at the
   * prepare block, for every operation that prices a pool. Returns the TWAP tick.
   */
  private async priceGuard(pool: string, blockNumber: bigint): Promise<number> {
    const e = entry(pool, this.registry)
    const { twapWindowSeconds, maxTwapDeviationTicks } = this.cfg.policy.execution
    const [[, tick], twap] = await Promise.all([
      this.client.readContract({ address: e.address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber }),
      twapTickAt(this.client, e.address, twapWindowSeconds, blockNumber),
    ])
    if (diverges(tick, twap, maxTwapDeviationTicks)) throw new ReasonError('EHG_PRICE_DIVERGENCE', `${pool}: tick ${tick} at block ${blockNumber}, TWAP ${twap}`)
    return twap
  }

  /**
   * Spec 007 T6: `priceGuard` for a v4-covered pool — the same slot0-vs-TWAP divergence check (otto/mamoru#140,
   * kept for every policy), but the TWAP read is MamoruActionPolicy's own two-window oracle (`poolOracle`, one
   * `observe([long, short, 0])`) instead of `twapTickAt`'s single-window one: no extra eth_call versus before (T3:
   * "no extra RPC per op if avoidable"), and the short window and liquidity it also returns feed the range math
   * (`v4Range`) right below. The divergence check itself still runs against the long TWAP, same as `priceGuard`.
   */
  private async priceGuardV4(pool: RegistryName, blockNumber: bigint, shortWindowSeconds: number): Promise<OracleRead> {
    const e = entry(pool, this.registry)
    const { twapWindowSeconds, maxTwapDeviationTicks } = this.cfg.policy.execution
    const [[, tick], oracle] = await Promise.all([
      this.client.readContract({ address: e.address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber }),
      this.poolOracle(pool, twapWindowSeconds, shortWindowSeconds, blockNumber),
    ])
    if (diverges(tick, oracle.twapLong, maxTwapDeviationTicks)) throw new ReasonError('EHG_PRICE_DIVERGENCE', `${pool}: tick ${tick} at block ${blockNumber}, TWAP ${oracle.twapLong}`)
    return oracle
  }

  /**
   * The router minimum of an engine swap, judged at the pool's TWAP and never at its spot: slot0 and a quote at the
   * block we read can both be moved by a swap in that same block, and the grant only asks amountOutMinimum > 0.
   * - otto/mamoru#140: never under what the input buys at the TWAP moved `maxTwapDeviationTicks` against the swap,
   *   less the tolerance (slippage, or the impact budget with depth sizing on); a quote under it is refused
   *   (EHG_PRICE_DIVERGENCE).
   * - otto/mamoru#127, depth sizing on: the quote (which crosses ticks) must be within `maxImpactBps` of what the
   *   input buys at the TWAP itself, the pool fee aside (EHG_SWAP_IMPACT_OVER_LIMIT).
   * The minimum is the largest of the usual slippage minimum on the quote and both floors.
   */
  private async swapMin(p: { pool: string; tokenIn: string; fee: number; amountIn: bigint }, amountOut: bigint, blockNumber: bigint, knownTwapTick?: number): Promise<bigint> {
    const e = entry(p.pool, this.registry)
    const { slippageBps, maxTwapDeviationTicks } = this.cfg.policy.execution
    const depth = this.cfg.policy.depth
    const impactBps = depth ? (depth.maxImpactBpsByPool?.[p.pool] ?? depth.maxImpactBps) : null
    const tokenInIsToken0 = e.token0 === p.tokenIn
    // Spec 007 (#151) T3: a v4-covered pool already read the TWAP (and ran the divergence check) for its own band
    // math right above; reuse it here rather than a second `observe`+`slot0` (T3: "no extra RPC per op if avoidable").
    const twapTick = knownTwapTick ?? (await this.priceGuard(p.pool, blockNumber))
    const tolerance = impactBps !== null && impactBps > slippageBps ? impactBps : slippageBps
    const floor = deviationFloor({ amountIn: p.amountIn, fee: p.fee, twapTick, tokenInIsToken0, deviationTicks: maxTwapDeviationTicks, slippageBps: tolerance })
    const impactFloor = impactBps !== null ? twapFloor(p.amountIn, p.fee, twapTick, tokenInIsToken0, impactBps) : 0n
    if (amountOut < impactFloor) throw new ReasonError('EHG_SWAP_IMPACT_OVER_LIMIT', `${p.pool}: quote ${amountOut} for ${p.amountIn}, under ${impactFloor} (TWAP tick ${twapTick}, ${impactBps} bps)`)
    const min = swapMinimum(amountOut, slippageBps, floor)
    if (min === null) throw new ReasonError('EHG_PRICE_DIVERGENCE', `${p.pool}: quote ${amountOut} for ${p.amountIn} ${p.tokenIn}, under the TWAP floor ${floor} (tick ${twapTick})`)
    return impactFloor > min ? impactFloor : min
  }

  /**
   * otto/mamoru#140: the on-chain expiry of a swap batch. With the deadline action in the session grant, the batch
   * carries SwapRouter02.multicall(deadline, []) and cannot execute after `deadline`. A grant from before has no
   * such action: the only on-chain bound is then the session's own validUntil (TimeFramePolicy), until the owner
   * renews to grants that have it.
   */
  private swapExpiry(session: EngineSession, deadline: bigint): { calls: V3Call[]; expiresAt: bigint } {
    if (grantHasSwapDeadline(session.grant, this.registry)) return { calls: [this.v3.deadlineCheck(deadline)], expiresAt: deadline }
    // validUntil 0 is no bound at all (ERC-4337 validationData): nothing settles the op but its nonce then.
    const until = session.grant.userOp.validUntil
    return { calls: [], expiresAt: until > 0 ? BigInt(until) : 2n ** 64n }
  }

  /**
   * The pool's TWAP tick at `blockNumber`, shared by depth sizing (`depthFloor`) for a non-v4 pool, so a swap under
   * it needs only one read (spec 007 T3: "no extra RPC per op if avoidable"). otto/mamoru#140 (Sol review of #64)
   * moved the one `observe` eth_call and its floor rounding (`OracleLibrary.consult`'s own rounding, the same
   * formula `MamoruActionPolicy._twapTick` uses on chain) into `@mamoru/uniswap-v3/twap`'s `twapTickAt`, which
   * `priceGuard` above also calls: one code path. A v4-covered pool reads `poolOracle`/`priceGuardV4` instead (both
   * TWAPs in one `observe`).
   */
  private async poolTwapTick(pool: RegistryName, windowSeconds: number, blockNumber: bigint): Promise<number> {
    return twapTickAt(this.client, entry(pool, this.registry).address as Address, windowSeconds, blockNumber)
  }

  /**
   * Spec 007 T6 (M-1, H-1): MamoruActionPolicy's own oracle read — one `observe([long, short, 0])` at `blockNumber`,
   * folded exactly as `MamoruActionPolicy._oracle` does (`oracleFromObserve`): both TWAP ticks. `twapLong` is the
   * same tick `poolTwapTick(pool, long)` returns.
   */
  private async poolOracle(pool: RegistryName, longSeconds: number, shortSeconds: number, blockNumber: bigint): Promise<OracleRead> {
    try {
      const [ticks] = await this.client.readContract({ address: entry(pool, this.registry).address as Address, abi: observeAbi, functionName: 'observe', args: [[longSeconds, shortSeconds, 0]], blockNumber })
      return oracleFromObserve(ticks, longSeconds, shortSeconds)
    } catch {
      throw new ReasonError('EHG_TWAP_UNAVAILABLE', `${pool}: observe(${longSeconds}, ${shortSeconds}) did not answer at ${blockNumber}`)
    }
  }

  /**
   * Spec 007 T6: the range the engine builds a v4 call against — MamoruActionPolicy's `_range` at the engine's
   * narrower band, clipped to the pool's anchor. Refuses (POLICY_PRICE_BAND) where the policy would find it empty
   * anyway: TWAPs too far apart, or the price outside the anchor.
   */
  private v4Range(pool: RegistryName, v4: { bandTicks: number; anchor?: PriceAnchor }, o: OracleRead): PriceRange {
    const r = priceRange(o, v4.bandTicks, v4.anchor)
    if (!r) throw new ReasonError('POLICY_PRICE_BAND', `${pool}: empty range (twap ${o.twapLong}/${o.twapShort}, band ${v4.bandTicks})`)
    return r
  }

  /**
   * otto/mamoru#127, with depth sizing on. Slot0 and a quote at the block we read can both be moved by a swap in that
   * same block, so the entry swap is judged against the pool's TWAP, never against its spot:
   * - the quote (which crosses ticks) must be within `maxImpactBps` of what the input buys at the TWAP, the pool fee
   *   aside; otherwise it is refused before anything is sent (EHG_SWAP_IMPACT_OVER_LIMIT);
   * - the router minimum is the larger of the usual slippage minimum on the quote and that TWAP bound, so whatever
   *   happens to the price before inclusion, the swap never executes worse than the limit against the TWAP.
   * `tick`: the pool's TWAP at the review block, already read once by the caller (`poolTwapTick`). Returns the
   * minimum out to use, or null when depth sizing is off (the usual minimum applies).
   */
  private depthFloor(p: Extract<Proposal, { kind: 'enter_swap' }>, amountOut: bigint, tick: number): bigint | null {
    const depth = this.cfg.policy.depth
    if (!depth) return null
    const pool = entry(p.pool, this.registry)
    const limit = depth.maxImpactBpsByPool?.[p.pool] ?? depth.maxImpactBps
    const floor = twapFloor(p.amountIn, p.fee, tick, pool.token0 === p.tokenIn, limit)
    if (amountOut < floor) throw new ReasonError('EHG_SWAP_IMPACT_OVER_LIMIT', `${p.pool}: quote ${amountOut} for ${p.amountIn}, under ${floor} (TWAP tick ${tick}, ${limit} bps)`)
    return floor
  }

  /**
   * Spec 007 (#151) T3: when the engine's policy carries a deployed MamoruActionPolicy covering `pool`
   * (`cfg.policy.actionPolicy.bandTicksByPool[pool]`), the narrower band it computes bounds at — the pool's own
   * `bandTicks` scaled down by `bandFactorBps` (default 0.8x, `DEFAULT_BAND_FACTOR_BPS`). A pool the config does
   * not list, or no `actionPolicy` at all (every live policy today), returns `undefined`: every call for it stays
   * byte-identical to today (fail safe — never assume a band the caller did not confirm it enabled on chain).
   */
  private v4PoolConfig(pool: RegistryName): { address: Address; bandTicks: number; anchor?: PriceAnchor; twapShortSeconds: number } | undefined {
    const ap = this.cfg.policy.actionPolicy
    const bandTicks = ap?.bandTicksByPool[pool]
    if (!ap || bandTicks === undefined) return undefined
    const factor = ap.bandFactorBps ?? DEFAULT_BAND_FACTOR_BPS
    const anchor = ap.anchorByPool?.[pool]
    return { address: ap.address, bandTicks: Math.floor((bandTicks * factor) / 10_000), ...(anchor ? { anchor } : {}), twapShortSeconds: ap.twapShortWindowSeconds ?? TWAP_SHORT_WINDOW_SECONDS }
  }

  /**
   * Spec 007 (#151) T4: `pool`'s FULL (1.0x, the account's actually-enabled) MamoruActionPolicy config for
   * precheck's own mirror of `checkAction` — never `v4PoolConfig`'s narrower band, which only exists to build
   * calls the policy accepts with margin. `undefined`: same fail-safe as `v4PoolConfig` (no `actionPolicy`, the
   * pool is not in `bandTicksByPool`, or it has no `budgetsByPool` entry — precheck cannot mirror (c) without
   * knowing the budget caps, since the contract exposes no getter for them) — precheck then runs grant-only
   * checks for this pool, exactly as it did before this unit.
   */
  private actionPolicyConfigFor(pool: RegistryName): ActionPolicyPoolConfig | undefined {
    const ap = this.cfg.policy.actionPolicy
    const bandTicks = ap?.bandTicksByPool[pool]
    const budget = ap?.budgetsByPool?.[pool]
    if (!ap || bandTicks === undefined || !budget) return undefined
    const anchor = ap.anchorByPool?.[pool]
    const e = entry(pool, this.registry)
    if (!e.token0 || !e.token1 || !e.fee) return undefined
    return {
      pool,
      address: ap.address,
      token0: address(e.token0, this.registry),
      token1: address(e.token1, this.registry),
      feePips: e.fee,
      bandTicks,
      ...(anchor ? { anchor } : {}),
      ...(ap.contractVersion === 2 ? { exitIgnoresAnchor: true } : {}),
      budgetIn1: budget.in1,
      budgetWindowSeconds: budget.windowSeconds,
      perWindow: budget.perWindow,
      total: budget.total,
    }
  }

  /**
   * Spec 007 (#151) T4: refreshes the ledger's mirror of MamoruActionPolicy for `pool` right before precheck runs
   * on this op — the same "read right before validating" discipline T3's bound-building already follows for the
   * TWAP (`poolTwapTick`). Two extra eth_calls (`spendOf`, `generationOf`) plus one `observe`, all at this op's own
   * block; a no-op for any pool `actionPolicyConfigFor` does not cover — every live policy today, since
   * `actionPolicy` is never set on `POLICIES`.
   */
  private async syncActionPolicyLedger(pool: RegistryName, blockNumber: bigint, tokenId?: bigint): Promise<void> {
    const cfg = this.actionPolicyConfigFor(pool)
    if (!cfg) return
    this.ledger.watchActionPolicyPool(cfg)
    const poolAddress = entry(pool, this.registry).address
    // Spec 007 T7: a position admitted on chain before this engine started (an earlier run's mint through the policy,
    // or a renewal's owner-signed Init.admit) is read from `admittedPool` once, so precheck's mirror agrees with the
    // chain after an operator restart too. Only ever adds what the chain already has.
    if (tokenId !== undefined && !this.ledger.isAdmitted(tokenId, pool)) {
      const at = await this.client.readContract({ address: cfg.address, abi: mamoruActionPolicyReadAbi, functionName: 'admittedPool', args: [this.cfg.account, tokenId], blockNumber })
      if (at.toLowerCase() === poolAddress.toLowerCase()) this.ledger.admitTokenId(tokenId, pool)
    }
    const [spend, currentGeneration, oracle] = await Promise.all([
      this.client.readContract({ address: cfg.address, abi: mamoruActionPolicyReadAbi, functionName: 'spendOf', args: [this.cfg.account, poolAddress], blockNumber }),
      this.client.readContract({ address: cfg.address, abi: mamoruActionPolicyReadAbi, functionName: 'generationOf', args: [this.cfg.account], blockNumber }),
      this.poolOracle(pool, this.cfg.policy.execution.twapWindowSeconds, this.cfg.policy.actionPolicy?.twapShortWindowSeconds ?? TWAP_SHORT_WINDOW_SECONDS, blockNumber),
    ])
    this.ledger.syncActionPolicyReads(pool, { oracle, spend, currentGeneration })
  }

  /**
   * otto/mamoru#151: under MamoruActionPolicyV2 (`actionPolicy.contractVersion` 2), a guardian pause refuses every session
   * action at validation; the engine reads it at the prepare block and waits (POLICY_PAUSED) instead of sending an op
   * that cannot validate. V1 has no pause: no read.
   */
  private async refuseWhilePaused(blockNumber: bigint): Promise<void> {
    const ap = this.cfg.policy.actionPolicy
    if (ap?.contractVersion !== 2) return
    let paused: boolean
    try {
      paused = await this.client.readContract({ address: ap.address, abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', args: [this.cfg.account], blockNumber })
    } catch (e) {
      throw new ReasonError('EHG_TWAP_UNAVAILABLE', `MamoruActionPolicyV2.isPaused at ${blockNumber}: ${(e as Error).message.split('\n')[0]}`)
    }
    if (paused) throw new ReasonError('POLICY_PAUSED', `MamoruActionPolicyV2 ${ap.address}: the guardian paused ${this.cfg.account}`)
  }

  /**
   * Spec 007 T3, a swap in a pool MamoruActionPolicyV2 covers: minimum and price limit from the policy's range at the
   * engine band, and a quote taken WITH that limit, as the router will run it (#151 review P1-3). Near the band edge the
   * bounded swap stops at the limit and fills only part of the input, so the batch's deltas would not match: such a size
   * is halved, at most V4_SWAP_SIZE_DOWN_STEPS times, until the quote fills the whole input within the limit and meets
   * the bound. No size works: not sent (EHG_PRICE_DIVERGENCE). The prepared quote names the size sent.
   */
  private async prepareV4Swap(p: Extract<Proposal, { kind: 'enter_swap' }>, blockNumber: bigint, session: EngineSession, deadline: bigint, v4: NonNullable<ReturnType<Engine['v4PoolConfig']>>): Promise<Prepared> {
    const oracle = await this.priceGuardV4(p.pool, blockNumber, v4.twapShortSeconds)
    const range = this.v4Range(p.pool, v4, oracle)
    const zeroForOne = entry(p.pool, this.registry).token0 === p.tokenIn
    let amountIn = p.amountIn
    for (let step = 0; ; step++) {
      const bound = swapBoundsInRange({ range, feePips: p.fee, zeroForOne, tokenIn: address(p.tokenIn, this.registry), tokenOut: address(p.tokenOut, this.registry), amountIn })
      const q = await this.v3.quoteExactInputSingleWithLimit(this.client, { tokenIn: address(p.tokenIn, this.registry), tokenOut: address(p.tokenOut, this.registry), fee: p.fee, amountIn, sqrtPriceLimitX96: bound.sqrtPriceLimitX96, blockNumber })
      if (q.filled && q.amountOut >= bound.minOut) {
        // otto/mamoru#140: never under today's TWAP floors either (the max of the minimums, the tighter limit).
        let amountOutMinimum = await this.swapMin({ ...p, amountIn }, q.amountOut, blockNumber, oracle.twapLong)
        if (bound.minOut > amountOutMinimum) amountOutMinimum = bound.minOut
        const expiry = this.swapExpiry(session, deadline)
        return {
          quote: { amountIn, amountOut: q.amountOut, amountOutMinimum },
          calls: [...expiry.calls, this.v3.approve(p.tokenIn, 'SwapRouter02', amountIn), this.v3.exactInputSingle({ account: this.cfg.account, tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, amountIn, amountOutMinimum, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 })].map(exec),
          expiresAt: expiry.expiresAt,
        }
      }
      if (step >= V4_SWAP_SIZE_DOWN_STEPS || amountIn / 2n === 0n) {
        throw new ReasonError('EHG_PRICE_DIVERGENCE', `${p.pool}: ${amountIn} ${p.tokenIn} (of ${p.amountIn}) ${q.filled ? `returns ${q.amountOut}, under the policy bound ${bound.minOut}` : 'stops at the price limit'} (range ${range.lo}..${range.hi})`)
      }
      amountIn /= 2n
    }
  }

  /**
   * otto/mamoru#171: an entry added to a held position, only through MamoruActionPolicyV2.increase (`policyIncrease`):
   * approvals of the policy for the desired amounts (it pulls exactly them and refunds the rest, like its mint), then the
   * policy's increase. Re-read at the prepare block: the policy admitted the tokenId for this pool and the account still
   * owns it (the policy refuses otherwise), the position is the one decide split the amounts for (pool and range) with
   * the price strictly inside it, the divergence check and a non-empty policy range. Minimums as for a mint, from the
   * same quote over the position's range.
   */
  private async prepareIncrease(p: Extract<Proposal, { kind: 'increase_liquidity' }>, blockNumber: bigint, deadline: bigint): Promise<Prepared> {
    const v4 = this.v4PoolConfig(p.pool)
    if (!v4 || this.cfg.policy.actionPolicy?.contractVersion !== 2) throw new ReasonError('SESSION_MISSING', `${p.grant}: no MamoruActionPolicyV2 covers ${p.pool}; no session may call the position manager's increaseLiquidity`)
    const oracle = await this.priceGuardV4(p.pool, blockNumber, v4.twapShortSeconds)
    this.v4Range(p.pool, v4, oracle)
    const pool = entry(p.pool, this.registry)
    const [admittedAt, owner, pos, [sqrtPriceX96, tick]] = await Promise.all([
      this.client.readContract({ address: v4.address, abi: mamoruActionPolicyV2Abi, functionName: 'admittedPool', args: [this.cfg.account, p.tokenId], blockNumber }),
      this.client.readContract({ address: address('NonfungiblePositionManager', this.registry), abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', args: [p.tokenId], blockNumber }),
      this.client.readContract({ address: address('NonfungiblePositionManager', this.registry), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [p.tokenId], blockNumber }),
      this.client.readContract({ address: pool.address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber }),
    ])
    if (!isAddressEqual(admittedAt, pool.address)) throw new ReasonError('POLICY_NOT_ADMITTED', `position ${p.tokenId} is not admitted for ${p.pool} by ${v4.address}`)
    if (!isAddressEqual(owner, this.cfg.account)) throw new ReasonError('POLICY_DENIED_POSITION', `position ${p.tokenId} is no longer owned by the account (owner ${owner})`)
    if (!isAddressEqual(pos[2], address(pool.token0!, this.registry)) || !isAddressEqual(pos[3], address(pool.token1!, this.registry)) || pos[4] !== pool.fee || pos[5] !== p.tickLower || pos[6] !== p.tickUpper) {
      throw new ReasonError('OP_DECISION_STALE', `position ${p.tokenId} is not ${p.pool} [${p.tickLower}, ${p.tickUpper}]`)
    }
    if (!(p.tickLower < tick && tick < p.tickUpper)) throw new ReasonError('OP_DECISION_STALE', `${p.pool}: tick ${tick} is not inside [${p.tickLower}, ${p.tickUpper}]`)
    const q = quoteMint({ sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps: this.cfg.policy.execution.slippageBps })
    return {
      expiresAt: deadline,
      calls: [
        this.v3.approveTo(pool.token0!, v4.address, p.amount0Desired),
        this.v3.approveTo(pool.token1!, v4.address, p.amount1Desired),
        policyIncrease(v4.address, { tokenId: p.tokenId, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, amount0Min: q.amount0Min, amount1Min: q.amount1Min, deadline }),
      ].map(exec),
    }
  }

  /**
   * otto/mamoru#215: savings to the account's own sleeve on another chain, exactly what the bridge-out grant allows:
   * approve(TokenMessengerV2, amount) on the savings token, then depositForBurn(amount, the chain's CCTP domain, this
   * account, the savings token, any caller, fee 0, Standard finality). The approval is spent in full by the burn. No
   * on-chain expiry (CCTP has none): a late landing is a real burn, which the operator's bridge journal counts in flight
   * from before signing until the chain settles it.
   */
  private prepareBridgeOut(p: Extract<Proposal, { kind: 'bridge_out' }>): Prepared {
    const domain = CCTP_DOMAIN_BY_CHAIN[p.chainId]
    if (domain === undefined) throw new ReasonError('POLICY_DENIED_TARGET', `bridge_out to chain ${p.chainId}: no CCTP domain known for it`)
    if (p.amount <= 0n) throw new ReasonError('POLICY_DENIED_AMOUNT', `bridge_out of ${p.amount}`)
    const savings = this.cfg.policy.savingsAsset
    if (!isDeployed('TokenMessengerV2', this.registry) || !isDeployed(savings, this.registry)) throw new ReasonError('POLICY_TARGET_NOT_IN_REGISTRY', `bridge_out: TokenMessengerV2 or ${savings} is not in the ${this.registry.chain} registry`)
    const token = address(savings, this.registry)
    const messenger = address('TokenMessengerV2', this.registry)
    return {
      expiresAt: null,
      calls: [
        { target: token, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [messenger, p.amount] }) },
        {
          target: messenger,
          value: 0n,
          callData: encodeFunctionData({ abi: tokenMessengerV2Abi, functionName: 'depositForBurn', args: [p.amount, domain, pad(this.cfg.account, { size: 32 }), token, zeroHash, 0n, CCTP_STANDARD_FINALITY] }),
        },
      ],
    }
  }

  /** FR-UNI-001 to FR-UNI-006: calls from fresh quotes, exact approvals, nothing left approved. */
  private async prepareCalls(p: Proposal, blockNumber: bigint, timestamp: bigint, session: EngineSession): Promise<Prepared> {
    const acct = this.cfg.account
    const slippage = this.cfg.policy.execution.slippageBps
    // Every priced call of the batch expires on chain at the same time (NonfungiblePositionManager and SwapRouter02).
    const deadline = timestamp + BigInt(this.cfg.policy.execution.observationTtlSeconds)
    await this.refuseWhilePaused(blockNumber)
    if (p.kind === 'bridge_out') return this.prepareBridgeOut(p)
    // MamoruActionPolicyV2 accounts (v5) quote their swaps with the price limit; the deployed V1's (v4) keep the path below.
    const v4Swap = p.kind === 'enter_swap' && this.cfg.policy.actionPolicy?.contractVersion === 2 ? this.v4PoolConfig(p.pool) : undefined
    if (p.kind === 'enter_swap' && v4Swap) return this.prepareV4Swap(p, blockNumber, session, deadline, v4Swap)
    if (p.kind === 'enter_swap') {
      const amountOut = await this.v3.quoteExactInputSingle(this.client, { tokenIn: address(p.tokenIn, this.registry), tokenOut: address(p.tokenOut, this.registry), fee: p.fee, amountIn: p.amountIn, blockNumber })
      const v4 = this.v4PoolConfig(p.pool)
      // otto/mamoru#140: every engine swap is judged at the TWAP, not just depth-sized ones — `swapMin` runs the
      // divergence check (EHG_PRICE_DIVERGENCE) and the TWAP/impact floors unconditionally, for every policy
      // (spec 007 T6 conflict note: kept as-is here). A v4-covered pool reads both TWAPs in one `observe`
      // (`priceGuardV4`) instead of `priceGuard`'s single-window one — same eth_call count, no extra RPC per op —
      // and reuses the long tick for `swapMin` exactly as before (spec 007 T3).
      const oracle = v4 ? await this.priceGuardV4(p.pool, blockNumber, v4.twapShortSeconds) : undefined
      let amountOutMinimum = await this.swapMin(p, amountOut, blockNumber, oracle?.twapLong)
      let sqrtPriceLimitX96: bigint | undefined
      if (v4 && oracle) {
        // Spec 007 T3/T6: amountOutMinimum and sqrtPriceLimitX96 from the same math as MamoruActionPolicy's
        // `_range`/`_swapBounds`, at a narrower band (v4.bandTicks is already scaled by bandFactorBps) — "never
        // below today's TWAP floor (take the max of minimums, the tighter limit)".
        const pool = entry(p.pool, this.registry)
        const bound = swapBoundsInRange({
          range: this.v4Range(p.pool, v4, oracle),
          feePips: p.fee,
          zeroForOne: pool.token0 === p.tokenIn,
          tokenIn: address(p.tokenIn, this.registry),
          tokenOut: address(p.tokenOut, this.registry),
          amountIn: p.amountIn,
        })
        if (bound.minOut > amountOutMinimum) amountOutMinimum = bound.minOut
        sqrtPriceLimitX96 = bound.sqrtPriceLimitX96
      }
      const expiry = this.swapExpiry(session, deadline)
      return {
        quote: { amountIn: p.amountIn, amountOut, amountOutMinimum },
        calls: [...expiry.calls, this.v3.approve(p.tokenIn, 'SwapRouter02', p.amountIn), this.v3.exactInputSingle({ account: acct, tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, amountIn: p.amountIn, amountOutMinimum, sqrtPriceLimitX96 })].map(exec),
        expiresAt: expiry.expiresAt,
      }
    }
    if (p.kind === 'enter_mint') {
      await this.priceGuard(p.pool, blockNumber)
      const pool = entry(p.pool, this.registry)
      const [sqrtPriceX96] = await this.client.readContract({ address: pool.address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber })
      const q = quoteMint({ sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps: slippage })
      const v4 = this.v4PoolConfig(p.pool)
      if (!v4) {
        return {
          expiresAt: deadline,
          calls: [
            this.v3.approve(pool.token0!, 'NonfungiblePositionManager', p.amount0Desired),
            this.v3.approve(pool.token1!, 'NonfungiblePositionManager', p.amount1Desired),
            this.v3.mint({ account: acct, pool: p.pool, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, amount0Min: q.amount0Min, amount1Min: q.amount1Min, deadline }),
            this.v3.approve(pool.token0!, 'NonfungiblePositionManager', 0n),
            this.v3.approve(pool.token1!, 'NonfungiblePositionManager', 0n),
          ].map(exec),
        }
      }
      // Spec 007 T3 "(b) positions": mint through the policy, not the manager; approvals go to the policy, which
      // pulls exactly amount*Desired and refunds what it does not use (MamoruActionPolicy.mint), so the allowance
      // is spent in full without a trailing reset — packages/scenarios/action-policy/t1-fork.ts's "engine op 2"
      // mint does the same, no zero-approves.
      const mintParams = {
        token0: address(pool.token0!, this.registry),
        token1: address(pool.token1!, this.registry),
        fee: pool.fee!,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        amount0Desired: p.amount0Desired,
        amount1Desired: p.amount1Desired,
        amount0Min: q.amount0Min,
        amount1Min: q.amount1Min,
        recipient: acct,
        deadline,
      }
      const approveToPolicy = (tokenName: RegistryName, amount: bigint): Execution => ({
        target: address(tokenName, this.registry),
        value: 0n,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [v4.address, amount] }),
      })
      return {
        expiresAt: deadline,
        calls: [
          approveToPolicy(pool.token0!, p.amount0Desired),
          approveToPolicy(pool.token1!, p.amount1Desired),
          { target: v4.address, value: 0n, callData: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [mintParams] }) },
        ],
      }
    }
    if (p.kind === 'rerange' || p.kind === 'reduce') {
      // decreaseLiquidity(all or part) + collect(to the Safe) [+ burn]: nothing leaves the account.
      await this.priceGuard(p.pool, blockNumber)
      const [pos, [sqrtPriceX96]] = await Promise.all([
        this.client.readContract({ address: address('NonfungiblePositionManager', this.registry), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [p.tokenId], blockNumber }),
        this.client.readContract({ address: entry(p.pool, this.registry).address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber }),
      ])
      const liquidity = p.kind === 'rerange' ? pos[7] : p.liquidity < pos[7] ? p.liquidity : pos[7]
      const calls: V3Call[] = []
      if (liquidity > 0n) {
        const a = amountsOf(sqrtPriceX96, pos[5], pos[6], liquidity)
        let amount0Min = a.amount0 > 0n ? minOut(a.amount0, slippage) : 0n
        let amount1Min = a.amount1 > 0n ? minOut(a.amount1, slippage) : 0n
        const v4 = this.v4PoolConfig(p.pool)
        if (v4) {
          // Spec 007 T3: decrease minimums from the same math as MamoruActionPolicy._decreaseMins, at the narrower
          // band; never below the usual slippage minimum either (take the max, same reasoning as the swap floor).
          const oracle = await this.poolOracle(p.pool, this.cfg.policy.execution.twapWindowSeconds, v4.twapShortSeconds, blockNumber)
          // LeftClaw M-6: MamoruActionPolicyV2 prices a decrease off the TWAP range alone, so a depeg past the anchor
          // does not lock the exit; V1 still clips it to the anchor.
          const exitRange = this.cfg.policy.actionPolicy?.contractVersion === 2 ? { bandTicks: v4.bandTicks } : v4
          const bound = decreaseMinsInRange({ range: this.v4Range(p.pool, exitRange, oracle), tickLower: pos[5], tickUpper: pos[6], liquidity })
          if (bound.amount0Min > amount0Min) amount0Min = bound.amount0Min
          if (bound.amount1Min > amount1Min) amount1Min = bound.amount1Min
        }
        calls.push(this.v3.decreaseLiquidity({ tokenId: p.tokenId, liquidity, amount0Min, amount1Min, deadline }))
      }
      calls.push(this.v3.collect({ account: acct, tokenId: p.tokenId }))
      if (p.kind === 'rerange') calls.push(this.v3.burn(p.tokenId))
      // Without a decrease the batch prices nothing (collect and burn to the account): late, it is harmless.
      return { calls: calls.map(exec), expiresAt: liquidity > 0n ? deadline : null }
    }
    if (p.kind === 'increase_liquidity') return this.prepareIncrease(p, blockNumber, deadline)
    // otto/mamoru#140: a harvest only collects, to the account. A conversion in the same batch swapped a fixed amount
    // checked against the simulated Collect only: if the fees were collected elsewhere before inclusion, it swapped
    // idle principal instead. The volatile fees stay in the account, where a later idle sell-back (priced at the
    // TWAP, on the balance the chain shows then) or an entry uses them.
    if (p.convert) throw new ReasonError('EHG_SIM_DELTA_MISMATCH', `harvest of ${p.tokenId} asks to convert ${p.convert.amount} ${p.convert.token}: harvests only collect`)
    const owedAt = await principalOwedBefore(this.client, [p.tokenId], this.historyFromBlock, { block: blockNumber + 1n, logIndex: 0 }, this.registry)
    const owed = owedAt.get(p.tokenId) ?? [0n, 0n]
    return { calls: [this.v3.collect({ account: acct, tokenId: p.tokenId })].map(exec), owed, expiresAt: null }
  }

  /** The harvest's simulated Collect pays more than the principal owed on at least one side. */
  private harvestCollectsFees(p: Extract<Proposal, { kind: 'harvest' }>, prepared: Prepared, sim: Simulation): boolean {
    const c = positionEvents(sim.logs, this.registry).find((e) => e.kind === 'collect' && e.tokenId === p.tokenId)
    if (!c) return false
    const [owed0, owed1] = prepared.owed ?? [0n, 0n]
    return c.amount0 > owed0 || c.amount1 > owed1
  }

  /**
   * otto/mamoru#215: a bridge-out moves the savings token by exactly -amount and nothing else (no position, no other
   * token), and burns once: one DepositForBurn of TokenMessengerV2, from this account, of the amount, to this account
   * on the chain's domain, any caller, no fee, Standard finality, no hook.
   */
  private bridgeMismatch(p: Extract<Proposal, { kind: 'bridge_out' }>, sim: Simulation): string | null {
    const savings = this.cfg.policy.savingsAsset
    const d = sim.deltas[savings] ?? 0n
    if (d !== -p.amount) return `${savings} moved ${d}, intent ${-p.amount}`
    if (sim.nftDelta !== 0n) return `positions changed by ${sim.nftDelta}`
    for (const [t, v] of Object.entries(sim.deltas)) if (t !== savings && v !== 0n) return `${t} moved ${v} in a bridge`
    const messenger = address('TokenMessengerV2', this.registry)
    const burns = parseEventLogs({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', logs: sim.logs.filter((l) => isAddressEqual(l.address, messenger)) })
    if (burns.length !== 1) return `${burns.length} DepositForBurn events`
    const a = burns[0]!.args
    const ok =
      isAddressEqual(a.burnToken, address(savings, this.registry)) &&
      isAddressEqual(a.depositor, this.cfg.account) &&
      a.amount === p.amount &&
      a.mintRecipient.toLowerCase() === pad(this.cfg.account, { size: 32 }).toLowerCase() &&
      a.destinationDomain === CCTP_DOMAIN_BY_CHAIN[p.chainId] &&
      BigInt(a.destinationCaller) === 0n &&
      a.maxFee === 0n &&
      a.minFinalityThreshold === CCTP_STANDARD_FINALITY &&
      a.hookData === '0x'
    return ok ? null : 'the simulated DepositForBurn is not this account to itself on the bridge-out terms'
  }

  /** FR-RPC-002: the simulated deltas must be the ones the intent expects. Returns why not, or null. */
  private deltaMismatch(p: Proposal, prepared: Prepared, sim: Simulation): string | null {
    const d = (t: string) => sim.deltas[t] ?? 0n
    if (p.kind === 'enter_swap') {
      // A swap under the action policy may be sized down to fill within its price limit (prepareV4Swap): the size sent is the quote's.
      const amountIn = prepared.quote?.amountIn ?? p.amountIn
      if (d(p.tokenIn) !== -amountIn) return `${p.tokenIn} moved ${d(p.tokenIn)}, intent ${-amountIn}`
      if (d(p.tokenOut) < prepared.quote!.amountOutMinimum) return `${p.tokenOut} rose ${d(p.tokenOut)}, below the minimum`
      return null
    }
    if (p.kind === 'enter_mint') {
      const pool = entry(p.pool, this.registry)
      if (sim.nftDelta !== 1n) return `positions changed by ${sim.nftDelta}`
      if (d(pool.token0!) > 0n || -d(pool.token0!) > p.amount0Desired) return `${pool.token0} moved ${d(pool.token0!)}`
      if (d(pool.token1!) > 0n || -d(pool.token1!) > p.amount1Desired) return `${pool.token1} moved ${d(pool.token1!)}`
      return null
    }
    if (p.kind === 'increase_liquidity') {
      // otto/mamoru#171: no new NFT, and nothing but the pool's two tokens leaves, at most the desired amounts.
      const pool = entry(p.pool, this.registry)
      if (sim.nftDelta !== 0n) return `positions changed by ${sim.nftDelta}`
      if (d(pool.token0!) > 0n || -d(pool.token0!) > p.amount0Desired) return `${pool.token0} moved ${d(pool.token0!)}`
      if (d(pool.token1!) > 0n || -d(pool.token1!) > p.amount1Desired) return `${pool.token1} moved ${d(pool.token1!)}`
      if (d(pool.token0!) === 0n && d(pool.token1!) === 0n) return 'the increase took nothing'
      return null
    }
    if (p.kind === 'rerange' || p.kind === 'reduce') {
      const want = p.kind === 'rerange' ? -1n : 0n
      if (sim.nftDelta !== want) return `positions changed by ${sim.nftDelta}, intent ${want}`
      const pool = entry(p.pool, this.registry)
      if (d(pool.token0!) < 0n || d(pool.token1!) < 0n) return `${pool.token0} moved ${d(pool.token0!)}, ${pool.token1} moved ${d(pool.token1!)}: a ${p.kind} only returns tokens to the account`
      return null
    }
    if (p.kind === 'bridge_out') return this.bridgeMismatch(p, sim)
    if (sim.nftDelta !== 0n) return `positions changed by ${sim.nftDelta}`
    // FR-UNI-005, otto/mamoru#140: a harvest only collects to the account; nothing else moves.
    const pool = entry(p.pool, this.registry)
    const collects = positionEvents(sim.logs, this.registry).filter((e) => e.kind === 'collect' && e.tokenId === p.tokenId)
    if (collects.length !== 1) return `${collects.length} Collect events for ${p.tokenId}`
    const c = collects[0]!
    if (d(pool.token0!) !== c.amount0) return `${pool.token0} moved ${d(pool.token0!)}, the Collect paid ${c.amount0}`
    if (d(pool.token1!) !== c.amount1) return `${pool.token1} moved ${d(pool.token1!)}, the Collect paid ${c.amount1}`
    for (const [t, v] of Object.entries(sim.deltas)) if (t !== pool.token0 && t !== pool.token1 && v !== 0n) return `${t} moved ${v} in a harvest`
    return null
  }
}
