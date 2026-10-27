import { concat, encodeFunctionData, getAddress, hexToBigInt, keccak256, pad, recoverAddress, type PublicClient, parseEventLogs, sliceHex, type Hex, type Log } from 'viem'
import type { Address } from '@mamoru/domain'
import { erc20Abi, messageTransmitterV2Abi, tokenMessengerV2Abi } from '@mamoru/registry'

// CCTP V2 as a route of the L1 userOp (otto/mamoru#180). Native USDC burned on Ethereum, minted to the same Safe on
// Base. destinationCaller is open (zero) and there is no hook: once Circle attests the burn, the operator submits
// receiveMessage on Base itself (Base gas is cents). Circle's Forwarding Service is not used: it charges a USDC fee
// out of the transfer and needs depositForBurnWithHook, which the design forbids. Fork-proven in
// test/e2e-l1-userop.ts, mint included (a fork attester).

/** TokenMessengerV2, same address on Ethereum and Base. */
export const TOKEN_MESSENGER_V2: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
export const CCTP_DOMAIN_ETHEREUM = 0
export const CCTP_DOMAIN_BASE = 6
/** otto/mamoru#215: MessageTransmitterV2.localDomain() on Monad (chain 143), read 2026-10-27. */
export const CCTP_DOMAIN_MONAD = 15
/** Standard transfer (finalized, ~15 min from Ethereum, no fee); 1000 is Fast (fee from Circle's fee API). */
export const FINALITY_STANDARD = 2000
export const FINALITY_FAST = 1000
export const IRIS_API = 'https://iris-api.circle.com'
/** MessageTransmitterV2, same address on Ethereum and Base. */
export const MESSAGE_TRANSMITTER_V2: Address = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'
/** Ethereum finality: Standard transfers are attested after ~13-19 minutes. */
export const STANDARD_FILL_SEC = 1_200
export const FAST_FILL_SEC = 30

// The ABIs live in the registry package (otto/mamoru#215: the engine builds Base -> Monad burns from them too).
export { messageTransmitterV2Abi, tokenMessengerV2Abi }

export type Burn = { amount: bigint; maxFee: bigint; minFinality: number }

/** approve exactly the amount, then depositForBurn to the same address on Base, any caller may mint, no hook. */
export function cctpCalls(usdc: Address, safe: Address, b: Burn): { to: Address; value: bigint; data: Hex }[] {
  if (b.maxFee >= b.amount) throw new Error('fee must be below the amount')
  return [
    { to: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TOKEN_MESSENGER_V2, b.amount] }) },
    {
      to: TOKEN_MESSENGER_V2,
      value: 0n,
      data: encodeFunctionData({ abi: tokenMessengerV2Abi, functionName: 'depositForBurn', args: [b.amount, CCTP_DOMAIN_BASE, pad(safe, { size: 32 }), usdc, `0x${'00'.repeat(32)}`, b.maxFee, b.minFinality] }),
    },
  ]
}

/**
 * True when the logs hold exactly one burn of the signed amount from the Safe to itself on `destinationDomain` (Base
 * unless said), open caller, no hook.
 */
