import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFunctionData, getAddress, pad, parseAbi, parseAbiItem, parseEventLogs, TransactionNotFoundError, TransactionReceiptNotFoundError, toHex, zeroAddress, type Hex, type Log, type PublicClient, type TransactionReceipt } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'
import type { AccountContext, Address, BridgeOutRoute, BridgeOutToSign, BridgeOutView, EthConvert, EthConvertToSign, MigrateV4Input, OwnerSignature } from '@mamoru/domain'
import { address, baseRegistry, entryPointV07Abi, erc20Abi, ethereumRegistry } from '@mamoru/registry'
import { buildMigrateV4, smartSessionV4Abi } from '@mamoru/account/one-auth'
import { oneAuthV4Deployment } from '@mamoru/policy'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { chmodSync, closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { browserOwnerSignature, deployCall, encodeWebAuthnSignature, liveAccountFromContext, ownerSafeTx, readSafeNonce, safeContractSignature, safeTxHashOf, verifyOwnerSignature, type LiveAccount } from '@mamoru/account/live'
import { execTransactionData, type SafeTx } from '@mamoru/account/safe'
import { userOpHash } from '@mamoru/account/sessions'
import { maxGasCostWei, OWNER_NONCE_KEY, ownerUserOp, ownerUserOpSignature, safeOpHash, userOpLogs, type PaymasterFields, type UserOpGas } from '@mamoru/account/userop'
import { attestationValid, burnMatches, cctpAttestation, cctpCalls, cctpMessageKey, FINALITY_FAST, FINALITY_STANDARD, cctpFees, cctpMaxFee, decodeCctpMessage, FAST_FILL_SEC, MESSAGE_TRANSMITTER_V2, messageTransmitterV2Abi, mintIsFor, receiveMessageData, STANDARD_FILL_SEC, type Burn } from './cctp.ts'
import type { BundlerGuard } from './bundler.ts'
import { L1Bundler, MAX_CONSTANT_FEE, PaymasterError, RATE_SLACK_BPS, RpcRefused, type Erc20Paymaster, type GasPrice } from './paymaster.ts'
import { Lock } from './lock.ts'
import { HttpError } from './operator.ts'
import { logErr } from './metrics.ts'

// Bridge-out (otto/mamoru#133, first instance of the routing layer). USDC that reached a Mamoru account's address on
// Ethereum, where the account has never been deployed (otto/mamoru#117), goes to the same account on Base. The owner
// approves one Safe transaction with the passkey: approve + Across SpokePool.depositV3, depositor and recipient the
// account itself, native USDC in and out. The relayer deploys the Safe on Ethereum first if it has no code, and pays
// the L1 gas. Fork-proven in packages/scenarios/l1/bridge-out.ts (ottodevs/mamoru#70).
//
// Self-contained: its own Ethereum client and relayer, its own prepared map and journal. It never reads or writes the
// Base account state, and the operator's engine never sees it. Off unless MAMORU_L1_RPC_URL is set.
//
// otto/mamoru#180: with a bundler and an ERC-20 paymaster configured, the move is one ERC-4337 v0.7 userOp instead:
// initCode deploys the account (same setup as Base), the account pays its gas in USDC through the paymaster, and the
// same batch approves the paymaster for the gas cap, approves the SpokePool and deposits. The passkey signs the
// SafeOp hash. No relayer transaction, no relayer budget; tracking is eth_getUserOperationReceipt and Across's status.
// Without them, the relayer path below is the fallback.
//
// What the owner is told follows the chain, never a guess: a move is 'failed' only when the owner transaction was
// never handed to the provider, or when its receipt says it reverted. Anything else that is not proven is
// 'unconfirmed', and status() resolves it from the chain.

/** The Safe's nonce, read at a pinned block in convert reconciliation (otto/mamoru#285). */
const safeNonceAbi = parseAbi(['function nonce() view returns (uint256)'])

export const ETHEREUM_CHAIN_ID = 1
export const BASE_CHAIN_ID = 8453
export const L1_USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
/** Across SpokePool on Ethereum. A quote naming any other contract is refused. */
export const ACROSS_SPOKE_POOL: Address = '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'
export const ACROSS_API = 'https://app.across.to/api'

// ETH at the account's address on Ethereum (otto/mamoru#211). Move to Base takes USDC only, so the owner first swaps
// all of the ETH to native USDC in the same account: one Safe transaction, SwapRouter02.multicall(deadline,
// [exactInputSingle]) with the ETH as value (the router wraps it), WETH/USDC 0.05%, recipient the account itself.
// The relayer deploys the account if needed and pays the gas, as on the relayer path of the move.
export const L1_WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
export const SWAP_ROUTER_02: Address = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
export const QUOTER_V2: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
/** Chainlink ETH/USD on Ethereum (8 decimals, 1 h heartbeat): the pool's quote must agree with it. */
export const CHAINLINK_ETH_USD: Address = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
export const WETH_USDC_FEE = 500
/** Below this the conversion is not offered: 0.002 ETH. */
export const MIN_CONVERT_WEI = 2_000_000_000_000_000n
/** The swap reverts if it pays less than the quote minus this (0.5%). */
export const CONVERT_SLIPPAGE_BPS = 50n
/** A quote further than this from Chainlink is refused (1%). */
export const MAX_ORACLE_GAP_BPS = 100n
/** A Chainlink answer older than this is refused (heartbeat 1 h, plus margin). */
export const ORACLE_MAX_AGE_SEC = 4_200
/** The swap's deadline after the prepare. */
export const CONVERT_DEADLINE_SEC = 900
/** Conversions one account may start per UTC day; counted apart from moves, so a conversion never uses up the move that follows it. */
export const CONVERTS_PER_ACCOUNT_DAY = 3
/** Gas limit of the owner transaction (the swap used ~130k on Ethereum), with margin. */
export const CONVERT_GAS = 300_000n

// otto/mamoru#309 (b), spec 010 "Ethereum and siblings": the account's own Safe on Ethereum gets ONE V4 session whose
// Init names the account itself as home (home domain 6, Base). The owner signs one Safe transaction on Ethereum, built by
// the same builder the Worker rebuilds with (buildMigrateV4, step 1, chain 1, no old sessions): trust the Rhinestone
// attester and the Safe, self-attest V4 and MamoruGasPolicyV2, enableSessions, assertMigrated. No ENABLE signature. The
// relayer deploys the Safe first when it has no code (the account's own initializer) and pays the gas, charged to the
// day's budget like a conversion. From then on Mamoru wraps, swaps and bridges home under V4 with no signature (#309 c).
/** Ceiling of the sibling's owner transaction (fork: trust + attest + enable ~1.5M on Ethereum); the limit sent is the estimate plus 30 %. */
export const SIBLING_ENABLE_GAS = 2_500_000n
/** Below these the sibling is not offered: nothing for it to do. */
export const SIBLING_MIN_WEI = MIN_CONVERT_WEI
/** A dropped or reverted enable is resent with the same signature at most this many times, then alerted (fail closed). */
export const SIBLING_RESENDS = 3
/** A sibling out of resends is read again at most this often (it is alerted; ops looks). */
export const SIBLING_STUCK_POLL_MS = 10 * 60_000
/** CCTP domain of Base: a sibling's only home. */
export const SIBLING_HOME_DOMAIN = 6

/** Safe 1.4.1: keccak256('ExecutionSuccess(bytes32,uint256)') and keccak256('ExecutionFailure(bytes32,uint256)'). */
const EXECUTION_SUCCESS_TOPIC = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e'
const EXECUTION_FAILURE_TOPIC = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23'

export const swapRouter02Abi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
])
export const quoterV2Abi = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])
export const aggregatorAbi = parseAbi(['function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'])

/** The swap as the owner signs it: all of `amountIn` ETH to USDC at `safe`, at least `minOut`, before `deadline`. */
export function convertCall(safe: Address, amountIn: bigint, minOut: bigint, deadline: number): { to: Address; value: bigint; data: Hex } {
  const swap = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: 'exactInputSingle',
    args: [{ tokenIn: L1_WETH, tokenOut: L1_USDC, fee: WETH_USDC_FEE, recipient: safe, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
  })
  return { to: SWAP_ROUTER_02, value: amountIn, data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [BigInt(deadline), [swap]] }) }
}

/**
 * The least the swap accepts, from the pool's quote, after checking the quote against Chainlink: within
 * MAX_ORACLE_GAP_BPS of the oracle's value for the same ETH, the oracle answer positive and fresh. Throws otherwise.
 */
export function convertMinOut(amountIn: bigint, quoted: bigint, oracle: { answer: bigint; updatedAt: bigint }, nowSec: number): bigint {
  if (oracle.answer <= 0n || BigInt(nowSec) - oracle.updatedAt > BigInt(ORACLE_MAX_AGE_SEC)) throw new HttpError(503, 'CONVERT_PRICE_UNAVAILABLE', 'the ETH price could not be checked right now, try later')
  // wei × USD(8 decimals) → USDC (6 decimals)
  const fair = (amountIn * oracle.answer) / 10n ** 20n
  const gap = quoted > fair ? quoted - fair : fair - quoted
  if (fair === 0n || gap * 10_000n > fair * MAX_ORACLE_GAP_BPS) throw new HttpError(503, 'CONVERT_PRICE_UNAVAILABLE', 'the ETH price could not be checked right now, try later')
  return (quoted * (10_000n - CONVERT_SLIPPAGE_BPS)) / 10_000n
}

/** Every line the owner signs to set up the sibling (#309, #41: the plain words of what the Safe tx does). */
export function siblingStepLines(p: { capUsd: bigint; eth: bigint; usdc: bigint }): string[] {
  const usd = (raw: bigint) => `${(raw / 1_000_000n).toLocaleString('en-US')}`
  const held = [p.eth > 0n ? `${eth(p.eth)} ETH` : '', p.usdc > 0n ? `${usdc(p.usdc)} USDC` : ''].filter(Boolean).join(' and ')
  return [
    `Lets Mamoru move what your Safe on Ethereum holds (${held || 'nothing yet'}) to your own Safe on Base, the same address, with no further signature`,
    'Mamoru may only turn ETH into USDC there (Uniswap, under the same price limits as on Base) and send the USDC to your Safe on Base. It can send it nowhere else',
    `At most ${usd(p.capUsd)} USDC of value a day, and nothing leaves until Mamoru's guardian has checked your Safe on Base`,
    'Mamoru pays the Ethereum gas to set this up; the moves after it are paid from the ETH in this Safe',
  ]
}

/** USDC the receipt shows arriving at `safe` (Transfer events of native USDC). */
export function usdcInto(receipt: { logs: Log[] }, safe: Address): bigint {
  let n = 0n
  for (const ev of parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs.filter((l) => getAddress(l.address) === L1_USDC) })) {
    if (getAddress(ev.args.to) === getAddress(safe)) n += ev.args.value
  }
  return n
}

/** Below this the move is not offered: 1 USDC. */
export const MIN_USDC = 1_000_000n
/** Fees above this share of the amount are refused (0.5%). Across charged 1.3 bps for 150 USDC on 18 Oct. */
export const MAX_FEE_BPS = 50n
/** An exclusive relayer may hold the fill for at most this long (Across quoted ~3.5 min on 18 Oct). */
export const MAX_EXCLUSIVITY_SEC = 600
/** Fill deadlines further out than this are refused: a stuck deposit would wait that long for its refund. */
export const MAX_FILL_DEADLINE_SEC = 24 * 3600
/** The relayer does not send on Ethereum above this gas price (3 gwei; 18 Oct: 0.04). */
export const MAX_GAS_PRICE_WEI = 3_000_000_000n
/** Most the relayer spends on Ethereum per UTC day across all accounts: 0.005 ETH (~150 moves at today's prices). */
export const DAILY_BUDGET_WEI = 5_000_000_000_000_000n
/** Moves one account may start per UTC day. */
export const MOVES_PER_ACCOUNT_DAY = 3
/** Gas the deploy and the owner transaction used on the fork, with margin: the gas limits sent, and the spend bound. */
export const DEPLOY_GAS = 700_000n
export const EXEC_GAS = 300_000n
/** A move left in 'sending' longer than this (the process stopped mid-send) is resolved from the chain. */
export const SENDING_STALE_MS = 10 * 60_000
/** An 'unconfirmed' move not executed after this stops blocking a new one (same Safe nonce: at most one runs). */
export const UNCONFIRMED_GIVEUP_MS = 15 * 60_000
/** A prepared move is signable this long. */
export const PREPARE_TTL_MS = 120_000
export const QUOTE_TIMEOUT_MS = 8_000
/** Across status and chain reconciliation run at most this often per account. */
export const STATUS_CACHE_MS = 10_000
/** How far past the send reconciliation looks for the deposit event (~1 day), and in chunks of how many blocks.
 * Providers cap eth_getLogs ranges (18 Oct: QuickNode answered 1,000 and refused 7,200; Alchemy's free tier allows
 * 10). The owner transaction lands within minutes of the send, so the first chunk normally holds it. */
const LOG_WINDOW_BLOCKS = 7_200n
export const LOG_CHUNK_BLOCKS = 1_000n

// userOp path (#180). Gas limits from an Ethereum fork (apps/mamoru-operator/test/e2e-l1-userop.ts, 18 Oct, block
// 26219317) with margin; a bundler that estimates higher wins. Only callGasLimit and the postOp limit cost anything
// when unused (10% penalty); the verification limit only sizes the cap.
/** Verification with initCode. Fork: SafeProxyFactory deploy + Safe7579 setup 511k, passkey check 29k. */
export const USEROP_VERIFY_GAS_DEPLOY = 700_000n
/** Verification on a deployed account. Fork: 50k (P-256 precompile at 0x100). */
export const USEROP_VERIFY_GAS = 150_000n
/** approve x2 + depositV3 through Safe7579.execute. Fork: execution plus the paymaster's postOp 158k-188k. */
export const USEROP_CALL_GAS = 200_000n
/** Gas limit of the operator's handleOps on Ethereum: the userOp's limits (≈1.11M with deploy) plus EntryPoint overhead. */
export const L1_HANDLE_OPS_GAS = 1_400_000n
/** The operator's Ethereum bundler answers eth_sendUserOperation after the bundle's receipt (~1-3 blocks). */
export const L1_BUNDLER_TIMEOUT_MS = 180_000
/** Floor for preVerificationGas; the bundler's estimate wins when higher. */
export const USEROP_PVG_FLOOR = 80_000n
/** The SafeOp is valid this long after the prepare. */
export const USEROP_VALID_SEC = 600
/** The account pays at most this much for Ethereum gas in one move: 5 USDC. */
export const MAX_GAS_USDC = 5_000_000n
/** ... and at most this share of what it holds there (5%). */
export const MAX_GAS_BPS = 500n
/** How long submit waits for the bundler's receipt before answering 'unconfirmed' (status() goes on asking). */
export const USEROP_WAIT_MS = 60_000
/** Pimlico's paymaster charges 10% of the unused execution gas (callGasLimit + postOp limit) on top. */
const PENALTY_PERCENT = 10n

export const spokePoolAbi = parseAbi([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
])

/** What Across's suggested-fees answers, the fields this module uses. */
export type AcrossQuote = {
  outputAmount: string
  totalRelayFee: { total: string }
  timestamp: string
  fillDeadline: string
  exclusiveRelayer: string
  exclusivityDeadline: number
  spokePoolAddress: string
  estimatedFillTimeSec: number
  isAmountTooLow: boolean
}

/** The deposit as the owner signs it. Every field goes into depositV3 and must come back in the event. */
export type Deposit = {
  amount: bigint
  outputAmount: bigint
  exclusiveRelayer: Address
  quoteTimestamp: number
  fillDeadline: number
  exclusivityDeadline: number
  fillSec: number
}

