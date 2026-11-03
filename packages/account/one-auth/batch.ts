// otto/mamoru#348 (spec 010 A1): the ONE builder of a MamoruActionPolicyV4 session batch, and its validator.
//
// Every userOp of a V4 session passes MamoruGasPolicyV2's batch-shape check (`_shape`, contracts/action-policy/src/
// MamoruGasPolicyV2.sol) and V4's `checkAction` on each call. Verified in the Solidity:
//  1. `execute(mode, batch)` with mode = batch call type, default exec type, no selector or payload (never single mode);
//  2. at least two calls; the first is `clock(T)` with no value and exactly 36 bytes, CLOCK_SLACK < T <= 2^48-1 - CLOCK_SLACK
//     (the gas policy returns validAfter = T - S, validUntil = T + S; V4.clock reverts at execution unless |now - T| <= S);
//  3. every `decreaseLiquidity` on the chain's position manager is IMMEDIATELY preceded by
//     `checkExit(tokenId, liquidity, amount0Min, amount1Min)` with the decrease's own four first arguments;
//  4. every non-zero `approve(spender, x)` is followed LATER by `approve(spender, 0)` on the same token, itself
//     IMMEDIATELY followed by `assertZero(token)`;
// and, per call, V4's checkAction (static part; admission and generation are V4's storage): `deposit()` with value on
// the wrapped native and `withdraw(x)` without; no value anywhere else; on V4 only swap, mint, increase, deposit, redeem,
// bridge, registerRemote, clock, checkExit, assertZero, announceReady; on the position manager only decrease, collect
// (recipient the account) and burn; on the CCTP MessageTransmitterV2 only receiveMessage; elsewhere only approve(V4, x).
//
// `buildA1Batch` produces that shape by construction from intents and throws on an intent V4 would refuse whatever the
// chain state (a zero amount, a recipient other than the account, a maxFee over the chain's CCTP cap, a domain outside
// the table, an expired deadline). `a1Shape` is `_shape` line for line; `checkA1Batch` adds checkAction's static rules.
// contracts/action-policy/test/A1BatchParity.t.sol runs the batches of `a1-batch-fixture.ts` through the real gas policy.
import { decodeAbiParameters, encodeFunctionData, getAddress, hexToBigInt, isAddressEqual, keccak256, parseAbi, size, slice, toFunctionSelector, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { CALLTYPE_BATCH, EXECTYPE_DEFAULT, encodeBatchExecution, encodeMode, type Execution } from '../safe/index.ts'

// ---- the chain table (MamoruV4Chains.byChainId, the fields a batch depends on) ---------------------------------------

export type A1ChainTargets = {
  domain: number
  npm: Address
  wrapped: Address
  stables: readonly Address[]
  cctpFeeCapBps: number
}

/** MamoruV4Chains, field for field where a batch depends on it (a unit test checks it against the registry files). */
export const A1_CHAINS: Readonly<Record<number, A1ChainTargets>> = {
  8453: {
    domain: 6,
    npm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    wrapped: '0x4200000000000000000000000000000000000006',
    stables: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'],
    cctpFeeCapBps: 10,
  },
  143: {
    domain: 15,
    npm: '0x7197E214c0b767cFB76Fb734ab638E2c192F4E53',
    wrapped: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    stables: ['0x754704Bc059F8C67012fEd69BC8A327a5aafb603'],
    cctpFeeCapBps: 10,
  },
  1: {
    domain: 0,
    npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    wrapped: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    stables: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
    cctpFeeCapBps: 10,
  },
}

/** MamoruActionPolicyV4.MESSAGE_TRANSMITTER (CCTP V2, the same proxy on every chain). */
export const A1_MESSAGE_TRANSMITTER: Address = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'
/** MamoruGasPolicyV2.CLOCK_SLACK = MamoruActionPolicyV4.CLOCK_SLACK (S, seconds). */
export const A1_CLOCK_SLACK = 300n

/**
 * The last second an op claiming time `t` can be included: the gas policy returns validUntil = T + S, and the
 * EntryPoint v0.7 refuses an op once block.timestamp > validUntil (and while block.timestamp <= validAfter = T - S).
 * Every V4 op is dead after it, whatever its deadline: the engine settles a dropped one from there (`expiresAt`).
 */
export function a1ExpiresAt(t: bigint): bigint {
  return t + A1_CLOCK_SLACK
}
/** MamoruActionPolicyV4.MAX_RATIO_BPS (the bps denominator of cctpFeeCapBps). */
const BPS = 10_000n
const UINT48_MAX = (1n << 48n) - 1n

// ---- ABIs and selectors ----------------------------------------------------------------------------------------

/** The V4 functions a session batch calls (MamoruActionPolicyV4.sol), and the calls around them. */
export const a1Abi = parseAbi([
  'struct SwapParams { address pool; address tokenIn; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; uint256 deadline; }',
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function clock(uint256 t)',
  'function checkExit(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min)',
  'function assertZero(address token)',
  'function swap(SwapParams s) returns (uint256 amountOut)',
  'function mint(MintParams m) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increase(IncreaseLiquidityParams n) returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function deposit(address vault, uint256 assets) returns (uint256 shares)',
  'function redeem(address vault, uint256 shares) returns (uint256 assets)',
  'function bridge(uint32 domain, address token, uint256 amount, uint256 maxFee)',
  'function registerRemote(uint32 domain, address sessionKey) returns (address remote)',
  'function announceReady(address safe, uint32 toDomain, address sessionKey, bytes32 permissionId)',
  'function decreaseLiquidity(DecreaseLiquidityParams params) returns (uint256 amount0, uint256 amount1)',
  'function collect(CollectParams params) returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function deposit()',
  'function withdraw(uint256 wad)',
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
])

const sel = (sig: string) => toFunctionSelector(sig).toLowerCase() as Hex
const EXECUTE = sel('function execute(bytes32,bytes)') // 0xe9ae5c53
const MODE_BATCH = encodeMode(CALLTYPE_BATCH, EXECTYPE_DEFAULT).toLowerCase()
const CLOCK = sel('function clock(uint256)')
const CHECK_EXIT = sel('function checkExit(uint256,uint128,uint256,uint256)')
const ASSERT_ZERO = sel('function assertZero(address)')
const APPROVE = '0x095ea7b3'
const DECREASE = '0x0c49ccbe'
const COLLECT = '0xfc6f7865'
const BURN = '0x42966c68'
const WRAP = '0xd0e30db0'
const UNWRAP = '0x2e1a7d4d'
const RECEIVE_MESSAGE = '0x57ecfd28'
/** checkAction: the V4 functions a session may call. */
const V4_SESSION_FUNCTIONS = new Set(
  [
    'function swap((address,address,uint256,uint256,uint160,uint256))',
    'function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
    'function increase((uint256,uint256,uint256,uint256,uint256,uint256))',
    'function deposit(address,uint256)',
    'function redeem(address,uint256)',
    'function bridge(uint32,address,uint256,uint256)',
    'function registerRemote(uint32,address)',
    'function clock(uint256)',
    'function checkExit(uint256,uint128,uint256,uint256)',
    'function assertZero(address)',
    'function announceReady(address,uint32,address,bytes32)',
  ].map(sel),
)

// ---- intents ---------------------------------------------------------------------------------------------------

export type A1SwapParams = { pool: Address; tokenIn: Address; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint; deadline: bigint }
export type A1MintParams = { token0: Address; token1: Address; fee: number; tickLower: number; tickUpper: number; amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint; recipient: Address; deadline: bigint }
export type A1IncreaseParams = { tokenId: bigint; amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint }

/**
 * What the account does in one V4 session userOp. Every value-moving intent that V4 pulls from the account gets its
 * exact approval of V4 before it, and the approval's reset and `assertZero` after it, from the builder.
 */
export type A1Intent =
  /** V4.swap: approve(tokenIn, amountIn) first. */
  | { kind: 'swap'; params: A1SwapParams }
  /** V4.mint (recipient the account): approvals of both tokens for the desired amounts. */
  | { kind: 'mint'; params: A1MintParams }
  /** V4.increase on a held, admitted position: the pool's two tokens (V4 pulls them) and the params. */
  | { kind: 'increase'; token0: Address; token1: Address; params: A1IncreaseParams }
  /**
   * An exit: `checkExit` then the position manager's decreaseLiquidity (same tokenId, liquidity and minimums), then
   * `collect` to the account unless `collect === false`, then `burn` when asked. A burn needs the collect and the whole
   * position out: `positionLiquidity` (the position's liquidity as read) must equal `liquidity`.
   */
  | { kind: 'decrease'; tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint; collect?: boolean; burn?: boolean; positionLiquidity?: bigint }
  /** The position manager's collect of everything owed, to the account (a harvest). */
  | { kind: 'collect'; tokenId: bigint }
  /** The position manager's burn of a position with no liquidity left, after its `collect` in the same batch. */
  | { kind: 'burn'; tokenId: bigint }
  /** V4.deposit into a vault of the table: approve(asset, assets) first. */
  | { kind: 'deposit'; vault: Address; asset: Address; assets: bigint }
  /** V4.redeem: V4 pulls the shares, so approve(vault, shares) first. */
  | { kind: 'redeem'; vault: Address; shares: bigint }
  /** V4.bridge (CCTP Standard) of a pinned stable: approve(token, amount) first. `maxFee` is CCTP's, 0 today. */
  | { kind: 'bridge'; domain: number; token: Address; amount: bigint; maxFee: bigint }
  /** The account wraps `amount` of its native coin (the only call with value). */
  | { kind: 'wrap'; amount: bigint }
  /** The account unwraps `amount` back to itself. */
  | { kind: 'unwrap'; amount: bigint }
  /** V4.registerRemote: the account's remote on `domain` for the remote session's key. */
  | { kind: 'registerRemote'; domain: number; sessionKey: Address }
  /**
   * V4.announceReady (#348, noema-d3): prove `safe` ready to the same V4 on `toDomain` by CCTP. Anyone may call it; as an
   * intent it runs from the account's own session (the account pays the gas).
   */
  | { kind: 'announceReady'; safe: Address; toDomain: number; sessionKey: Address; permissionId: Hex }
  /** MessageTransmitterV2.receiveMessage: the account relays a finalized readiness message to its own V4 (A1). */
  | { kind: 'relayMessage'; message: Hex; attestation: Hex }

export type A1Context = {
  /** The chain the op runs on: a chain of V4's table. */
  chainId: number
  /** The account (the userOp's sender), the only recipient V4 allows. */
  account: Address
  /** MamoruActionPolicyV4 on this chain. */
  policy: Address
  /** The claimed time T of the leading `clock(T)`, seconds: the block time the op is prepared at. */
  t: bigint
}

export class A1BatchError extends Error {
  constructor(message: string) {
    super(`A1 batch: ${message}`)
    this.name = 'A1BatchError'
  }
}

const fail = (m: string): never => {
  throw new A1BatchError(m)
}

export function a1Chain(chainId: number): A1ChainTargets {
  return A1_CHAINS[chainId] ?? fail(`chain ${chainId} is not in V4's table`)
}

/** The chain of a CCTP domain in V4's table (domain 0 is Ethereum, never "none"). */
function chainOfDomain(domain: number): number | undefined {
  for (const [id, c] of Object.entries(A1_CHAINS)) if (c.domain === domain) return Number(id)
  return undefined
}

/**
 * The exact `Execution[]` of one V4 session userOp for `intents`, in order: `clock(T)`, then each intent with its
 * approvals before and their resets plus `assertZero` after. Throws A1BatchError on an intent V4 would refuse.
 */
export function buildA1Batch(ctx: A1Context, intents: readonly A1Intent[]): Execution[] {
  const ch = a1Chain(ctx.chainId)
  if (!intents.length) fail('no intent (an action-free batch is refused)')
  if (ctx.t <= A1_CLOCK_SLACK || ctx.t > UINT48_MAX - A1_CLOCK_SLACK) fail(`claimed time ${ctx.t} out of range`)
  const v4 = getAddress(ctx.policy)
  const account = getAddress(ctx.account)
  const call = (target: Address, data: Hex, value = 0n): Execution => ({ target: getAddress(target), value, callData: data })
  const onV4 = (data: Hex) => call(v4, data)
  const approve = (token: Address, amount: bigint) => call(token, encodeFunctionData({ abi: a1Abi, functionName: 'approve', args: [v4, amount] }))
  const reset = (token: Address) => [approve(token, 0n), onV4(encodeFunctionData({ abi: a1Abi, functionName: 'assertZero', args: [getAddress(token)] }))]
  /** The approvals of `pulls` (zero amounts need none), the action, then each approval's reset and assertZero. */
  const pulled = (pulls: readonly (readonly [Address, bigint])[], action: Execution): Execution[] => {
    const live = pulls.filter(([, a]) => a > 0n)
    return [...live.map(([t, a]) => approve(t, a)), action, ...live.flatMap(([t]) => reset(t))]
  }
  // Review of #247 (P2): the op can be included until T + S; a deadline before that lets it validate (and charge the
  // account and its gas rate) and then revert in V4 with Expired. So a deadline covers the whole window.
  const notExpired = (deadline: bigint, what: string) => {
    if (deadline < a1ExpiresAt(ctx.t)) fail(`${what} deadline ${deadline} ends before the op's window (T + S = ${a1ExpiresAt(ctx.t)})`)
  }
  const xs: Execution[] = [onV4(encodeFunctionData({ abi: a1Abi, functionName: 'clock', args: [ctx.t] }))]
  const collected = new Set<bigint>()
  for (const i of intents) {
    switch (i.kind) {
      case 'swap': {
        const s = i.params
        if (s.amountIn <= 0n) fail('swap of 0 (V4 ZeroAmount)')
        notExpired(s.deadline, 'swap')
        xs.push(...pulled([[s.tokenIn, s.amountIn]], onV4(encodeFunctionData({ abi: a1Abi, functionName: 'swap', args: [{ ...s, pool: getAddress(s.pool), tokenIn: getAddress(s.tokenIn) }] }))))
        break
      }
      case 'mint': {
        const m = i.params
        if (!isAddressEqual(m.recipient, account)) fail(`mint recipient ${m.recipient} is not the account (V4 WrongRecipient)`)
        if (m.amount0Desired <= 0n && m.amount1Desired <= 0n) fail('mint of nothing')
        notExpired(m.deadline, 'mint')
        const data = encodeFunctionData({ abi: a1Abi, functionName: 'mint', args: [{ ...m, token0: getAddress(m.token0), token1: getAddress(m.token1), recipient: account }] })
        xs.push(...pulled([[m.token0, m.amount0Desired], [m.token1, m.amount1Desired]], onV4(data)))
        break
      }
      case 'increase': {
        const n = i.params
        if (n.amount0Desired <= 0n && n.amount1Desired <= 0n) fail('increase of nothing')
        notExpired(n.deadline, 'increase')
        xs.push(...pulled([[i.token0, n.amount0Desired], [i.token1, n.amount1Desired]], onV4(encodeFunctionData({ abi: a1Abi, functionName: 'increase', args: [n] }))))
        break
      }
      case 'decrease': {
        if (i.liquidity <= 0n || i.liquidity >= 1n << 128n) fail(`decrease of liquidity ${i.liquidity}`)
        notExpired(i.deadline, 'decrease')
        // Review of #247 (P2): the manager's burn reverts unless the position is emptied and collected first.
        if (i.burn && (i.collect === false || i.positionLiquidity === undefined || i.positionLiquidity !== i.liquidity)) fail('burn without the collect, or without taking all of the position\'s liquidity out')
        xs.push(onV4(encodeFunctionData({ abi: a1Abi, functionName: 'checkExit', args: [i.tokenId, i.liquidity, i.amount0Min, i.amount1Min] })))
        xs.push(call(ch.npm, encodeFunctionData({ abi: a1Abi, functionName: 'decreaseLiquidity', args: [{ tokenId: i.tokenId, liquidity: i.liquidity, amount0Min: i.amount0Min, amount1Min: i.amount1Min, deadline: i.deadline }] })))
        if (i.collect !== false) {
          collected.add(i.tokenId)
          xs.push(collectCall(ch.npm, account, i.tokenId))
        }
        if (i.burn) xs.push(call(ch.npm, encodeFunctionData({ abi: a1Abi, functionName: 'burn', args: [i.tokenId] })))
        break
      }
      case 'collect':
        collected.add(i.tokenId)
        xs.push(collectCall(ch.npm, account, i.tokenId))
        break
      case 'burn':
        // Review of #247 (P2): a bare burn only of a position with no liquidity, collected earlier in the same batch.
        if (!collected.has(i.tokenId)) fail(`burn of ${i.tokenId} without its collect before it in the batch`)
        xs.push(call(ch.npm, encodeFunctionData({ abi: a1Abi, functionName: 'burn', args: [i.tokenId] })))
        break
      case 'deposit':
        if (i.assets <= 0n) fail('vault deposit of 0 (V4 ZeroAmount)')
        if (!ch.stables.some((s) => isAddressEqual(s, i.asset))) fail(`vault asset ${i.asset} is not a pinned stable`)
        xs.push(...pulled([[i.asset, i.assets]], onV4(encodeFunctionData({ abi: a1Abi, functionName: 'deposit', args: [getAddress(i.vault), i.assets] }))))
        break
      case 'redeem':
        if (i.shares <= 0n) fail('vault redeem of 0 shares (V4 ZeroAmount)')
        xs.push(...pulled([[i.vault, i.shares]], onV4(encodeFunctionData({ abi: a1Abi, functionName: 'redeem', args: [getAddress(i.vault), i.shares] }))))
        break
      case 'bridge': {
        if (i.amount <= 0n) fail('bridge of 0 (V4 ZeroAmount)')
        if (i.maxFee < 0n || i.maxFee > (i.amount * BigInt(ch.cctpFeeCapBps)) / BPS) fail(`bridge maxFee ${i.maxFee} over the chain's cap (${ch.cctpFeeCapBps} bps of ${i.amount}; V4 BadBridge(6))`)
        if (!ch.stables.some((s) => isAddressEqual(s, i.token))) fail(`bridge token ${i.token} is not a pinned stable (V4 NotPinned)`)
        const to = chainOfDomain(i.domain)
        if (to === undefined || to === ctx.chainId) fail(`bridge to domain ${i.domain}: not another chain of V4's table`)
        xs.push(...pulled([[i.token, i.amount]], onV4(encodeFunctionData({ abi: a1Abi, functionName: 'bridge', args: [i.domain, getAddress(i.token), i.amount, i.maxFee] }))))
        break
      }
      case 'wrap':
        if (i.amount <= 0n) fail('wrap of 0 (checkAction refuses a wrap without value)')
        xs.push(call(ch.wrapped, encodeFunctionData({ abi: a1Abi, functionName: 'deposit' }), i.amount))
        break
      case 'unwrap':
        if (i.amount <= 0n) fail('unwrap of 0')
        xs.push(call(ch.wrapped, encodeFunctionData({ abi: a1Abi, functionName: 'withdraw', args: [i.amount] })))
        break
      case 'registerRemote': {
        if (BigInt(i.sessionKey) === 0n) fail('registerRemote without a session key (V4 BadBridge(5))')
        const to = chainOfDomain(i.domain)
        if (to === undefined || to === ctx.chainId) fail(`registerRemote on domain ${i.domain}: not another chain of V4's table`)
        xs.push(onV4(encodeFunctionData({ abi: a1Abi, functionName: 'registerRemote', args: [i.domain, getAddress(i.sessionKey)] })))
        break
      }
      case 'announceReady': {
        const to = chainOfDomain(i.toDomain)
        if (to === undefined || to === ctx.chainId) fail(`announceReady to domain ${i.toDomain}: not another chain of V4's table (V4 BadAnnounce)`)
        if (size(i.permissionId) !== 32) fail('announceReady: permissionId is not 32 bytes')
        xs.push(onV4(encodeFunctionData({ abi: a1Abi, functionName: 'announceReady', args: [getAddress(i.safe), i.toDomain, getAddress(i.sessionKey), i.permissionId] })))
        break
      }
      case 'relayMessage':
        xs.push(call(A1_MESSAGE_TRANSMITTER, encodeFunctionData({ abi: a1Abi, functionName: 'receiveMessage', args: [i.message, i.attestation] })))
        break
      default:
        fail(`unknown intent ${(i as { kind: string }).kind}`)
    }
  }
  // Built by construction; checked anyway, so a builder bug can never reach a signature.
  const r = checkA1Batch(xs, ctx)
  if (!r.ok) fail(`built a batch the policy would refuse: ${r.reason}`)
  return xs
}

function collectCall(npm: Address, account: Address, tokenId: bigint): Execution {
  const max = (1n << 128n) - 1n
  return { target: getAddress(npm), value: 0n, callData: encodeFunctionData({ abi: a1Abi, functionName: 'collect', args: [{ tokenId, recipient: account, amount0Max: max, amount1Max: max }] }) }
}

/** `execute(batch mode, xs)`: the userOp callData of a V4 session batch. Never single mode (the gas policy refuses it). */
export function a1CallData(xs: readonly Execution[]): Hex {
  if (xs.length < 2) fail('a V4 session batch has at least two calls (clock and an action)')
  return encodeFunctionData({
    abi: parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']),
    functionName: 'execute',
    args: [encodeMode(CALLTYPE_BATCH, EXECTYPE_DEFAULT), encodeBatchExecution([...xs])],
  })
}

/** `buildA1Batch` then `a1CallData`. */
export function buildA1CallData(ctx: A1Context, intents: readonly A1Intent[]): { calls: Execution[]; callData: Hex } {
  const calls = buildA1Batch(ctx, intents)
  return { calls, callData: a1CallData(calls) }
}

// ---- the validator -----------------------------------------------------------------------------------------------

export type A1Verdict = { ok: true; t: bigint } | { ok: false; reason: string }

const word = (d: Hex, o: number): Hex => slice(d, o, o + 32).toLowerCase() as Hex
const selOf = (d: Hex): Hex => slice(d, 0, 4).toLowerCase() as Hex

function decodeBatch(callData: Hex): { xs: Execution[] } | { reason: string } {
  if (size(callData) < 68 || selOf(callData) !== EXECUTE) return { reason: 'not execute(bytes32,bytes)' }
  let mode: Hex
  let batch: Hex
  try {
    ;[mode, batch] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], slice(callData, 4))
  } catch {
    return { reason: 'execute arguments do not decode' }
  }
  if (mode.toLowerCase() !== MODE_BATCH) return { reason: `mode ${mode} is not batch/default with no payload` }
  try {
    const [xs] = decodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }], batch)
    return { xs: xs.map((x) => ({ target: x.target, value: x.value, callData: x.callData })) }
  } catch {
    return { reason: 'batch does not decode as Execution[]' }
  }
}

