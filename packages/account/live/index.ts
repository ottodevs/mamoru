import { concat, encodeAbiParameters, encodeFunctionData, hashTypedData, hexToBigInt, numberToHex, pad, size, toHex, type PublicClient } from 'viem'
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

/** Owner-authorized cap for the live happy path on Base: 25 USDC per account (6 decimals). */
export const LIVE_CAP_USDC = 25_000_000n

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

/** ASN.1 DER ECDSA-Sig-Value -> r, low s. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0
  const byte = () => {
    const b = der[i++]
    if (b === undefined) throw new Error('DER signature truncated')
    return b
  }
  const len = () => {
    let l = byte()
    if (l & 0x80) {
      const n = l & 0x7f
      l = 0
      for (let k = 0; k < n; k++) l = (l << 8) | byte()
    }
    return l
  }
  if (byte() !== 0x30) throw new Error('DER signature: expected SEQUENCE')
  const seqLen = len()
  if (i + seqLen !== der.length) throw new Error('DER signature: bad length')
  const int = () => {
    if (byte() !== 0x02) throw new Error('DER signature: expected INTEGER')
    const l = len()
    if (l === 0 || i + l > der.length) throw new Error('DER signature: bad INTEGER')
    const v = BigInt(toHex(der.subarray(i, i + l)))
    i += l
    return v
  }
  const r = int()
  let s = int()
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) throw new Error('DER signature out of range')
  if (s > P256_N / 2n) s = P256_N - s
  return { r, s }
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

export function execData(tx: SafeTx, signature: Hex): Hex {
  return execTransactionData(tx, signature)
}

export type { MultiSendCall, SafeTx, WebAuthnSigner }
