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
  test('a withdrawal takes only what it needs, in order: redeem(all) for a whole vault, withdraw(assets) for a part', () => {
    const p = planVaultExit([holding('vault:gtUSDCp', 500n * USDC), holding('vault:waBasUSDC', 100n * USDC)], 300n * USDC, ORDER)
    expect(p.short).toBe(0n)
    expect(p.exits).toEqual([
      { vault: 'vault:waBasUSDC', mode: 'redeem', assets: 100n * USDC, shares: 900n * USDC, all: true },
      { vault: 'vault:gtUSDCp', mode: 'withdraw', assets: 200n * USDC, shares: 0n, all: false },
    ])
  })

  test('Stop (need null) takes every share of a vault that can pay them all', () => {
    const p = planVaultExit([holding('vault:gtUSDCp', 500n * USDC), holding('vault:waBasUSDC', 0n, { shares: 0n })], null, ORDER)
    expect(p).toEqual({ exits: [{ vault: 'vault:gtUSDCp', mode: 'redeem', assets: 500n * USDC, shares: 4_500n * USDC, all: true }], short: 0n })
  })

  test('review of #153: a vault short of liquidity is redeemed under its cap, never at the edge, and counted at the margin', () => {
    // maxWithdraw 120 of 500: redeem 99 % of maxRedeem, counted as 99 % of 120; the rest is short.
    const p = planVaultExit([holding('vault:gtUSDCp', 500n * USDC, { maxWithdraw: 120n * USDC, maxRedeem: 1_080n * USDC })], null, ORDER)
    expect(p.exits).toEqual([{ vault: 'vault:gtUSDCp', mode: 'redeem', assets: 118_800_000n, shares: 1_069_200_000n, all: false }])
    expect(p.short).toBe(500n * USDC - 118_800_000n)
    // A part with less than 1 % of room above it is redeemed under the cap too, not withdrawn at the edge.
    const edge = planVaultExit([holding('vault:gtUSDCp', 500n * USDC, { maxWithdraw: 200n * USDC, maxRedeem: 1_800n * USDC })], 200n * USDC, ORDER)
    expect(edge.exits[0]).toMatchObject({ mode: 'redeem', shares: 1_782n * USDC, assets: 198n * USDC })
    expect(edge.short).toBe(2n * USDC)
    expect(planVaultExit([holding('vault:gtUSDCp', 500n * USDC, { maxWithdraw: 0n, maxRedeem: 0n })], 50n * USDC, ORDER)).toEqual({ exits: [], short: 50n * USDC })
  })

  test('the calls: redeem(shares, safe, safe) and withdraw(assets, safe, safe), to the vault', () => {
    const calls = vaultExitCalls(SAFE, [
      { vault: 'vault:gtUSDCp', mode: 'redeem', assets: 5n, shares: 7n, all: true },
      { vault: 'vault:waBasUSDC', mode: 'withdraw', assets: 3n, shares: 0n, all: false },
    ], baseRegistry)
    expect(calls[0]!.to).toBe(address('vault:gtUSDCp', baseRegistry))
    expect(decodeFunctionData({ abi: erc4626Abi, data: calls[0]!.data })).toEqual({ functionName: 'redeem', args: [7n, SAFE, SAFE] })
    expect(calls[1]!.to).toBe(address('vault:waBasUSDC', baseRegistry))
    expect(decodeFunctionData({ abi: erc4626Abi, data: calls[1]!.data })).toEqual({ functionName: 'withdraw', args: [3n, SAFE, SAFE] })
    expect(calls.every((c) => c.value === 0n)).toBe(true)
  })
})