/** The relayer sends this module needs, so tests can stand in for the operator's Relayer. */
export type L1Sender = {
  readonly address: Address
  send(tx: { to: Address; data?: Hex; gas?: bigint }, onSent?: (hash: Hex) => void, onSending?: (maxFeeWei: bigint, signed: { hash: Hex; nonce: number; maxFeePerGas: bigint }) => void, onSigned?: (hash: Hex, nonce: number) => void): Promise<{ hash: Hex; receipt: TransactionReceipt }>
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** The userOp the owner signs and what it was built against. */
/** The bridge leg the owner signs (#180): Across depositV3 or CCTP V2 depositForBurn, both to the same Safe on Base. */
export type Leg = { bridge: 'across'; deposit: Deposit; output: bigint; fillSec: number } | { bridge: 'cctp'; burn: Burn; output: bigint; fillSec: number }
type PreparedOp = { op: UserOperation<'0.7'>; validUntil: number; balance: bigint; gasCap: bigint; leg: Leg; aa: AccountAbstraction; quote: GasPrice }

/** Base side of CCTP: the operator's Base client and relayer submit receiveMessage once Circle attests. */
export type BaseMinter = { client: PublicClient; relayer: L1Sender }
/** Gas limit of one receiveMessage on Base (a CCTP V2 mint is ~120k). */
export const MINT_GAS = 300_000n
/** The relayer does not mint on Base above this gas price (2 gwei: at most ~0.0006 ETH per mint; Base is usually below 0.01 gwei). */
export const MAX_BASE_GAS_PRICE_WEI = 2_000_000_000n
/** Most the operator spends on Base mints per UTC day, all accounts (0.002 ETH, ~100 mints at 0.1 gwei), and how many. */
export const MINT_BUDGET_WEI = 2_000_000_000_000_000n
export const MINTS_PER_DAY = 100
/** A mint signed but without a receipt after this long is tried again (it may never have been broadcast). */
export const MINT_PENDING_MS = 10 * 60_000
/** A reservation whose transaction can never land is released after it looked so for this long. */
export const RESERVATION_GONE_MS = 30 * 60_000
type Prepared = { prepareId: string; accountKey: string; live: LiveAccount; tx: SafeTx; safeTxHash: Hex; deposit: Deposit; deployed: boolean; expires: number; userOp?: PreparedOp }

/** The bundler and paymaster of the userOp path. */
export type AccountAbstraction = { bundler: L1Bundler; paymaster: Erc20Paymaster }

/** A route as kept on disk: what the owner sees, plus what reconciliation needs. */
type Stored = BridgeOutRoute & { id: string; safe: Address; safeNonce: string; fromBlock: string; execStarted?: boolean; userOpTx?: Hex; cctp?: { maxFee: string; minFinality: number; message?: Hex; nonce?: Hex }; mintAt?: string }
/**
 * What the relayer fronted for one handleOps on Ethereum, keyed by the userOp hash, until its outcome is proven: the
 * bundle's receipt (settled to cost minus the EntryPoint's refund), or its relayer nonce taken by another transaction
 * with no receipt for it (it can never land: released). `tx`/`nonce` are written before the broadcast.
 */
type Reservation = { wei: string; tx?: Hex; nonce?: number; at: string; goneAt?: string }
/** #211: a conversion as kept on disk. */
type StoredConvert = EthConvert & { id: string; safe: Address; safeNonce: string; safeTxHash: Hex; fromBlock: string; execStarted?: boolean }
type PreparedConvert = { prepareId: string; accountKey: string; live: LiveAccount; tx: SafeTx; safeTxHash: Hex; amountIn: bigint; minOut: bigint; deployed: boolean; expires: number }
/** The sibling's enable, as the journal keeps it. 'unconfirmed': sent, not proven either way; tick() resolves it. */
export type StoredSibling = {
  id: string
  safe: Address
  safeNonce: string
  safeTxHash: Hex
  permissionId: Hex
  sessionKey: Address
  capUsdc: string
  fromBlock: string
  state: 'sending' | 'unconfirmed' | 'done' | 'failed'
  deployTx?: Hex
  l1Tx?: Hex
  execStarted?: boolean
  /** When the send began (never rewritten): the clock of a resend (review r1 of #227). */
  sentAt?: string
  /** The signed execTransaction calldata (a signature over this tx only, public once broadcast): resent when dropped. */
  execData?: Hex
  /** Resends of execData after a dropped or reverted send (at most SIBLING_RESENDS). */
  resends?: number
  /** Every V4 permission id this account has signed for its sibling (review r2 of #227): any of them is its own. */
  signedIds?: Hex[]
  /** When a stuck row (out of resends) was last read (review r3 of #227: its own clock, `at` does not move). */
  polledAt?: string
  at: string
}

type PreparedSibling = { prepareId: string; accountKey: string; live: LiveAccount; tx: SafeTx; safeTxHash: Hex; permissionId: Hex; sessionKey: Address; capUsdc: bigint; deployed: boolean; expires: number }

/** What the owner signs for the sibling: the Safe tx, the plain lines, and the builder's input (the Worker rebuilds it). */
export type SiblingToSign = { safe: Address; chainId: number; safeTxHash: Hex; summary: string[]; expiresAt: string; prepareId: string; built: { input: MigrateV4Input; safeTxHash: Hex } }
export type SiblingView = { state: 'none' | StoredSibling['state']; safe?: Address; l1Tx?: Hex; sessionKey?: Address }

type Journal = { siblings?: Record<string, StoredSibling>; converts?: Record<string, StoredConvert>; convertDays?: Record<string, { day: string; n: number }>; reservations?: Record<string, Reservation>; cctpBurns?: Record<string, string[]>; routes: Record<string, Stored>; spent: { day: string; wei: string }; moves: Record<string, { day: string; n: number }>; mintDays?: Record<string, { n: number; wei: string }>; cctpNonces?: Record<string, string[]> }

const NON_TERMINAL = new Set<BridgeOutRoute['state']>(['sending', 'deposited', 'unconfirmed', 'expired'])

/** Checks a quote against what this module will sign. Throws HttpError with a fixed message; never echoes the quote. */
export function checkQuote(q: AcrossQuote, amount: bigint, nowSec: number): Deposit {
  const bad = (why: string) => new HttpError(502, 'BRIDGE_QUOTE_REFUSED', `the bridge quote was refused: ${why}`)
  let spoke: Address
  let relayer: Address
  try {
    spoke = getAddress(q.spokePoolAddress)
    relayer = getAddress(q.exclusiveRelayer)
  } catch {
    throw bad('malformed')
  }
  if (spoke !== ACROSS_SPOKE_POOL) throw bad('unexpected contract')
  if (q.isAmountTooLow) throw new HttpError(409, 'BRIDGE_AMOUNT_TOO_LOW', 'the amount is too small to bridge')
  let out: bigint
  let fee: bigint
  try {
    out = BigInt(q.outputAmount)
    fee = BigInt(q.totalRelayFee.total)
  } catch {
    throw bad('malformed')
  }
  if (out <= 0n || out > amount) throw bad('output amount out of range')
  if (amount - out !== fee) throw bad('fee does not match the output')
  if ((amount - out) * 10_000n > amount * MAX_FEE_BPS) throw bad('fee too high')
  const quoteTimestamp = Number(q.timestamp)
  const fillDeadline = Number(q.fillDeadline)
  const exclusivityDeadline = Number(q.exclusivityDeadline)
  if (![quoteTimestamp, fillDeadline, exclusivityDeadline].every((n) => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 32)) throw bad('malformed')
  if (Math.abs(quoteTimestamp - nowSec) > 600) throw bad('stale')
  if (fillDeadline < nowSec + 1800) throw bad('fill deadline too close')
  if (fillDeadline > nowSec + MAX_FILL_DEADLINE_SEC) throw bad('fill deadline too far')
  // Only the named relayer may fill during exclusivity: a relayer that does nothing would force expiry and a refund.
  // The SpokePool reads a small value as an offset from the deposit's block and a large one as a timestamp.
  if (relayer === zeroAddress) {
    if (exclusivityDeadline !== 0) throw bad('exclusivity without a relayer')
  } else {
    const until = exclusivityDeadline > 1_000_000_000 ? exclusivityDeadline : nowSec + exclusivityDeadline
    if (until > nowSec + MAX_EXCLUSIVITY_SEC || until >= fillDeadline) throw bad('exclusivity too long')
  }
  return { amount, outputAmount: out, exclusiveRelayer: relayer, quoteTimestamp, fillDeadline, exclusivityDeadline, fillSec: Number(q.estimatedFillTimeSec) || 0 }
}

/** approve exactly the amount, then depositV3. depositV3 pulls the whole allowance, so none is left behind. */
export function bridgeCalls(safe: Address, d: Deposit): { to: Address; value: bigint; data: Hex }[] {
  return [
    { to: L1_USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ACROSS_SPOKE_POOL, d.amount] }) },
    {
      to: ACROSS_SPOKE_POOL,
      value: 0n,
      data: encodeFunctionData({
        abi: spokePoolAbi,
        functionName: 'depositV3',
        args: [safe, safe, L1_USDC, BASE_USDC, d.amount, d.outputAmount, BigInt(BASE_CHAIN_ID), d.exclusiveRelayer, d.quoteTimestamp, d.fillDeadline, d.exclusivityDeadline, '0x'],
      }),
    },
  ]
}

/** userOp path: the paymaster may pull at most the gas cap, in USDC, then the bridge calls. */
export function userOpCalls(safe: Address, d: Deposit, paymaster: Address, gasCap: bigint): { to: Address; value: bigint; data: Hex }[] {
  return [{ to: L1_USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [paymaster, gasCap] }) }, ...bridgeCalls(safe, d)]
}

/**
 * The most the paymaster can charge, in USDC base units, rounded up: every gas unit the userOp may use, its postOp
 * gas and the 10% penalty on unused execution gas, at maxFeePerGas and the quoted rate, plus the largest constant fee
 * the account accepts.
 */
export function gasCapUsdc(op: UserOperation<'0.7'>, q: GasPrice, maxConstantFee: bigint): bigint {
  const penalty = ((op.callGasLimit + (op.paymasterPostOpGasLimit ?? 0n)) * PENALTY_PERCENT) / 100n
  const wei = maxGasCostWei(op) + (q.postOpGas + penalty) * op.maxFeePerGas
  return (wei * q.exchangeRate + 10n ** 18n - 1n) / 10n ** 18n + maxConstantFee
}

/**
 * A signature of the right shape for gas estimation: SafeWebAuthnSharedSigner, a 37-byte authenticatorData with
 * user verification, typical clientData fields. It does not verify; Safe7579 turns that into a failed validation,
 * which estimation accepts.
 */
export function stubOwnerSignature(validUntil: number): Hex {
  const auth = `0x${'49'.repeat(32)}05${'00'.repeat(4)}` as Hex
  const sig = encodeWebAuthnSignature({ authenticatorData: auth, clientDataFields: '"origin":"https://app.mamoru.lol","crossOrigin":false', r: 1n, s: 1n })
  return ownerUserOpSignature(0, validUntil, safeContractSignature(address('SafeWebAuthnSharedSigner', baseRegistry), sig))
}

const USER_OPERATION_EVENT = parseAbiItem('event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)')

class MintBudget extends Error {}

/** Approvals kept at once, all accounts. One per account; expired ones go first. */
export const MAX_PREPARED = 256

/** Keeps one prepare per account; refuses when MAX_PREPARED other accounts hold live ones. */
export function admitPrepare<P extends { prepareId: string; accountKey: string; expires: number }>(map: Map<string, P>, p: P, max: number, now: number): boolean {
  for (const [id, q] of map) if (q.accountKey === p.accountKey || q.expires < now) map.delete(id)
  if (map.size >= max) return false
  map.set(p.prepareId, p)
  return true
}

