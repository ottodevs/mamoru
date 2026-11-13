import type { Address, ChainId, Hex, ReasonCode } from '@mamoru/domain'
import type { Registry, RegistryName } from '@mamoru/registry'

/** Plan §8.1. Every chain read is pinned to `block`. */
export type Observation = {
  chainId: number
  /**
   * The registry the observation was read against. The gates compare every pool identity with it and `decide`
   * never resolves it from a chain id or a constant. Optional only while the registry default exists: an observation
   * without one is a Base observation (`baseRegistry`). It becomes required when the default is retired.
   */
  registry?: Registry
  block: { number: bigint; hash: Hex; timestamp: bigint }
  safeBlock: { number: bigint; hash: Hex }
  account: { address: Address; deployed: boolean; nonceKey: bigint; nonce: bigint }
  sessions: SessionObs[]
  native: bigint
  balances: Record<RegistryName, bigint>
  positions: PositionObs[]
  pools: PoolObs[]
  /** Price source for the gas cost in the savings asset: WETH/USDC 0.3% slot0. */
  ethPrice: { pool: RegistryName; sqrtPriceX96: bigint; token0: RegistryName }
  /** The fee per gas the engine would bid, and the gas budget of one userOp. */
  gas: { maxFeePerGas: bigint; opGasUnits: bigint }
  deposits: DepositObs[]
  intents: { paused: boolean; exitRequested: boolean }
  slot: { opId: string; state: string } | null
  /**
   * otto/mamoru#213: what the account holds for its `remoteBuckets` (its sleeves on other chains and bridges in flight),
   * in raw savings units. It counts in the account total, so the local buckets keep their share of the whole account
   * after a bridge instead of shrinking to it. Absent: nothing remote (every one-chain policy).
   */
  remote?: {
    /** Sleeve value plus `inFlight`, in raw savings units, valued at the TWAP. */
    value: bigint
    /** Burned here and not yet minted there: counted in `value`, and no new bridge leaves while it is above 0. */
    inFlight?: bigint
    /** The sleeve on the other chain exists and runs (deployed, activated): only then may savings be bridged to it. */
    ready?: boolean
    /**
     * otto/mamoru#107 (spec 012 HRV-R4): the sleeve Safe's own USDC its engine has not placed, raw savings units, and
     * since when (unix s) it has been at or above the return threshold (absent: below it). Absent: not read.
     */
    idle?: bigint
    idleSince?: number
    /** otto/mamoru#107: block time (unix s) of the last return home from that chain, for the 24 h no-ping-pong hold. */
    returnedAt?: number
  }
  /**
   * otto/mamoru#278: savings (raw units) the home account asked this remote Safe to send back to it on `chainId`, not
   * burned yet. While it is open the engine only frees and bridges (`releaseOf`). Absent: none, and it hashes as before.
   */
  release?: { amount: bigint; chainId: ChainId }
  /**
   * otto/mamoru#210: the account's shares in each ERC-4626 vault the policy names (`buckets[].vaults`), read at
   * `block`. Absent: the policy has no vault bucket, or nothing was read (the bucket then holds nothing and gets no op).
   * otto/mamoru#352: the operator's engine also reads every other savings-asset vault of its registry: only the ones a
   * bucket names get ops (`bucketVaults`); the others count as placed under the cap (`placedOf`).
   */
  vaults?: VaultObs[]
  /**
   * otto/mamoru#352: vaults whose shares or share price could not be read (a reverting or paused vault). Not in
   * `vaults`. While any is, nothing new is placed (as with another chain unread); while one the policy names is,
   * nothing is reduced either, since the bucket weights are not known. Re-ranges, harvests and owner exits go on. Absent: every vault was read.
   */
  vaultsUnread?: RegistryName[]
  /**
   * otto/mamoru#210: the account opted in to the exit of its `exitOptIn` buckets (v7's USDC/USDT), from the per-account
   * `stables_lp_exit` flag. Absent or false: those buckets are held, nothing of them is reduced.
   */
  exitOptIn?: boolean
  /**
   * otto/mamoru#107 (spec 012 HRV-R1, R2): volatile the engine's own harvests collected and has not sold yet, per token
   * (raw units), never above the Safe's balance, and since when (unix s) it has been above 0. Only this is sold by a
   * harvest sale; entries and idle sales see the balance without it. Absent: none, and the observation hashes as before.
   */
  harvested?: Partial<Record<RegistryName, { amount: bigint; since: number }>>
  /**
   * otto/mamoru#107 (spec 012 HRV-R7): MamoruActionPolicyV4's spending room on this chain (min of `budgetLeft`'s windows,
   * less a margin), raw savings units; 0 when the read failed. `vaultRoom`: what the vault buckets may still take under
   * the policy's vault ratio of C. Absent: not V4 (no read; the chain's own checks apply).
   */
  budget?: { room: bigint; vaultRoom?: bigint }
  /** Block timestamp of the last confirmed re-range, for the policy cooldown. Absent or null: none yet. */
  lastRerangeAt?: bigint | null
  /**
   * otto/mamoru#218: block timestamps of this account's confirmed re-ranges in the last 7 days, with the pool, for the
   * weekly cap (`policy.range.maxPerWeek`). Absent when there are none, so such an observation hashes as before.
   * `merge` (#220): a close that folded a second position of the pool into the other; it keeps the cooldown, not the cap.
   */
  recentReranges?: { pool: string; at: bigint; merge?: true }[]
  /**
   * otto/mamoru#184: the positions every other Mamoru account holds on this chain, as the operator last observed them.
   * Depth sizing counts them with the account's own, so Mamoru as a whole stays under the share limit of a pool.
   * Absent: a single-account run (backtest, lab), nothing else to count. Null: the operator has not yet observed every
   * running account since it started, so the pool-wide share is unknown and depth gives no share room.
   */
  peerPositions?: PeerPositionObs[] | null
  /**
   * otto/mamoru#101 phase 1b (shadow only): off-chain pool statistics by pool name, supplied by the operator for a policy
   * that lists `packaging:tvl`. Read only by `poolStatsShadowRisk`, which writes to Decision.shadowRisk (outside the
   * premise hash); the premise body never sees it, so no value here can move premiseHash or decisionId. Absent: not supplied.
   */
  poolStats?: Record<string, PoolStatsObs>
  /**
   * otto/mamoru#101 phase 1c (shadow only): the exit-direction price impact curve by pool name, supplied by the operator
   * for a policy that lists `packaging:eel`. Read only by `poolDepthShadowRisk`, which writes to Decision.shadowRisk
   * (outside the premise hash); no value here can move premiseHash or decisionId. Absent: not supplied.
   */
  poolDepth?: Record<string, PoolDepthObs>
  /**
   * otto/mamoru#184 (Sol review): pools where another account has an entry decided whose liquidity no observation
   * shows yet. Depth gives no share room in them until that account observes again. Absent: none.
   */
  peerEntering?: RegistryName[]
  /**
   * otto/mamoru#212: the account's cap (raw savings units) and what it has placed on its other chains. The engine places
   * new savings only up to the cap minus everything placed across chains (`withinCap`); the rest stays idle. Absent: no
   * cap (backtest, lab). `elsewhereUsdc` null: another chain could not be read, so nothing new is placed.
   * `reinvestUsdc`: savings the engine's own re-range, reduce or conversion took out of what was placed, which it may
   * put back whatever the cap and the other chains say (finishing a re-range is not new money). Absent: none.
   * `chainCapUsdc`: a second bound on what this chain's Safe alone places (a remote Safe's own cap, its bridge-out total,
   * when `capUsdc` is the account's cap its home answers). Absent: none.
   */
  cap?: { capUsdc: bigint; elsewhereUsdc: bigint | null; reinvestUsdc?: bigint; chainCapUsdc?: bigint }
  /**
   * Spec 004: 24 h history per pool, from TWAP samples (see `marketOf`). Read only by a policy with `guards`;
   * absent or null fields make the guard rules abstain.
   */
  guard?: {
    pools: Partial<Record<RegistryName, PoolGuardObs>>
    /** Lab (#101 CPPI): the highest account value seen, in raw savings units. Absent: the current value. */
    peakValue?: bigint
    /** Lab (#101 round 3 depeg guard): the guard's state as the engine keeps it (`pegStep`). Absent: not tripped. */
    peg?: { tripped: boolean; deviationBps: number | null }
    /** Lab (#101 round 3 staged exits): thirds each volatile bucket holds out (0-3), as the engine keeps them (`stageStep`). */
    stages?: Partial<Record<string, number>>
    /** Lab (otto/mamoru#409 regime shift): buckets whose pool is defensive, as the engine keeps it (`regimeStep`). Absent: none. */
    regime?: Partial<Record<string, boolean>>
  }
  /** Lab (#101): history for `policy.geometry`. Absent: geometry rules abstain (centred range, policy width). */
  geometry?: { pools: Partial<Record<RegistryName, PoolGeometryObs>> }
}

