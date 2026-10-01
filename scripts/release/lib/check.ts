// Shared "is it safe to ship" gate. Split so deploy scripts can build with a different env
// (VITE_BETA=1) than the plain `release:check` gate, without building twice.
import { $ } from 'bun'

export async function runTypecheckAndTest(root: string): Promise<void> {
  console.log('-> typecheck')
  await $`bun run typecheck`.cwd(root)

  console.log('-> test (packages apps)')
  await $`bun test packages apps`.cwd(root)

  console.log('-> test (scripts/release)')
  await $`bun test scripts/release`.cwd(root)
}

export async function buildApp(appDir: string, extraEnv: Record<string, string> = {}): Promise<void> {
  console.log('-> build apps/mamoru-app')
  await $`bun run build`.cwd(appDir).env({ ...process.env, ...extraEnv })
}

/** typecheck + tests + production build. Every deploy script runs this (or its pieces) first. */
export async function runCheck(root: string): Promise<void> {
  await runTypecheckAndTest(root)
  await buildApp(`${root}/apps/mamoru-app`)
  console.log('release:check passed')
}