/** The calls of a batch-mode `execute` callData, or null when it is not one (single mode, another exec type, bad bytes). */
export function a1Calls(callData: Hex): Execution[] | null {
  const d = decodeBatch(callData)
  return 'reason' in d ? null : d.xs
}

/**
 * MamoruGasPolicyV2._shape, line for line: the userOp callData (or its decoded batch) against the chain's position
 * manager `npm`. Returns the claimed time of the leading `clock`.
 */
export function a1Shape(batch: Hex | readonly Execution[], npm: Address): A1Verdict {
  let xs: readonly Execution[]
  if (typeof batch === 'string') {
    const d = decodeBatch(batch)
    if ('reason' in d) return { ok: false, reason: d.reason }
    xs = d.xs
  } else xs = batch
  const n = xs.length
  if (n < 2) return { ok: false, reason: 'fewer than two calls (no empty and no action-free batch)' }
  const c0 = xs[0]!
  if (c0.value !== 0n || size(c0.callData) !== 36 || selOf(c0.callData) !== CLOCK) return { ok: false, reason: 'the first call is not clock(T) with no value' }
  const t = hexToBigInt(word(c0.callData, 4))
  if (t <= A1_CLOCK_SLACK || t > UINT48_MAX - A1_CLOCK_SLACK) return { ok: false, reason: `claimed time ${t} out of range` }
  for (let i = 1; i < n; i++) {
    const d = xs[i]!.callData
    if (size(d) < 4) continue // the action policy refuses it
    const s = selOf(d)
    if (s === DECREASE && isAddressEqual(xs[i]!.target, npm)) {
      if (!exitChecked(xs[i - 1]!.callData, d)) return { ok: false, reason: `call ${i}: decreaseLiquidity not immediately preceded by checkExit with its arguments` }
    } else if (s === APPROVE && size(d) === 68 && hexToBigInt(word(d, 36)) !== 0n) {
      if (!resetAfter(xs, i)) return { ok: false, reason: `call ${i}: approve not followed by its reset to 0 and assertZero` }
    }
  }
  return { ok: true, t }
}