export type PoolGuardObs = {
  twap24hAgoTick: number | null
  realizedVol24hBps: number | null
  /**
   * Lab (#101 lazy re-range): growth of the pool's fee growth globals over about the last 24 h (per unit of active
   * liquidity, X128) and the seconds it covers. Absent or null: the cost test abstains.
   */
  feeGrowth24h?: { growth0X128: bigint; growth1X128: bigint; seconds: number } | null
}

/**
 * Lab (#101, range geometry): market history per pool, read only by a policy with `geometry`. Volatilities are
 * annualized, in bps, from 10-minute TWAP means over the last hour, 24 h and 7 days (or what history exists, at
 * least 24 h). `emaTick`: exponential mean of the TWAP tick, 7-day span. Null: not enough history; the rule abstains.
 */
export type PoolGeometryObs = {
  twap24hAgoTick: number | null
  emaTick: number | null
  vol1hBps: number | null
  vol24hBps: number | null
  vol7dBps: number | null
}

/** What a guard rule measured and held, per bucket, for the app and /ops. `metric` is null when history is missing. */
export type GuardNote = {
  bucket: string
  pool: RegistryName
  code: ReasonCode
  metric: { fallBps: number; volBps: number } | null
  threshold: { fallBps: number; volBps: number }
}

/** otto/mamoru#210: one ERC-4626 vault, as the account holds it. Amounts in raw units of the vault's asset (savings). */
export type VaultObs = {
  /** Registry name (kind `vault`). */
  name: RegistryName
  /** The account's shares, raw share units. */
  shares: bigint
  /** `convertToAssets(shares)`: what the shares are worth now. */
  assets: bigint
  /** `maxWithdraw(account)`: what the vault can pay the account now (less than `assets` when its markets are lent out). */
  maxWithdraw: bigint
  /** `maxDeposit(account)`: what the vault takes now (0 when paused or at its cap). */
  maxDeposit: bigint
  /** `maxRedeem(account)`: the shares the vault redeems now; a redeem never asks for more (review of #153). */
  maxRedeem: bigint
}

