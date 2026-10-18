import { getAddress, type Address, type Hex } from 'viem'
import { RouteError } from './errors.ts'

/** otto/mamoru#181. The owner-only check that stands in for a session policy when a provider (Relay, LI.FI,
 * deBridge — any aggregator that picks a solver or route per request) cannot offer a fixed calldata offset ahead
 * of time. A `UniActionPolicy` EQUAL rule reads one 32-byte word at a known offset; this does the same check but
 * without knowing the offset in advance, by scanning every word of the calldata after the 4-byte selector. If the
 * account's address is not one of those words, the quote is not safe to show the owner as "send to yourself" and
 * must be refused — never returned, never signed.
 *
 * This is an app-side sanity check, not a cryptographic guarantee: a provider could in principle hide a different
 * effective recipient behind a contract that reads the word for something else. It catches the honest-mistake and
 * wrong-account cases (stale cache, swapped request field, a provider that silently defaults to its own relayer),
 * which is what owner review is for — the owner still sees and signs the real calldata.
 */
export function calldataPinsRecipient(calldata: Hex, account: Address): boolean {
  const hex = calldata.slice(2).toLowerCase()
  if (hex.length <= 8) return false
  const body = hex.slice(8) // drop the 4-byte function selector
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