function exitChecked(prev: Hex, dec: Hex): boolean {
  if (size(prev) !== 132 || selOf(prev) !== CHECK_EXIT || size(dec) !== 164) return false
  for (let o = 4; o < 132; o += 32) if (word(prev, o) !== word(dec, o)) return false
  return true
}

function resetAfter(xs: readonly Execution[], i: number): boolean {
  const token = xs[i]!.target
  const spender = word(xs[i]!.callData, 4)
  const reset = keccak256(`${APPROVE}${spender.slice(2)}${'0'.repeat(64)}` as Hex)
  const assert0 = keccak256(`${ASSERT_ZERO}${'0'.repeat(24)}${token.slice(2).toLowerCase()}` as Hex)
  for (let j = i + 1; j + 1 < xs.length; j++) {
    if (isAddressEqual(xs[j]!.target, token) && keccak256(xs[j]!.callData) === reset && keccak256(xs[j + 1]!.callData) === assert0) return true
  }
  return false
}

/** An ABI word holding an address (Solidity's abi.decode reverts on dirty upper bits). */
function addressWord(d: Hex, o: number): Address | null {
  const w = word(d, o)
  return /^0x0{24}/.test(w) ? getAddress(`0x${w.slice(26)}`) : null
}

/**
 * MamoruActionPolicyV4.checkAction's static rules for one call (what does not depend on the account's storage: the
 * binding, generation and admission are V4's). Null when V4 would admit the call.
 */