export type SessionObs = {
  grant: string
  permissionId: Hex
  tokenId?: bigint
  validUntil: number
  active: boolean
  /** otto/mamoru#149: userOps the grant has left before its usage limit. Absent: not known (no gate on it). */
  usesLeft?: number
  /**
   * otto/mamoru#376 (spec 011 CAP-R5): on the `bridge-out` session, what its grant still lets the engine bridge. `v3`: the
   * signed per-call cap and what is left of the signed total; `none`: a V4 grant (no total, set from the policy family,
   * never from absence); `unknown`: not readable now. Absent on a bridge-out session reads as `unknown` (fail closed).
   */
  bridgeLimit?: BridgeLimit
}

export type BridgeLimit = { kind: 'v3'; perCall: bigint; amountLeft: bigint } | { kind: 'none' } | { kind: 'unknown' }

/** otto/mamoru#184: another Mamoru account's position, only what depth sizing needs. */
export type PeerPositionObs = Pick<PositionObs, 'pool' | 'tickLower' | 'tickUpper' | 'liquidity'>

export type PositionObs = {
  tokenId: bigint
  /** Registry name of the pool, or null when the pool is not in the registry. */
  pool: RegistryName | null
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** What a static `collect` from the account would return. */
  collectable0: bigint
  collectable1: bigint
  /** FR-PRJ-003: principal still owed from decreases, from the journal. */
  principalOwed0: bigint
  principalOwed1: bigint
  /** The tokenId is in the account's allowedTokenIds. */
  managed: boolean
  /**
   * Spec 007, set only when the engine runs a session that can increase (MamoruActionPolicyV2): the policy admitted this
   * tokenId for the account in its pool, read at the observation block. Absent: not read; never treated as admitted.
   */
  admitted?: boolean
  /** Lab (#101 lazy re-range): block time since which the price has been out of the range without coming back. */
  outOfRangeSince?: bigint | null
}

