import { getAddress, hexToBigInt, sliceHex, toHex, type Hex } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'
import type { Address } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { toRpcUserOp } from '@mamoru/erc4337'
import type { PaymasterFields } from '@mamoru/account/userop'

// Pluggable ERC-20 paymaster and the L1 bundler for the userOp path of bridge-out (otto/mamoru#180).
//
// The account pays its own Ethereum gas in USDC: the batch the owner signs approves the paymaster for at most the
// gas cap, in USDC, that the owner was shown; the paymaster pulls the real cost in postOp. Whatever a provider puts in
// paymasterData, that allowance is the most it can take: the approve runs in the account's own callData.
//
// Providers speak ERC-7677 (pm_getPaymasterStubData / pm_getPaymasterData) for the paymaster fields. The token
// price is provider specific (Pimlico: pimlico_getTokenQuotes), and so is the layout of paymasterData, which each
// provider decodes and checks before the owner is asked to sign.

/** USDC base units per 1e18 wei of gas, and what the paymaster adds to the account's gas. */
export type GasPrice = { paymaster: Address; token: Address; exchangeRate: bigint; postOpGas: bigint }

export interface Erc20Paymaster {
  readonly name: string
  /** The USDC price of gas, before the userOp is built: the approve and the bridged amount depend on it. */
  quote(): Promise<GasPrice>
  /** Fields for gas estimation (ERC-7677 pm_getPaymasterStubData). */
  stub(op: UserOperation<'0.7'>): Promise<PaymasterFields>
  /** Final fields over the finished userOp (ERC-7677 pm_getPaymasterData). */
  data(op: UserOperation<'0.7'>): Promise<PaymasterFields>
  /** Refuses fields that do not match the quote: another paymaster, another token, a dearer rate, a recipient. */
  check(fields: PaymasterFields, quote: GasPrice): void
}

export class PaymasterError extends Error {}

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>

/** JSON-RPC over a keyed URL. Errors never carry the URL: only the method and the provider's code. */
export function rpcClient(url: string, fetcher: typeof fetch = fetch, timeoutMs = 10_000): Rpc {
  let id = 0
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    let res: Response
    try {
      res = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw new RpcUnavailable(method)
    }
    let json: { result?: T; error?: { code?: number; message?: string } }
    try {
      json = (await res.json()) as typeof json
    } catch {
      throw new RpcUnavailable(method)
    }
    if (json.error) throw new RpcRefused(method, Number(json.error.code ?? 0), String(json.error.message ?? '').slice(0, 300))
    return json.result as T
  }
}

/** The request did not reach the provider or its answer was lost: the outcome is unknown. */
export class RpcUnavailable extends Error {
  constructor(readonly method: string) {
    super(`${method}: no answer`)
  }
}

/** The provider answered with a JSON-RPC error: it refused. */
export class RpcRefused extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly detail: string,
  ) {
    super(`${method}: refused (${code}) ${detail}`)
  }
}

type RpcPaymasterFields = { paymaster: Address; paymasterData: Hex; paymasterVerificationGasLimit?: Hex; paymasterPostOpGasLimit?: Hex }

function fields(r: RpcPaymasterFields, stub?: PaymasterFields): PaymasterFields {
  // pm_getPaymasterData may leave out the gas limits it gave in the stub (ERC-7677).
  return {
    paymaster: getAddress(r.paymaster),
    paymasterData: r.paymasterData,
    paymasterVerificationGasLimit: r.paymasterVerificationGasLimit !== undefined ? BigInt(r.paymasterVerificationGasLimit) : (stub?.paymasterVerificationGasLimit ?? 0n),
    paymasterPostOpGasLimit: r.paymasterPostOpGasLimit !== undefined ? BigInt(r.paymasterPostOpGasLimit) : (stub?.paymasterPostOpGasLimit ?? 0n),
  }
}

/** Pimlico's singleton ERC-20 paymaster for EntryPoint v0.7 on Ethereum (checked 18 Oct: 3.51 ETH deposit). */
export const PIMLICO_ERC20_PAYMASTER_V07: Address = '0x777777777777AeC03fd955926DbF81597e66834C'

/** A rate above the quote by more than this is refused (the quote and the signed data are seconds apart). */
export const RATE_SLACK_BPS = 200n
/** A constant fee above this is refused: 0.05 USDC. */
export const MAX_CONSTANT_FEE = 50_000n

export type PimlicoErc20Config = {
  mode: number
  allowAllBundlers: boolean
  validUntil: number
  validAfter: number
  token: Address
  postOpGas: bigint
  exchangeRate: bigint
  paymasterValidationGasLimit: bigint
  treasury: Address
  preFund: bigint
  constantFee: bigint
  recipient: Address | null
  signature: Hex
}