export function a1CallRefusal(c: Execution, ctx: Pick<A1Context, 'chainId' | 'account' | 'policy'>): string | null {
  const ch = A1_CHAINS[ctx.chainId]
  if (!ch) return `chain ${ctx.chainId} is not in V4's table`
  if (size(c.callData) < 4) return 'empty call'
  const s = selOf(c.callData)
  const len = size(c.callData)
  if (isAddressEqual(c.target, ch.wrapped)) {
    if (s === WRAP) return len === 4 && c.value !== 0n ? null : 'wrap without value or with arguments'
    if (s === UNWRAP) return len === 36 && c.value === 0n ? null : 'unwrap with value or bad arguments'
  }
  if (c.value !== 0n) return `native value to ${c.target}`
  if (isAddressEqual(c.target, ctx.policy)) return V4_SESSION_FUNCTIONS.has(s) ? null : `V4 function ${s}`
  if (isAddressEqual(c.target, ch.npm)) {
    if (s === DECREASE) return len >= 164 ? null : 'decreaseLiquidity arguments'
    if (s === BURN) return len >= 36 ? null : 'burn arguments'
    if (s === COLLECT) {
      if (len < 132) return 'collect arguments'
      const to = addressWord(c.callData, 36)
      return to && isAddressEqual(to, ctx.account) ? null : 'collect to someone other than the account'
    }
    return `position manager function ${s}`
  }
  if (isAddressEqual(c.target, A1_MESSAGE_TRANSMITTER)) return s === RECEIVE_MESSAGE ? null : `message transmitter function ${s}`
  if (s === APPROVE && len === 68) {
    const spender = addressWord(c.callData, 4)
    return spender && isAddressEqual(spender, ctx.policy) ? null : 'approval to a spender other than V4'
  }
  return `(${c.target}, ${s}) is not a V4 action`
}

