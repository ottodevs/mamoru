import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { zeroAddress } from 'viem'
import { address, ethereumRegistry, registryFor } from '@mamoru/registry'
import { decodeInitV4, encodeInitV4, GAS_CAPS_V2_BY_CHAIN, oneAuthV4Deployment, V4_CHAIN_BY_DOMAIN, V4_DOMAIN_BY_CHAIN, V4_PINNED } from './index.ts'

const CHAINS_SOL = readFileSync(new URL('../../../contracts/action-policy/src/MamoruV4Chains.sol', import.meta.url), 'utf8')
const HOME = '0x000000000000000000000000000000000000cafe' as const

describe('Ethereum in the V4 tables (otto/mamoru#307, #308)', () => {
  test('domain 0 is Ethereum both ways, and an unpinned chain or domain is absent, never 0', () => {
    expect(V4_DOMAIN_BY_CHAIN[1]).toBe(0)
    expect(V4_CHAIN_BY_DOMAIN[0]).toBe(1)
    expect(V4_DOMAIN_BY_CHAIN[42161]).toBeUndefined()
    expect(V4_CHAIN_BY_DOMAIN[3]).toBeUndefined()
    for (const [chain, domain] of Object.entries(V4_DOMAIN_BY_CHAIN)) expect(V4_CHAIN_BY_DOMAIN[domain]).toBe(Number(chain))
  })

  test('the pinned tokens and the Uniswap periphery match MamoruV4Chains.sol, from the ethereum registry', () => {
    const block = CHAINS_SOL.slice(CHAINS_SOL.indexOf('chainId == ETHEREUM'))
    for (const name of [...V4_PINNED[1]!.stables, ...V4_PINNED[1]!.assets, 'UniswapV3Factory', 'NonfungiblePositionManager', 'SwapRouter02']) {
      expect(block.toLowerCase()).toContain(address(name, ethereumRegistry).toLowerCase())
    }
    expect(block).toContain('c.domain = 0;')
    expect(V4_PINNED[1]!.stables).toEqual(['USDC']) // USDT left out: CCTP burn limit 0 on Ethereum
  })

  test("the L1 gas caps are MamoruV4Chains' remoteCaps for Ethereum, under its GAS_REVIEW", () => {
    const c = GAS_CAPS_V2_BY_CHAIN[1]!
    expect(CHAINS_SOL).toContain('GasCaps(100_000_000, 3_000_000, 2_000_000, 200_000, 5_000_000_000, 0, 0.01 ether, 1 days)')
    expect([c.maxPriorityFeePerGas, c.maxVerificationGasLimit, c.maxCallGasLimit, c.maxPreVerificationGas, c.maxFeePerGas, c.maxPaymasterGas]).toEqual([100_000_000n, 3_000_000n, 2_000_000n, 200_000n, 5_000_000_000n, 0n])
    expect(c.perWindow).toBe(10n ** 16n)
    expect(c.window).toBe(86_400)
    expect(CHAINS_SOL).toContain('c.gasReview = 0.02 ether;')
  })

  test('the ethereum registry resolves, and V4 is not pinned there until T7 deploys it', () => {
    expect(registryFor(1)).toBe(ethereumRegistry)
    expect(oneAuthV4Deployment(ethereumRegistry)).toBeNull()
  })
})

describe('encodeInitV4 follows V4 BadInit(4) with domain 0 (#307)', () => {
  const init = (home: `0x${string}`, homeDomain: number) => ({ capUsd: 1_000_000n, generation: 1n, home, homeDomain, admit: [] })

  test('a home account: no home, domain 0', () => {
    expect(decodeInitV4(encodeInitV4(init(zeroAddress, 0))).homeDomain).toBe(0)
  })

  test('a home account naming a home domain is refused', () => {
    expect(() => encodeInitV4(init(zeroAddress, 6))).toThrow('names no home domain')
  })

  test('a remote or a sibling whose home is on Ethereum (domain 0) is accepted', () => {
    expect(decodeInitV4(encodeInitV4(init(HOME, 0))).homeDomain).toBe(0)
  })

  test('a sibling on Ethereum whose home is Base (domain 6) is accepted', () => {
    const d = decodeInitV4(encodeInitV4(init(HOME, 6)))
    expect([d.home.toLowerCase(), d.homeDomain]).toEqual([HOME, 6])
  })

  test('a home domain outside the table is refused', () => {
    expect(() => encodeInitV4(init(HOME, 3))).toThrow("not a chain of V4's table")
  })
})