/** paymasterData of SingletonPaymasterV7 in ERC-20 mode (pimlicolabs/singleton-paymaster, BaseSingletonPaymaster). */
export function decodePimlicoErc20(data: Hex): PimlicoErc20Config {
  const n = (data.length - 2) / 2
  let p = 0
  const take = (len: number): Hex => {
    if (p + len > n) throw new PaymasterError('paymaster data too short')
    const h = sliceHex(data, p, p + len, { strict: true })
    p += len
    return h
  }
  const first = Number(hexToBigInt(take(1)))
  const flags = Number(hexToBigInt(take(1)))
  const cfg: PimlicoErc20Config = {
    mode: first >> 1,
    allowAllBundlers: (first & 1) === 1,
    validUntil: Number(hexToBigInt(take(6))),
    validAfter: Number(hexToBigInt(take(6))),
    token: getAddress(take(20)),
    postOpGas: hexToBigInt(take(16)),
    exchangeRate: hexToBigInt(take(32)),
    paymasterValidationGasLimit: hexToBigInt(take(16)),
    treasury: getAddress(take(20)),
    preFund: flags & 0x04 ? hexToBigInt(take(16)) : 0n,
    constantFee: flags & 0x01 ? hexToBigInt(take(16)) : 0n,
    recipient: flags & 0x02 ? getAddress(take(20)) : null,
    signature: '0x',
  }
  if (flags & ~0x07) throw new PaymasterError('unknown paymaster flags')
  const sigLen = n - p
  if (sigLen !== 64 && sigLen !== 65) throw new PaymasterError('paymaster signature length')
  cfg.signature = take(sigLen)
  return cfg
}

/**
 * What the account accepts from Pimlico's ERC-20 paymaster. Mode 1 (ERC-20), the token is USDC, the rate is at most
 * the quoted one, nothing is pulled before the account runs (no preFund: the approve is in the account's own batch),
 * no recipient (it would receive the unused prefund), a constant fee no larger than MAX_CONSTANT_FEE, and any
 * bundler allowed (the operator submits handleOps from its own relayer).
 */
export function checkPimlicoErc20(f: PaymasterFields, q: GasPrice, usdc: Address): PimlicoErc20Config {
  if (getAddress(f.paymaster) !== getAddress(q.paymaster)) throw new PaymasterError('unexpected paymaster')
  const c = decodePimlicoErc20(f.paymasterData)
  if (c.mode !== 1) throw new PaymasterError('paymaster is not in ERC-20 mode')
  // The operator bundles itself (#180): data restricted to Pimlico's bundlers would revert in validation.
  if (!c.allowAllBundlers) throw new PaymasterError('paymaster data limited to its own bundlers')
  if (c.token !== getAddress(usdc)) throw new PaymasterError('paymaster charges another token')
  if (c.exchangeRate <= 0n || c.exchangeRate * 10_000n > q.exchangeRate * (10_000n + RATE_SLACK_BPS)) throw new PaymasterError('paymaster rate above the quote')
  if (c.postOpGas > q.postOpGas) throw new PaymasterError('paymaster postOp gas above the quote')
  if (c.preFund !== 0n) throw new PaymasterError('paymaster asks for a prefund')
  if (c.recipient !== null) throw new PaymasterError('paymaster names a recipient')
  if (c.constantFee > MAX_CONSTANT_FEE) throw new PaymasterError('paymaster constant fee too high')
  return c
}

/** Pimlico over ERC-7677 plus pimlico_getTokenQuotes. The URL carries the API key: never logged. */
export class PimlicoErc20Paymaster implements Erc20Paymaster {
  readonly name = 'pimlico'
  private readonly rpc: Rpc
  private lastStub: PaymasterFields | undefined

  constructor(
    url: string,
    private readonly chainId: number,
    private readonly usdc: Address,
    fetcher: typeof fetch = fetch,
    private readonly expected: Address = PIMLICO_ERC20_PAYMASTER_V07,
  ) {
    this.rpc = rpcClient(url, fetcher)
  }

  async quote(): Promise<GasPrice> {
    const r = await this.rpc<{ quotes?: { paymaster: string; token: string; exchangeRate: Hex; postOpGas: Hex }[] }>('pimlico_getTokenQuotes', [{ tokens: [this.usdc] }, address('EntryPointV07'), toHex(this.chainId)])
    const q = r.quotes?.find((x) => x.token.toLowerCase() === this.usdc.toLowerCase())
    if (!q) throw new PaymasterError('no USDC quote')
    const paymaster = getAddress(q.paymaster)
    if (paymaster !== getAddress(this.expected)) throw new PaymasterError('unexpected paymaster')
    return { paymaster, token: getAddress(q.token), exchangeRate: BigInt(q.exchangeRate), postOpGas: BigInt(q.postOpGas) }
  }