/**
 * Everything the operator can check before signing a V4 session op: the gas policy's shape (`a1Shape`), V4's static
 * checkAction rules on every call, the leading `clock` on V4 itself, and, when `now` is given, the claimed time within
 * CLOCK_SLACK of it (the EntryPoint admits the op only while T - S < now <= T + S).
 */
export function checkA1Batch(batch: Hex | readonly Execution[], ctx: Pick<A1Context, 'chainId' | 'account' | 'policy'> & { now?: bigint }): A1Verdict {
  const ch = A1_CHAINS[ctx.chainId]
  if (!ch) return { ok: false, reason: `chain ${ctx.chainId} is not in V4's table` }
  let xs: readonly Execution[]
  if (typeof batch === 'string') {
    const d = decodeBatch(batch)
    if ('reason' in d) return { ok: false, reason: d.reason }
    xs = d.xs
  } else xs = batch
  const shape = a1Shape(xs, ch.npm)
  if (!shape.ok) return shape
  if (!isAddressEqual(xs[0]!.target, ctx.policy)) return { ok: false, reason: 'clock(T) is not called on V4' }
  for (let i = 0; i < xs.length; i++) {
    if (isAddressEqual(xs[i]!.target, ctx.account)) return { ok: false, reason: `call ${i}: a call to the account itself` }
    const why = a1CallRefusal(xs[i]!, ctx)
    if (why) return { ok: false, reason: `call ${i}: ${why}` }
  }
  // EntryPoint v0.7: valid while validAfter < block.timestamp <= validUntil, i.e. T - S < now <= T + S (validAfter strict).
  if (ctx.now !== undefined && (ctx.now > shape.t + A1_CLOCK_SLACK || ctx.now <= shape.t - A1_CLOCK_SLACK)) return { ok: false, reason: `claimed time ${shape.t} outside (now - ${A1_CLOCK_SLACK}, now + ${A1_CLOCK_SLACK}] for now = ${ctx.now}` }
  return shape
}
