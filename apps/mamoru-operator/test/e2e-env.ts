// otto/mamoru#450: where an e2e fork reads the chain, and what an e2e operator inherits from the shell.
//
// An anvil fork reads storage and code slot by slot from its upstream. The e2e scripts used to fall back to the live
// operator's env file (~/.config/mamoru-operator/env) and ~/.config/quicknode/endpoints.env, so every e2e:all forked
// through the production keyed provider: on 22 Nov two runs spent most of the month's last credits. Worse, the operator
// an e2e boots read MAMORU_RPC_TRUSTED from that env, proved those providers on chain 8453 (the fork's id too) and spread
// its reads between the fork and Base mainnet. An e2e now never reads either file: the fork's upstream is E2E_RPC_URL
// (Base) or E2E_L1_RPC_URL (Ethereum) when set, a public node otherwise, and every production-only variable is cleared
// before the operator boots.

/** Public upstreams: slow and rate limited (FORK_CUPS throttles the fork), never anyone's quota. */
export const PUBLIC_UPSTREAM = { base: 'https://mainnet.base.org', l1: 'https://ethereum-rpc.publicnode.com' } as const
const UPSTREAM_VAR = { base: 'E2E_RPC_URL', l1: 'E2E_L1_RPC_URL' } as const

/** The live Base operator's policy contracts (public addresses), which the Base e2e runs used to inherit from its env. */
export const LIVE_BASE_POLICY = {
  MAMORU_ONCHAIN_POLICY_V4: '1',
  MAMORU_ACTION_POLICY_ADDRESS: '0x0083A9ca619f22A4f29704F97981dfFe8CD35215',
  MAMORU_GAS_POLICY_ADDRESS: '0x9EB9a72c5e7231374eD65f5a1fF3e38a39798866',
  MAMORU_ACTION_POLICY_V2_ADDRESS: '0x9ef35e544C93A6722a13473AB9EF115f719bbE6B',
} as const

/** Variables only a live operator may hold: providers, keys, peers, the settings Worker. */
export const PRODUCTION_ONLY = [
  'RPC_URL',
  'BASE_RPC_URL',
  'L1_RPC_URL',
  'OPERATOR_SECRET',
  'MAMORU_RPC_TRUSTED',
  'MAMORU_RPC_FALLBACKS',
  'MAMORU_LOG_RANGES',
  'MAMORU_L1_RPC_URL',
  'MAMORU_L1_RPC_TRUSTED',
  'MAMORU_L1_RPC_FALLBACKS',
  'MAMORU_MONAD_RPC_URL',
  'MAMORU_MONAD_RPC_TRUSTED',
  'MAMORU_MONAD_RPC_FALLBACKS',
  'MAMORU_PEER_OPERATORS',
  'MAMORU_SETTINGS_URL',
] as const

/** Every PRODUCTION_ONLY variable, and any provider key (`ALCHEMY_*`, `QUICKNODE_*`), removed from `env`. */
export function clearProductionEnv(env: Record<string, string | undefined> = process.env): void {
  for (const k of Object.keys(env)) if ((PRODUCTION_ONLY as readonly string[]).includes(k) || /^(ALCHEMY|QUICKNODE)_/.test(k)) delete env[k]
}

/** The upstream an e2e fork of `chain` reads: E2E_RPC_URL / E2E_L1_RPC_URL, else the public node. Logs which, never the URL of a set one. */
export function e2eUpstream(chain: keyof typeof PUBLIC_UPSTREAM): string {
  const name = UPSTREAM_VAR[chain]
  const set = process.env[name]?.trim()
  console.log(`[e2e] ${chain} fork upstream: ${set ? `${name}` : `public ${PUBLIC_UPSTREAM[chain]} (set ${name} for another)`}`)
  return set || PUBLIC_UPSTREAM[chain]
}

/**
 * A Base e2e's environment: production variables cleared, `RPC_URL` (what startForkProxy reads) set to the e2e
 * upstream, and with `livePolicy` the live policy contracts where the script has not set its own.
 */
export function e2eBaseEnv(opts: { livePolicy?: boolean } = {}): string {
  const upstream = e2eUpstream('base')
  clearProductionEnv()
  process.env.RPC_URL = upstream
  if (opts.livePolicy) for (const [k, v] of Object.entries(LIVE_BASE_POLICY)) process.env[k] ??= v
  return upstream
}
