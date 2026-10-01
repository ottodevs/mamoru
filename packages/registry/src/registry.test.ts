import { describe, expect, test } from 'bun:test'
import { getAddress, isHash } from 'viem'
import { ReasonError } from '@mamoru/domain'
import { address, baseRegistry, entry, monadRegistry, nameOf, registries, registryFor, type Registry } from './index.ts'

const ACCOUNT_STACK = [
  'EntryPointV07',
  'SafeL2_141',
  'SafeProxyFactory_141',
  'Safe7579',
  'Safe7579Launchpad',
  'ModuleRegistry',
  'RhinestoneAttester',
  'SmartSession',
  'OwnableValidator',
  'UniActionPolicy',
  'SafeWebAuthnSharedSigner',
  'P256Verifier',
  'MultiSendCallOnly_141',
  'MultiSend_141',
  'Multicall3',
]

/** Not deployed on Monad: a lookup must fail loudly, never fall back to Base. */
const MISSING_ON_MONAD = ['TimeFramePolicy', 'UsageLimitPolicy', 'SafeWebAuthnSignerFactory']

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    return e instanceof ReasonError ? e.code : undefined
  }
  return undefined
}

describe('registryFor', () => {
  test('selects the registry by chain id', () => {
    expect(registryFor(8453)).toBe(baseRegistry)
    expect(registryFor(143)).toBe(monadRegistry)
    expect(baseRegistry.chain).toBe('base')
    expect(monadRegistry.chain).toBe('monad')
    expect(monadRegistry.chainId).toBe(143)
  })

  test('throws a ReasonError for a chain without a registry', () => {
    for (const chainId of [1, 10, 84532, 10143, 0, -1]) {
      expect(code(() => registryFor(chainId))).toBe('OBS_CHAIN_MISMATCH')
    }
    expect(() => registryFor(1)).toThrow(/no registry for chain id 1/)
  })

  test('every registered chain id is unique', () => {
    expect(new Set(registries.map((r) => r.chainId)).size).toBe(registries.length)
  })
})

describe.each(registries.map((r) => [r.chain, r] as const))('%s registry', (_chain, registry: Registry) => {
  test('pins a block, its hash and a code hash for every entry', () => {
    expect(registry.block).toBeGreaterThan(0)
    expect(isHash(registry.blockHash)).toBe(true)
    for (const e of registry.entries) {
      expect(e.codeHash, e.name).not.toBeNull()
      expect(isHash(e.codeHash ?? '0x'), e.name).toBe(true)
    }
  })

  test('names and addresses are unique and checksummed', () => {
    expect(new Set(registry.entries.map((e) => e.name)).size).toBe(registry.entries.length)
    expect(new Set(registry.entries.map((e) => e.address.toLowerCase())).size).toBe(registry.entries.length)
    for (const e of registry.entries) expect(e.address, e.name).toBe(getAddress(e.address))
  })

  test('tokens carry decimals and pools point at tokens of the same registry', () => {
    for (const e of registry.entries) {
      if (e.kind === 'token') expect(typeof e.decimals, e.name).toBe('number')
      if (e.kind === 'pool') {
        expect(entry(e.token0 ?? '', registry).kind, e.name).toBe('token')
        expect(entry(e.token1 ?? '', registry).kind, e.name).toBe('token')
        expect(e.name, e.name).toBe(`pool:${e.token0}/${e.token1}/${e.fee}`)
        expect(e.tickSpacing, e.name).toBe({ 100: 1, 500: 10, 3000: 60, 10000: 200 }[e.fee ?? 0])
      }
    }
  })

  test('carries the whole account stack', () => {
    for (const name of ACCOUNT_STACK) expect(entry(name, registry).name).toBe(name)
  })
})

describe('monad registry', () => {
  test('account stack sits at the same addresses as Base', () => {
    for (const name of ACCOUNT_STACK) expect(address(name, monadRegistry), name).toBe(address(name, baseRegistry))
  })

  test('refuses the names that have no code on Monad instead of resolving them from Base', () => {
    for (const name of MISSING_ON_MONAD) {
      expect(address(name, baseRegistry), name).toMatch(/^0x/)
      expect(code(() => entry(name, monadRegistry)), name).toBe('POLICY_TARGET_NOT_IN_REGISTRY')
      expect(code(() => address(name, monadRegistry)), name).toBe('POLICY_TARGET_NOT_IN_REGISTRY')
      expect(nameOf(address(name, baseRegistry), monadRegistry), name).toBeUndefined()
    }
  })

  test('tokens, Uniswap v3 periphery and pools', () => {
    expect(entry('USDC', monadRegistry)).toMatchObject({ address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6 })
    expect(entry('WMON', monadRegistry)).toMatchObject({ address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', decimals: 18 })
    expect(entry('EURW', monadRegistry)).toMatchObject({ decimals: 6 })
    expect(address('UniswapV3Factory', monadRegistry)).toBe('0x204FAca1764B154221e35c0d20aBb3c525710498')
    expect(address('NonfungiblePositionManager', monadRegistry)).toBe('0x7197E214c0b767cFB76Fb734ab638E2c192F4E53')
    expect(address('SwapRouter02', monadRegistry)).toBe('0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900')
    expect(address('QuoterV2', monadRegistry)).toBe('0x661E93cca42AfacB172121EF892830cA3b70F08d')
    expect(entry('pool:WMON/USDC/3000', monadRegistry)).toMatchObject({ token0: 'WMON', token1: 'USDC', fee: 3000, tickSpacing: 60 })
    expect(entry('pool:EURW/USDC/100', monadRegistry)).toMatchObject({ token0: 'EURW', token1: 'USDC', fee: 100, tickSpacing: 1 })
    expect(monadRegistry.entries.filter((e) => e.kind === 'pool')).toHaveLength(2)
  })

  test('Base-only tokens and pools do not leak into Monad', () => {
    for (const name of ['cbBTC', 'WETH', 'EURC', 'USDT', 'JPYT', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/500']) {
      expect(code(() => entry(name, monadRegistry)), name).toBe('POLICY_TARGET_NOT_IN_REGISTRY')
    }
    expect(nameOf(address('USDC', baseRegistry), monadRegistry)).toBeUndefined()
    expect(nameOf(address('USDC', monadRegistry), baseRegistry)).toBeUndefined()
  })
})

describe('base defaults', () => {
  test('entry(), address() and nameOf() without a registry still resolve Base', () => {
    expect(address('USDC')).toBe(address('USDC', baseRegistry))
    expect(entry('EntryPointV07')).toBe(entry('EntryPointV07', baseRegistry))
    expect(nameOf(address('USDC', baseRegistry))).toBe('USDC')
  })
})
