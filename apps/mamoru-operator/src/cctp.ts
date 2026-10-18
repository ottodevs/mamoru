import { encodeFunctionData, getAddress, pad, parseAbi, parseEventLogs, type Hex, type Log } from 'viem'
import type { Address } from '@mamoru/domain'
import { erc20Abi } from '@mamoru/registry'

// CCTP V2 as a route of the L1 userOp (otto/mamoru#180). Native USDC burned on Ethereum, minted to the same Safe on
// Base. Fork-proven in test/e2e-l1-userop.ts; not yet offered by BridgeOut: the default route is a decision for Ot
// (design §5.2), and the mint on Base needs receiveMessage with Circle's attestation (destinationCaller is open, so
// the account's own Base userOp or any relayer can submit it).

/** TokenMessengerV2, same address on Ethereum and Base. */
export const TOKEN_MESSENGER_V2: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
export const CCTP_DOMAIN_ETHEREUM = 0
export const CCTP_DOMAIN_BASE = 6
/** Standard transfer (finalized, ~15 min from Ethereum, no fee); 1000 is Fast (fee from Circle's fee API). */
export const FINALITY_STANDARD = 2000
export const FINALITY_FAST = 1000
export const IRIS_API = 'https://iris-api.circle.com'

export const tokenMessengerV2Abi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
])

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

/** True when the logs hold exactly one burn of the signed amount from the Safe to itself on Base, open caller, no hook. */
export function burnMatches(logs: Log[], usdc: Address, safe: Address, b: Burn): boolean {
  const evs = parseEventLogs({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', logs: logs.filter((l) => getAddress(l.address) === TOKEN_MESSENGER_V2) })
  if (evs.length !== 1) return false
  const a = evs[0]!.args
  return (
    getAddress(a.burnToken) === getAddress(usdc) &&
    getAddress(a.depositor) === getAddress(safe) &&
    a.amount === b.amount &&
    a.mintRecipient.toLowerCase() === pad(safe, { size: 32 }).toLowerCase() &&
    a.destinationDomain === CCTP_DOMAIN_BASE &&
    BigInt(a.destinationCaller) === 0n &&
    a.maxFee === b.maxFee &&
    a.minFinalityThreshold === b.minFinality &&
    a.hookData === '0x'
  )
}

/** Circle's attestation for the burn transaction: pending until 'complete', then the message and attestation to mint. */
export async function cctpAttestation(txHash: Hex, fetcher: typeof fetch = fetch): Promise<{ status: 'pending' | 'complete'; message?: Hex; attestation?: Hex } | null> {
  const res = await fetcher(`${IRIS_API}/v2/messages/${CCTP_DOMAIN_ETHEREUM}?transactionHash=${txHash}`, { signal: AbortSignal.timeout(8_000) })
  if (res.status === 404) return { status: 'pending' }
  if (!res.ok) return null
  const j = (await res.json()) as { messages?: { status?: string; message?: string; attestation?: string }[] }
  const m = j.messages?.[0]
  if (!m) return { status: 'pending' }
  if (m.status !== 'complete' || !m.message?.startsWith('0x') || !m.attestation?.startsWith('0x')) return { status: 'pending' }
  return { status: 'complete', message: m.message as Hex, attestation: m.attestation as Hex }
}