export type PoolObs = {
  name: RegistryName
  address: Address
  token0: RegistryName
  token1: RegistryName
  fee: number
  tickSpacing: number
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  /** Time-weighted tick over the policy window, or null when `observe` cannot answer. */
  twapTick: number | null
  /**
   * Harmonic-mean in-range liquidity over the same window (from `secondsPerLiquidityCumulativeX128`), or null when
   * `observe` cannot answer. Not movable inside one block, unlike `liquidity`: depth sizing reads the smaller of the two.
   */
  twapLiquidity?: bigint | null
  /**
   * otto/mamoru#101 (shadow): pool TVL in raw savings units, token0.balanceOf(pool) + token1.balanceOf(pool), each valued
   * at the pool's TWAP price (spot when the pool has no TWAP). Read only for a policy whose `shadow` lists `packaging:tvl`
   * (absent otherwise, so other observations stay as they were); null when a balance could not be read or the pool does
   * not pair the savings asset.
   */
  tvlSavings?: bigint | null
  /** What the chain says about the pool, for Purga's identity check. */
  identity: { factoryPool: Address; token0: Address; token1: Address; fee: number; tickSpacing: number }
}

export type DepositObs = { token: RegistryName; amount: bigint; block: bigint; txHash: Hex; logIndex: number; safe: boolean }

export type GateVerdict = 'GO' | 'NO_GO' | 'EXIT' | 'SKIP'
export type GateStep = { gate: string; verdict: GateVerdict; reason: ReasonCode }
/** `pool`, `metric` and `threshold` (decimal strings in raw units) are set by the shadow notes that measure something. */
export type ShadowNote = { code: ReasonCode; note: string }
/**
 * otto/mamoru#101 phase 1: a Packaging risk rule that would have fired, shadow only. `metric` and `threshold` in raw savings
 * units, `label` short for logs. Lives outside the premise hash (see Decision.shadowRisk).
 */
export type ShadowRisk = { code: ReasonCode; pool: string; threshold: string; metric?: string; label?: string; window?: '1d' | '7d' | '30d' | '28d' }

/**
 * otto/mamoru#101 phase 1b (shadow): off-chain pool statistics for Packaging's TVL change and activity rules, in USD.
 * null: the source did not give it. `asOf` is the unix second of the fetch. Never hashed (see Observation.poolStats).
 */
export type PoolStatsObs = {
  tvlUsd: number | null
  tvl1dAgoUsd: number | null
  tvl7dAgoUsd: number | null
  tvl30dAgoUsd: number | null
  volume7dUsd: number | null
  volumeLastDayUsd: number | null
  volume28dAvgUsd: number | null
  asOf: number
}

/**
 * otto/mamoru#101 phase 1c (shadow): the impact of selling the pool's non-USDC token for USDC, by USD size. `impactBps[i]`
 * is the price impact at `sizesUsd[i]` against the pool's mid price, after the pool fee (so it excludes `feeBps`); null:
 * QuoterV2 reverted or returned nothing there, or the curve is not fresh (a null stops the ladder: larger sizes are null
 * too). `asOf` is the unix second of the read (0: never read). Never hashed (see Observation.poolDepth).
 */
