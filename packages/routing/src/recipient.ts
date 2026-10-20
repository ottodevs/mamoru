import { getAddress, type Address, type Hex } from 'viem'

// otto/mamoru#181. REMOVED (review round 4, 20 Oct 2026): this module used to export `calldataPinsRecipient` and
// `assertOwnerOnlyRecipient`, a generic "scan every 32-byte word of the calldata for the account" check used by
// every owner-only adapter. It was found, by direct testing, to not actually prove what it claimed: it cannot
// tell "the real recipient argument" from "the account's bytes appear somewhere in this call" without knowing
// the exact argument position in advance, and in practice this made Relay's and deBridge's recipient checks
// into no-ops (Relay's calldata carries only the depositor, never the recipient; deBridge's recipient argument
// is right-padded inside its word and the scan's left-padded match never found it at all) — both routes are
// quote-only now (see relay.ts, debridge.ts). LI.FI's generic-scan check happened to be backed by its own
// declared `action.toAddress` field, so it was not actually broken the same way, but kept the same risk for the
// future: a provider could change its calldata shape and the scan would start passing for the wrong reason
// again, silently. lifi.ts now decodes LI.FI's actual `ILiFi.BridgeData` struct (the same way LI.FI's own
// on-chain `CalldataVerificationFacet.extractBridgeData` does, generically across every facet) and checks
// `receiver` at its real, known field position — no scanning, no adapter in this package may rely on a generic
// "is the account anywhere in this calldata" check again.
//
// What remains below are exact-position reads only: `wordAt` (used by relay.ts to check specific ABI-encoded
// fields — token, amount — at offsets confirmed stable by direct testing) and `parseDeclaredAddress` (used by
// lifi.ts as a cheap extra consistency check against LI.FI's own declared recipient field, on top of — never
// instead of — decoding BridgeData.receiver itself).

/** The word at `wordIndex` (0-based) of the calldata body, after the 4-byte selector — or undefined when the
 * calldata is too short or not whole-word ABI encoding. Only ever used at an offset a provider's calldata shape
 * was actually confirmed to place a specific field at (verified empirically, not assumed) — never to scan for
 * a value at an unknown position. */
export function wordAt(calldata: Hex, wordIndex: number): string | undefined {
  const hex = calldata.slice(2).toLowerCase()
  if (hex.length <= 8) return undefined
  const body = hex.slice(8)
  if (body.length % 64 !== 0) return undefined
  const start = wordIndex * 64
  if (start + 64 > body.length) return undefined
  return body.slice(start, start + 64)
}

/** Whether the word at `wordIndex` is exactly `account`, left-padded. */
export function calldataPinsRecipientAtWord(calldata: Hex, account: Address, wordIndex: number): boolean {
  return wordAt(calldata, wordIndex) === account.slice(2).toLowerCase().padStart(64, '0')
}

/** Parses and checksums an address a provider returned in its own JSON (e.g. a declared `recipient` or `user`
 * field), or returns undefined for anything malformed rather than throwing. */
export function parseDeclaredAddress(value: unknown): Address | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return getAddress(value)
  } catch {
    return undefined
  }
}
