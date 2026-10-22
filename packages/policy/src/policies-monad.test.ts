// otto/mamoru#65: the Monad lab policy resolves every name in the Monad registry and signs only for a lab fork.
import { describe, expect, test } from 'bun:test'
import { address, baseRegistry, monadRegistry } from '@mamoru/registry'
import { POLICIES, conservadorLiveV2, instantiateGrant, labWmonUsdcMonadV1, MONAD_LAB_POLICIES, policyHash, policyRegistry } from './index.ts'

const ctx = {
  account: '0x00000000000000000000000000000000000000aa' as const,
  sessionKey: '0x00000000000000000000000000000000000000bb' as const,
  chainId: 314143,
  salt: `0x${'01'.padStart(64, '0')}` as const,
  validAfter: 1,
  validUntil: 2,
  caps: { usdcSwapPerCall: 1n, usdcSwapTotal: 2n, wmonMint: 3n, usdcMint: 4n, wmonConvertPerCall: 5n, wmonConvertTotal: 6n },
}

describe('policyRegistry', () => {
  test('a policy without sourceChainId is Base, as every policy before Monad', () => {
    expect(policyRegistry(conservadorLiveV2)).toBe(baseRegistry)
    for (const p of Object.values(POLICIES)) expect(policyRegistry(p)).toBe(baseRegistry)
  })

  test('the Monad lab policy is Monad', () => {
    expect(policyRegistry(labWmonUsdcMonadV1)).toBe(monadRegistry)
  })
})

describe('lab-wmon-usdc-monad-v1', () => {
  test('is a lab policy outside POLICIES, so no pinned Base hash moves', () => {
    expect(MONAD_LAB_POLICIES[labWmonUsdcMonadV1.policyId]).toBe(labWmonUsdcMonadV1)
    expect(Object.keys(POLICIES)).not.toContain(labWmonUsdcMonadV1.policyId)
    expect(labWmonUsdcMonadV1.chain).toBe('fork')
    expect(policyHash(labWmonUsdcMonadV1)).not.toBe(policyHash(conservadorLiveV2))
  })

  test('its grants target Monad addresses, never Base ones', () => {
    for (const name of ['enter-swap', 'enter-mint'] as const) {
      const g = instantiateGrant(labWmonUsdcMonadV1, name, ctx)
      for (const a of g.actions) {
        expect(a.targetAddress).toBe(address(a.target, monadRegistry))
        expect(baseRegistry.entries.some((e) => e.address.toLowerCase() === a.targetAddress.toLowerCase())).toBe(false)
      }
    }
    const swap = instantiateGrant(labWmonUsdcMonadV1, 'enter-swap', ctx).actions.find((a) => a.target === 'SwapRouter02' && a.signature.startsWith('exactInputSingle'))!
    expect(swap.params.find((p) => p.field === 'tokenOut')!.ref).toBe(BigInt(address('WMON', monadRegistry)))
  })

  test('refuses Monad mainnet and its testnet: signing there waits for a live Monad policy', () => {
    expect(() => instantiateGrant(labWmonUsdcMonadV1, 'enter-swap', { ...ctx, chainId: 143 })).toThrow()
    expect(() => instantiateGrant(labWmonUsdcMonadV1, 'enter-swap', { ...ctx, chainId: 10143 })).toThrow()
  })

  test('a Base policy keeps resolving on Base', () => {
    const g = instantiateGrant(POLICIES['conservador-lab-v1']!, 'enter-swap', { ...ctx, caps: { usdcSwapPerCall: 1n, usdcSwapTotal: 2n } })
    for (const a of g.actions) expect(a.targetAddress).toBe(address(a.target, baseRegistry))
  })
})