export type PoolDepthObs = {
  sizesUsd: number[]
  impactBps: (number | null)[]
  feeBps: number
  asOf: number
}

export type EnterSwapProposal = {
  kind: 'enter_swap'
  /** `enter-swap`, or `enter-swap:<pool>` on a multi-pool policy; `convert-any[:<pool>]` sends the volatile side back to savings before a re-mint. */
  grant: 'enter-swap' | `enter-swap:${string}` | 'convert-any' | `convert-any:${string}` | 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenIn: RegistryName
  tokenOut: RegistryName
  fee: number
  amountIn: bigint
  /** otto/mamoru#107: the sale of harvested volatile (spec 012 HRV-R1); the operator takes it off `harvested` when confirmed. */
  harvestSale?: true
}

export type EnterMintProposal = {
  kind: 'enter_mint'
  /** `manage-any[:<pool>]`: re-mints after a re-range are not bounded by enter-mint's one-time cumulative cap. */
  grant: 'enter-mint' | `enter-mint:${string}` | 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
}

/**
 * otto/mamoru#171: an entry added to a position the account already holds in the pool, instead of a second NFT:
 * approvals of MamoruActionPolicyV2 + MamoruActionPolicyV2.increase(tokenId) (spec 007: only a policy whose manage-any
 * carries that action proposes it, and only for a position the policy admitted). `tickLower`/`tickUpper` are the
 * position's own range, which the amounts are split for; the engine checks them against the chain before it builds
 * the call.
 */
export type IncreaseLiquidityProposal = {
  kind: 'increase_liquidity'
  /** The pool's manage-any session (v5): no grant per position. */
  grant: 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenId: bigint
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
}

export type HarvestProposal = {
  kind: 'harvest'
  grant: `manage:${string}` | 'convert-any' | `convert-any:${string}` | 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenId: bigint
  /** Fees only: collectable minus principal owed. */
  fees0: bigint
  fees1: bigint
  /** The fee token that is not the savings asset, and how much of it to convert. */
  convert: { token: RegistryName; amount: bigint } | null
}

/** Whole position back to the Safe: decreaseLiquidity(all) + collect(to the Safe) + burn. */
export type RerangeProposal = {
  kind: 'rerange'
  grant: 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenId: bigint
  liquidity: bigint
  /**
   * otto/mamoru#219: why the range moves, for the owner's history: the price left the range (`out`), sat near an
   * edge (`edge`), or volatility widened it early (`widen`); #220: or the pool held a second position (`merge`). And
   * the range it leaves. Not part of any call.
   */
  why?: 'out' | 'edge' | 'widen' | 'merge'
  tickLower?: number
  tickUpper?: number
}

/** Part of an over-weight bucket's position back to the Safe: decreaseLiquidity(part) + collect(to the Safe). */
export type ReduceProposal = {
  kind: 'reduce'
  grant: 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenId: bigint
  liquidity: bigint
}

/**
 * otto/mamoru#215: savings to the account's own sleeve on another chain, for a remote bucket (CCTP V2 burn here, mint
 * there to the same address). No pool on this chain: the remote bucket's pool is entered there by that chain's engine.
 */
export type BridgeOutProposal = {
  kind: 'bridge_out'
  grant: 'bridge-out'
  bucket: string
  chainId: ChainId
  /**
   * The remote bucket's pool, a registry name on `chainId`: never one of `obs.pools`, never acted on here. For a return
   * home (#278, `releaseOf`) it is the local pool the value leaves.
   */
  pool: RegistryName
  /** Raw savings units. */
  amount: bigint
}

/**
 * otto/mamoru#210: savings supplied to an ERC-4626 vault of a vault bucket: USDC.approve(vault) + vault.deposit(assets,
 * account). `pool` names the vault (a registry entry of kind `vault`, never one of `obs.pools`), so code that reads
 * `proposal.pool` for a label keeps working; nothing may price it as a pool.
 */
