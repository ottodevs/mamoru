import { createECDH, createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { concat, encodeAbiParameters, hashTypedData, numberToHex, pad, size, toHex, type Hex, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { safeTxTypedData, type SafeTx } from '@mamoru/account/safe'

/** Fixed test scalars for the software passkeys. Test material only. */
export const PASSKEY_SCALARS = {
  a1: '0x1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100',
  a2: '0x2f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
} as const

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/** RIP-7212 precompile address, the high 16 bits of SafeWebAuthnSharedSigner's verifiers. */
export const P256_PRECOMPILE = 0x100

const RP_ID = 'app.mamoru.lol'
const ORIGIN = `https://${RP_ID}`
/** authenticatorData flags: user present and user verified. */
const FLAGS_UP_UV = 0x05

export function passkeyPublicKey(scalar: Hex): { x: bigint; y: bigint } {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(scalar.slice(2), 'hex'))
  const pub = ecdh.getPublicKey()
  return { x: BigInt(`0x${pub.subarray(1, 33).toString('hex')}`), y: BigInt(`0x${pub.subarray(33, 65).toString('hex')}`) }
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest()
}

export type WebAuthnAssertion = {
  authenticatorData: Hex
  /** clientDataJSON after the challenge, without the braces: what SafeWebAuthnSharedSigner rebuilds around it. */
  clientDataFields: string
  clientDataJSON: string
  r: bigint
  s: bigint
}

/**
 * Software WebAuthn authenticator over one fixed P-256 scalar (plan 19,
 * "Autenticador de software"). It produces the assertion a platform
 * authenticator would for the given challenge, with low-s signatures.
 */
export class SoftwarePasskey {
  readonly x: bigint
  readonly y: bigint
  private readonly key: KeyObject
  private signCount = 0

  constructor(scalar: Hex) {
    const { x, y } = passkeyPublicKey(scalar)
    this.x = x
    this.y = y
    const coord = (v: bigint) => b64url(Buffer.from(pad(toHex(v), { size: 32 }).slice(2), 'hex'))
    this.key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64url(Buffer.from(scalar.slice(2), 'hex')), x: coord(x), y: coord(y) }, format: 'jwk' })
  }

  /** ECDSA over sha256(message), as r and low s. */
  signRaw(message: Uint8Array): { r: bigint; s: bigint } {
    const sig = sign('sha256', message, { key: this.key, dsaEncoding: 'ieee-p1363' })
    const r = BigInt(`0x${sig.subarray(0, 32).toString('hex')}`)
    const s = BigInt(`0x${sig.subarray(32, 64).toString('hex')}`)
    return { r, s: s > P256_N / 2n ? P256_N - s : s }
  }

  assert(challenge: Hex): WebAuthnAssertion {
    this.signCount++
    const authenticatorData = concat([toHex(sha256(RP_ID)), numberToHex(FLAGS_UP_UV, { size: 1 }), numberToHex(this.signCount, { size: 4 })])
    const clientDataFields = `"origin":"${ORIGIN}","crossOrigin":false`
    const clientDataJSON = `{"type":"webauthn.get","challenge":"${b64url(Buffer.from(challenge.slice(2), 'hex'))}",${clientDataFields}}`
    const { r, s } = this.signRaw(Buffer.concat([Buffer.from(authenticatorData.slice(2), 'hex'), sha256(clientDataJSON)]))
    return { authenticatorData, clientDataFields, clientDataJSON, r, s }
  }
}

/** The WebAuthn signature SafeWebAuthnSharedSigner decodes: abi.encode(bytes, string, uint256, uint256). */
export function encodeWebAuthnSignature(a: WebAuthnAssertion): Hex {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }], [a.authenticatorData, a.clientDataFields, a.r, a.s])
}

/**
 * One Safe contract signature (v = 0) from `signer`: the static part points
 * at offset 65, where the length-prefixed signer data follows.
 */
export function safeContractSignature(signer: Address, data: Hex): Hex {
  return concat([pad(signer, { size: 32 }), numberToHex(65, { size: 32 }), '0x00', numberToHex(size(data), { size: 32 }), data])
}

/** Input of the RIP-7212 precompile and of the P256Verifier fallback: hash, r, s, x, y. */
export function p256VerifyInput(hash: Hex, sig: { r: bigint; s: bigint }, key: { x: bigint; y: bigint }): Hex {
  return concat([pad(hash, { size: 32 }), ...[sig.r, sig.s, key.x, key.y].map((v) => numberToHex(v, { size: 32 }))])
}

/** A valid vector from the software passkey, and the same vector with the message changed. */
export function p256Vectors(passkey: SoftwarePasskey): { valid: Hex; tampered: Hex } {
  const message = Buffer.from('mamoru LAB-08 P-256 vector')
  const hash = toHex(sha256(message))
  const sig = passkey.signRaw(message)
  const tampered = toHex(sha256(Buffer.from('mamoru LAB-08 P-256 vector, altered')))
  return { valid: p256VerifyInput(hash, sig, passkey), tampered: p256VerifyInput(tampered, sig, passkey) }
}

export type P256Check = { available: boolean; precompile: boolean; fallback: boolean; fallbackCode: number; detail: string }

const ONE = pad('0x01', { size: 32 })

/**
 * FR-LAB-010: the fork verifies P-256 if the RIP-7212 precompile or the pinned
 * P256Verifier accepts the software passkey's vector and refuses the altered one.
 * The precompile has no code, so only the vector can show it.
 */
export async function checkP256(client: PublicClient, passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)): Promise<P256Check> {
  const v = p256Vectors(passkey)
  const verifies = async (to: Address) => {
    const ask = (data: Hex) => client.call({ to, data }).then((r) => r.data === ONE, () => false)
    return (await ask(v.valid)) && !(await ask(v.tampered))
  }
  const fallbackAddress = address('P256Verifier')
  const code = await client.getCode({ address: fallbackAddress })
  const fallbackCode = code ? size(code) : 0
  const precompile = await verifies(pad(numberToHex(P256_PRECOMPILE), { size: 20 }))
  const fallback = fallbackCode > 0 && (await verifies(fallbackAddress))
  const detail = `precompile 0x100 ${precompile ? 'verifies' : 'does not verify'}; P256Verifier ${fallbackCode ? `${fallbackCode} bytes, ${fallback ? 'verifies' : 'does not verify'}` : 'has no code'}`
  return { available: precompile || fallback, precompile, fallback, fallbackCode, detail }
}

/** The owner signature SafeWebAuthnSharedSigner accepts for a Safe transaction: a WebAuthn assertion over the SafeTx hash. */
export function signSafeTxWithPasskey(passkey: SoftwarePasskey, safe: Address, chainId: number, tx: SafeTx): Hex {
  const challenge = hashTypedData(safeTxTypedData(safe, chainId, tx))
  return safeContractSignature(address('SafeWebAuthnSharedSigner'), encodeWebAuthnSignature(passkey.assert(challenge)))
}
