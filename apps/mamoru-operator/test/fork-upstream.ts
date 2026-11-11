import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Public Base RPC the e2e forks read from unless told otherwise. */
export const PUBLIC_BASE_RPC = 'https://mainnet.base.org'
/** The block the Base e2e forks are pinned to (the Lab manifest's, as e2e-v4 and e2e-v5). E2E_FORK_BLOCK changes it. */
export const DEFAULT_FORK_BLOCK = '51811000'
/** Set to 1 to let an e2e read from the keyed provider (RPC_URL, else BASE_RPC_URL, else ~/.config/mamoru-operator/env). */
export const ALLOW_KEYED_VAR = 'E2E_ALLOW_KEYED'

type Env = Record<string, string | undefined>

/**
 * Sets `RPC_URL`, the upstream of the fork proxy, for a Base e2e. By default it is `BASE_FORK_RPC_URL` or the public
 * RPC: a fork read is billed on a keyed provider (about 200k slot reads a day from a few runs), and `BASE_RPC_URL` in the
 * operator's env file is the keyed one. The keyed URL is used only with E2E_ALLOW_KEYED=1.
 */
export function useBaseForkRpc(env: Env = process.env, envFile: string = join(homedir(), '.config/mamoru-operator/env')): void {
  if (env[ALLOW_KEYED_VAR] !== '1') {
    env.RPC_URL = env.BASE_FORK_RPC_URL || PUBLIC_BASE_RPC
    return
  }
  if (!env.RPC_URL && existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line)
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
    }
  }
  if (!env.RPC_URL && env.BASE_RPC_URL) env.RPC_URL = env.BASE_RPC_URL
  if (!env.RPC_URL) throw new Error(`${ALLOW_KEYED_VAR}=1 but neither RPC_URL nor BASE_RPC_URL is set`)
}

/**
 * Anvil's `--fork-block-number` for a Base e2e: E2E_FORK_BLOCK or the pinned default. A fork at a fixed block lets anvil
 * keep every slot it reads on disk (~/.foundry/cache/rpc), so a second run reads nothing from the upstream; a fork at the
 * head has a new block every run and re-reads everything.
 */
export function forkBlockArgs(env: Env = process.env): string[] {
  return ['--fork-block-number', env.E2E_FORK_BLOCK || DEFAULT_FORK_BLOCK]
}