export type VaultDepositProposal = {
  kind: 'vault_deposit'
  grant: `vault-supply:${string}`
  bucket: string
  pool: RegistryName
  vault: RegistryName
  /** Raw savings units. */
  assets: bigint
}

/** otto/mamoru#210: shares of a vault bucket redeemed to the account: vault.redeem(shares, account, account). */
export type VaultRedeemProposal = {
  kind: 'vault_redeem'
  grant: `vault-supply:${string}`
  bucket: string
  /** The vault, as in VaultDepositProposal. */
  pool: RegistryName
  vault: RegistryName
  shares: bigint
  /** What the shares are worth at the observation (raw savings units), for the journal and the app. */
  assets: bigint
}

export type Proposal = EnterSwapProposal | EnterMintProposal | IncreaseLiquidityProposal | HarvestProposal | RerangeProposal | ReduceProposal | BridgeOutProposal | VaultDepositProposal | VaultRedeemProposal

export type DecisionKind = 'hold' | Proposal['kind']

/** Plan §8.3. */
export type Decision = {
  decisionId: Hex
  /** Hash of the decision without the observation block, for FR-ENG-015 dedupe. */
  premiseHash: Hex
  observationRef: { block: bigint; hash: Hex }
  policyRef: { policyId: string; version: string; hash: Hex }
  observationCodes: ReasonCode[]
  kind: DecisionKind
  code: 'DECIDE_HOLD' | 'DECIDE_ENTER' | 'DECIDE_HARVEST' | 'DECIDE_RANGE_ADJUST' | 'STRATEGY_PREFERENCE_DEVIATION' | 'DECIDE_BRIDGE_OUT'
  reason: ReasonCode
  trail: GateStep[]
  proposal: Proposal | null
  shadow: ShadowNote[]
  /**
   * otto/mamoru#101 phase 1: Packaging risk rules that would have fired, shadow only. Deliberately outside the hashed body:
   * the premise hash keys the dedupe of a discarded premise and the bundler backoff (engine.ts), and a pool TVL that moves
   * or hovers around a floor must never change it. Nothing in decide or the engine reads it. Present only when non-empty.
   */
  shadowRisk?: ShadowRisk[]
  buckets: { bucket: string; code: ReasonCode }[]
  positions: { tokenId: bigint; codes: ReasonCode[] }[]
  /** Present only when the policy sets `guards` (FR-LC-001: absent, the decision is byte-identical). */
  guards?: GuardNote[]
  /** Lab (#101 experiment 6): bucket preferences after the volatility target or CPPI. Present only with one of them. */
  targets?: { bucket: string; preference: number }[]
  /**
   * Lab (#101 round 3): depeg guard tripped (`value`: deviation in bps) and staged exits in force (`value`: thirds
   * out), per bucket. Present only with `depegGuard` or `stagedExit` and something to report.
   */
  labGuards?: { bucket: string; code: 'RISK_DEPEG_PAIRED' | 'RISK_STAGED_EXIT'; value: number }[]
  /**
   * otto/mamoru#127, #128: savings held back on purpose, per bucket, with why. Outside the premise hash and the id
   * (the amounts move with every price). Absent when nothing waits.
   */
  waiting?: { bucket: string; code: 'DECIDE_WAIT_DEPTH' | 'DECIDE_WAIT_GAS' | 'DECIDE_ENTRY_PAUSED_FALL' | 'DECIDE_WAIT_BRIDGE' | 'DECIDE_WAIT_VAULT_LIQUIDITY' | 'DECIDE_WAIT_BRIDGE_LIMIT' | 'DECIDE_WAIT_BUDGET' | 'DECIDE_WAIT_RENEWAL'; amount: bigint }[]
  /**
   * otto/mamoru#278: a remote bucket's excess over its target and band, due home: the operator asks the remote Safe to
   * send it back. Outside the premise hash and the id, as `waiting`. Absent: nothing due (or the review was paused).
   */
  returnDue?: { bucket: string; chainId: ChainId; amount: bigint }
}
