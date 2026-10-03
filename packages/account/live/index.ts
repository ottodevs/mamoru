import { concat, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, hashTypedData, hexToBigInt, hexToBytes, numberToHex, pad, size, toHex, type PublicClient } from 'viem'
import type { AccountContext, Address, Hex, OwnerSignature } from '@mamoru/domain'
import { address, erc20Abi, safeAbi } from '@mamoru/registry'
import type { SessionGrant } from '@mamoru/policy'
import { approve, burn, collect, decreaseLiquidity, exactInputSingle, exactInputSingleTo, swapToEth } from '@mamoru/uniswap-v3'
import {
  OPERATION_CALL,
  createProxyCall,
  execTransactionData,
  multiSendCallOnly,
  safeTxTypedData,
  webAuthnSigner,
  type MultiSendCall,
  type SafeTx,
  type WebAuthnSigner,
} from '../safe/index.ts'
import { accountSetup, counterfactualAddress } from '../recovery/index.ts'
import { activationCall, registryTrustCalls, revocationCalls } from '../sessions/index.ts'

/** Owner-authorized cap for the live happy path on Base: 100 USDC per account (6 decimals). */
export const LIVE_CAP_USDC = 100_000_000n

/** pool:USDC/cbBTC/500. token0 USDC, token1 cbBTC. */
export const LIVE_POOL_FEE = 500

export type LiveAccount = { safe: Address; chainId: number; owners: Address[]; saltNonce: bigint; webauthn: WebAuthnSigner }

export type LivePosition = { tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint }
export type LiveSwap = { amountIn: bigint; amountOutMinimum: bigint }
/** What the recipient receives instead of USDC: a USDC swap on SwapRouter02 whose output goes straight to them. `asset` is the registry token out (the app's JPYC slot pays out JPYT). */
export type LiveReceive = { asset: 'EURC' | 'ETH' | 'JPYT'; fee: number; amountOutMinimum: bigint }

/** Rebuilds the account from the stored context and refuses it if the counterfactual address does not match. */
export function liveAccountFromContext(ctx: AccountContext): LiveAccount {
  const owners = ctx.owners as Address[]
  const saltNonce = BigInt(ctx.saltNonce)
  const webauthn = webAuthnSigner(hexToBigInt(ctx.passkey.x), hexToBigInt(ctx.passkey.y))
  const safe = counterfactualAddress(accountSetup(owners, saltNonce, webauthn))
  if (safe.toLowerCase() !== ctx.address.toLowerCase()) throw new Error(`counterfactual address ${safe} does not match context ${ctx.address}`)
  return { safe, chainId: ctx.chainId, owners, saltNonce, webauthn }
}

/** SafeProxyFactory.createProxyWithNonce for the account. Any EOA can send it. */
export function deployCall(a: LiveAccount): { to: Address; data: Hex } {
  return createProxyCall(accountSetup(a.owners, a.saltNonce, a.webauthn))
}

export async function readSafeNonce(client: PublicClient, safe: Address): Promise<{ deployed: boolean; nonce: bigint }> {
  const code = await client.getCode({ address: safe })
  if (!code || code === '0x') return { deployed: false, nonce: 0n }
  const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
  return { deployed: true, nonce }
}

/** One call is a plain CALL; several go through MultiSendCallOnly 1.4.1 (delegatecall). */
export function ownerSafeTx(calls: MultiSendCall[], nonce: bigint): SafeTx {
  if (calls.length === 0) throw new Error('no calls')
  if (calls.length === 1) {
    const c = calls[0]!
    return { to: c.to, value: c.value, data: c.data, operation: OPERATION_CALL, nonce }
  }
  const b = multiSendCallOnly(calls)
  return { to: b.to, value: 0n, data: b.data, operation: b.operation, nonce }
}

/** The SafeTx EIP-712 hash. The passkey signs it as the WebAuthn challenge. */
export function safeTxHashOf(a: LiveAccount, tx: SafeTx): Hex {
  return hashTypedData(safeTxTypedData(a.safe, a.chainId, tx))
}

