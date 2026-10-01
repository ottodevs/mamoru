// Shared "is it safe to ship" gate: typecheck, tests, SPA build. Every deploy script runs this first.
import { $ } from 'bun'

export async function runCheck(root: string): Promise<void> {
  console.log('-> typecheck')
  await $`bun run typecheck`.cwd(root)

  console.log('-> test')
  await $`bun test packages apps`.cwd(root)

  console.log('-> build apps/mamoru-app')
  await $`bun run build`.cwd(`${root}/apps/mamoru-app`)

  console.log('release:check passed')
}
