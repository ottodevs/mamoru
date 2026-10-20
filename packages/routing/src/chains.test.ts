import { describe, expect, test } from 'bun:test'
import { BASE_CHAIN_ID, ETHEREUM_CHAIN_ID, MONAD_CHAIN_ID, NATIVE_ASSET_ADDRESS, tokenAddress } from './chains.ts'

describe('tokenAddress', () => {
  test('ETH resolves on Ethereum and Base, whose native asset is confirmed ETH', () => {
    expect(tokenAddress('ETH', ETHEREUM_CHAIN_ID)).toBe(NATIVE_ASSET_ADDRESS)
    expect(tokenAddress('ETH', BASE_CHAIN_ID)).toBe(NATIVE_ASSET_ADDRESS)
  })

  // otto/mamoru#181 fix: a review caught that tokenAddress('ETH', 143) used to return the native pseudo-address
  // unconditionally, which would have let a caller ask Relay/LI.FI/deBridge to "bridge ETH" to or from Monad —
  // whose native asset is MON, not ETH. ETH does not natively exist on Monad at all.
  test("ETH is undefined on Monad: its native asset is MON, not ETH", () => {
    expect(tokenAddress('ETH', MONAD_CHAIN_ID)).toBeUndefined()
  })

  test('ETH is undefined on any chain not in the registry at all — never assumed', () => {
    expect(tokenAddress('ETH', 42161)).toBeUndefined() // Arbitrum: likely ETH-native in reality, but unverified here
  })

  test('USDC resolves only for chains the registry actually covers', () => {
    expect(tokenAddress('USDC', ETHEREUM_CHAIN_ID)).toBeDefined()
    expect(tokenAddress('USDC', MONAD_CHAIN_ID)).toBeDefined()
    expect(tokenAddress('USDC', 42161)).toBeUndefined()
  })
})
