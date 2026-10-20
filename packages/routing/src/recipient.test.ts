import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, parseAbi } from 'viem'
import { calldataPinsRecipientAtWord, parseDeclaredAddress, wordAt } from './recipient.ts'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const

const abi = parseAbi(['function send(address to, uint256 amount) returns (bool)'])
const sendTo = (to: `0x${string}`) => encodeFunctionData({ abi, functionName: 'send', args: [to, 150_000_000n] })

// otto/mamoru#181, review round 4: this file used to also test `calldataPinsRecipient` and
// `assertOwnerOnlyRecipient`, a generic "scan every word for the account" check. It was removed from recipient.ts
// entirely after direct testing showed it made Relay's and deBridge's recipient checks into no-ops (see their
// module comments) — no adapter in this package may rely on a generic scan for a recipient claim again. What
// remains are exact-position reads only, used at offsets a provider's calldata shape was actually confirmed
// (by direct testing) to place a specific field at.

describe('wordAt / calldataPinsRecipientAtWord', () => {
  test('reads the exact word at an index', () => {
    const data = sendTo(ACCOUNT) // send(address to, uint256 amount): word 0 is `to`, word 1 is `amount`
    expect(calldataPinsRecipientAtWord(data, ACCOUNT, 0)).toBe(true)
    expect(calldataPinsRecipientAtWord(data, ACCOUNT, 1)).toBe(false) // the account is not the amount
  })

  test('a decoy at an unrelated word does not satisfy an exact-offset check', () => {
    const abiWithExtra = parseAbi(['function send(address to, uint256 amount, bytes32 memo) returns (bool)'])
    const decoy = encodeFunctionData({ abi: abiWithExtra, functionName: 'send', args: [OTHER, 150_000_000n, `0x${'0'.repeat(24)}${ACCOUNT.slice(2).toLowerCase()}`] })
    expect(calldataPinsRecipientAtWord(decoy, ACCOUNT, 0)).toBe(false) // word 0 is OTHER, not ACCOUNT
  })

  test('does not match an address that is right-padded within its word instead of left-padded', () => {
    // otto/mamoru#181, review round 3: the precise bug that made debridge.ts's recipient check a no-op before
    // it was made quote-only — a plain `address` argument is always left-padded; some encodings are not.
    const rightPadded: `0x${string}` = `0xaabbccdd${ACCOUNT.slice(2).toLowerCase()}${'0'.repeat(24)}`
    expect(calldataPinsRecipientAtWord(rightPadded, ACCOUNT, 0)).toBe(false)
  })

  test('out of range or malformed calldata is undefined/false, never a throw', () => {
    expect(wordAt(sendTo(ACCOUNT), 5)).toBeUndefined()
    expect(wordAt('0xaabbccdd', 0)).toBeUndefined()
    expect(calldataPinsRecipientAtWord('0xaabbccdd', ACCOUNT, 0)).toBe(false)
  })

  test('refuses calldata whose body is not a whole number of 32-byte words', () => {
    const truncated = sendTo(ACCOUNT).slice(0, -2) as `0x${string}` // drop the last byte: no longer word-aligned
    expect(wordAt(truncated, 0)).toBeUndefined()
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
