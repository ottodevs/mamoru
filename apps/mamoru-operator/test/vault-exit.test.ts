import { describe, expect, test } from 'bun:test'
import { decodeFunctionData } from 'viem'
import { address, baseRegistry, erc4626Abi } from '@mamoru/registry'
import type { VaultHolding } from '../src/chain.ts'
import { planVaultExit, vaultExitCalls } from '../src/unwind.ts'

// otto/mamoru#210: what a withdrawal or a Stop takes out of the stables bucket's vaults.
const USDC = 1_000_000n
const SAFE = '0x00000000000000000000000000000000000000AA' as const
const ORDER = ['vault:waBasUSDC', 'vault:gtUSDCp']

function holding(name: string, assets: bigint, over: Partial<VaultHolding> = {}): VaultHolding {
  return { name, shares: assets * 9n, assets, maxWithdraw: assets, maxRedeem: assets * 9n, ...over }
}

describe('planVaultExit', () => {
  test('a withdrawal takes only what it needs, in order, with withdraw(assets) for a part', () => {
    const p = planVaultExit([holding('vault:gtUSDCp', 500n * USDC), holding('vault:waBasUSDC', 100n * USDC)], 300n * USDC, ORDER)
    expect(p.short).toBe(0n)
    expect(p.exits).toEqual([
      { vault: 'vault:waBasUSDC', assets: 100n * USDC, shares: 900n * USDC, all: true },
      { vault: 'vault:gtUSDCp', assets: 200n * USDC, shares: 0n, all: false },
    ])
  })

  test('Stop (need null) takes every share, redeem for a whole vault', () => {
    const p = planVaultExit([holding('vault:gtUSDCp', 500n * USDC), holding('vault:waBasUSDC', 0n, { shares: 0n })], null, ORDER)
    expect(p).toEqual({ exits: [{ vault: 'vault:gtUSDCp', assets: 500n * USDC, shares: 4_500n * USDC, all: true }], short: 0n })
  })

  test('a vault lent out pays only what it can now; the rest is reported short, never planned', () => {
    const p = planVaultExit([holding('vault:gtUSDCp', 500n * USDC, { maxWithdraw: 120n * USDC, maxRedeem: 1_080n * USDC })], null, ORDER)
    expect(p.exits).toEqual([{ vault: 'vault:gtUSDCp', assets: 120n * USDC, shares: 0n, all: false }])
    expect(p.short).toBe(380n * USDC)
    expect(planVaultExit([holding('vault:gtUSDCp', 500n * USDC, { maxWithdraw: 0n, maxRedeem: 0n })], 50n * USDC, ORDER)).toEqual({ exits: [], short: 50n * USDC })
  })

  test('the calls: redeem(shares, safe, safe) for all, withdraw(assets, safe, safe) for a part, to the vault', () => {
    const calls = vaultExitCalls(SAFE, [
      { vault: 'vault:gtUSDCp', assets: 5n, shares: 7n, all: true },
      { vault: 'vault:waBasUSDC', assets: 3n, shares: 0n, all: false },
    ], baseRegistry)
    expect(calls[0]!.to).toBe(address('vault:gtUSDCp', baseRegistry))
    expect(decodeFunctionData({ abi: erc4626Abi, data: calls[0]!.data })).toEqual({ functionName: 'redeem', args: [7n, SAFE, SAFE] })
    expect(calls[1]!.to).toBe(address('vault:waBasUSDC', baseRegistry))
    expect(decodeFunctionData({ abi: erc4626Abi, data: calls[1]!.data })).toEqual({ functionName: 'withdraw', args: [3n, SAFE, SAFE] })
    expect(calls.every((c) => c.value === 0n)).toBe(true)
  })
})