const word = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`

/** The deposit id, when the receipt holds exactly the deposit that was signed. Null otherwise. */
export function depositIdFrom(receipt: { logs: Log[] }, safe: Address, d: Deposit): string | null {
  const evs = parseEventLogs({ abi: spokePoolAbi, eventName: 'FundsDeposited', logs: receipt.logs.filter((l) => getAddress(l.address) === ACROSS_SPOKE_POOL) })
  if (evs.length !== 1) return null
  const a = evs[0]!.args
  const ok =
    a.depositor.toLowerCase() === word(safe) &&
    a.recipient.toLowerCase() === word(safe) &&
    a.inputToken.toLowerCase() === word(L1_USDC) &&
    a.outputToken.toLowerCase() === word(BASE_USDC) &&
    a.inputAmount === d.amount &&
    a.outputAmount === d.outputAmount &&
    a.destinationChainId === BigInt(BASE_CHAIN_ID) &&
    a.exclusiveRelayer.toLowerCase() === word(d.exclusiveRelayer) &&
    a.quoteTimestamp === d.quoteTimestamp &&
    a.fillDeadline === d.fillDeadline &&
    a.exclusivityDeadline === d.exclusivityDeadline &&
    a.message === '0x'
  return ok ? a.depositId.toString() : null
}

const usdc = (raw: bigint) => {
  const s = raw.toString().padStart(7, '0')
  return `${s.slice(0, -6)}.${s.slice(-6).replace(/0+$/, '').padEnd(2, '0')}`
}

const eth = (wei: bigint) => {
  const s = wei.toString().padStart(19, '0')
  const frac = s.slice(-18, -10).replace(/0+$/, '')
  return `${s.slice(0, -18)}${frac ? `.${frac}` : ''}`
}

/** The owner-facing part of a stored conversion (#211). */
function convertView(c: StoredConvert | undefined): EthConvert | null {
  if (!c) return null
  const { id: _id, safe: _safe, safeNonce: _n, safeTxHash: _h, fromBlock: _b, execStarted: _e, ...rest } = c
  return rest
}

/** The owner-facing part of a stored route. */
function view(r: Stored | undefined, enabled: boolean): BridgeOutView {
  if (!r) return { route: null, enabled }
  const { id: _id, safe: _safe, safeNonce: _n, fromBlock: _b, execStarted: _e, userOpTx: _u, cctp: _c, mintAt: _m, ...route } = r
  return { route, enabled }
}

export class BridgeOut {
  private readonly prepared = new Map<string, Prepared>()
  private readonly statusAt = new Map<string, number>()
  private readonly journal: Journal
  /** One move at a time: the budget check, the sends and the journal writes of a move do not interleave with another's. */
  private readonly lock = new Lock()

  constructor(
    private readonly l1: PublicClient,
    private readonly relayer: L1Sender,
    private readonly stateDir: string,
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly acrossKey: string | undefined = process.env.ACROSS_API_KEY,
    /** The /ops flag for the account (engine settings bridgeOut). Off: no prepare, no submit; status still answers. */
    private readonly enabledFor: (accountKey: string) => boolean = () => false,
    /** #180: bundler + ERC-20 paymaster. Set: every move is a userOp paid in USDC. Null: the relayer path. */
    private readonly aa: AccountAbstraction | null = null,
    /** #180: Base client + relayer for the CCTP mint. Null: CCTP is not offered. */
    private readonly base: BaseMinter | null = null,
  ) {
    this.journal = this.load()
    if (this.droppedReservations > 0) this.save()
  }

  private get file(): string {
    return join(this.stateDir, 'bridge-out.json')
  }

  private droppedReservations = 0

  private load(): Journal {
    const empty: Journal = { routes: {}, spent: { day: '', wei: '0' }, moves: {} }
    if (!existsSync(this.file)) return empty
    // An unreadable journal stops the operator from starting: starting empty would forget moves under way and the
    // day's spend.
    const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Journal>
    // A reservation without a signed transaction was never broadcast (the hash is written before it): nothing to hold.
    const reservations = Object.fromEntries(Object.entries(j.reservations ?? {}).filter(([, r]) => !!r.tx))
    this.droppedReservations = Object.keys(j.reservations ?? {}).length - Object.keys(reservations).length
    const converts = Object.fromEntries(Object.entries(j.converts ?? {}).filter(([, c]) => !!c.safeTxHash && !!c.fromBlock))
    const dropped = Object.keys(j.converts ?? {}).length - Object.keys(converts).length
    // None should ever be dropped (every conversion is written with both): say so if one is.
    if (dropped > 0) logErr('[bridge-out] conversions without safeTxHash/fromBlock dropped from the journal:', dropped)
    return { siblings: j.siblings ?? {}, routes: j.routes ?? {}, converts, convertDays: j.convertDays ?? {}, spent: j.spent ?? empty.spent, moves: j.moves ?? {}, mintDays: j.mintDays ?? {}, cctpNonces: j.cctpNonces ?? {}, cctpBurns: j.cctpBurns ?? {}, reservations }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.journal, null, 1))
    renameSync(tmp, this.file)
  }

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10)
  }

  /** Writes a route only if it is still the account's current one: a late answer about an older move changes nothing. */
  private write(accountKey: string, route: Stored): void {
    const cur = this.journal.routes[accountKey]
    if (cur && cur.id !== route.id) return
    route.at = new Date(this.now()).toISOString()
    this.journal.routes[accountKey] = route
    this.save()
  }

  /** What the relayer may still lose: today's settled spend plus every open reservation, whatever day it was made. */
  private committed(): bigint {
    return this.spentToday() + Object.values(this.journal.reservations ?? {}).reduce((a, r) => a + BigInt(r.wei), 0n)
  }

  /** The day's spend so far, reset at UTC midnight. */
  private spentToday(): bigint {
    if (this.journal.spent.day !== this.day()) this.journal.spent = { day: this.day(), wei: '0' }
    return BigInt(this.journal.spent.wei)
  }

  /** Adds to (or takes back from) today's spend; it never goes below zero. */
  private spend(wei: bigint): void {
    this.spendOn(this.day(), wei)
  }

  /** The same on the ledger of `day`, read once by the caller: a ledger of another day restarts at zero. */
  private spendOn(day: string, wei: bigint): void {
    const cur = this.journal.spent.day === day ? BigInt(this.journal.spent.wei) : 0n
    const next = cur + wei
    this.journal.spent = { day, wei: (next > 0n ? next : 0n).toString() }
    this.save()
  }

  /** The Ethereum side of the account: the Base context, chain id 1. Same address, or refused. */
  private live(ctx: AccountContext): LiveAccount {
    try {
      return { ...liveAccountFromContext(ctx), chainId: ETHEREUM_CHAIN_ID }
    } catch {
      throw new HttpError(409, 'ACCOUNT_MISMATCH', 'the account context does not match its address')
    }
  }

  private async usdcAt(safe: Address): Promise<bigint> {
    return this.l1.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [safe] })
  }

  private async quote(amount: bigint): Promise<AcrossQuote> {
    const url = `${ACROSS_API}/suggested-fees?inputToken=${L1_USDC}&outputToken=${BASE_USDC}&originChainId=${ETHEREUM_CHAIN_ID}&destinationChainId=${BASE_CHAIN_ID}&amount=${amount}`
    let res: Response
    try {
      res = await this.fetcher(url, { headers: this.acrossKey ? { authorization: `Bearer ${this.acrossKey}` } : {}, signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) })
    } catch {
      throw new HttpError(502, 'BRIDGE_QUOTE_UNAVAILABLE', 'the bridge did not answer, try again')
    }
    if (!res.ok) throw new HttpError(502, 'BRIDGE_QUOTE_UNAVAILABLE', 'the bridge did not answer, try again')
    return (await res.json()) as AcrossQuote
  }

  /** Refuses a send whose most expensive outcome would cross today's budget, the gas ceiling or the relayer's balance. */
  private async affordable(gas: bigint): Promise<bigint> {
    const price = await this.l1.getGasPrice()
    if (price > MAX_GAS_PRICE_WEI) throw new HttpError(503, 'BRIDGE_GAS_HIGH', 'Ethereum gas is too high right now, try later')
    const bound = gas * price * 2n
    if (this.committed() + bound > DAILY_BUDGET_WEI) throw new HttpError(503, 'BRIDGE_BUDGET', 'moves from Ethereum are paused for today, try tomorrow')
    if ((await this.l1.getBalance({ address: this.relayer.address })) < bound) throw new HttpError(503, 'BRIDGE_RELAYER_EMPTY', 'moves from Ethereum are paused, try later')
    return bound
  }

  /**
   * One relayer send, charged to the day. The bound is written to disk before the send, so a restart while waiting for
   * the receipt keeps it charged; a receipt then replaces it with what the transaction really cost.
   */
  private async charged(tx: { to: Address; data: Hex; gas: bigint }, onSent: (hash: Hex) => void, onSigned?: (hash: Hex) => void): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    const bound = await this.affordable(tx.gas)
    this.spend(bound)
    const r = await this.relayer.send(tx, onSent, undefined, onSigned ? (h) => onSigned(h) : undefined)
    const cost = r.receipt.gasUsed * r.receipt.effectiveGasPrice
    if (cost < bound) this.spend(cost - bound)
    return r
  }

  /**
   * Whether the account's current route stops a new move. An 'unconfirmed' route stops blocking only when the chain
   * proves its transaction did not run: after UNCONFIRMED_GIVEUP_MS, the nonce it signed (EntryPoint nonce for a
   * userOp, Safe nonce for the relayer path) is still unspent. A new move signs that same nonce, so at most one of
   * the two can ever run. Time alone never unblocks; a spent nonce keeps it blocked until status() resolves it.
   */
  private async blocking(r: Stored | undefined): Promise<boolean> {
    if (!r || !NON_TERMINAL.has(r.state)) return false
    if (r.state !== 'unconfirmed' || this.now() - Date.parse(r.at) < UNCONFIRMED_GIVEUP_MS) return true
    try {
      const nonce = r.userOpHash
        ? await this.l1.readContract({ address: address('EntryPointV07', baseRegistry), abi: entryPointV07Abi, functionName: 'getNonce', args: [r.safe, OWNER_NONCE_KEY] })
        : (await readSafeNonce(this.l1, r.safe)).nonce
      return nonce !== BigInt(r.safeNonce)
    } catch {
      return true
    }
  }

  private on(accountKey: string): void {
    if (!this.enabledFor(accountKey)) throw new HttpError(404, 'BRIDGE_OFF', 'moves from Ethereum are not available')
  }

  async prepare(ctx: AccountContext): Promise<BridgeOutToSign> {
    this.on(ctx.accountKey)
    const live = this.live(ctx)
    if (await this.blocking(this.journal.routes[ctx.accountKey])) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    if (this.convertBlocking(ctx.accountKey) || this.siblingInFlight(ctx.accountKey)) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    const moves = this.journal.moves[ctx.accountKey]
    if (moves && moves.day === this.day() && moves.n >= MOVES_PER_ACCOUNT_DAY) throw new HttpError(429, 'BRIDGE_ACCOUNT_LIMIT', 'too many moves from Ethereum today, try tomorrow')
    const amount = await this.usdcAt(live.safe)
    if (amount < MIN_USDC) throw new HttpError(409, 'BRIDGE_NOTHING', 'there is no USDC on Ethereum to move')
    if (this.aa) return this.prepareUserOp(ctx, live, amount, this.aa)
    const deposit = checkQuote(await this.quote(amount), amount, Math.floor(this.now() / 1000))
    const { deployed, nonce } = await readSafeNonce(this.l1, live.safe)
    const tx = ownerSafeTx(bridgeCalls(live.safe, deposit), nonce)
    const safeTxHash = safeTxHashOf(live, tx)
    const prepareId = toHex(randomBytes(16)).slice(2)
    const expires = this.now() + PREPARE_TTL_MS
    this.remember({ prepareId, accountKey: ctx.accountKey, live, tx, safeTxHash, deposit, deployed, expires })
    const fee = deposit.amount - deposit.outputAmount
    return {
      safe: live.safe,
      chainId: ETHEREUM_CHAIN_ID,
      safeTxHash,
      summary: [
        `Move ${usdc(deposit.amount)} USDC from Ethereum to this same account on Base`,
        `You receive ${usdc(deposit.outputAmount)} USDC on Base, in about ${Math.max(deposit.fillSec, 1)} s`,
        `Bridge: Across, fee ${usdc(fee)} USDC. Mamoru pays the Ethereum gas`,
      ],
      expiresAt: new Date(expires).toISOString(),
      prepareId,
      route: { outputUsdc: deposit.outputAmount.toString(), feeUsdc: fee.toString(), fillSec: deposit.fillSec },
    }
  }

  /** Remembers a prepare, single use, one per account, at most MAX_PREPARED across accounts. */
  private remember(p: Prepared): void {
    if (!admitPrepare(this.prepared, p, MAX_PREPARED, this.now())) throw new HttpError(503, 'BRIDGE_BUSY', 'too many moves are waiting for approval, try again in a minute')
  }

  /**
   * #180: the move as one userOp. The gas cap comes first (it is paid out of the same USDC), then the Across quote
   * for what is left, then the paymaster's final data over the finished userOp, checked before the owner sees it.
   */
  private async prepareUserOp(ctx: AccountContext, live: LiveAccount, balance: bigint, aa: AccountAbstraction): Promise<BridgeOutToSign> {
    const gasDown = () => new HttpError(503, 'BRIDGE_GAS_UNAVAILABLE', 'paying the Ethereum gas in USDC is not available right now, try later')
    let q: GasPrice
    try {
      q = await aa.paymaster.quote()
    } catch (e) {
      logErr(`[bridge-out] paymaster ${aa.paymaster.name} quote:`, e instanceof Error ? e.message : 'failed')
      throw gasDown()
    }
    const [fees, code, nonce] = await Promise.all([
      aa.bundler.gasPrice().then((g) => g ?? this.l1.estimateFeesPerGas()),
      this.l1.getCode({ address: live.safe }),
      this.l1.readContract({ address: address('EntryPointV07', baseRegistry), abi: entryPointV07Abi, functionName: 'getNonce', args: [live.safe, OWNER_NONCE_KEY] }),
    ])
    if (fees.maxFeePerGas > MAX_GAS_PRICE_WEI) throw new HttpError(503, 'BRIDGE_GAS_HIGH', 'Ethereum gas is too high right now, try later')
    const deployed = !!code && code !== '0x'
    const validUntil = Math.floor(this.now() / 1000) + USEROP_VALID_SEC
    const base: UserOpGas = {
      verificationGasLimit: deployed ? USEROP_VERIFY_GAS : USEROP_VERIFY_GAS_DEPLOY,
      callGasLimit: USEROP_CALL_GAS,
      preVerificationGas: USEROP_PVG_FLOOR,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    }
    // A draft of the same shape (amounts are placeholders) for the paymaster stub and the bundler's estimate.
    const placeholder: Deposit = { amount: balance, outputAmount: balance, exclusiveRelayer: zeroAddress, quoteTimestamp: 0, fillDeadline: 0, exclusivityDeadline: 0, fillSec: 0 }
    const build = (d: Deposit, cap: bigint, gas: UserOpGas, pm?: PaymasterFields) => ownerUserOp({ live, deployed, nonce, calls: userOpCalls(live.safe, d, q.paymaster, cap), gas, paymaster: pm })
    let gas = base
    let stub: PaymasterFields
    try {
      stub = await aa.paymaster.stub(build(placeholder, balance, base))
      const est = await aa.bundler.estimate({ ...build(placeholder, balance, base, stub), signature: stubOwnerSignature(validUntil) })
      if (est) {
        const up = (v: bigint) => (v * 12n) / 10n
        gas = {
          ...base,
          verificationGasLimit: up(est.verificationGasLimit) > base.verificationGasLimit ? up(est.verificationGasLimit) : base.verificationGasLimit,
          callGasLimit: up(est.callGasLimit) > base.callGasLimit ? up(est.callGasLimit) : base.callGasLimit,
          preVerificationGas: est.preVerificationGas > base.preVerificationGas ? est.preVerificationGas : base.preVerificationGas,
        }
        stub = {
          ...stub,
          paymasterVerificationGasLimit: est.paymasterVerificationGasLimit ?? stub.paymasterVerificationGasLimit,
          paymasterPostOpGasLimit: est.paymasterPostOpGasLimit ?? stub.paymasterPostOpGasLimit,
        }
      }
    } catch (e) {
      logErr(`[bridge-out] paymaster/bundler estimate:`, e instanceof Error ? e.message : 'failed')
      throw gasDown()
    }
    // Priced at the dearest rate check() accepts, so the allowance covers whatever accepted data charges.
    const dearest: GasPrice = { ...q, exchangeRate: (q.exchangeRate * (10_000n + RATE_SLACK_BPS) + 9_999n) / 10_000n }
    const gasCap = gasCapUsdc(build(placeholder, balance, gas, stub), dearest, MAX_CONSTANT_FEE)
    if (gasCap > MAX_GAS_USDC || gasCap * 10_000n > balance * MAX_GAS_BPS) throw new HttpError(409, 'BRIDGE_GAS_TOO_HIGH', 'Ethereum gas would take too much of this amount, try later or with more')
    const amount = balance - gasCap
    if (amount < MIN_USDC) throw new HttpError(409, 'BRIDGE_NOTHING', 'there is no USDC on Ethereum to move')
    const leg = await this.pickLeg(amount, Math.floor(this.now() / 1000), ctx.accountKey)
    const legCalls = leg.bridge === 'across' ? bridgeCalls(live.safe, leg.deposit) : cctpCalls(L1_USDC, live.safe, leg.burn)
    const approvePm = { to: L1_USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [q.paymaster, gasCap] }) }
    let op = ownerUserOp({ live, deployed, nonce, calls: [approvePm, ...legCalls], gas, paymaster: stub })
    try {
      const pm = await aa.paymaster.data(op)
      aa.paymaster.check(pm, q)
      // The cap assumed the stub's paymaster gas: larger limits now would make it too small.
      if (pm.paymasterVerificationGasLimit > stub.paymasterVerificationGasLimit || pm.paymasterPostOpGasLimit > stub.paymasterPostOpGasLimit) throw new PaymasterError('paymaster gas above the stub')
      op = { ...op, ...pm }
    } catch (e) {
      logErr(`[bridge-out] paymaster ${aa.paymaster.name} data:`, e instanceof Error ? e.message : 'failed')
      throw gasDown()
    }
    const challenge = safeOpHash(op, ETHEREUM_CHAIN_ID, 0, validUntil)
    const prepareId = toHex(randomBytes(16)).slice(2)
    const expires = this.now() + PREPARE_TTL_MS
    // tx/safeTxHash keep their meaning for the relayer path; here the passkey signs the SafeOp hash. `deposit` carries
    // amount and output for the stored route whatever the bridge.
    const tx = ownerSafeTx(legCalls, 0n)
    const deposit: Deposit = leg.bridge === 'across' ? leg.deposit : { amount, outputAmount: leg.output, exclusiveRelayer: zeroAddress, quoteTimestamp: 0, fillDeadline: 0, exclusivityDeadline: 0, fillSec: leg.fillSec }
    this.remember({ prepareId, accountKey: ctx.accountKey, live, tx, safeTxHash: challenge, deposit, deployed, expires, userOp: { op, validUntil, balance, gasCap, leg, aa, quote: q } })
    const fee = amount - leg.output
    const when = leg.fillSec >= 600 ? `in about ${Math.round(leg.fillSec / 60)} minutes` : `in about ${Math.max(leg.fillSec, 1)} s`
    const bridgeLine =
      leg.bridge === 'cctp'
        ? `Bridge: Circle CCTP (native USDC), fee at most ${usdc(fee)} USDC; Mamoru pays the Base gas to receive it`
        : `Bridge: Across, fee ${usdc(fee)} USDC`
    return {
      safe: live.safe,
      chainId: ETHEREUM_CHAIN_ID,
      safeTxHash: challenge,
      summary: [
        `Move ${usdc(amount)} USDC from Ethereum to this same account on Base`,
        `You receive ${leg.bridge === 'cctp' ? 'at least ' : ''}${usdc(leg.output)} USDC on Base, ${when}`,
        `${bridgeLine}. Ethereum gas: at most ${usdc(gasCap)} USDC from this amount; what is not used stays at your address on Ethereum`,
      ],
      expiresAt: new Date(expires).toISOString(),
      prepareId,
      route: { outputUsdc: leg.output.toString(), feeUsdc: fee.toString(), fillSec: leg.fillSec, gasUsdc: gasCap.toString(), bridge: leg.bridge },
    }
  }

  /**
   * Quotes Across and CCTP V2 (Standard and Fast) for the amount and picks the largest output to the Safe on Base;
   * equal outputs go to CCTP (native USDC, no refund path), then to the faster. CCTP only with a Base minter.
   */
  private async pickLeg(amount: bigint, nowSec: number, accountKey: string): Promise<Leg> {
    const [across, cctp] = await Promise.allSettled([
      this.quote(amount).then((q) => checkQuote(q, amount, nowSec)),
      this.base ? cctpFees(this.fetcher) : Promise.reject(new Error('no Base minter')),
    ])
    const legs: Leg[] = []
    if (across.status === 'fulfilled') legs.push({ bridge: 'across', deposit: across.value, output: across.value.outputAmount, fillSec: across.value.fillSec })
    if (cctp.status === 'fulfilled') {
      for (const f of cctp.value) {
        if (f.finalityThreshold !== FINALITY_STANDARD && f.finalityThreshold !== FINALITY_FAST) continue
        // A tag of 1-999 base units (< 0.001 USDC) that no earlier burn of this account used with this amount makes
        // the burn's message unlike any earlier one of the account, so an attestation of an earlier burn can never
        // match it. maxFee is a ceiling: a Standard transfer executes with fee 0 and mints the whole amount.
        const used = new Set(this.journal.cctpBurns?.[accountKey] ?? [])
        const base = cctpMaxFee(amount, f.minimumFeeBps)
        let maxFee = -1n
        for (let i = 0, start = randomBytes(2).readUInt16BE(0) % 999; i < 999; i++) {
          const candidate = base + 1n + BigInt((start + i) % 999)
          if (!used.has(`${amount}:${candidate}`)) {
            maxFee = candidate
            break
          }
        }
        if (maxFee < 0n) continue
        if (maxFee * 10_000n > amount * MAX_FEE_BPS) continue
        legs.push({ bridge: 'cctp', burn: { amount, maxFee, minFinality: f.finalityThreshold }, output: amount - maxFee, fillSec: f.finalityThreshold === FINALITY_FAST ? FAST_FILL_SEC : STANDARD_FILL_SEC })
      }
    }
    if (legs.length === 0) {
      // Across's own refusal (amount too low, quote refused) says more than "unavailable".
      if (across.status === 'rejected' && across.reason instanceof HttpError) throw across.reason
      throw new HttpError(502, 'BRIDGE_QUOTE_UNAVAILABLE', 'the bridge did not answer, try again')
    }
    legs.sort((a, b) => (a.output !== b.output ? (b.output > a.output ? 1 : -1) : a.bridge !== b.bridge ? (a.bridge === 'cctp' ? -1 : 1) : a.fillSec - b.fillSec))
    return legs[0]!
  }

  async submit(ctx: AccountContext, body: OwnerSignature): Promise<BridgeOutView> {
    // One move is sent at a time (the guard of the operator's bundler is per move). Another account's submit does
    // not queue behind it: it is told to retry, its approval still valid.
    if (this.inFlight || this.bundling.size > 0) throw new HttpError(503, 'BRIDGE_BUSY', 'another move from Ethereum is being sent, try again in a minute')
    const p = body && typeof body.prepareId === 'string' ? this.prepared.get(body.prepareId) : undefined
    if (!p || p.accountKey !== ctx.accountKey) throw new HttpError(404, 'PREPARE_NOT_FOUND', 'that approval is not known, tap again')
    // Single use, whatever happens next.
    this.prepared.delete(p.prepareId)
    if (p.expires < this.now()) throw new HttpError(410, 'PREPARE_EXPIRED', 'that approval expired, tap again')
    let signature: Hex
    try {
      signature = browserOwnerSignature(body, p.safeTxHash)
    } catch {
      throw new HttpError(400, 'BAD_SIGNATURE', 'the passkey signature could not be read')
    }
    if (!(await verifyOwnerSignature(signature, p.safeTxHash, p.live.webauthn))) throw new HttpError(400, 'BAD_SIGNATURE', 'the passkey signature does not match this account')
    // Turned off on /ops between the prepare and the signature: nothing is sent.
    this.on(ctx.accountKey)
    // The path, bundler and paymaster that run are the ones the owner's approval was prepared for: a relayer-path
    // approval never becomes a userOp, nor the reverse, and the userOp sent is the one whose SafeOp hash was signed.
    if (!!p.userOp !== !!this.aa) throw new HttpError(409, 'PREPARE_MISMATCH', 'that approval was prepared for another way of sending, tap again')
    if (p.userOp) {
      const u = p.userOp
      if (u.aa !== this.aa || getAddress(u.op.paymaster ?? zeroAddress) !== getAddress(u.quote.paymaster) || safeOpHash(u.op, ETHEREUM_CHAIN_ID, 0, u.validUntil) !== p.safeTxHash)
        throw new HttpError(409, 'PREPARE_MISMATCH', 'that approval does not match what would be sent, tap again')
      return this.exclusive(() => this.sendUserOp(ctx, p, u, signature, u.aa))
    }
    return this.exclusive(() => this.send(ctx, p, signature))
  }

  private inFlight = false

  /** The lock, never queued: a move already being sent answers BRIDGE_BUSY. Bounded by the bundler/relayer timeouts. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    // The bundler may still hold a userOp whose client call timed out: that counts as being sent.
    if (this.inFlight || this.bundling.size > 0) return Promise.reject(new HttpError(503, 'BRIDGE_BUSY', 'another move from Ethereum is being sent, try again in a minute'))
    this.inFlight = true
    return this.lock.run(fn).finally(() => {
      this.inFlight = false
    })
  }

  /** #180: hands the signed userOp to the bundler, then follows it by its hash. Nothing is spent by Mamoru. */
  private async sendUserOp(ctx: AccountContext, p: Prepared, u: PreparedOp, signature: Hex, aa: AccountAbstraction): Promise<BridgeOutView> {
    if (await this.blocking(this.journal.routes[ctx.accountKey])) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    if (this.convertBlocking(ctx.accountKey) || this.siblingInFlight(ctx.accountKey)) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    // Nothing changed on Ethereum since the prepare: same balance, same deploy state, same EntryPoint nonce.
    const [balance, code, nonce, head] = await Promise.all([
      this.usdcAt(p.live.safe),
      this.l1.getCode({ address: p.live.safe }),
      this.l1.readContract({ address: address('EntryPointV07', baseRegistry), abi: entryPointV07Abi, functionName: 'getNonce', args: [p.live.safe, OWNER_NONCE_KEY] }),
      this.l1.getBlockNumber({ cacheTime: 0 }),
    ])
    if (balance !== u.balance || (!!code && code !== '0x') !== p.deployed || nonce !== u.op.nonce) throw new HttpError(409, 'BRIDGE_STALE', 'the balance on Ethereum changed, tap again')
    const moves = this.journal.moves[ctx.accountKey]
    if (moves && moves.day === this.day() && moves.n >= MOVES_PER_ACCOUNT_DAY) throw new HttpError(429, 'BRIDGE_ACCOUNT_LIMIT', 'too many moves from Ethereum today, try tomorrow')
    const op: UserOperation<'0.7'> = { ...u.op, signature: ownerUserOpSignature(0, u.validUntil, signature) }
    const hash = userOpHash(op, ETHEREUM_CHAIN_ID)
    const day = this.day()
    this.journal.moves[ctx.accountKey] = { day, n: moves && moves.day === day ? moves.n + 1 : 1 }
    const route: Stored = {
      id: p.prepareId,
      safe: p.live.safe,
      safeNonce: u.op.nonce.toString(),
      fromBlock: head.toString(),
      state: 'sending',
      amountUsdc: p.deposit.amount.toString(),
      outputUsdc: p.deposit.outputAmount.toString(),
      userOpHash: hash,
      bridge: u.leg.bridge,
      ...(u.leg.bridge === 'cctp' ? { cctp: { maxFee: u.leg.burn.maxFee.toString(), minFinality: u.leg.burn.minFinality } } : {}),
      at: '',
    }
    // Every burn's (amount, maxFee) is kept for the account, before it can run: no later burn reuses it.
    if (u.leg.bridge === 'cctp') {
      const all = this.journal.cctpBurns ?? {}
      // Kept for good (3 moves a day at most: a few kB a year per account), so a tag is never reused.
      all[ctx.accountKey] = [...(all[ctx.accountKey] ?? []), `${u.leg.burn.amount}:${u.leg.burn.maxFee}`]
      this.journal.cctpBurns = all
    }
    // The hash is on disk before the bundler sees the userOp: whatever happens next, status() can ask for it.
    this.journal.routes[ctx.accountKey] = route
    this.write(ctx.accountKey, route)
    this.sending = { accountKey: ctx.accountKey, route }
    try {
      const sent = await aa.bundler.send(op)
      if (sent.toLowerCase() !== hash.toLowerCase()) logErr(`[bridge-out] ${ctx.accountKey.slice(0, 8)}: bundler answered another userOp hash`, sent)
      route.state = 'unconfirmed'
      const until = this.now() + USEROP_WAIT_MS
      for (;;) {
        await this.resolveUserOp(route, u.leg)
        if (route.state !== 'unconfirmed' || this.now() >= until) break
        await Bun.sleep(3_000)
      }
    } catch (e) {
      // 'failed' only when the bundler refused it in validation (ERC-7769 codes -32500..-32507, not a duplicate or a
      // nonce conflict), it has no receipt and the account's EntryPoint nonce is still the one signed. Any other error may come after admission: 'unconfirmed', status() asks by hash.
      const refused = e instanceof RpcRefused && e.method === 'eth_sendUserOperation' && e.code <= -32500 && e.code >= -32507 && !/already|known|duplicate|exists|AA25|nonce/i.test(e.detail)
      if (refused) {
        logErr(`[bridge-out] ${ctx.accountKey.slice(0, 8)}: bundler refused the userOp`, (e as RpcRefused).detail)
        route.state = 'unconfirmed'
        try {
          await this.resolveUserOp(route, u.leg)
        } catch {
          // no answer: stays unconfirmed
        }
        // Failed only when nothing with this nonce ran: no receipt for the hash and the EntryPoint nonce not consumed.
        if (route.state === 'unconfirmed' && !route.l1Tx) {
          const [receipt, nonceNow] = await Promise.all([
            aa.bundler.receipt(hash).catch(() => undefined),
            this.l1.readContract({ address: address('EntryPointV07', baseRegistry), abi: entryPointV07Abi, functionName: 'getNonce', args: [p.live.safe, OWNER_NONCE_KEY] }).catch(() => undefined),
          ])
          if (receipt === null && nonceNow === u.op.nonce) route.state = 'failed'
        }
      } else {
        logErr(`[bridge-out] ${ctx.accountKey.slice(0, 8)}:`, e instanceof Error ? e.message : e)
        route.state = 'unconfirmed'
      }
    }
    this.sending = null
    this.write(ctx.accountKey, route)
    if (route.state === 'failed') throw new HttpError(502, 'BRIDGE_FAILED', 'the move from Ethereum did not go through; the USDC is still at your address on Ethereum')
    return view(route, true)
  }

  /** The move whose userOp the operator's Ethereum bundler is handling (one at a time, under the lock). */
  private sending: { accountKey: string; route: Stored } | null = null

  /**
   * #180: the guard of the operator's own Ethereum bundler. The relayer fronts handleOps gas only for the move under
   * way, within the gas ceiling, the day's budget and its balance (the #72 checks); the EntryPoint pays the
   * beneficiary (the relayer) the userOp's gas from the paymaster's deposit, and only what was not refunded stays
   * charged to the day. The bundle's hash is kept on the route: after a restart the receipt is read from the chain.
   */
  /** userOps the operator's bundler is working on in this process (between before() and after()/failed()). */
  private readonly bundling = new Set<string>()

  private reserve(key: string, wei: bigint, extra: Partial<Reservation> = {}): void {
    const all = this.journal.reservations ?? {}
    const cur = all[key]
    all[key] = { at: cur?.at ?? new Date(this.now()).toISOString(), ...cur, ...extra, wei: wei.toString() }
    this.journal.reservations = all
    this.save()
  }

  /** The bundle's outcome is proven: the reservation goes, the unrefunded part (if any) is spent today. */
  private settle(key: string, net: bigint): void {
    const all = this.journal.reservations ?? {}
    if (!all[key]) return
    delete all[key]
    this.journal.reservations = all
    this.spend(net > 0n ? net : 0n)
  }

  /**
   * Open reservations whose bundle has an outcome: a receipt (cost minus the EntryPoint's refund to the relayer is
   * spent), or the relayer nonce it was signed with taken by another transaction while it has no receipt (it can
   * never land: nothing spent). Anything else stays reserved. Runs on the tick.
   */
  private async settleReservations(): Promise<void> {
    for (const [key, r] of Object.entries(this.journal.reservations ?? {})) {
      if (this.bundling.has(key) || !r.tx) continue
      // undefined: the node did not answer (unknown, nothing changes); null: the node says there is no receipt.
      const rc = await this.l1.getTransactionReceipt({ hash: r.tx }).catch((e) => (e instanceof TransactionReceiptNotFoundError ? null : undefined))
      if (rc === undefined) continue
      if (rc) {
        const refund = parseEventLogs({ abi: entryPointV07Abi, eventName: 'UserOperationEvent', logs: rc.logs.filter((l) => getAddress(l.address) === address('EntryPointV07', baseRegistry)) }).reduce((a, l) => a + l.args.actualGasCost, 0n)
        // The refund goes to the beneficiary, the relayer itself (bundler.ts handleOpsData).
        this.settle(key, rc.gasUsed * rc.effectiveGasPrice - refund)
        continue
      }
      if (r.nonce === undefined) continue
      // Its relayer nonce taken by another transaction and no receipt for it: it can never land. Released only when
      // that holds on ticks at least RESERVATION_GONE_MS apart (a lagging node cannot release it in one reading), and
      // the node also does not know the transaction.
      const mined = await this.l1.getTransactionCount({ address: this.relayer.address, blockTag: 'latest' }).catch(() => -1)
      const known = await this.l1.getTransaction({ hash: r.tx }).then(
        () => true,
        (e) => (e instanceof TransactionNotFoundError ? false : undefined),
      )
      if (mined > r.nonce && known === false) {
        if (!r.goneAt) this.reserve(key, BigInt(r.wei), { goneAt: new Date(this.now()).toISOString() })
        else if (this.now() - Date.parse(r.goneAt) >= RESERVATION_GONE_MS) this.settle(key, 0n)
      } else if (r.goneAt) {
        const { goneAt: _g, ...rest } = r
        this.journal.reservations![key] = rest
        this.save()
      }
    }
  }

  /**
   * #180: the guard of the operator's own Ethereum bundler. The relayer fronts handleOps gas only for a move this
   * operator is sending (its route names the userOp), one bundle at a time, within the gas ceiling, the daily budget
   * (open reservations of any day included) and its balance. Each bundle's reservation is keyed by its userOp hash and
   * persisted with the signed transaction's hash and nonce before the broadcast; it is released only on a proven
   * outcome (after(), or settleReservations()). A client that stopped waiting releases nothing.
   */
  bundlerGuard(): Required<BundlerGuard> {
    return {
      before: async (key: Hex, gas: bigint) => {
        const route = Object.values(this.journal.routes).find((r) => r.userOpHash?.toLowerCase() === key.toLowerCase())
        if (!route || (route.state !== 'sending' && route.state !== 'unconfirmed')) throw new Error('no move under way for this userOp')
        if (this.bundling.size > 0) throw new Error('another bundle is in flight')
        if (this.journal.reservations?.[key]) throw new Error('this userOp already has a bundle')
        const bound = await this.affordable(gas)
        this.bundling.add(key)
        this.reserve(key, bound)
      },
      // The signed transaction's own bound (gas at its maxFeePerGas), before the broadcast: it replaces the
      // estimate, and over the budget or the gas ceiling the send stops here.
      sending: (key: Hex, maxFeeWei: bigint, gas: bigint) => {
        this.reserve(key, maxFeeWei)
        if (this.committed() > DAILY_BUDGET_WEI) throw new Error("over the day's budget")
        if (gas > 0n && maxFeeWei / gas > MAX_GAS_PRICE_WEI * 2n) throw new Error('over the gas ceiling')
      },
      sent: (key: Hex, tx: Hex, nonce: number) => {
        this.reserve(key, BigInt(this.journal.reservations?.[key]?.wei ?? '0'), { tx, nonce })
        for (const [accountKey, r] of Object.entries(this.journal.routes)) {
          if (r.userOpHash?.toLowerCase() !== key.toLowerCase()) continue
          r.userOpTx = tx
          this.write(accountKey, r)
          if (this.sending?.route.id === r.id) this.sending.route.userOpTx = tx
        }
      },
      after: (key: Hex, cost: bigint, refund: bigint) => {
        this.bundling.delete(key)
        this.settle(key, cost - refund)
      },
      failed: (key: Hex, signed: boolean) => {
        this.bundling.delete(key)
        // Never signed for broadcast: nothing can be spent. Signed: unknown, it stays until settleReservations().
        if (!signed) this.settle(key, 0n)
      },
    }
  }

  /**
   * A userOp route from its receipt: the bundler says whether and where it was included, the transaction receipt
   * holds its logs (only the slice between its boundaries counts), the deposit event must be the one signed.
   * No receipt yet: unchanged.
   */
  private async resolveUserOp(r: Stored, leg: Leg | null): Promise<void> {
    if (!r.userOpHash) return
    // The bundler's receipt, or (the operator's own bundler forgets on restart, or the userOp path is off after a
    // rollback) the bundle transaction it reported, or the userOp's event.
    const br = this.aa ? await this.aa.bundler.receipt(r.userOpHash).catch(() => null) : null
    const txHash = br?.txHash ?? r.userOpTx ?? (await this.findUserOpTx(r))
    if (!txHash) return
    const receipt = await this.l1.getTransactionReceipt({ hash: txHash }).catch(() => null)
    if (!receipt) return
    r.userOpTx = txHash
    r.l1Tx = txHash
    const mine = userOpLogs(receipt, r.userOpHash)
    if (!mine) {
      // A bundle that reverted (or holds another userOp): this one did not run in it.
      logErr(`[bridge-out] ${r.safe.slice(0, 10)}: bundle without the UserOperationEvent`, txHash)
      if (!br && receipt.status === 'reverted') r.userOpTx = undefined
      if (!br) r.l1Tx = undefined
      return
    }
    // What the paymaster took: all USDC out of the account in this userOp, minus what the bridge took (when it ran).
    let out = 0n
    for (const ev of parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: mine.logs.filter((l) => getAddress(l.address) === L1_USDC) })) {
      if (getAddress(ev.args.from) === getAddress(r.safe)) out += ev.args.value
    }
    const bridged = mine.success ? BigInt(r.amountUsdc) : 0n
    r.gasUsdc = (out > bridged ? out - bridged : 0n).toString()
    if (!mine.success) {
      r.state = 'failed'
      return
    }
    if (r.bridge === 'cctp') {
      const burn: Burn | null = leg?.bridge === 'cctp' ? leg.burn : r.cctp ? { amount: BigInt(r.amountUsdc), maxFee: BigInt(r.cctp.maxFee), minFinality: r.cctp.minFinality } : null
      const sent = parseEventLogs({ abi: messageTransmitterV2Abi, eventName: 'MessageSent', logs: mine.logs.filter((l) => getAddress(l.address) === MESSAGE_TRANSMITTER_V2) })
      if (!burn || !burnMatches(mine.logs, L1_USDC, r.safe, burn) || sent.length !== 1) {
        logErr(`[bridge-out] ${r.safe.slice(0, 10)}: userOp included without the expected burn`, txHash)
        return
      }
      // The exact message this burn emitted, less the fields Circle fills in: the mint must be this one.
      r.cctp = { ...(r.cctp ?? { maxFee: burn.maxFee.toString(), minFinality: burn.minFinality }), message: cctpMessageKey(sent[0]!.args.message) }
      r.state = 'deposited'
      return
    }
    const id = leg?.bridge === 'across' ? depositIdFrom({ logs: mine.logs }, r.safe, leg.deposit) : this.depositIdLoose(mine.logs, r)
    if (id === null) {
      logErr(`[bridge-out] ${r.safe.slice(0, 10)}: userOp included without the expected deposit event`, txHash)
      return
    }
    r.depositId = id
    r.state = 'deposited'
  }

  /**
   * Last resort when neither the bundler nor the route knows the bundle (only reachable if the journal lost the hash
   * written before the broadcast): when the account's EntryPoint nonce has moved past the signed one, the
   * UserOperationEvent with this userOpHash (an indexed topic, what bundlers answer eth_getUserOperationReceipt from)
   * in provider-sized chunks from the send block. Nonce unspent: nothing to find. The window covers the userOp's
   * whole life: the SafeOp's validUntil is USEROP_VALID_SEC (10 min, ~50 blocks) after the prepare and the
   * EntryPoint refuses it after that, so it can only be in the first ~50 of the 7,200 blocks searched.
   */
  private async findUserOpTx(r: Stored): Promise<Hex | undefined> {
    const nonce = await this.l1.readContract({ address: address('EntryPointV07', baseRegistry), abi: entryPointV07Abi, functionName: 'getNonce', args: [r.safe, OWNER_NONCE_KEY] })
    if (nonce <= BigInt(r.safeNonce)) return undefined
    const head = await this.l1.getBlockNumber({ cacheTime: 0 })
    const from = BigInt(r.fromBlock)
    const end = head < from + LOG_WINDOW_BLOCKS ? head : from + LOG_WINDOW_BLOCKS
    for (let lo = from; lo <= end; lo += LOG_CHUNK_BLOCKS) {
      const hi = lo + LOG_CHUNK_BLOCKS - 1n < end ? lo + LOG_CHUNK_BLOCKS - 1n : end
      const logs = await this.l1.getLogs({ address: address('EntryPointV07', baseRegistry), event: USER_OPERATION_EVENT, args: { userOpHash: r.userOpHash }, fromBlock: lo, toBlock: hi })
      if (logs.length > 0) return logs[0]!.transactionHash ?? undefined
    }
    logErr(`[bridge-out] ${r.safe.slice(0, 10)}:`, `EntryPoint nonce spent but no UserOperationEvent for the userOp in blocks ${from}..${end}`)
    return undefined
  }

  /** After a restart the signed deposit is gone: who, to whom, how much in and out, and where must match. */
  private depositIdLoose(logs: Log[], r: Stored): string | null {
    const evs = parseEventLogs({ abi: spokePoolAbi, eventName: 'FundsDeposited', logs: logs.filter((l) => getAddress(l.address) === ACROSS_SPOKE_POOL) }).filter(
      (e) =>
        e.args.depositor.toLowerCase() === word(r.safe) &&
        e.args.recipient.toLowerCase() === word(r.safe) &&
        e.args.inputAmount === BigInt(r.amountUsdc) &&
        e.args.outputAmount === BigInt(r.outputUsdc) &&
        e.args.destinationChainId === BigInt(BASE_CHAIN_ID),
    )
    return evs.length === 1 ? evs[0]!.args.depositId.toString() : null
  }

  private async send(ctx: AccountContext, p: Prepared, signature: Hex): Promise<BridgeOutView> {
    if (await this.blocking(this.journal.routes[ctx.accountKey])) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    if (this.convertBlocking(ctx.accountKey) || this.siblingInFlight(ctx.accountKey)) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    // Nothing changed on Ethereum since the prepare: same balance, same deploy state and nonce.
    const [amount, state, head] = await Promise.all([this.usdcAt(p.live.safe), readSafeNonce(this.l1, p.live.safe), this.l1.getBlockNumber({ cacheTime: 0 })])
    if (amount !== p.deposit.amount || state.deployed !== p.deployed || state.nonce !== p.tx.nonce) throw new HttpError(409, 'BRIDGE_STALE', 'the balance on Ethereum changed, tap again')
    const moves = this.journal.moves[ctx.accountKey]
    if (moves && moves.day === this.day() && moves.n >= MOVES_PER_ACCOUNT_DAY) throw new HttpError(429, 'BRIDGE_ACCOUNT_LIMIT', 'too many moves from Ethereum today, try tomorrow')
    const exec = execTransactionData(p.tx, signature)
    // A deployed account must accept the owner transaction in simulation before the relayer spends anything on it.
    if (p.deployed) await this.simulate(p.live.safe, exec)
    const day = this.day()
    const m = this.journal.moves[ctx.accountKey]
    this.journal.moves[ctx.accountKey] = { day, n: m && m.day === day ? m.n + 1 : 1 }
    const route: Stored = {
      id: p.prepareId,
      safe: p.live.safe,
      safeNonce: p.tx.nonce.toString(),
      fromBlock: head.toString(),
      state: 'sending',
      amountUsdc: p.deposit.amount.toString(),
      outputUsdc: p.deposit.outputAmount.toString(),
      at: '',
    }
    this.journal.routes[ctx.accountKey] = route
    this.write(ctx.accountKey, route)
    try {
      if (!p.deployed) {
        const d = deployCall(p.live)
        const r = await this.charged({ to: d.to, data: d.data, gas: DEPLOY_GAS }, (h) => {
          route.deployTx = h
          this.write(ctx.accountKey, route)
        })
        if (r.receipt.status !== 'success') throw new Error('deploy reverted')
        await this.simulate(p.live.safe, exec)
      }
      // From here the owner transaction may reach the provider even if the call below throws before returning a hash.
      route.execStarted = true
      this.write(ctx.accountKey, route)
      const r = await this.charged({ to: p.live.safe, data: exec, gas: EXEC_GAS }, (h) => {
        route.l1Tx = h
        this.write(ctx.accountKey, route)
      })
      if (r.receipt.status !== 'success') {
        route.state = 'failed'
      } else {
        const id = depositIdFrom(r.receipt, p.live.safe, p.deposit)
        if (id === null) {
          logErr(`[bridge-out] ${ctx.accountKey.slice(0, 8)}: included without the expected deposit event`, r.hash)
          route.state = 'unconfirmed'
        } else {
          route.depositId = id
          route.state = 'deposited'
        }
      }
    } catch (e) {
      logErr(`[bridge-out] ${ctx.accountKey.slice(0, 8)}:`, e)
      route.state = route.execStarted ? 'unconfirmed' : 'failed'
    }
    this.write(ctx.accountKey, route)
    if (route.state === 'failed') throw new HttpError(502, 'BRIDGE_FAILED', 'the move from Ethereum did not go through; the USDC is still at your address on Ethereum')
    return view(route, true)
  }

  private async simulate(safe: Address, exec: Hex): Promise<void> {
    let ok = false
    try {
      const sim = await this.l1.call({ account: this.relayer.address, to: safe, data: exec })
      ok = sim.data === `0x${'1'.padStart(64, '0')}`
    } catch {
      ok = false
    }
    if (!ok) throw new HttpError(409, 'BRIDGE_SIMULATION', 'the account on Ethereum refused this move')
  }

  /** The last move of the account, brought up to date from the chain and from Across. */
  async status(ctx: AccountContext): Promise<BridgeOutView> {
    const v = await this.refresh(ctx.accountKey)
    return { ...v, convert: await this.convertStatus(ctx.accountKey) }
  }

  // ---- #211: ETH on Ethereum to USDC in the same account -------------------------------------------------------

  private readonly preparedConvert = new Map<string, PreparedConvert>()

  /** A conversion being sent or not proven blocks another one and a move (they would sign the same Safe nonce). */
  private convertBlocking(accountKey: string): boolean {
    const c = this.journal.converts?.[accountKey]
    return !!c && (c.state === 'sending' || c.state === 'unconfirmed')
  }

  private convertsToday(accountKey: string): number {
    const d = this.journal.convertDays?.[accountKey]
    return d && d.day === this.day() ? d.n : 0
  }

  private writeConvert(accountKey: string, c: StoredConvert): void {
    c.at = new Date(this.now()).toISOString()
    this.journal.converts = { ...(this.journal.converts ?? {}), [accountKey]: c }
    this.save()
  }

  async prepareConvert(ctx: AccountContext): Promise<EthConvertToSign> {
    this.on(ctx.accountKey)
    const live = this.live(ctx)
    if (this.convertBlocking(ctx.accountKey) || this.siblingInFlight(ctx.accountKey) || (await this.blocking(this.journal.routes[ctx.accountKey]))) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    if (this.convertsToday(ctx.accountKey) >= CONVERTS_PER_ACCOUNT_DAY) throw new HttpError(429, 'BRIDGE_ACCOUNT_LIMIT', 'too many moves from Ethereum today, try tomorrow')
    const amountIn = await this.l1.getBalance({ address: live.safe })
    if (amountIn < MIN_CONVERT_WEI) throw new HttpError(409, 'CONVERT_NOTHING', 'there is no ETH on Ethereum to convert')
    let quoted: bigint
    let oracle: { answer: bigint; updatedAt: bigint }
    try {
      const [q, round] = await Promise.all([
        this.l1.simulateContract({ address: QUOTER_V2, abi: quoterV2Abi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: L1_WETH, tokenOut: L1_USDC, amountIn, fee: WETH_USDC_FEE, sqrtPriceLimitX96: 0n }] }),
        this.l1.readContract({ address: CHAINLINK_ETH_USD, abi: aggregatorAbi, functionName: 'latestRoundData' }),
      ])
      quoted = q.result[0]
      oracle = { answer: round[1], updatedAt: round[3] }
    } catch (e) {
      logErr('[bridge-out] convert quote:', e instanceof Error ? e.message : 'failed')
      throw new HttpError(503, 'CONVERT_PRICE_UNAVAILABLE', 'the ETH price could not be checked right now, try later')
    }
    const nowSec = Math.floor(this.now() / 1000)
    const minOut = convertMinOut(amountIn, quoted, oracle, nowSec)
    const { deployed, nonce } = await readSafeNonce(this.l1, live.safe)
    const tx = ownerSafeTx([convertCall(live.safe, amountIn, minOut, nowSec + CONVERT_DEADLINE_SEC)], nonce)
    const safeTxHash = safeTxHashOf(live, tx)
    const prepareId = toHex(randomBytes(16)).slice(2)
    const expires = this.now() + PREPARE_TTL_MS
    const p: PreparedConvert = { prepareId, accountKey: ctx.accountKey, live, tx, safeTxHash, amountIn, minOut, deployed, expires }
    if (!admitPrepare(this.preparedConvert, p, MAX_PREPARED, this.now())) throw new HttpError(503, 'BRIDGE_BUSY', 'too many moves are waiting for approval, try again in a minute')
    return {
      safe: live.safe,
      chainId: ETHEREUM_CHAIN_ID,
      safeTxHash,
      summary: [
        `Convert ${eth(amountIn)} ETH to USDC, in this same account on Ethereum`,
        `You get about ${usdc(quoted)} USDC, at least ${usdc(minOut)} or nothing changes`,
        `Swap: Uniswap, ETH/USDC 0.05% pool. Mamoru pays the Ethereum gas. Then Move to Base takes the USDC`,
      ],
      expiresAt: new Date(expires).toISOString(),
      prepareId,
      convert: { ethWei: amountIn.toString(), quotedUsdc: quoted.toString(), minUsdc: minOut.toString() },
    }
  }

  async submitConvert(ctx: AccountContext, body: OwnerSignature): Promise<BridgeOutView> {
    if (this.inFlight || this.bundling.size > 0) throw new HttpError(503, 'BRIDGE_BUSY', 'another move from Ethereum is being sent, try again in a minute')
    const p = body && typeof body.prepareId === 'string' ? this.preparedConvert.get(body.prepareId) : undefined
    if (!p || p.accountKey !== ctx.accountKey) throw new HttpError(404, 'PREPARE_NOT_FOUND', 'that approval is not known, tap again')
    this.preparedConvert.delete(p.prepareId)
    if (p.expires < this.now()) throw new HttpError(410, 'PREPARE_EXPIRED', 'that approval expired, tap again')
    let signature: Hex
    try {
      signature = browserOwnerSignature(body, p.safeTxHash)
    } catch {
      throw new HttpError(400, 'BAD_SIGNATURE', 'the passkey signature could not be read')
    }
    if (!(await verifyOwnerSignature(signature, p.safeTxHash, p.live.webauthn))) throw new HttpError(400, 'BAD_SIGNATURE', 'the passkey signature does not match this account')
    this.on(ctx.accountKey)
    return this.exclusive(() => this.sendConvert(ctx, p, signature))
  }

  private async sendConvert(ctx: AccountContext, p: PreparedConvert, signature: Hex): Promise<BridgeOutView> {
    if (this.convertBlocking(ctx.accountKey) || this.siblingInFlight(ctx.accountKey) || (await this.blocking(this.journal.routes[ctx.accountKey]))) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    // Nothing changed on Ethereum since the prepare: same ETH, same deploy state and Safe nonce.
    const [amount, state, head] = await Promise.all([this.l1.getBalance({ address: p.live.safe }), readSafeNonce(this.l1, p.live.safe), this.l1.getBlockNumber({ cacheTime: 0 })])
    if (amount !== p.amountIn || state.deployed !== p.deployed || state.nonce !== p.tx.nonce) throw new HttpError(409, 'BRIDGE_STALE', 'the balance on Ethereum changed, tap again')
    if (this.convertsToday(ctx.accountKey) >= CONVERTS_PER_ACCOUNT_DAY) throw new HttpError(429, 'BRIDGE_ACCOUNT_LIMIT', 'too many moves from Ethereum today, try tomorrow')
    const exec = execTransactionData(p.tx, signature)
    if (p.deployed) await this.simulate(p.live.safe, exec)
    const day = this.day()
    this.journal.convertDays = { ...(this.journal.convertDays ?? {}), [ctx.accountKey]: { day, n: this.convertsToday(ctx.accountKey) + 1 } }
    const c: StoredConvert = { id: p.prepareId, safe: p.live.safe, safeNonce: p.tx.nonce.toString(), safeTxHash: p.safeTxHash, fromBlock: head.toString(), state: 'sending', ethWei: p.amountIn.toString(), minUsdc: p.minOut.toString(), at: '' }
    this.writeConvert(ctx.accountKey, c)
    try {
      if (!p.deployed) {
        const d = deployCall(p.live)
        const r = await this.charged({ to: d.to, data: d.data, gas: DEPLOY_GAS }, (h) => {
          c.deployTx = h
          this.writeConvert(ctx.accountKey, c)
        })
        if (r.receipt.status !== 'success') throw new Error('deploy reverted')
        await this.simulate(p.live.safe, exec)
      }
      c.execStarted = true
      this.writeConvert(ctx.accountKey, c)
      const r = await this.charged({ to: p.live.safe, data: exec, gas: CONVERT_GAS }, (h) => {
        c.l1Tx = h
        this.writeConvert(ctx.accountKey, c)
      })
      this.settleConvert(c, r.receipt)
    } catch (e) {
      logErr(`[bridge-out] convert ${ctx.accountKey.slice(0, 8)}:`, e)
      c.state = c.execStarted ? 'unconfirmed' : 'failed'
    }
    this.writeConvert(ctx.accountKey, c)
    if (c.state === 'failed') throw new HttpError(502, 'CONVERT_FAILED', 'the conversion did not go through; the ETH is still at your address on Ethereum')
    return { ...view(this.journal.routes[ctx.accountKey], true), convert: convertView(c) }
  }

  /**
   * From the owner transaction's receipt. Safe's execTransaction does not revert when the inner call fails: it emits
   * ExecutionFailure. The USDC that arrived decides: at least the signed minimum is done, none is failed.
   */
  private settleConvert(c: StoredConvert, receipt: TransactionReceipt): void {
    if (receipt.status !== 'success') {
      c.state = 'failed'
      return
    }
    const got = usdcInto(receipt, c.safe)
    if (got >= BigInt(c.minUsdc)) {
      c.state = 'done'
      c.usdcOut = got.toString()
    } else if (got === 0n) {
      c.state = 'failed'
    } else {
      logErr(`[bridge-out] convert ${c.safe.slice(0, 10)}: less USDC than the signed minimum`, receipt.transactionHash)
      c.state = 'unconfirmed'
    }
  }

  // ---------------------------------------------------------------- #309 (b): the V4 sibling on Ethereum

  /** The account's C on Base (USD units), set by boot from the operator (the same C a Base V4 home signs). Null: unknown. */
  siblingCapUsd: (ctx: AccountContext) => bigint | null = () => null
  private readonly preparedSibling = new Map<string, PreparedSibling>()

  private get keyFile(): string {
    return join(this.stateDir, 'ethereum-sibling-keys.json')
  }

  /** The sibling's session key of `accountKey`, created once and kept in its own 0600 file (never in the journal). */
  private siblingKey(accountKey: string): Hex {
    const keys = existsSync(this.keyFile) ? (JSON.parse(readFileSync(this.keyFile, 'utf8')) as Record<string, Hex>) : {}
    if (keys[accountKey]) return keys[accountKey]!
    keys[accountKey] = generatePrivateKey()
    const tmp = `${this.keyFile}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(keys, null, 1))
      fsyncSync(fd) // a key that signed an enable must survive a crash (review r2 of #227)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.keyFile)
    return keys[accountKey]!
  }

  /** The private key of the account's sibling session, for the engine leg (#309 c). Undefined before its prepare. */
  siblingSessionKey(accountKey: string): Hex | undefined {
    if (!existsSync(this.keyFile)) return undefined
    return (JSON.parse(readFileSync(this.keyFile, 'utf8')) as Record<string, Hex>)[accountKey]
  }

  /**
   * #309 (a): the account's USDC at its own address on Ethereum plus its ETH valued at Chainlink's ETH/USD (fresh answers
   * only), in USDC units. 0 when the sibling does not apply (off for the account, V4 not on Ethereum); THROWS when it
   * applies and cannot be read (security review of #235: a cap check never reads an unreadable balance as zero).
   */
  async siblingHoldingsUsdc(ctx: AccountContext): Promise<bigint> {
    if (!this.enabledFor(ctx.accountKey) || !oneAuthV4Deployment(ethereumRegistry)) return 0n
    const safe = this.live(ctx).safe
    const [usdcHeld, wei, round] = await Promise.all([this.usdcAt(safe), this.l1.getBalance({ address: safe }), this.l1.readContract({ address: CHAINLINK_ETH_USD, abi: aggregatorAbi, functionName: 'latestRoundData' })])
    const answer = round[1]
    if (answer <= 0n || BigInt(Math.floor(this.now() / 1000)) - round[3] > BigInt(ORACLE_MAX_AGE_SEC)) throw new Error('ETH/USD price stale or unusable')
    return usdcHeld + (wei * answer) / 10n ** 20n
  }

  siblingView(accountKey: string): SiblingView {
    const c = this.journal.siblings?.[accountKey]
    return c ? { state: c.state, safe: c.safe, sessionKey: c.sessionKey, ...(c.l1Tx ? { l1Tx: c.l1Tx } : {}) } : { state: 'none' }
  }

  /** A sibling enable on its way (it signs the Safe's nonce on Ethereum): conversions and moves wait for it. */
  private siblingInFlight(accountKey: string): boolean {
    const c = this.journal.siblings?.[accountKey]
    return !!c && (c.state === 'sending' || c.state === 'unconfirmed')
  }

  private siblingBlocking(accountKey: string): boolean {
    const c = this.journal.siblings?.[accountKey]
    return !!c && c.state !== 'failed'
  }

  /**
   * The sibling's owner transaction for the passkey. Offered when V4 is pinned on Ethereum, the account holds something
   * there for it to do, and its Safe there has no SmartSession permission yet (a Safe Mamoru set up never had one on
   * Ethereum: any other is refused, fail closed).
   */
  async prepareSibling(ctx: AccountContext): Promise<SiblingToSign> {
    this.on(ctx.accountKey)
    const deployment = oneAuthV4Deployment(ethereumRegistry)
    if (!deployment) throw new HttpError(503, 'SIBLING_UNAVAILABLE', 'Mamoru on Ethereum is not available yet')
    const live = this.live(ctx)
    if (this.siblingBlocking(ctx.accountKey)) throw new HttpError(409, 'SIBLING_IN_PROGRESS', 'your Safe on Ethereum is already set up or being set up')
    const cap = this.siblingCapUsd(ctx)
    if (!cap || cap <= 0n) throw new HttpError(503, 'SIBLING_UNAVAILABLE', 'your account limit could not be read just now, try again in a minute')
    // One Safe nonce at a time on Ethereum (review r2 of #227): never beside a conversion or a move in flight.
    if (this.convertBlocking(ctx.accountKey) || (await this.blocking(this.journal.routes[ctx.accountKey]))) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    const [eth, usdc, state] = await Promise.all([this.l1.getBalance({ address: live.safe }), this.usdcAt(live.safe), readSafeNonce(this.l1, live.safe)])
    if (state.deployed) {
      // Before the funds check (review r2 of #227): an emptied Safe whose own enable landed late still becomes done.
      const ids = ((await this.l1.readContract({ address: address('SmartSession', ethereumRegistry), abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [live.safe] })) as Hex[]).map((x) => x.toLowerCase())
      const own = this.journal.siblings?.[ctx.accountKey]
      const mine = new Set([...(own?.signedIds ?? []), ...(own ? [own.permissionId] : [])].map((x) => x.toLowerCase()))
      // A late landing of one of the account's own earlier enables: it is done, not a mismatch.
      if (own && ids.length === 1 && mine.has(ids[0]!)) {
        own.permissionId = ids[0] as Hex
        own.state = 'done'
        this.writeSibling(ctx.accountKey, own)
        throw new HttpError(409, 'SIBLING_IN_PROGRESS', 'your Safe on Ethereum is already set up')
      }
      if (ids.length) {
        logErr(`[alert] bridge-out sibling ${ctx.accountKey.slice(0, 8)}: ${live.safe} on Ethereum has ${ids.length} SmartSession permission(s) Mamoru does not know: nothing prepared`, undefined)
        throw new HttpError(409, 'SIBLING_INVENTORY_MISMATCH', 'your Safe on Ethereum has permissions Mamoru did not give: nothing was prepared, and the team was alerted')
      }
    }
    if (eth < SIBLING_MIN_WEI && usdc < MIN_USDC) throw new HttpError(409, 'SIBLING_NOTHING', 'there is nothing on Ethereum for Mamoru to move')
    const priv = this.siblingKey(ctx.accountKey)
    const sessionKey = privateKeyToAccount(priv).address
    const input: MigrateV4Input = { chainId: ETHEREUM_CHAIN_ID, safe: live.safe, safeNonce: state.nonce.toString(), step: 1, capUsdc: cap.toString(), sessionKey, generation: '1', admit: [], oldPermissionIds: [], removeIds: [], noncesBefore: [], home: live.safe, homeDomain: SIBLING_HOME_DOMAIN }
    const built = buildMigrateV4(input, ethereumRegistry)
    const tx: SafeTx = { to: built.safeTx.to, value: 0n, data: built.safeTx.data, operation: built.safeTx.operation, nonce: state.nonce }
    // The builder hashes with the chain's domain; the account's own view of the same tx must agree.
    if (safeTxHashOf(live, tx) !== built.safeTxHash) throw new Error('sibling: safeTxHash mismatch between the builder and the account')
    const prepareId = toHex(randomBytes(16)).slice(2)
    const expires = this.now() + PREPARE_TTL_MS
    const p: PreparedSibling = { prepareId, accountKey: ctx.accountKey, live, tx, safeTxHash: built.safeTxHash, permissionId: built.permissionId, sessionKey, capUsdc: cap, deployed: state.deployed, expires }
    if (!admitPrepare(this.preparedSibling, p, MAX_PREPARED, this.now())) throw new HttpError(503, 'BRIDGE_BUSY', 'too many approvals are waiting, try again in a minute')
    return {
      safe: live.safe,
      chainId: ETHEREUM_CHAIN_ID,
      safeTxHash: built.safeTxHash,
      summary: siblingStepLines({ capUsd: cap, eth, usdc }),
      expiresAt: new Date(expires).toISOString(),
      prepareId,
      built: { input, safeTxHash: built.safeTxHash },
    }
  }

  async submitSibling(ctx: AccountContext, body: OwnerSignature): Promise<SiblingView> {
    if (this.inFlight || this.bundling.size > 0) throw new HttpError(503, 'BRIDGE_BUSY', 'another move from Ethereum is being sent, try again in a minute')
    const p = body && typeof body.prepareId === 'string' ? this.preparedSibling.get(body.prepareId) : undefined
    if (!p || p.accountKey !== ctx.accountKey) throw new HttpError(404, 'PREPARE_NOT_FOUND', 'that approval is not known, tap again')
    this.preparedSibling.delete(p.prepareId)
    if (p.expires < this.now()) throw new HttpError(410, 'PREPARE_EXPIRED', 'that approval expired, tap again')
    let signature: Hex
    try {
      signature = browserOwnerSignature(body, p.safeTxHash)
    } catch {
      throw new HttpError(400, 'BAD_SIGNATURE', 'the passkey signature could not be read')
    }
    if (!(await verifyOwnerSignature(signature, p.safeTxHash, p.live.webauthn))) throw new HttpError(400, 'BAD_SIGNATURE', 'the passkey signature does not match this account')
    this.on(ctx.accountKey)
    return this.exclusive(() => this.sendSibling(ctx, p, signature))
  }

  private async sendSibling(ctx: AccountContext, p: PreparedSibling, signature: Hex): Promise<SiblingView> {
    if (this.siblingBlocking(ctx.accountKey)) throw new HttpError(409, 'SIBLING_IN_PROGRESS', 'your Safe on Ethereum is already set up or being set up')
    // The same gates as the prepare, again under the lock, before any row is written (security review of #227).
    if (this.convertBlocking(ctx.accountKey) || (await this.blocking(this.journal.routes[ctx.accountKey]))) throw new HttpError(409, 'BRIDGE_IN_PROGRESS', 'a move from Ethereum is already under way')
    const [state, head] = await Promise.all([readSafeNonce(this.l1, p.live.safe), this.l1.getBlockNumber({ cacheTime: 0 })])
    if (state.deployed !== p.deployed || state.nonce !== p.tx.nonce) throw new HttpError(409, 'BRIDGE_STALE', 'your Safe on Ethereum changed, tap again')
    const exec = execTransactionData(p.tx, signature)
    if (p.deployed) await this.simulate(p.live.safe, exec)
    const c: StoredSibling = { id: p.prepareId, safe: p.live.safe, safeNonce: p.tx.nonce.toString(), safeTxHash: p.safeTxHash, permissionId: p.permissionId, sessionKey: p.sessionKey, capUsdc: p.capUsdc.toString(), fromBlock: head.toString(), state: 'sending', sentAt: new Date(this.now()).toISOString(), execData: exec, resends: 0, signedIds: [...new Set([...(this.journal.siblings?.[ctx.accountKey]?.signedIds ?? []), p.permissionId])], at: '' }
    this.installSibling(ctx.accountKey, c)
    try {
      if (!p.deployed) {
        const d = deployCall(p.live)
        const r = await this.charged({ to: d.to, data: d.data, gas: DEPLOY_GAS }, (h) => {
          c.deployTx = h
          this.writeSibling(ctx.accountKey, c)
        })
        if (r.receipt.status !== 'success') throw new Error('deploy reverted')
        await this.simulate(p.live.safe, exec)
      }
      const est = await this.l1.estimateGas({ account: this.relayer.address, to: p.live.safe, data: exec })
      const gas = (est * 13n) / 10n
      if (gas > SIBLING_ENABLE_GAS) throw new Error(`sibling enable would take ${est} gas`)
      // Started once SIGNED (review r2 of #227): the hash exists before the broadcast, so a provider that accepts the tx
      // and then fails the call leaves it 'unconfirmed' (reconciled), never 'failed' while it can still land. A refusal
      // before signing (gas price, budget) leaves nothing to reconcile.
      const started = (h: Hex) => {
        c.l1Tx = h
        c.execStarted = true
        this.writeSibling(ctx.accountKey, c)
      }
      const r = await this.charged({ to: p.live.safe, data: exec, gas }, started, started)
      await this.settleSibling(c, r.receipt)
    } catch (e) {
      logErr(`[bridge-out] sibling ${ctx.accountKey.slice(0, 8)}:`, e)
      c.state = c.execStarted ? 'unconfirmed' : 'failed'
    }
    this.writeSibling(ctx.accountKey, c)
    if (c.state === 'failed') throw new HttpError(502, 'SIBLING_FAILED', 'setting up your Safe on Ethereum did not go through; nothing moved')
    return this.siblingView(ctx.accountKey)
  }

  /** Done only when the Safe executed it (ExecutionSuccess for its hash) AND SmartSession lists the V4 session now. */
  private async settleSibling(c: StoredSibling, receipt: TransactionReceipt): Promise<void> {
    // A reverted send left the Safe's nonce unspent: the signed tx can still run. Unconfirmed; tick() resends it.
    if (receipt.status !== 'success') {
      c.state = 'unconfirmed'
      return
    }
    const ok = receipt.logs.some((l) => getAddress(l.address) === getAddress(c.safe) && l.topics[0] === EXECUTION_SUCCESS_TOPIC && (l.topics[1] ?? `0x${l.data.slice(2, 66)}`).toLowerCase() === c.safeTxHash.toLowerCase())
    const failed = receipt.logs.some((l) => getAddress(l.address) === getAddress(c.safe) && l.topics[0] === EXECUTION_FAILURE_TOPIC)
    if (failed) {
      c.state = 'failed'
      return
    }
    const enabled = ok && (await this.siblingEnabled(c))
    c.state = enabled ? 'done' : 'unconfirmed'
  }

  private async siblingEnabled(c: StoredSibling): Promise<boolean> {
    return (await this.l1.readContract({ address: address('SmartSession', ethereumRegistry), abi: smartSessionV4Abi, functionName: 'isPermissionEnabled', args: [c.permissionId, c.safe] })) as boolean
  }

  /**
   * An unfinished enable, from the chain (review r1 of #227 and the security review of its fix). A signed Safe tx with
   * no deadline stays valid while its nonce is unspent, so time alone never fails it:
   * - the V4 session listed: done (also for a 'failed' row whose tx landed late);
   * - failed only on proof at Ethereum's finalized block: the Safe's ExecutionFailure for the hash, or the Safe's nonce
   *   above the signed one with no execution of this hash (another transaction took it, this one can never run);
   * - the sent tx's receipt successful: settled from its logs;
   * - reverted, or no receipt past UNCONFIRMED_GIVEUP_MS, with the nonce unspent: the same signed calldata is resent
   *   (charged), at most SIBLING_RESENDS times; then it stays unconfirmed and is alerted: the account stays blocked
   *   (fail closed) until ops looks;
   * - a provider error aborts the pass (only "receipt not found" means no receipt). Never while a send is in flight.
   */
  private async reconcileSibling(accountKey: string): Promise<void> {
    const c = this.journal.siblings?.[accountKey]
    if (!c || c.state === 'done' || this.inFlight) return
    if (c.state === 'failed') {
      // Any failed row (review r3 of #227): a never-broadcast one too, since the browser still holds a valid signature.
      if (await this.siblingEnabled(c)) {
        c.state = 'done'
        this.writeSibling(accountKey, c)
      }
      return
    }
    // Out of resends (alerted): looked at again only every SIBLING_STUCK_POLL_MS, not every tick (review r2/r3 of #227).
    if ((c.resends ?? 0) >= SIBLING_RESENDS) {
      if (c.polledAt && this.now() - Date.parse(c.polledAt) < SIBLING_STUCK_POLL_MS) return
      c.polledAt = new Date(this.now()).toISOString()
      this.save()
    }
    const before = c.state
    if (await this.siblingEnabled(c)) c.state = 'done'
    else if (!c.l1Tx) {
      // Never signed for broadcast (a refusal or a crash before the exec, e.g. after the deploy): its signature never left
      // this host, so no one can run it. Failed after the give-up time; the account can prepare again.
      if (this.now() - Date.parse(c.sentAt ?? c.at) > UNCONFIRMED_GIVEUP_MS) c.state = 'failed'
    } else {
      const fin = (await this.l1.getBlock({ blockTag: 'finalized' })).number
      const ran = fin < BigInt(c.fromBlock) ? null : await this.findExecution(c.safe, c.safeTxHash, BigInt(c.fromBlock), fin)
      if (ran && !ran.success) c.state = 'failed'
      else if (ran?.success) {
        // Executed, yet SmartSession does not list the session (removed since, or a read behind): never stuck silently.
        logErr(`[alert] bridge-out sibling ${accountKey.slice(0, 8)}: ${c.safe}'s enable executed (${ran.tx}) but the V4 session is not listed`, undefined)
        c.state = 'unconfirmed'
      } else if (!ran) {
        const code = fin < BigInt(c.fromBlock) ? '0x' : await this.l1.getCode({ address: c.safe, blockNumber: fin })
        const nonceFin = !code || code === '0x' ? null : ((await this.l1.readContract({ address: c.safe, abi: safeNonceAbi, functionName: 'nonce', blockNumber: fin })) as bigint)
        if (nonceFin !== null && nonceFin > BigInt(c.safeNonce)) c.state = 'failed' // taken by another tx: this one can never run
        else {
          let receipt: TransactionReceipt | null = null
          if (c.l1Tx) {
            try {
              receipt = await this.l1.getTransactionReceipt({ hash: c.l1Tx })
            } catch (e) {
              if (!(e instanceof TransactionReceiptNotFoundError)) throw e // a provider error: decide nothing this pass
            }
          }
          if (receipt?.status === 'success') await this.settleSibling(c, receipt)
          // Dropped or reverted alike, a resend waits UNCONFIRMED_GIVEUP_MS from the last send: never a burst. A tx still
          // pending in the mempool (stuck under its max fee) is never resent beside itself (review r2 of #227).
          else if (this.now() - Date.parse(c.sentAt ?? c.at) > UNCONFIRMED_GIVEUP_MS && !(receipt === null && (await this.pending(c.l1Tx)))) await this.resendSibling(accountKey, c)
          else if (c.state === 'sending') c.state = 'unconfirmed'
        }
      }
    }
    if (c.state !== before) this.writeSibling(accountKey, c)
  }

  /** Whether `hash` is known to the provider but not mined (pending). A provider error counts as pending: no resend. */
  private async pending(hash: Hex): Promise<boolean> {
    try {
      await this.l1.getTransaction({ hash })
      return true
    } catch (e) {
      return !(e instanceof TransactionNotFoundError)
    }
  }

  /**
   * The same signed enable again, after a dropped or reverted send; bounded, then alerted (the row stays unconfirmed).
   * Security review of #227: only when nothing else is being sent; the Safe simulates it first and its gas stays under
   * SIBLING_ENABLE_GAS (else alerted, never sent); the resend counter and the clock move only once a hash exists, so a
   * refusal before the send (gas price, budget, simulation) consumes nothing and is tried again on a later tick.
   */
  private async resendSibling(accountKey: string, c: StoredSibling): Promise<void> {
    c.state = 'unconfirmed'
    if (!c.execData || (c.resends ?? 0) >= SIBLING_RESENDS) {
      logErr(`[alert] bridge-out sibling ${accountKey.slice(0, 8)}: the enable of ${c.safe} did not land after ${c.resends ?? 0} resends; the account stays blocked until ops looks`, undefined)
      return
    }
    if (this.inFlight || this.bundling.size > 0) return
    const data = c.execData
    const seen = { l1Tx: c.l1Tx, sentAt: c.sentAt }
    await this.exclusive(async () => {
      // Overlapping ticks (review r3 of #227): another resend may have gone out meanwhile: then this one is not sent.
      const now = this.journal.siblings?.[accountKey]
      if (!now || now.id !== c.id || now.l1Tx !== seen.l1Tx || now.sentAt !== seen.sentAt) return
      await this.simulate(c.safe, data)
      const est = await this.l1.estimateGas({ account: this.relayer.address, to: c.safe, data })
      const gas = (est * 13n) / 10n
      if (gas > SIBLING_ENABLE_GAS) {
        logErr(`[alert] bridge-out sibling ${accountKey.slice(0, 8)}: the resend of ${c.safe}'s enable would take ${est} gas: not sent`, undefined)
        return
      }
      let counted = false
      const started = (h: Hex) => {
        c.l1Tx = h
        if (!counted) {
          counted = true
          c.resends = (c.resends ?? 0) + 1
          c.sentAt = new Date(this.now()).toISOString()
        }
        this.writeSibling(accountKey, c)
      }
      const r = await this.charged({ to: c.safe, data, gas }, started, started)
      await this.settleSibling(c, r.receipt)
    }).catch((e) => logErr(`[bridge-out] sibling resend ${accountKey.slice(0, 8)}:`, e))
  }

  /**
   * A new enable becomes the account's row: only a submit does this, under the lock, after siblingBlocking said no live
   * row exists (none, or a 'failed' one). The old row's signed ids carry over (in c.signedIds).
   */
  private installSibling(accountKey: string, c: StoredSibling): void {
    const cur = this.journal.siblings?.[accountKey]
    if (cur && cur.state !== 'failed' && cur.id !== c.id) throw new Error('sibling: a live row is already installed')
    c.at = new Date(this.now()).toISOString()
    this.journal.siblings = { ...(this.journal.siblings ?? {}), [accountKey]: c }
    this.save()
  }

  private writeSibling(accountKey: string, c: StoredSibling): void {
    // Updates of the installed row only: a late write of an older row never replaces a newer one (review r2 of #227).
    const cur = this.journal.siblings?.[accountKey]
    if (cur && cur.id !== c.id) return
    c.at = new Date(this.now()).toISOString()
    this.journal.siblings = { ...(this.journal.siblings ?? {}), [accountKey]: c }
    this.save()
  }

  /**
   * The Safe's ExecutionSuccess / ExecutionFailure for `safeTxHash` from `from` on, in provider-sized chunks over
   * LOG_WINDOW_BLOCKS (the signed swap's deadline is CONVERT_DEADLINE_SEC, ~75 blocks: it cannot run later). The hash
   * is read from the indexed topic or, for a Safe build that does not index it, from the data. Null: not found.
   */
  private async findExecution(safe: Address, safeTxHash: Hex, from: bigint, upTo?: bigint): Promise<{ tx: Hex; success: boolean } | null> {
    const head = upTo ?? (await this.l1.getBlockNumber({ cacheTime: 0 }))
    const end = head < from + LOG_WINDOW_BLOCKS ? head : from + LOG_WINDOW_BLOCKS
    const want = safeTxHash.toLowerCase()
    for (let lo = from; lo <= end; lo += LOG_CHUNK_BLOCKS) {
      const hi = lo + LOG_CHUNK_BLOCKS - 1n < end ? lo + LOG_CHUNK_BLOCKS - 1n : end
      const logs = await this.l1.getLogs({ address: safe, fromBlock: lo, toBlock: hi })
      for (const l of logs) {
        const t0 = l.topics[0]
        if (t0 !== EXECUTION_SUCCESS_TOPIC && t0 !== EXECUTION_FAILURE_TOPIC) continue
        const h = (l.topics[1] ?? `0x${l.data.slice(2, 66)}`).toLowerCase()
        if (h === want && l.transactionHash) return { tx: l.transactionHash, success: t0 === EXECUTION_SUCCESS_TOPIC }
      }
    }
    return null
  }

  /** Whether block `at` is past the deadline of a swap sent in block `sent` (signed at most PREPARE_TTL_MS before). */
  private async pastDeadline(at: bigint, sent: bigint): Promise<boolean> {
    const [a, b] = await Promise.all([this.l1.getBlock({ blockNumber: at }), this.l1.getBlock({ blockNumber: sent })])
    return a.timestamp > b.timestamp + BigInt(CONVERT_DEADLINE_SEC) + BigInt(Math.ceil(PREPARE_TTL_MS / 1000))
  }

  /** The account's last conversion, resolved from the chain when it is not proven yet. */
  private async convertStatus(accountKey: string): Promise<EthConvert | null> {
    const c = this.journal.converts?.[accountKey]
    if (!c) return null
    if (c.state !== 'sending' && c.state !== 'unconfirmed') return convertView(c)
    if (this.inFlight || (c.state === 'sending' && this.now() - Date.parse(c.at) < SENDING_STALE_MS)) return convertView(c)
    const next: StoredConvert = { ...c }
    try {
      const receipt = next.l1Tx ? await this.l1.getTransactionReceipt({ hash: next.l1Tx }).catch(() => null) : null
      if (receipt) this.settleConvert(next, receipt)
      else if (!next.execStarted) next.state = 'failed'
      else if (this.now() - Date.parse(c.at) >= UNCONFIRMED_GIVEUP_MS) {
        // No receipt to read after the wait. Signed Safe nonce still unspent: it did not run, and any later
        // transaction of the account signs that same nonce, so at most one of them ever runs: failed. Nonce spent:
        // the Safe's own ExecutionSuccess/ExecutionFailure for the signed safeTxHash says whether this one ran; neither
        // means another transaction took the nonce and this one can never run: failed. Unknown stays unconfirmed.
        // otto/mamoru#285: a terminal answer is read at Ethereum's finalized block, nonce and logs alike. Through
        // several providers, a recent block number can be a node behind or another fork; the finalized block is the
        // same block for every honest node, so "spent and not found" and "unspent past the deadline" are both final.
        // Until finality covers the send (about 13 minutes) the conversion stays unconfirmed.
        const head = (await this.l1.getBlock({ blockTag: 'finalized' })).number
        const signed = BigInt(next.safeNonce)
        const ran = head < BigInt(next.fromBlock) ? null : await this.findExecution(next.safe, next.safeTxHash, BigInt(next.fromBlock), head)
        if (ran?.success) {
          const receipt = await this.l1.getTransactionReceipt({ hash: ran.tx })
          next.l1Tx = ran.tx
          this.settleConvert(next, receipt)
        } else if (ran) {
          next.l1Tx = ran.tx
          next.state = 'failed'
        } else if (head >= BigInt(next.fromBlock)) {
          // No execution of the signed hash up to `head`. Failed only on proof at that block: a nonce above the signed
          // one (another transaction took it, this one can never run), or the signed nonce still unspent once `head` is
          // past the swap's deadline (set at the prepare, at most PREPARE_TTL_MS before the send block). An empty code
          // or a lower nonce proves nothing (a node behind): unconfirmed, looked at again.
          const code = await this.l1.getCode({ address: next.safe, blockNumber: head })
          const nonce = !code || code === '0x' ? null : await this.l1.readContract({ address: next.safe, abi: safeNonceAbi, functionName: 'nonce', blockNumber: head })
          if (nonce !== null && nonce > signed) next.state = 'failed'
          else if ((nonce === signed || (nonce === null && signed === 0n)) && (await this.pastDeadline(head, BigInt(next.fromBlock)))) next.state = 'failed'
          else next.state = 'unconfirmed'
        } else next.state = 'unconfirmed'
      } else if (next.state === 'sending') next.state = 'unconfirmed'
    } catch (e) {
      logErr(`[bridge-out] convert status ${accountKey.slice(0, 8)}:`, e)
      return convertView(c)
    }
    if (next.state !== c.state || next.usdcOut !== c.usdcOut) this.writeConvert(accountKey, next)
    return convertView(this.journal.converts?.[accountKey])
  }

  /**
   * #180: brings every CCTP move still waiting on Base up to date, so the mint does not wait for the owner to open
   * the app. The operator calls it on a timer; each account is throttled like status().
   */
  async tick(): Promise<void> {
    await this.settleReservations().catch((e) => logErr('[bridge-out] tick reservations:', e instanceof Error ? e.message : e))
    for (const accountKey of Object.keys(this.journal.siblings ?? {})) await this.reconcileSibling(accountKey).catch((e) => logErr('[bridge-out] tick sibling:', e instanceof Error ? e.message : e))
    for (const [accountKey, r] of Object.entries(this.journal.routes)) {
      // Every unfinished CCTP move, so a burn left 'sending' or 'unconfirmed' by a crash is reconciled and minted too.
      // otto/mamoru#212: and every unfinished Across move, so a fill nobody polls for stops counting as in flight (the
      // cap would count it twice, in flight and in the Safe). Each account is throttled as status() is.
      if (NON_TERMINAL.has(r.state)) await this.refresh(accountKey).catch((e) => logErr('[bridge-out] tick:', e instanceof Error ? e.message : e))
    }
  }

  /**
   * otto/mamoru#212: USDC of this account's move from Ethereum still on its way to Base (sending, held by the bridge, or
   * its outcome unknown), counted in the account's cap. Not an expired move: that one goes back to Ethereum.
   */
  inFlightUsdc(accountKey: string): bigint {
    const r = this.journal.routes[accountKey]
    if (!r || !(r.state === 'sending' || r.state === 'deposited' || r.state === 'unconfirmed')) return 0n
    const v = r.outputUsdc || r.amountUsdc
    return /^[0-9]+$/.test(v) ? BigInt(v) : 0n
  }

  /** CCTP moves not finished on Base (burned or possibly burned, not minted). */
  pendingCctp(): number {
    return Object.values(this.journal.routes).filter((r) => r.bridge === 'cctp' && NON_TERMINAL.has(r.state)).length
  }

  private async refresh(accountKey: string): Promise<BridgeOutView> {
    const ctx = { accountKey }
    const enabled = this.enabledFor(ctx.accountKey)
    const route = this.journal.routes[ctx.accountKey]
    if (!route || !NON_TERMINAL.has(route.state)) return view(route, enabled)
    // The move this process is sending: its own code writes it; a refresh from a stale copy could undo those writes.
    if (this.sending && this.sending.route.id === route.id) return view(route, enabled)
    if (route.state === 'sending' && this.now() - Date.parse(route.at) < SENDING_STALE_MS) return view(route, enabled)
    const last = this.statusAt.get(ctx.accountKey) ?? 0
    if (this.now() - last < STATUS_CACHE_MS) return view(route, enabled)
    this.statusAt.set(ctx.accountKey, this.now())
    const next: Stored = { ...route }
    try {
      if ((next.state === 'sending' || next.state === 'unconfirmed') && next.userOpHash) {
        await this.resolveUserOp(next, null)
        // A stale 'sending' (stopped mid-send) may or may not have reached the bundler: unknown, not failed, and it
        // stops blocking after UNCONFIRMED_GIVEUP_MS (same EntryPoint nonce: at most one of two userOps runs).
        if (next.state === 'sending') next.state = 'unconfirmed'
      }
      else if (next.state === 'sending' || next.state === 'unconfirmed') await this.reconcile(next)
      if (next.bridge === 'cctp' && next.state === 'deposited') await this.cctpMint(ctx.accountKey, next)
      else if ((next.state === 'deposited' || next.state === 'expired') && next.depositId) await this.across(next)
    } catch (e) {
      // Unknown is not failed: the route stays as it was and is asked again later.
      logErr(`[bridge-out] status ${ctx.accountKey.slice(0, 8)}:`, e)
      return view(route, enabled)
    }
    if (next.state !== route.state || next.depositId !== route.depositId || next.fillTx !== route.fillTx || next.l1Tx !== route.l1Tx || next.mintTx !== route.mintTx) this.write(ctx.accountKey, next)
    return view(this.journal.routes[ctx.accountKey], enabled)
  }

  /** A move whose owner transaction may or may not have run: the Safe nonce and the SpokePool's events decide. */
  private async reconcile(r: Stored): Promise<void> {
    const { deployed, nonce } = await readSafeNonce(this.l1, r.safe)
    if (deployed && nonce > BigInt(r.safeNonce)) {
      const matches = (a: { depositor?: Hex; recipient?: Hex; inputAmount?: bigint; outputAmount?: bigint; destinationChainId?: bigint }) =>
        a.depositor?.toLowerCase() === word(r.safe) &&
        a.recipient?.toLowerCase() === word(r.safe) &&
        a.inputAmount === BigInt(r.amountUsdc) &&
        a.outputAmount === BigInt(r.outputUsdc) &&
        a.destinationChainId === BigInt(BASE_CHAIN_ID)
      // The usual case: the provider took the transaction and returned its hash, the wait for the receipt failed.
      if (r.l1Tx) {
        const receipt = await this.l1.getTransactionReceipt({ hash: r.l1Tx }).catch(() => null)
        if (receipt) {
          const evs = parseEventLogs({ abi: spokePoolAbi, eventName: 'FundsDeposited', logs: receipt.logs.filter((l) => getAddress(l.address) === ACROSS_SPOKE_POOL) }).filter((e) => matches(e.args))
          if (receipt.status === 'success' && evs.length === 1) {
            r.depositId = evs[0]!.args.depositId.toString()
            r.state = 'deposited'
            return
          }
        }
      }
      // No hash (the send threw after it may have broadcast): the SpokePool's events from the account decide.
      const head = await this.l1.getBlockNumber({ cacheTime: 0 })
      const from = BigInt(r.fromBlock)
      const end = head < from + LOG_WINDOW_BLOCKS ? head : from + LOG_WINDOW_BLOCKS
      // An older owner transaction with the same Safe nonce may be the one that ran (signed on another quote): the
      // output amount is not compared here, only who, to whom, how much in and where.
      type DepositLog = Awaited<ReturnType<typeof this.depositLogs>>[number]
      let mine: DepositLog[] = []
      for (let lo = from; lo <= end && mine.length === 0; lo += LOG_CHUNK_BLOCKS) {
        const hi = lo + LOG_CHUNK_BLOCKS - 1n < end ? lo + LOG_CHUNK_BLOCKS - 1n : end
        mine = (await this.depositLogs(r.safe, lo, hi)).filter(
          (l) => l.args.depositor?.toLowerCase() === word(r.safe) && l.args.recipient?.toLowerCase() === word(r.safe) && l.args.inputAmount === BigInt(r.amountUsdc) && l.args.destinationChainId === BigInt(BASE_CHAIN_ID),
        )
      }
      if (mine.length === 1) {
        r.depositId = mine[0]!.args.depositId!.toString()
        r.l1Tx = mine[0]!.transactionHash
        r.state = 'deposited'
      }
      // The nonce moved without a matching deposit: left 'unconfirmed' for a person to look at, never called failed.
      else logErr(`[bridge-out] reconcile ${r.safe.slice(0, 10)}: nonce moved, ${mine.length} matching deposit event(s)`, `blocks ${from}..${end}`)
      return
    }
    // Not executed yet. No node can prove a broadcast transaction will never land, so this is never called failed: the
    // route stays 'unconfirmed' and is checked again. After UNCONFIRMED_GIVEUP_MS it stops blocking a new move (see
    // blocking()): the new owner transaction uses the same Safe nonce, so at most one of the two can ever run, and both
    // deposit to the account itself.
  }

  /** FundsDeposited events whose depositor is the account, in one provider-sized range. */
  private depositLogs(safe: Address, fromBlock: bigint, toBlock: bigint) {
    return this.l1.getLogs({ address: ACROSS_SPOKE_POOL, event: spokePoolAbi[1], args: { depositor: pad(safe.toLowerCase() as Address, { size: 32 }) }, fromBlock, toBlock })
  }

  private readonly minting = new Set<string>()

  /**
   * CCTP, after the burn: Circle's attestation, then receiveMessage on Base by the operator. Gas is paid only for an
   * attested message that is this account's burn (mintIsFor). A nonce already used on Base (anyone may mint: open
   * caller) is filled without a transaction of ours. The mint transaction's hash is on disk before it is sent.
   */
  private async cctpMint(accountKey: string, r: Stored): Promise<void> {
    if (!this.base || !r.l1Tx || this.minting.has(accountKey)) return
    this.minting.add(accountKey)
    try {
      const base = this.base
      if (r.mintTx) {
        const rc = await base.client.getTransactionReceipt({ hash: r.mintTx }).catch(() => null)
        if (rc?.status === 'success') {
          if (r.cctp?.nonce) this.completed(accountKey, r.cctp.nonce)
          r.state = 'filled'
          r.fillTx = r.mintTx
          return
        }
        // No receipt yet: pending, unless it was signed and never broadcast (a crash or a refused send). After
        // MINT_PENDING_MS the attempt below runs again: the used-nonce check stops it if the first one landed, and if
        // the first lands later, the second reverts (nonce used): the message mints once.
        if (!rc && this.now() - Date.parse(r.mintAt ?? r.at) < MINT_PENDING_MS) return
        // Reverted or lost: someone else may have minted first; otherwise try again below.
        r.mintTx = undefined
      }
      const atts = await cctpAttestation(r.l1Tx, this.fetcher)
      if (!atts) return
      // Only a complete attestation whose message is this route's burn: this account, this amount, Ethereum to Base.
      // ... and exactly the message the burn emitted (only Circle's fields may differ). A route without that key (none
      // is created without it: resolveUserOp sets it with the burn) is never minted.
      const key = r.cctp?.message
      if (!key) return
      const att = atts.find((a) => {
        try {
          return mintIsFor(decodeCctpMessage(a.message), L1_USDC, r.safe, BigInt(r.amountUsdc)) && cctpMessageKey(a.message) === key
        } catch {
          return false
        }
      })
      if (!att) {
        if (atts.length > 0) logErr(`[bridge-out] ${r.safe.slice(0, 10)}:`, `no attested message is this burn (${atts.length} complete)`)
        return
      }
      const msg = decodeCctpMessage(att.message)
      // Iris is not trusted: the attestation must be Circle's (signers enabled on Base, threshold met) before its
      // nonce means anything, and nonce zero is never a transfer (MessageTransmitterV2 marks it used at init).
      if (BigInt(msg.nonce) === 0n || !(await attestationValid(base.client, att.message, att.attestation))) {
        logErr(`[bridge-out] ${r.safe.slice(0, 10)}:`, 'attestation not signed by the attesters enabled on Base, ignored')
        return
      }
      // ... and not the attestation of an earlier move of this account (its burns differ by the maxFee tag; this is
      // the second lock): a nonce this account already completed never completes another route.
      const done = this.journal.cctpNonces?.[accountKey] ?? []
      if (done.includes(msg.nonce.toLowerCase())) {
        logErr(`[bridge-out] ${r.safe.slice(0, 10)}:`, 'attestation of an earlier move of this account, ignored')
        return
      }
      // A used nonce of an authenticated message of this burn: the transfer was minted to this Safe (anyone may
      // submit it; the message fixes the recipient and amount).
      const used = await base.client.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'usedNonces', args: [msg.nonce] })
      if (used !== 0n) {
        this.completed(accountKey, msg.nonce)
        r.state = 'filled'
        return
      }
      const price = await base.client.getGasPrice()
      if (price > MAX_BASE_GAS_PRICE_WEI) {
        logErr(`[bridge-out] ${r.safe.slice(0, 10)}:`, 'Base gas above the mint ceiling, minting later')
        return
      }
      // The mint budget of the day the mint is admitted on, all accounts. Every charge of this mint (the estimate,
      // the relayer's signed bound before the broadcast, the receipt's cost after) goes to that same day's record,
      // and the cap is checked against it before the broadcast, even if the send waited past midnight.
      const day = this.day()
      const m = this.mintDay(day)
      // A first estimate for the admission; the relayer's own bound (gas at its signed maxFeePerGas plus twice the
      // L1 data fee) replaces it before the broadcast, and the receipt's real cost (L1 data fee included) after.
      const estimate = MINT_GAS * price * 2n
      if (m.n >= MINTS_PER_DAY || BigInt(m.wei) + estimate > MINT_BUDGET_WEI) {
        logErr(`[bridge-out] ${r.safe.slice(0, 10)}:`, 'Base mint budget for today used up, minting tomorrow')
        return
      }
      let charged = 0n
      const charge = (wei: bigint, dn = 0) => {
        const cur = this.mintDay(day)
        const next = BigInt(cur.wei) - charged + wei
        this.setMintDay(day, { n: cur.n + dn, wei: next > 0n ? next : 0n })
        charged = wei
      }
      charge(estimate, 1)
      let broadcast = false
      let sent: { hash: Hex; receipt: TransactionReceipt }
      try {
        sent = await base.relayer.send(
          { to: MESSAGE_TRANSMITTER_V2, data: receiveMessageData(att.message, att.attestation), gas: MINT_GAS },
          undefined,
          (maxFeeWei, { maxFeePerGas }) => {
            // The relayer's real bound, before anything is broadcast: over the admission day's cap, or signed above the
            // Base gas ceiling, it stops here.
            charge(maxFeeWei)
            if (BigInt(this.mintDay(day).wei) > MINT_BUDGET_WEI) throw new MintBudget('Base mint budget for today used up, minting tomorrow')
            if (maxFeePerGas > MAX_BASE_GAS_PRICE_WEI) throw new MintBudget('Base gas above the mint ceiling, minting later')
          },
          (h) => {
            // The mint's hash (and the nonce it mints) is on disk before the broadcast.
            broadcast = true
            r.cctp = { ...r.cctp!, nonce: msg.nonce }
            r.mintTx = h
            r.mintAt = new Date(this.now()).toISOString()
            this.write(accountKey, { ...r })
          },
        )
      } catch (e) {
        // Nothing was signed for broadcast: the day gets its count and charge back.
        if (!broadcast) charge(0n, -1)
        if (e instanceof MintBudget) {
          logErr(`[bridge-out] ${r.safe.slice(0, 10)}:`, e.message)
          return
        }
        throw e
      }
      // The receipt's cost, L1 data fee included; a receipt without l1Fee keeps the bound charged.
      // viem's default receipt formatter (the relayer's client has no OP-stack chain) leaves l1Fee as the node's hex
      // string: parsed here, never added to a bigint as a string (that zeroed the day's ledger). Unparseable: bound kept.
      const rawL1Fee = (sent.receipt as { l1Fee?: unknown }).l1Fee
      const l1Fee = typeof rawL1Fee === 'bigint' ? rawL1Fee : typeof rawL1Fee === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(rawL1Fee) ? BigInt(rawL1Fee) : null
      if (l1Fee !== null && l1Fee >= 0n) charge(sent.receipt.gasUsed * sent.receipt.effectiveGasPrice + l1Fee)
      r.mintTx = sent.hash
      if (sent.receipt.status === 'success') {
        this.completed(accountKey, msg.nonce)
        r.state = 'filled'
        r.fillTx = sent.hash
      }
    } finally {
      this.minting.delete(accountKey)
    }
  }

  private mintDay(day: string): { n: number; wei: string } {
    return this.journal.mintDays?.[day] ?? { n: 0, wei: '0' }
  }

  /** One day's mint record; days older than the last three are dropped. */
  private setMintDay(day: string, v: { n: number; wei: bigint }): void {
    const days = { ...(this.journal.mintDays ?? {}), [day]: { n: Math.max(0, v.n), wei: v.wei.toString() } }
    for (const d of Object.keys(days).sort().slice(0, -3)) delete days[d]
    this.journal.mintDays = days
    this.save()
  }

  /** The CCTP nonces this account's moves completed, kept for good. */
  private completed(accountKey: string, nonce: Hex): void {
    const all = this.journal.cctpNonces ?? {}
    all[accountKey] = [...(all[accountKey] ?? []), nonce.toLowerCase()]
    this.journal.cctpNonces = all
    this.save()
  }

  /** Across's answer for a deposit: filled on Base, expired (refund pending) or refunded to the account on Ethereum. */
  private async across(r: Stored): Promise<void> {
    const res = await this.fetcher(`${ACROSS_API}/deposit/status?originChainId=${ETHEREUM_CHAIN_ID}&depositId=${r.depositId}`, {
      headers: this.acrossKey ? { authorization: `Bearer ${this.acrossKey}` } : {},
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    })
    if (!res.ok) return
    const s = (await res.json()) as { status?: string; fillTx?: string }
    if (s.status === 'filled') {
      r.state = 'filled'
      if (typeof s.fillTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s.fillTx)) r.fillTx = s.fillTx as Hex
    } else if (s.status === 'expired') {
      r.state = 'expired'
    } else if (s.status === 'refunded') {
      r.state = 'refunded'
    }
  }
}