  private params(op: UserOperation<'0.7'>) {
    return [toRpcUserOp(op), address('EntryPointV07'), toHex(this.chainId), { token: this.usdc }]
  }

  async stub(op: UserOperation<'0.7'>): Promise<PaymasterFields> {
    this.lastStub = fields(await this.rpc<RpcPaymasterFields>('pm_getPaymasterStubData', this.params(op)))
    return this.lastStub
  }

  async data(op: UserOperation<'0.7'>): Promise<PaymasterFields> {
    return fields(await this.rpc<RpcPaymasterFields>('pm_getPaymasterData', this.params(op)), this.lastStub)
  }

  check(f: PaymasterFields, q: GasPrice): void {
    checkPimlicoErc20(f, q, this.usdc)
  }
}

export type GasEstimate = { preVerificationGas: bigint; verificationGasLimit: bigint; callGasLimit: bigint; paymasterVerificationGasLimit?: bigint; paymasterPostOpGasLimit?: bigint }

export type BundlerReceipt = { success: boolean; actualGasCost: bigint; txHash: Hex; blockNumber: bigint }

/**
 * The few bundler methods the L1 path uses, against the operator's own loopback bundler on Ethereum. Kept apart from
 * @mamoru/erc4337's BundlerClient, which sends only on Base: this one serves only bridge-out.
 */
export class L1Bundler {
  private readonly rpc: Rpc

  constructor(url: string, fetcher: typeof fetch = fetch, timeoutMs = 15_000) {
    this.rpc = rpcClient(url, fetcher, timeoutMs)
  }

  /** Null when the bundler does not estimate (the lab bundler): the caller uses its fork-measured limits. */
  async estimate(op: UserOperation<'0.7'>): Promise<GasEstimate | null> {
    let r: Record<string, Hex | undefined>
    try {
      r = await this.rpc<Record<string, Hex | undefined>>('eth_estimateUserOperationGas', [toRpcUserOp(op), address('EntryPointV07')])
    } catch (e) {
      if (e instanceof RpcRefused && e.code === -32601) return null
      throw e
    }
    const big = (h: Hex | undefined) => (h === undefined ? undefined : BigInt(h))
    return {
      preVerificationGas: BigInt(r.preVerificationGas ?? '0x0'),
      verificationGasLimit: BigInt(r.verificationGasLimit ?? '0x0'),
      callGasLimit: BigInt(r.callGasLimit ?? '0x0'),
      paymasterVerificationGasLimit: big(r.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: big(r.paymasterPostOpGasLimit),
    }
  }

  /** The bundler's own fee advice (Pimlico: pimlico_getUserOperationGasPrice, 'fast'); null when it has none. */
  async gasPrice(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null> {
    try {
      const r = await this.rpc<{ fast?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } }>('pimlico_getUserOperationGasPrice', [])
      if (!r.fast) return null
      return { maxFeePerGas: BigInt(r.fast.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.fast.maxPriorityFeePerGas) }
    } catch (e) {
      if (e instanceof RpcRefused && e.code === -32601) return null
      throw e
    }
  }

  async send(op: UserOperation<'0.7'>): Promise<Hex> {
    return this.rpc<Hex>('eth_sendUserOperation', [toRpcUserOp(op), address('EntryPointV07')])
  }

  async receipt(userOpHash: Hex): Promise<BundlerReceipt | null> {
    const r = await this.rpc<{ success: boolean; actualGasCost: Hex; receipt: { transactionHash: Hex; blockNumber: Hex } } | null>('eth_getUserOperationReceipt', [userOpHash])
    if (!r) return null
    return { success: r.success === true, actualGasCost: BigInt(r.actualGasCost), txHash: r.receipt.transactionHash, blockNumber: BigInt(r.receipt.blockNumber) }
  }
}

/** Candide's token paymaster for EntryPoint v0.7 (abstractionkit decodeTokenQuote.ts; same address on every chain). */
export const CANDIDE_TOKEN_PAYMASTER_V07: Address = '0x8b1f6cb5d062aa2Ce8d581942bbb960420d875BA'

export type CandideConfig = { mode: number; markupMode: number; gasTokenSlot: number; validUntil: number; exchangeRate: bigint; priceMarkup: bigint | null }

/**
 * The leading fields of Candide's v0.7 token paymasterData, as abstractionkit parses them: mode (0 = token), markup
 * mode, gas token slot, validUntil, exchangeRate, then priceMarkup when the markup mode is explicit (2). The rest
 * (signature and anything after) is not public; nothing in it can take more than the account's own approve.
 */
export function decodeCandide(data: Hex): CandideConfig {
  const n = (data.length - 2) / 2
  let p = 0
  const take = (len: number): Hex => {
    if (p + len > n) throw new PaymasterError('paymaster data too short')
    const h = sliceHex(data, p, p + len, { strict: true })
    p += len
    return h
  }
  const mode = Number(hexToBigInt(take(1)))
  const markupMode = Number(hexToBigInt(take(1)))
  const gasTokenSlot = Number(hexToBigInt(take(1)))
  const validUntil = Number(hexToBigInt(take(6)))
  const exchangeRate = hexToBigInt(take(32))
  const priceMarkup = markupMode === 2 ? hexToBigInt(take(32)) : null
  return { mode, markupMode, gasTokenSlot, validUntil, exchangeRate, priceMarkup }
}

/** What the account accepts from Candide: its v0.7 paymaster, token mode, a rate at most the quoted one. */
export function checkCandide(f: PaymasterFields, q: GasPrice): CandideConfig {
  if (getAddress(f.paymaster) !== getAddress(q.paymaster)) throw new PaymasterError('unexpected paymaster')
  const c = decodeCandide(f.paymasterData)
  if (c.mode !== 0) throw new PaymasterError('paymaster is not in token mode')
  if (c.exchangeRate <= 0n || c.exchangeRate * 10_000n > q.exchangeRate * (10_000n + RATE_SLACK_BPS)) throw new PaymasterError('paymaster rate above the quote')
  return c
}

/**
 * Candide (InstaGas) over ERC-7677 with context { token }, priced by pm_supportedERC20Tokens (exchangeRate: token
 * units per 1e18 wei). The URL carries the API key: never logged. Candide's v0.7 data has no bundler allowlist
 * (abstractionkit: the trusted-bundlers byte exists only on its v0.9 paymaster), so the operator's bundler may submit.
 */
export class CandideErc20Paymaster implements Erc20Paymaster {
  readonly name = 'candide'
  private readonly rpc: Rpc
  private lastStub: PaymasterFields | undefined

