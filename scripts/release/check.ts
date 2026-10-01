#!/usr/bin/env bun
// `bun run release:check` — typecheck + tests + build. Must pass before any deploy.
import { runCheck } from './lib/check.ts'

const root = new URL('../../', import.meta.url).pathname

try {
  await runCheck(root)
} catch (err) {
  console.error('release:check failed:', err instanceof Error ? err.message : err)
  process.exit(1)
}
