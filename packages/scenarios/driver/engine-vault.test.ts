// otto/mamoru#210: the vault op's simulation check against the vault's preview (`vaultMismatch`, private: reached with
// a cast, like engine-v5.test.ts). Live 2 Nov (b54dda3a, gtUSDCp): the simulation minted a few parts per billion fewer
// shares than the preview read a block earlier, and every deposit was discarded with EHG_SIM_DELTA_MISMATCH.
import { describe, expect, test } from 'bun:test'
import type { Proposal } from '@mamoru/decide'
import { Engine, vaultMinimumOf } from './engine.ts'

type Vault = Extract<Proposal, { kind: 'vault_deposit' | 'vault_redeem' }>
const engine = Object.assign(Object.create(Engine.prototype) as Engine, { cfg: { policy: { savingsAsset: 'USDC' } } })
const check = (p: Vault, quote: { amountIn: bigint; amountOut: bigint; amountOutMinimum: bigint }, deltas: Record<string, bigint>): string | null =>
  (engine as unknown as { vaultMismatch: (p: Vault, prepared: unknown, sim: unknown) => string | null }).vaultMismatch(p, { quote, calls: [] }, { deltas, nftDelta: 0n })
const minOf = vaultMinimumOf

const deposit: Vault = { kind: 'vault_deposit', grant: 'vault-supply:vault:gtUSDCp', bucket: 'stables', pool: 'vault:gtUSDCp', vault: 'vault:gtUSDCp', assets: 90_000_000n }
const redeem: Vault = { kind: 'vault_redeem', grant: 'vault-supply:vault:gtUSDCp', bucket: 'stables', pool: 'vault:gtUSDCp', vault: 'vault:gtUSDCp', shares: 79_000_000_000_000_000_000n, assets: 89_000_000n }

describe('vault op simulation vs preview (otto/mamoru#210)', () => {
  test('the minimum is the preview less 1 bp, never the preview itself (the 2 Nov discard)', () => {
    const preview = 79_684_498_891_098_116_516n
    expect(vaultMinimumOf(preview)).toBe(preview - preview / 10_000n)
    expect(79_684_498_648_761_534_316n >= vaultMinimumOf(preview)).toBe(true)
  })

  test('a deposit a few ppb under the preview (interest between preview and simulation) passes', () => {
    const preview = 79_684_498_891_098_116_516n
    const q = { amountIn: deposit.kind === 'vault_deposit' ? deposit.assets : 0n, amountOut: preview, amountOutMinimum: minOf(preview) }
    expect(check(deposit, q, { USDC: -90_000_000n, 'vault:gtUSDCp': 79_684_498_648_761_534_316n })).toBeNull()
  })

  test('a deposit more than the tolerance under the preview, or that moves other USDC, is refused', () => {
    const preview = 79_684_498_891_098_116_516n
    const q = { amountIn: 90_000_000n, amountOut: preview, amountOutMinimum: minOf(preview) }
    expect(check(deposit, q, { USDC: -90_000_000n, 'vault:gtUSDCp': minOf(preview) - 1n })).toContain('below the preview')
    expect(check(deposit, q, { USDC: -90_000_001n, 'vault:gtUSDCp': preview })).toContain('USDC moved')
  })

  test('a redeem: within the tolerance passes, below it is refused', () => {
    const shares = 79_000_000_000_000_000_000n
    const q = { amountIn: shares, amountOut: 89_000_000n, amountOutMinimum: minOf(89_000_000n) }
    expect(check(redeem, q, { USDC: 88_999_500n, 'vault:gtUSDCp': -shares })).toBeNull()
    expect(check(redeem, q, { USDC: minOf(89_000_000n) - 1n, 'vault:gtUSDCp': -shares })).toContain('below the preview')
  })
})
