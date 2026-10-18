import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, parseAbi } from 'viem'
import { assertOwnerOnlyRecipient, calldataPinsRecipient, calldataPinsRecipientAtWord, parseDeclaredAddress, wordAt } from './recipient.ts'
import { RouteError } from './errors.ts'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const

const abi = parseAbi(['function send(address to, uint256 amount) returns (bool)'])
const sendTo = (to: `0x${string}`) => encodeFunctionData({ abi, functionName: 'send', args: [to, 150_000_000n] })

describe('calldataPinsRecipient', () => {
  test('finds the account as one of the ABI-encoded words', () => {
    expect(calldataPinsRecipient(sendTo(ACCOUNT), ACCOUNT)).toBe(true)
  })

  test('does not find an account that is not in the calldata', () => {
    expect(calldataPinsRecipient(sendTo(OTHER), ACCOUNT)).toBe(false)
  })

  test('calldata with no body (just a selector) never matches', () => {
    expect(calldataPinsRecipient('0xaabbccdd', ACCOUNT)).toBe(false)
  })

  test('refuses calldata whose body is not a whole number of 32-byte words, even if truncating happens to leave a matching prefix', () => {
    const truncated = sendTo(ACCOUNT).slice(0, -2) as `0x${string}` // drop the last byte: no longer word-aligned
    expect(calldataPinsRecipient(truncated, ACCOUNT)).toBe(false)
  })

  test('known, accepted limitation: a decoy copy of the account elsewhere in the calldata still counts as a match', () => {
    // This function cannot tell "the real recipient argument" from "the account's bytes appear somewhere in this
    // call" without knowing the selector ahead of time — which is exactly why Relay/LI.FI/deBridge are owner-only
    // rather than session-key (see the module doc comment). A call to `send(other, amount)` with the account's
    // address packed into an unrelated trailing word still passes this check; the owner's own review of the
    // decoded transaction before signing is the real backstop for owner-only routes, not this function.
    const abiWithExtra = parseAbi(['function send(address to, uint256 amount, bytes32 memo) returns (bool)'])
    const decoy = encodeFunctionData({ abi: abiWithExtra, functionName: 'send', args: [OTHER, 150_000_000n, `0x${'0'.repeat(24)}${ACCOUNT.slice(2).toLowerCase()}`] })
    expect(calldataPinsRecipient(decoy, ACCOUNT)).toBe(true) // true, not false — documented, not a surprise
  })
})

describe('wordAt / calldataPinsRecipientAtWord', () => {
  test('reads the exact word at an index, unlike the scan this backs for providers with a confirmed fixed offset', () => {
    const data = sendTo(ACCOUNT) // send(address to, uint256 amount): word 0 is `to`, word 1 is `amount`
    expect(calldataPinsRecipientAtWord(data, ACCOUNT, 0)).toBe(true)
    expect(calldataPinsRecipientAtWord(data, ACCOUNT, 1)).toBe(false) // the account is not the amount
  })

  test('a decoy at the WRONG word does not satisfy an exact-offset check, unlike the generic scan', () => {
    const abiWithExtra = parseAbi(['function send(address to, uint256 amount, bytes32 memo) returns (bool)'])
    const decoy = encodeFunctionData({ abi: abiWithExtra, functionName: 'send', args: [OTHER, 150_000_000n, `0x${'0'.repeat(24)}${ACCOUNT.slice(2).toLowerCase()}`] })
    expect(calldataPinsRecipient(decoy, ACCOUNT)).toBe(true) // the generic scan is fooled (documented above)
    expect(calldataPinsRecipientAtWord(decoy, ACCOUNT, 0)).toBe(false) // the exact-offset check is not: word 0 is OTHER
  })

  test('out of range or malformed calldata is undefined/false, never a throw', () => {
    expect(wordAt(sendTo(ACCOUNT), 5)).toBeUndefined()
    expect(wordAt('0xaabbccdd', 0)).toBeUndefined()
    expect(calldataPinsRecipientAtWord('0xaabbccdd', ACCOUNT, 0)).toBe(false)
  })
})

describe('parseDeclaredAddress', () => {
  test('checksums a valid address', () => {
    expect(parseDeclaredAddress(ACCOUNT.toLowerCase())).toBe(ACCOUNT)
  })

  test('anything malformed is undefined, not a throw', () => {
    expect(parseDeclaredAddress('not-an-address')).toBeUndefined()
    expect(parseDeclaredAddress(undefined)).toBeUndefined()
    expect(parseDeclaredAddress(42)).toBeUndefined()
  })
})

describe('assertOwnerOnlyRecipient', () => {
  test('passes when the declared recipient and the calldata both agree with the account', () => {
    expect(() => assertOwnerOnlyRecipient('relay', ACCOUNT, sendTo(ACCOUNT), ACCOUNT)).not.toThrow()
  })

  test('passes with no declared recipient, as long as the calldata carries the account', () => {
    expect(() => assertOwnerOnlyRecipient('relay', ACCOUNT, sendTo(ACCOUNT))).not.toThrow()
  })

  test('refuses when the declared recipient is a different address', () => {
    expect(() => assertOwnerOnlyRecipient('relay', ACCOUNT, sendTo(ACCOUNT), OTHER)).toThrow(RouteError)
  })

  test('refuses when the calldata does not actually carry the account, even if declared matches', () => {
    expect(() => assertOwnerOnlyRecipient('relay', ACCOUNT, sendTo(OTHER), ACCOUNT)).toThrow(RouteError)
  })
})
