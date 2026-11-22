/**
 * otto/mamoru#413 (spec 012 savings-layer.md): an account's savings layer. Harvested yield, swapped to USDC and kept in
 * the Stable bucket's vault as shares tagged `savings`, outside the bucket weights. All amounts are raw USDC (6
 * decimals) as decimal strings; shares are the vault's raw share units.
 *
 * Savings are a part of what the account already holds (idle USDC and vault shares), never an addition to it: the
 * account total includes them once. Earned (spec 012) already counts the fees they came from and the vault yield of
 * every share: `usdc` is shown beside earned, never added to it again.
 */
export type AccountSavings = {
  /** What savings are worth now: `pendingUsdc` plus every vault's savings shares at that vault's rate. */
  usdc: string
  /**
   * Cost basis: what entered savings (each deposit's assets at entry, plus `pendingUsdc` one to one), less the basis
   * of what left (pro rata). `usdc - basisUsdc` is the vault growth of savings: the 10 % fee was paid on the
   * collection, so only this growth is fee base (otto/mamoru#433).
   */
  basisUsdc: string
  /** Harvested USDC in the Safe waiting for the next savings deposit (under the vault floor, or V4 room short). */
  pendingUsdc: string
  /** Savings shares per vault. Absent vaults hold none. */
  vaults: SavingsVault[]
  /** `partial`: an op's receipt is not read yet, so a figure may be short until it is. */
  status: 'counted' | 'partial'
}

export type SavingsVault = {
  /** Registry name of the vault (kind `vault`), e.g. `vault:gtUSDCp`. */
  vault: string
  shares: string
  /** `shares` at the vault's rate of the read. */
  usdc: string
  basisUsdc: string
}