const strip = (c: { to: Address; value: bigint; data: Hex }): MultiSendCall => ({ to: c.to, value: c.value, data: c.data })

/**
 * Registry trust (Rhinestone attester + self-attestation of the published
 * policies), then SmartSession.enableSessions, in the fork-proven order.
 * `trust: false` skips the registry calls when the account already ran them.
 */
export function activationBatch(
  a: LiveAccount,
  grants: SessionGrant[],
  revoked: Hex[],
  opts: { trust?: boolean } = {},
): { calls: MultiSendCall[]; permissionIds: Hex[] } {
  const act = activationCall(grants, revoked)
  const trust = opts.trust === false ? [] : registryTrustCalls(a.safe)
  return { calls: [...trust, { to: act.to, value: 0n, data: act.data }].map(strip), permissionIds: act.permissionIds }
}

function closeCalls(account: Address, p: LivePosition, deadline: bigint, burnIt: boolean): MultiSendCall[] {
  return [
    ...(p.liquidity > 0n ? [decreaseLiquidity({ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: p.amount0Min, amount1Min: p.amount1Min, deadline })] : []),
    collect({ account, tokenId: p.tokenId }),
    ...(burnIt ? [burn(p.tokenId)] : []),
  ].map(strip)
}

/** cbBTC -> USDC on pool:USDC/cbBTC/500, exact approve then reset to 0. */
function swapCbbtcCalls(account: Address, s: LiveSwap): MultiSendCall[] {
  if (s.amountIn <= 0n) return []
  return [
    approve('cbBTC', 'SwapRouter02', s.amountIn),
    exactInputSingle({ account, tokenIn: 'cbBTC', tokenOut: 'USDC', fee: LIVE_POOL_FEE, amountIn: s.amountIn, amountOutMinimum: s.amountOutMinimum }),
    approve('cbBTC', 'SwapRouter02', 0n),
  ].map(strip)
}

function uniqueTokenIds(ps: { tokenId: bigint }[]): void {
  if (new Set(ps.map((p) => p.tokenId)).size !== ps.length) throw new Error('duplicate tokenId')
}

/** Owner transfer: free USDC from positions if needed, optional cbBTC -> USDC, then USDC.transfer(to). */
export function transferBatch(i: {
  account: Address
  to: Address
  amountUsdc: bigint
  reduce: LivePosition[]
  swapCbbtc?: LiveSwap
  deadline: bigint
  receive?: LiveReceive
}): MultiSendCall[] {
  if (i.amountUsdc <= 0n) throw new Error('amountUsdc must be positive')
  if (i.to.toLowerCase() === i.account.toLowerCase()) throw new Error('recipient must not be the account')
  uniqueTokenIds(i.reduce)
  return [
    ...i.reduce.flatMap((p) => closeCalls(i.account, p, i.deadline, false)),
    ...(i.swapCbbtc ? swapCbbtcCalls(i.account, i.swapCbbtc) : []),
    ...(i.receive ? receiveCalls(i.to, i.amountUsdc, i.receive, i.deadline) : [{ to: address('USDC'), value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [i.to, i.amountUsdc] }) }]),
  ]
}

/** Exact USDC approve to SwapRouter02, the swap with `to` as the output recipient (ETH: unwrapped in the router), approve 0. */
function receiveCalls(to: Address, amountUsdc: bigint, r: LiveReceive, deadline: bigint): MultiSendCall[] {
  const swap =
    r.asset === 'ETH'
      ? swapToEth({ recipient: to, tokenIn: 'USDC', fee: r.fee, amountIn: amountUsdc, amountOutMinimum: r.amountOutMinimum, deadline })
      : exactInputSingleTo({ recipient: to, tokenIn: 'USDC', tokenOut: r.asset, fee: r.fee, amountIn: amountUsdc, amountOutMinimum: r.amountOutMinimum })
  return [approve('USDC', 'SwapRouter02', amountUsdc), swap, approve('USDC', 'SwapRouter02', 0n)].map(strip)
}

