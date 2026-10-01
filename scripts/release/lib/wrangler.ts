// Thin wrapper over `wrangler` for the release scripts. The environment is always explicit: ''
// targets the top-level (production) config, 'beta' targets env.beta. CLOUDFLARE_ENV is stripped
// from the child process env on every call so it can never silently override `--env`.
import { $ } from 'bun'

export type WranglerEnv = '' | 'beta'

/** process.env with CLOUDFLARE_ENV removed, for every wrangler child process. Exported for tests. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env = { ...base }
  delete env.CLOUDFLARE_ENV
  return env
}

function envArgs(env: WranglerEnv): string[] {
  return ['--env', env]
}

type WranglerDeployment = { created_on: string; versions?: { version_id: string }[] }

/**
 * The version id currently live for a Worker environment, or null if it has never been deployed.
 * Fails closed: a command failure (auth, network, parse) throws so the caller aborts before
 * deploying, rather than treating an error as "no previous version".
 */
export async function currentVersionId(appDir: string, env: WranglerEnv): Promise<string | null> {
  const raw = await $`bunx wrangler deployments list --json ${envArgs(env)}`.cwd(appDir).quiet().env(childEnv()).text()
  const rows = JSON.parse(raw) as WranglerDeployment[]
  if (rows.length === 0) return null
  const latest = rows.reduce((a, b) => (a.created_on > b.created_on ? a : b))
  return latest.versions?.[0]?.version_id ?? null
}

/** Runs `wrangler deploy` for the given (explicit) environment and returns stdout plus the new version id. */
export async function deploy(appDir: string, env: WranglerEnv): Promise<{ output: string; versionId: string | null }> {
  const output = await $`bunx wrangler deploy ${envArgs(env)}`.cwd(appDir).env(childEnv()).text()
  // The deploy is done here: a failed version lookup must not turn it into a "deploy failed".
  const versionId = output.match(/Current Version ID:\s*(\S+)/)?.[1] ?? (await currentVersionId(appDir, env).catch(() => null))
  return { output, versionId }
}

/** POSIX single-quoting: safe to paste whatever the string holds. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** A copy-pasteable shell command with every argument quoted. `''` prints as `--env ''`: an
 *  unquoted empty string collapses in a real shell and shifts versionId into the --env value. */
export function rollbackCommand(appDir: string, env: WranglerEnv, versionId: string): string {
  return `(cd ${shellQuote(appDir)} && bunx wrangler rollback --env ${shellQuote(env)} ${shellQuote(versionId)})`
}
