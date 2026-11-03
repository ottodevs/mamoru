import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { zeroAddress } from 'viem'
import { address, ethereumRegistry, registryFor } from '@mamoru/registry'
import { decodeInitV4, encodeInitV4, GAS_CAPS_V2_BY_CHAIN, oneAuthV4Deployment, V4_GAS_RATE_BY_CHAIN, V4_CHAIN_BY_DOMAIN, V4_DOMAIN_BY_CHAIN, V4_HOME_CHAINS, V4_PINNED } from './index.ts'

const CHAINS_SOL = readFileSync(new URL('../../../contracts/action-policy/src/MamoruV4Chains.sol', import.meta.url), 'utf8')
const HOME = '0x000000000000000000000000000000000000cafe' as const
/** The body of `chainId == ETHEREUM` in MamoruV4Chains.byChainId, up to the end of that branch (review r1 of #220). */
const ETH_BLOCK = (() => {
  const start = CHAINS_SOL.indexOf('} else if (chainId == ETHEREUM) {')
  const end = CHAINS_SOL.indexOf('\n        }\n    }', start)
  if (start < 0 || end < 0) throw new Error('MamoruV4Chains.sol: Ethereum branch not found')
  return CHAINS_SOL.slice(start, end)
})()

describe('Ethereum in the V4 tables (otto/mamoru#307, #308)', () => {
  test('domain 0 is Ethereum both ways, and an unpinned chain or domain is absent, never 0', () => {
    expect(V4_DOMAIN_BY_CHAIN[1]).toBe(0)
    expect(V4_CHAIN_BY_DOMAIN[0]).toBe(1)
    expect(V4_DOMAIN_BY_CHAIN[42161]).toBeUndefined()
    expect(V4_CHAIN_BY_DOMAIN[3]).toBeUndefined()
    for (const [chain, domain] of Object.entries(V4_DOMAIN_BY_CHAIN)) expect(V4_CHAIN_BY_DOMAIN[domain]).toBe(Number(chain))
    for (const [domain, chain] of Object.entries(V4_CHAIN_BY_DOMAIN)) expect(V4_DOMAIN_BY_CHAIN[chain]).toBe(Number(domain))
    // and they are MamoruV4Chains.chainOf, the Solidity's only domain -> chain map
    expect(CHAINS_SOL).toContain('return domain == 6 ? BASE : domain == 15 ? MONAD : domain == 0 ? ETHEREUM : 0;')
    expect(Object.keys(V4_CHAIN_BY_DOMAIN).map(Number).sort((a, b) => a - b)).toEqual([0, 6, 15])
  })

  test('the pinned tokens and the Uniswap periphery match MamoruV4Chains.sol, from the ethereum registry', () => {
    const block = ETH_BLOCK
    for (const name of [...V4_PINNED[1]!.stables, ...V4_PINNED[1]!.assets, 'UniswapV3Factory', 'NonfungiblePositionManager', 'SwapRouter02']) {
      expect(block.toLowerCase()).toContain(address(name, ethereumRegistry).toLowerCase())
    }
    expect(block).toContain('c.domain = 0;')
    // exactly the Solidity's stable and asset slots: USDC alone (USDT left out, CCTP burn limit 0), WETH alone
    expect(block).toContain(`c.stables = [${address('USDC', ethereumRegistry)}, address(0)];`)
    expect(block).toContain(`c.assets = [${address('WETH', ethereumRegistry)}, address(0)];`)
    expect(V4_PINNED[1]).toEqual({ stables: ['USDC'], assets: ['WETH'] })
  })

  test("the L1 gas caps are MamoruV4Chains' remoteCaps for Ethereum, and the rate (G, W) is the table's (A1)", () => {
    const c = GAS_CAPS_V2_BY_CHAIN[1]!
    const m = ETH_BLOCK.match(/GasCaps\(([^)]*)\)/)
    expect(m).not.toBeNull()
    const parts = m![1]!.split(',').map((x) => x.trim().replaceAll('_', ''))
    expect(parts).toHaveLength(6) // A1 (#317): no perWindow / window in the per-op caps
    const [prio, verif, call, pre, maxFee, pm] = parts
    expect([BigInt(prio!), BigInt(verif!), BigInt(call!), BigInt(pre!), BigInt(maxFee!), BigInt(pm!)]).toEqual([c.maxPriorityFeePerGas, c.maxVerificationGasLimit, c.maxCallGasLimit, c.maxPreVerificationGas, c.maxFeePerGas, c.maxPaymasterGas])
    expect([c.maxPriorityFeePerGas, c.maxVerificationGasLimit, c.maxCallGasLimit, c.maxPreVerificationGas, c.maxFeePerGas, c.maxPaymasterGas]).toEqual([100_000_000n, 3_000_000n, 2_000_000n, 200_000n, 5_000_000_000n, 0n])
    expect(ETH_BLOCK).toContain('(c.gasPerWindow, c.gasWindow) = (0.01 ether, 1 days);')
    expect(V4_GAS_RATE_BY_CHAIN[1]).toEqual({ perWindow: 10n ** 16n, window: 86_400 })
    expect(c).not.toHaveProperty('perWindow')
  })

  test("every chain's rate is MamoruV4Chains' (G, W)", () => {
    const want: Record<number, string> = { 8453: '(0.002 ether, 1 days)', 143: '(1 ether, 1 days)', 1: '(0.01 ether, 1 days)' }
    const wei: Record<string, bigint> = { '0.002 ether': 2n * 10n ** 15n, '1 ether': 10n ** 18n, '0.01 ether': 10n ** 16n }
    for (const [chain, txt] of Object.entries(want)) {
      expect(CHAINS_SOL).toContain(`(c.gasPerWindow, c.gasWindow) = ${txt};`)
      expect(V4_GAS_RATE_BY_CHAIN[Number(chain)]).toEqual({ perWindow: wei[txt.slice(1, txt.indexOf(','))]!, window: 86_400 })
    }
  })

  test('the ethereum registry resolves; V4 is not pinned anywhere until T8 (#348: T7 retired, A1 undeployed)', () => {
    expect(registryFor(1)).toBe(ethereumRegistry)
    expect(oneAuthV4Deployment(ethereumRegistry)).toBeNull()
    expect(oneAuthV4Deployment(registryFor(8453))).toBeNull()
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

  test('a home on Ethereum (domain 0) is refused: Ethereum hosts siblings, never a home (V4 would accept it)', () => {
    expect(V4_HOME_CHAINS).not.toContain(1)
    expect(() => encodeInitV4(init(HOME, 0))).toThrow('not an engine chain')
  })

  test('a remote whose home is Monad (domain 15) is accepted', () => {
    expect(decodeInitV4(encodeInitV4(init(HOME, 15))).homeDomain).toBe(15)
  })

  test('a sibling on Ethereum whose home is Base (domain 6) is accepted', () => {
    const d = decodeInitV4(encodeInitV4(init(HOME, 6)))
    expect([d.home.toLowerCase(), d.homeDomain]).toEqual([HOME, 6])
  })

  test('a home domain outside the table is refused', () => {
    expect(() => encodeInitV4(init(HOME, 3))).toThrow("not a chain of V4's table")
  })
})

describe('otto/mamoru#348 (review of #247): held pools', () => {
  test('a held pool the registry json does not pin resolves (exit-only), and one the eligible set serves stays in its bucket', async () => {
    const { baseRegistry } = await import('@mamoru/registry')
    const { oneAuthV4Live, staticPool, withRegistryPools } = await import('./index.ts')
    const entry = { twapWindow: 1800, twapShortWindow: 300, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 1500, active: true }
    const weth = { ...staticPool('pool:WETH/USDC/3000', baseRegistry), entry }
    // WETH/USDC at 0.01 %: a pool of pinned tokens the Base json does not list, found from the account's position
    const dynamic = { ...weth, address: '0x00000000000000000000000000000000000d1a01' as const, fee: 100, tickSpacing: 1 }
    const r = withRegistryPools(oneAuthV4Live, { policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3' }, [weth], baseRegistry, { held: [weth, dynamic] })
    expect(r.pools).toEqual(['pool:WETH/USDC/3000'])
    expect(r.exitOnly).toEqual(['pool:WETH/USDC/100'])
    expect(r.registry.entries.find((e) => e.name === 'pool:WETH/USDC/100')?.address.toLowerCase()).toBe(dynamic.address)
    expect(baseRegistry.entries.some((e) => e.name === 'pool:WETH/USDC/100')).toBe(false) // the json itself untouched
    expect(r.policy.buckets.at(-1)).toMatchObject({ id: 'exit-only', preference: 0, pools: ['pool:WETH/USDC/100'] })
    // a held record whose name an existing entry holds for another address keeps its own name
    const clash = { ...weth, address: '0x00000000000000000000000000000000000d1a02' as const, fee: 3000 }
    const c = withRegistryPools(oneAuthV4Live, { policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3' }, [], baseRegistry, { held: [clash] })
    expect(c.exitOnly).toEqual(['pool:WETH/USDC/3000@00000000'])
  })
})