export function burnMatches(logs: Log[], usdc: Address, safe: Address, b: Burn, destinationDomain: number = CCTP_DOMAIN_BASE): boolean {
  const evs = parseEventLogs({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', logs: logs.filter((l) => getAddress(l.address) === TOKEN_MESSENGER_V2) })
  if (evs.length !== 1) return false
  const a = evs[0]!.args
  return (
    getAddress(a.burnToken) === getAddress(usdc) &&
    getAddress(a.depositor) === getAddress(safe) &&
    a.amount === b.amount &&
    a.mintRecipient.toLowerCase() === pad(safe, { size: 32 }).toLowerCase() &&
    a.destinationDomain === destinationDomain &&
    BigInt(a.destinationCaller) === 0n &&
    a.maxFee === b.maxFee &&
    a.minFinalityThreshold === b.minFinality &&
    a.hookData === '0x'
  )
}

/**
 * Circle's complete attestations for the burn transaction (empty while pending), each with the message to mint.
 * Null when Circle did not answer. The caller picks the one that is its burn. `sourceDomain`: where the burn was
 * (Ethereum unless said; otto/mamoru#215 asks for Base's, 6).
 */
export async function cctpAttestation(txHash: Hex, fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch, sourceDomain: number = CCTP_DOMAIN_ETHEREUM): Promise<{ message: Hex; attestation: Hex }[] | null> {
  const res = await fetcher(`${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${txHash}`, { signal: AbortSignal.timeout(8_000) })
  if (res.status === 404) return []
  if (!res.ok) return null
  const j = (await res.json()) as { messages?: { status?: string; message?: string; attestation?: string }[] }
  return (j.messages ?? []).flatMap((m) => (m.status === 'complete' && /^0x[0-9a-fA-F]+$/.test(m.message ?? '') && /^0x[0-9a-fA-F]+$/.test(m.attestation ?? '') ? [{ message: m.message as Hex, attestation: m.attestation as Hex }] : []))
}

/** What Circle charges per finality threshold, in basis points (GET /v2/burn/USDC/fees/0/6). */
export async function cctpFees(fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch): Promise<{ finalityThreshold: number; minimumFeeBps: number }[]> {
  const res = await fetcher(`${IRIS_API}/v2/burn/USDC/fees/${CCTP_DOMAIN_ETHEREUM}/${CCTP_DOMAIN_BASE}`, { signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`fees ${res.status}`)
  const j = (await res.json()) as { finalityThreshold?: unknown; minimumFee?: unknown }[]
  if (!Array.isArray(j)) throw new Error('fees: not a list')
  return j.flatMap((x) => (typeof x.finalityThreshold === 'number' && typeof x.minimumFee === 'number' && x.minimumFee >= 0 ? [{ finalityThreshold: x.finalityThreshold, minimumFeeBps: x.minimumFee }] : []))
}

/** maxFee for a burn: the fee in bps of the amount, rounded up to a whole base unit. */
export function cctpMaxFee(amount: bigint, bps: number): bigint {
  const micro = BigInt(Math.ceil(bps * 1_000_000))
  return (amount * micro + 10_000_000_000n - 1n) / 10_000_000_000n
}

export type CctpMessage = { sourceDomain: number; destinationDomain: number; nonce: Hex; sender: Hex; recipient: Hex; destinationCaller: Hex; burnToken: Hex; mintRecipient: Hex; amount: bigint; messageSender: Hex; maxFee: bigint }

/** MessageV2 header (148 bytes) and BurnMessageV2 body, as MessageTransmitterV2 and TokenMessengerV2 lay them out. */
export function decodeCctpMessage(m: Hex): CctpMessage {
  const n = (m.length - 2) / 2
  if (n < 148 + 228) throw new Error('CCTP message too short')
  const at = (o: number, len: number) => sliceHex(m, o, o + len, { strict: true })
  return {
    sourceDomain: Number(hexToBigInt(at(4, 4))),
    destinationDomain: Number(hexToBigInt(at(8, 4))),
    nonce: at(12, 32),
    sender: at(44, 32),
    recipient: at(76, 32),
    destinationCaller: at(108, 32),
    burnToken: at(148 + 4, 32),
    mintRecipient: at(148 + 36, 32),
    amount: hexToBigInt(at(148 + 68, 32)),
    messageSender: at(148 + 100, 32),
    maxFee: hexToBigInt(at(148 + 132, 32)),
  }
}

/**
 * The operator pays gas for a mint only when the attested message is this account's burn: Ethereum to Base unless
 * `route` says otherwise (otto/mamoru#215: Base to Monad), from and to the TokenMessengerV2, the burned USDC (`usdc`,
 * the SOURCE chain's), the Safe as recipient, the amount burned, open caller.
 */
export function mintIsFor(m: CctpMessage, usdc: Address, safe: Address, amount: bigint, route: { source: number; destination: number } = { source: CCTP_DOMAIN_ETHEREUM, destination: CCTP_DOMAIN_BASE }): boolean {
  const w = (a: Address) => pad(a, { size: 32 }).toLowerCase()
  return (
    m.sourceDomain === route.source &&
    m.destinationDomain === route.destination &&
    m.sender.toLowerCase() === w(TOKEN_MESSENGER_V2) &&
    m.recipient.toLowerCase() === w(TOKEN_MESSENGER_V2) &&
    BigInt(m.destinationCaller) === 0n &&
    m.burnToken.toLowerCase() === w(usdc) &&
    m.mintRecipient.toLowerCase() === w(safe) &&
    m.messageSender.toLowerCase() === w(safe) &&
    m.amount === amount
  )
}

export function receiveMessageData(message: Hex, attestation: Hex): Hex {
  return encodeFunctionData({ abi: messageTransmitterV2Abi, functionName: 'receiveMessage', args: [message, attestation] })
}

/**
 * The message's identity across Ethereum and Circle: its hash with the fields Circle fills in after the burn zeroed
 * (nonce, finalityThresholdExecuted, and in the body feeExecuted and expirationBlock). The attested message of a burn
 * has the same key as the MessageSent it emitted.
 */
export function cctpMessageKey(m: Hex): Hex {
  const n = (m.length - 2) / 2
  if (n < 148 + 228) throw new Error('CCTP message too short')
  const z = (len: number): Hex => `0x${'00'.repeat(len)}`
  // hookData (after the 228-byte body) is empty for Mamoru's burns.
  const hook: Hex = n > 148 + 228 ? sliceHex(m, 148 + 228) : '0x'
  return keccak256(concat([sliceHex(m, 0, 12), z(32), sliceHex(m, 44, 144), z(4), sliceHex(m, 148, 148 + 164), z(64), hook]))
}

/**
 * Whether `attestation` is Circle's for `message`, checked the way MessageTransmitterV2 checks it, against the
 * attesters enabled on the chain `client` reads (the destination: Base, or Monad for otto/mamoru#215): 65-byte
 * signatures over keccak256(message), signers in strictly ascending order, each enabled, at least signatureThreshold
 * of them. Only then are the message's fields (its nonce among them) trusted.
 */
export async function attestationValid(client: PublicClient, message: Hex, attestation: Hex): Promise<boolean> {
  const n = (attestation.length - 2) / 2
  if (n === 0 || n % 65 !== 0) return false
  const hash = keccak256(message)
  const threshold = await client.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'signatureThreshold' })
  if (BigInt(n / 65) < threshold || threshold === 0n) return false
  let last = 0n
  for (let i = 0; i < n / 65; i++) {
    let signer: Address
    try {
      signer = await recoverAddress({ hash, signature: sliceHex(attestation, i * 65, i * 65 + 65, { strict: true }) })
    } catch {
      return false
    }
    if (BigInt(signer) <= last) return false
    last = BigInt(signer)
    if (!(await client.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'isEnabledAttester', args: [signer] }))) return false
  }
  return true
}
