// Thin wrapper over `wrangler` for the release scripts. Only reads deployment metadata and deploys;
// never touches secret values.
import { $ } from 'bun'

type WranglerDeployment = { created_on: string; versions?: { version_id: string }[] }

/** The version id currently live for a Worker environment, or null if the Worker has no deployments yet. */
export async function currentVersionId(appDir: string, env?: string): Promise<string | null> {
  const envArgs = env ? ['--env', env] : []
  let raw: string
  try {
    raw = await $`bunx wrangler deployments list --json ${envArgs}`.cwd(appDir).quiet().text()
  } catch {
    return null
  }
  const rows = JSON.parse(raw) as WranglerDeployment[]
  if (rows.length === 0) return null
  const latest = rows.reduce((a, b) => (a.created_on > b.created_on ? a : b))
  return latest.versions?.[0]?.version_id ?? null
}

/** Runs `wrangler deploy` for the given environment and returns its stdout plus the new version id. */
export async function deploy(appDir: string, env?: string): Promise<{ output: string; versionId: string | null }> {
  const envArgs = env ? ['--env', env] : []
  const output = await $`bunx wrangler deploy ${envArgs}`.cwd(appDir).text()
  const versionId = output.match(/Current Version ID:\s*(\S+)/)?.[1] ?? (await currentVersionId(appDir, env))
  return { output, versionId }
}

export function rollbackCommand(appDir: string, env: string | undefined, versionId: string): string {
  const envFlag = env ? ` --env ${env}` : ''
  return `(cd ${appDir} && bunx wrangler rollback${envFlag} ${versionId})`
}
