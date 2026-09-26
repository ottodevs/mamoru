// Contracts linked in the Base deployment by Ot (dashboard.md §6.2), keyed by registry name.
export type LinkedContract = { alias: string; label: string }

export const LINKED: Readonly<Record<string, LinkedContract>> = {
  'pool:USDC/cbBTC/500': { alias: 'mamoru-pool-usdc-cbbtc-500', label: 'uniswap-v3-pool' },
  NonfungiblePositionManager: { alias: 'mamoru-npm', label: 'uniswap-v3-npm' },
  EntryPointV07: { alias: 'mamoru-entrypoint-v07', label: 'erc4337-entrypoint-v07' },
}

