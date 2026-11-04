// Runs every e2e-*.ts one after the other, each under a timeout, and prints a PASS/FAIL table. Exit 1 when any fails.
// Needs foundry on PATH and RPC_URL, BASE_RPC_URL, BASE_FORK_RPC_URL, L1_RPC_URL (public ones work). E2E_TIMEOUT_S: per script (default 900).
// Usage: bun run e2e:all [name ...]   (names without the e2e- prefix, e.g. fork v4)
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../../..')
const timeoutS = Number(process.env.E2E_TIMEOUT_S ?? 900)
const logDir = process.env.E2E_LOG_DIR ?? join(process.env.TMPDIR ?? '/tmp', `mamoru-e2e-all-${Date.now()}`)
mkdirSync(logDir, { recursive: true })

const NOT_SCRIPTS = new Set(['e2e-client.ts', 'e2e-all.ts'])
const wanted = process.argv.slice(2)
const scripts = readdirSync(import.meta.dir)
  .filter((f) => /^e2e-.+\.ts$/.test(f) && !NOT_SCRIPTS.has(f))
  .filter((f) => wanted.length === 0 || wanted.includes(f.slice(4, -3)))
  .sort()

const rows: { name: string; result: 'PASS' | 'FAIL' | 'TIMEOUT'; secs: number; log: string }[] = []
for (const f of scripts) {
  const log = join(logDir, `${f.slice(0, -3)}.log`)
  const t0 = Date.now()
  const proc = Bun.spawn(['bun', join('apps/mamoru-operator/test', f)], { cwd: root, stdout: Bun.file(log), stderr: Bun.file(log), env: process.env })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutS * 1000)
  const code = await proc.exited
  clearTimeout(timer)
  const secs = Math.round((Date.now() - t0) / 1000)
  rows.push({ name: f.slice(4, -3), result: timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL', secs, log })
  console.log(`${rows.at(-1)!.result.padEnd(7)} ${f} (${secs}s)`)
}

const w = Math.max(6, ...rows.map((r) => r.name.length))
console.log(`\n${'script'.padEnd(w)}  result   secs  log`)
for (const r of rows) console.log(`${r.name.padEnd(w)}  ${r.result.padEnd(7)}  ${String(r.secs).padStart(4)}  ${r.log}`)
const bad = rows.filter((r) => r.result !== 'PASS')
console.log(`\n${rows.length - bad.length}/${rows.length} passed`)
process.exit(bad.length === 0 ? 0 : 1)