/** Stop allocation: revoke every grant, close and burn every position, swap cbBTC -> USDC. USDC stays in the Safe. */
export function stopBatch(i: {
  account: Address
  permissionIds: Hex[]
  positions: LivePosition[]
  swapCbbtc?: LiveSwap
  deadline: bigint
}): MultiSendCall[] {
  if (new Set(i.permissionIds.map((p) => p.toLowerCase())).size !== i.permissionIds.length) throw new Error('duplicate permissionId')
  uniqueTokenIds(i.positions)
  const calls = [
    ...revocationCalls(i.permissionIds).map(strip),
    ...i.positions.flatMap((p) => closeCalls(i.account, p, i.deadline, true)),
    ...(i.swapCbbtc ? swapCbbtcCalls(i.account, i.swapCbbtc) : []),
  ]
  if (calls.length === 0) throw new Error('nothing to stop')
  return calls
}

// Browser WebAuthn assertion -> Safe contract signature for SafeWebAuthnSharedSigner

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/** base64url -> bytes without Buffer, so the module runs in a Worker without nodejs_compat. */
export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error('not base64url')
  const b64 = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/**
 * Strict ASN.1 DER ECDSA-Sig-Value -> r, low s. One SEQUENCE of exactly two INTEGERs and nothing after it; each
 * INTEGER positive and minimal (a leading 0x00 only when the next byte has its high bit set, which is how every
 * authenticator encodes a value >= 2^255); r and s in [1, n-1].
 * High s is accepted and normalised to low s: authenticators emit it about half the time, and the on-chain verifier
 * (SafeWebAuthnSharedSigner over RIP-7212 / P256Verifier) accepts both forms, so rejecting it would fail real owners.
 * The normalised (r, s) is what goes on chain and what the off-chain checks verify.
 */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const { r, s } = parseDerStrict(der)
  return { r, s: s > P256_N / 2n ? P256_N - s : s }
}

/** The strict parse, with s as the authenticator sent it. */
function parseDerStrict(der: Uint8Array): { r: bigint; s: bigint } {
  // 2 + 2 * (2 + 33): a P-256 signature never needs the long length form, so a 0x8x length is not DER here.
  if (der.length < 2 || der.length > 72) throw new Error('DER signature: bad length')
  if (der[0] !== 0x30) throw new Error('DER signature: expected SEQUENCE')
  if (der[1]! & 0x80 || der[1]! !== der.length - 2) throw new Error('DER signature: bad length')
  let i = 2
  const int = () => {
    if (der[i] !== 0x02) throw new Error('DER signature: expected INTEGER')
    const l = der[i + 1]
    if (l === undefined || l === 0 || l > 33 || i + 2 + l > der.length) throw new Error('DER signature: bad INTEGER')
    const body = der.subarray(i + 2, i + 2 + l)
    if (body[0]! & 0x80) throw new Error('DER signature: negative INTEGER')
    if (l > 1 && body[0] === 0 && !(body[1]! & 0x80)) throw new Error('DER signature: non-minimal INTEGER')
    i += 2 + l
    return BigInt(toHex(body))
  }
  const r = int()
  const s = int()
  if (i !== der.length) throw new Error('DER signature: trailing data')
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) throw new Error('DER signature out of range')
  return { r, s }
}

/**
 * What an assertion looks like, without anything secret or identifying: sizes, the flags byte, the clientDataJSON
 * keys in the order the browser wrote them, and how the signature is encoded. Logged when a check that mirrors the
 * chain disagrees with the chain, or when sign-in refuses a real device, so the mirror can be fixed from the log.
 */
export type AssertionShape = {
  authenticatorDataLength: number
  flags: string | null
  signCountZero: boolean | null
  clientDataLength: number
  clientDataKeys: string[] | null
  clientDataPrefixOk: boolean
  signatureLength: number
  signatureDer: 'ok' | string
  highS: boolean | null
}

/** clientDataJSON members WebAuthn defines. Any other name is caller-controlled text and is only counted, never logged. */
const KNOWN_CLIENT_DATA_KEYS = new Set(['type', 'challenge', 'origin', 'crossOrigin', 'topOrigin', 'tokenBinding'])

