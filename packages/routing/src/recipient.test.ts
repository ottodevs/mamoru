import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, parseAbi } from 'viem'
import { assertOwnerOnlyRecipient, calldataPinsRecipient, parseDeclaredAddress } from './recipient.ts'
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