  constructor(
    url: string,
    private readonly chainId: number,
    private readonly usdc: Address,
    fetcher: typeof fetch = fetch,
    private readonly expected: Address = CANDIDE_TOKEN_PAYMASTER_V07,
  ) {
    this.rpc = rpcClient(url, fetcher)
  }

  async quote(): Promise<GasPrice> {
    const r = await this.rpc<{ paymasterMetadata?: { address?: string; dummyPaymasterAndData?: { paymasterPostOpGasLimit?: Hex } }; tokens?: { address: string; exchangeRate: Hex | string }[] }>('pm_supportedERC20Tokens', [address('EntryPointV07')])
    const pm = r.paymasterMetadata?.address
    if (!pm || getAddress(pm) !== getAddress(this.expected)) throw new PaymasterError('unexpected paymaster')
    const t = r.tokens?.find((x) => x.address.toLowerCase() === this.usdc.toLowerCase())
    if (!t) throw new PaymasterError('no USDC quote')
    // Candide charges its postOp within paymasterPostOpGasLimit; no separate postOp surcharge in the rate.
    return { paymaster: getAddress(pm), token: this.usdc, exchangeRate: BigInt(t.exchangeRate), postOpGas: 0n }
  }

  private params(op: UserOperation<'0.7'>) {
    return [toRpcUserOp(op), address('EntryPointV07'), toHex(this.chainId), { token: this.usdc }]
  }

  async stub(op: UserOperation<'0.7'>): Promise<PaymasterFields> {
    this.lastStub = fields(await this.rpc<RpcPaymasterFields>('pm_getPaymasterStubData', this.params(op)))
    return this.lastStub
  }

  async data(op: UserOperation<'0.7'>): Promise<PaymasterFields> {
    return fields(await this.rpc<RpcPaymasterFields>('pm_getPaymasterData', this.params(op)), this.lastStub)
  }

  check(f: PaymasterFields, q: GasPrice): void {
    checkCandide(f, q)
  }
}

/**
 * The configured provider: MAMORU_L1_PAYMASTER=pimlico|candide with its URL, or the provider named by the URL's
 * host. Null when none is configured: bridge-out keeps the relayer path.
 */
export function paymasterFromEnv(kind: string | undefined, url: string | undefined, chainId: number, usdc: Address): Erc20Paymaster | null {
  if (!url) return null
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error('MAMORU_L1_PAYMASTER_URL is not a URL')
  }
  const k = kind ?? (host.endsWith('pimlico.io') ? 'pimlico' : host.endsWith('candide.dev') ? 'candide' : '')
  if (k === 'pimlico') return new PimlicoErc20Paymaster(url, chainId, usdc)
  if (k === 'candide') return new CandideErc20Paymaster(url, chainId, usdc)
  throw new Error('MAMORU_L1_PAYMASTER must be pimlico or candide')
}