/** Key names safe to log: the known ones in order, then `+N` for however many others there were. */
export function safeClientDataKeys(keys: readonly string[]): string[] {
  const known = keys.filter((k) => KNOWN_CLIENT_DATA_KEYS.has(k))
  const others = keys.length - known.length
  return others > 0 ? [...known, `+${others}`] : known
}

export function assertionShape(a: { authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array }): AssertionShape {
  const auth = a.authenticatorData
  let keys: string[] | null = null
  let text = ''
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(a.clientDataJSON)
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) keys = safeClientDataKeys(Object.keys(parsed))
  } catch {
    // not JSON: keys stay null
  }
  let der: AssertionShape['signatureDer'] = 'ok'
  let highS: boolean | null = null
  try {
    highS = parseDerStrict(a.signature).s > P256_N / 2n
  } catch (e) {
    der = (e as Error).message
  }
  return {
    authenticatorDataLength: auth.length,
    flags: auth.length > 32 ? `0x${auth[32]!.toString(16).padStart(2, '0')}` : null,
    signCountZero: auth.length >= 37 ? auth[33] === 0 && auth[34] === 0 && auth[35] === 0 && auth[36] === 0 : null,
    clientDataLength: a.clientDataJSON.length,
    clientDataKeys: keys,
    clientDataPrefixOk: text.startsWith(CLIENT_DATA_PREFIX),
    signatureLength: a.signature.length,
    signatureDer: der,
    highS,
  }
}

/** The same for a stored Safe contract signature (the armed executor has nothing else): s is already normalised there. */
export function ownerSignatureShape(signature: Hex): Partial<AssertionShape> & { decodes: boolean } {
  try {
    const d = decodeOwnerSignature(signature)
    const auth = hexToBytes(d.authenticatorData)
    let keys: string[] | null = null
    try {
      keys = safeClientDataKeys(['type', 'challenge', ...Object.keys(JSON.parse(`{${d.clientDataFields}}`) as object)])
    } catch {
      // fields are not JSON members
    }
    return { decodes: true, authenticatorDataLength: auth.length, flags: auth.length > 32 ? `0x${auth[32]!.toString(16).padStart(2, '0')}` : null, clientDataKeys: keys }
  } catch {
    return { decodes: false }
  }
}

const CLIENT_DATA_PREFIX = '{"type":"webauthn.get","challenge":"'

/**
 * SafeWebAuthnSharedSigner rebuilds clientDataJSON as
 * `{"type":"webauthn.get","challenge":"<b64url(hash)>",` + fields + `}`.
 * Returns the fields and the challenge the browser signed.
 */
export function clientDataFieldsOf(clientDataJSON: string): { challenge: string; fields: string } {
  if (!clientDataJSON.startsWith(CLIENT_DATA_PREFIX)) throw new Error('clientDataJSON must start with type webauthn.get then challenge')
  const end = clientDataJSON.indexOf('"', CLIENT_DATA_PREFIX.length)
  if (end < 0 || clientDataJSON[end + 1] !== ',' || !clientDataJSON.endsWith('}')) throw new Error('clientDataJSON has no fields after the challenge')
  return { challenge: clientDataJSON.slice(CLIENT_DATA_PREFIX.length, end), fields: clientDataJSON.slice(end + 2, -1) }
}

/** abi.encode(bytes authenticatorData, string clientDataFields, uint256 r, uint256 s). */
export function encodeWebAuthnSignature(p: { authenticatorData: Hex; clientDataFields: string; r: bigint; s: bigint }): Hex {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }], [p.authenticatorData, p.clientDataFields, p.r, p.s])
}

/** One Safe contract signature (v = 0) from `signer`, data at offset 65. */
export function safeContractSignature(signer: Address, data: Hex): Hex {
  return concat([pad(signer, { size: 32 }), numberToHex(65, { size: 32 }), '0x00', numberToHex(size(data), { size: 32 }), data])
}

/**
 * The Safe signature bytes for a browser assertion. With `safeTxHash`, also
 * checks that the assertion's challenge is that hash.
 */
