import { getAddress, type Address, type Hex } from 'viem'
import { RouteError } from './errors.ts'

/** otto/mamoru#181. The owner-only check that stands in for a session policy when a provider (Relay, LI.FI,
 * deBridge — any aggregator that picks a solver or route per request) cannot offer a fixed calldata offset ahead
 * of time. A `UniActionPolicy` EQUAL rule reads one 32-byte word at a known offset; this does the same check but
 * without knowing the offset in advance, by scanning every full word of the calldata after the 4-byte selector.
 * If the account's address is not one of those words, the quote is not safe to show the owner as "send to
 * yourself" and must be refused — never returned, never signed.
 *
 * This is deliberately NOT the same guarantee an EQUAL-pinned session policy gives CCTP/Across: those two are
 * session-key precisely because their target, selector and recipient offset are fixed ahead of time; Relay,
 * LI.FI and deBridge pick a different underlying route (and selector) per request, which is exactly why they are
 * owner-only instead. Pinning a selector or argument offset here would mean maintaining an allowlist of every
 * selector any of these aggregators might ever choose — undoing the reason they're useful. The real security
 * boundary for an owner-only route is the owner's own passkey-signed review of the decoded transaction before
 * anything executes (a future, UI-side ticket); this function is an early, app-side filter that catches the
 * honest-mistake and wrong-account cases (stale cache, swapped request field, a provider defaulting to its own
 * relayer) before a bad quote is even shown — not a cryptographic substitute for that review.
 *
 * Calldata that is not whole-word ABI encoding (not a 4-byte selector followed by a whole number of 32-byte
 * words) is refused outright: anything a provider returns is expected to decode cleanly as a normal contract
 * call, and malformed/truncated bytes are never scanned for a "lucky" match.
 */
export function calldataPinsRecipient(calldata: Hex, account: Address): boolean {
  const hex = calldata.slice(2).toLowerCase()
  if (hex.length <= 8) return false
  const body = hex.slice(8) // drop the 4-byte function selector
  if (body.length % 64 !== 0) return false // not whole-word ABI encoding; never scan it for a match
  const word = account.slice(2).toLowerCase().padStart(64, '0')
  for (let i = 0; i + 64 <= body.length; i += 64) {
    if (body.slice(i, i + 64) === word) return true
  }
  return false
}

/** Parses and checksums an address a provider returned in its own JSON (e.g. a declared `recipient` or `user`
 * field), or returns undefined for anything malformed rather than throwing — callers treat undefined as "the
 * provider did not declare one" and fall through to the calldata scan alone. */
export function parseDeclaredAddress(value: unknown): Address | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return getAddress(value)
  } catch {
    return undefined
  }
}

/** The combined owner-only recipient check used by every aggregator adapter: the provider's own declared recipient
 * (when it has one) must equal the account, AND the account's address must be decodable out of the calldata the
 * provider wants signed. Either failing throws RouteError(provider, 'RECIPIENT_REFUSED', ...) — the same error
 * type every other refusal in this package uses, so a caller quoting several providers handles this refusal no
 * differently from a provider that was simply down (see selector.ts `quoteAll`). */
export function assertOwnerOnlyRecipient(provider: string, account: Address, calldata: Hex, declared?: Address): void {
  if (declared !== undefined && getAddress(declared) !== getAddress(account)) {
    throw new RouteError(provider, 'RECIPIENT_REFUSED', `declared recipient ${declared} is not the account ${account}`)
  }
  if (!calldataPinsRecipient(calldata, account)) {
    throw new RouteError(provider, 'RECIPIENT_REFUSED', 'the account address does not appear in the calldata to be signed')
  }
}
