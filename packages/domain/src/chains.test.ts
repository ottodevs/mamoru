import { describe, expect, test } from 'bun:test'
import { BASE_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, chainOf, FORBIDDEN_LAB_CHAIN_IDS, isChainId, ReasonError, SUPPORTED_CHAINS } from './index.ts'

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    return e instanceof ReasonError ? e.code : undefined
  }
  return undefined
}

describe('chain descriptors', () => {
  test('one descriptor per chain id, selected by id only', () => {
    expect(new Set(SUPPORTED_CHAINS.map((c) => c.chainId)).size).toBe(SUPPORTED_CHAINS.length)
    for (const c of SUPPORTED_CHAINS) {
      expect(chainOf(c.chainId)).toBe(c)
      expect(isChainId(c.chainId)).toBe(true)
    }
  })

  test('a chain id outside SUPPORTED_CHAINS is CHAIN_UNSUPPORTED, never another chain', () => {
    const outside = [10, 42161, 31337, 0, -1].filter((id) => !SUPPORTED_CHAINS.some((c) => c.chainId === id))
    for (const id of outside) {
      expect(isChainId(id)).toBe(false)
      expect(code(() => chainOf(id))).toBe('CHAIN_UNSUPPORTED')
    }
  })

  test('Base keeps the values the rest of the code assumed for it', () => {
    const base = chainOf(BASE_CHAIN_ID)
    expect(base.native.symbol).toBe('ETH')
    expect(base.finalityTag).toBe('safe')
    expect(base.gasModel).toBe('gas_used')
    expect(base.l1DataFee).toBe(true)
    expect(base.testnetChainIds).toEqual([BASE_SEPOLIA_CHAIN_ID])
  })

  test('Monad charges by gas limit and pays no L1 data fee', () => {
    const monad = chainOf(143)
    expect(monad.native.symbol).toBe('MON')
    expect(monad.gasModel).toBe('gas_limit')
    expect(monad.l1DataFee).toBe(false)
  })
})

describe('FORBIDDEN_LAB_CHAIN_IDS', () => {
  test('is derived from the descriptors: every supported chain and each of its test networks', () => {
    expect([...FORBIDDEN_LAB_CHAIN_IDS].sort((a, b) => a - b)).toEqual(
      SUPPORTED_CHAINS.flatMap((c) => [c.chainId, ...c.testnetChainIds]).sort((a, b) => a - b),
    )
  })

  test('still refuses the two ids it refused when Base was the only chain', () => {
    expect(FORBIDDEN_LAB_CHAIN_IDS).toContain(BASE_CHAIN_ID)
    expect(FORBIDDEN_LAB_CHAIN_IDS).toContain(BASE_SEPOLIA_CHAIN_ID)
  })

  test('refuses Monad mainnet and Monad testnet; the lab ids of the catalog stay allowed', () => {
    expect(FORBIDDEN_LAB_CHAIN_IDS).toContain(143)
    expect(FORBIDDEN_LAB_CHAIN_IDS).toContain(10143)
    for (const lab of [31337, 31338]) expect(FORBIDDEN_LAB_CHAIN_IDS).not.toContain(lab)
  })
})