export function browserOwnerSignature(sig: OwnerSignature, safeTxHash?: Hex): Hex {
  const authenticatorData = toHex(fromB64url(sig.authenticatorData))
  const clientDataJSON = new TextDecoder('utf-8', { fatal: true }).decode(fromB64url(sig.clientDataJSON))
  const { challenge, fields } = clientDataFieldsOf(clientDataJSON)
  if (safeTxHash && toHex(fromB64url(challenge)).toLowerCase() !== safeTxHash.toLowerCase()) throw new Error('assertion challenge is not the safeTxHash')
  const { r, s } = parseDerSignature(fromB64url(sig.signature))
  return safeContractSignature(address('SafeWebAuthnSharedSigner'), encodeWebAuthnSignature({ authenticatorData, clientDataFields: fields, r, s }))
}

/** authenticatorData flag SafeWebAuthnSharedSigner requires (WebAuthn.USER_VERIFICATION). */
const FLAG_UV = 0x04

function toB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The parts of a Safe contract signature built by safeContractSignature(SafeWebAuthnSharedSigner, encodeWebAuthnSignature(...)). */
export function decodeOwnerSignature(signature: Hex): { authenticatorData: Hex; clientDataFields: string; r: bigint; s: bigint } {
  const bytes = hexToBytes(signature)
  if (bytes.length < 97) throw new Error('owner signature too short')
  const signer = toHex(bytes.subarray(12, 32))
  const padding = hexToBigInt(toHex(bytes.subarray(0, 12)))
  if (padding !== 0n || signer.toLowerCase() !== address('SafeWebAuthnSharedSigner').toLowerCase()) throw new Error('owner signature is not from SafeWebAuthnSharedSigner')
  if (hexToBigInt(toHex(bytes.subarray(32, 64))) !== 65n || bytes[64] !== 0) throw new Error('owner signature is not one contract signature')
  if (hexToBigInt(toHex(bytes.subarray(65, 97))) !== BigInt(bytes.length - 97)) throw new Error('owner signature length mismatch')
  const [authenticatorData, clientDataFields, r, s] = decodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }], toHex(bytes.subarray(97)))
  return { authenticatorData, clientDataFields, r, s }
}

/**
 * Off-chain copy of what SafeWebAuthnSharedSigner checks for this account: the passkey (x, y) signed, with user
 * verification, a WebAuthn assertion whose challenge is `safeTxHash`. safeTxHash is the EIP-712 hash over the Safe
 * address, the chain id and the SafeTx with its nonce, so a true result means "this owner signed exactly this
 * transaction". Run it before the relayer spends anything: a forged signature must cost the relayer nothing.
 */
export async function verifyOwnerSignature(signature: Hex, safeTxHash: Hex, key: { x: bigint; y: bigint }): Promise<boolean> {
  try {
    const { authenticatorData, clientDataFields, r, s } = decodeOwnerSignature(signature)
    const auth = hexToBytes(authenticatorData)
    if (auth.length < 37 || !(auth[32]! & FLAG_UV)) return false
    if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) return false
    // The contract rebuilds clientDataJSON around the hash it is asked about; so does this.
    const clientDataJSON = `${CLIENT_DATA_PREFIX}${toB64url(hexToBytes(safeTxHash))}",${clientDataFields}}`
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientDataJSON)))
    const message = new Uint8Array(auth.length + 32)
    message.set(auth)
    message.set(clientHash, auth.length)
    const point = hexToBytes(concat(['0x04', numberToHex(key.x, { size: 32 }), numberToHex(key.y, { size: 32 })]))
    const pub = await crypto.subtle.importKey('raw', point as Uint8Array<ArrayBuffer>, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const raw = hexToBytes(concat([numberToHex(r, { size: 32 }), numberToHex(s, { size: 32 })]))
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, raw as Uint8Array<ArrayBuffer>, message)
  } catch {
    return false
  }
}

export function execData(tx: SafeTx, signature: Hex): Hex {
  return execTransactionData(tx, signature)
}

export type { MultiSendCall, SafeTx, WebAuthnSigner }
