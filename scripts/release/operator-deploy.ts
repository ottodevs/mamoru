#!/usr/bin/env bun
// `bun run operator:deploy <sha> --as <session> [--rollback] [--reason "<why>"]` — moves the live operator to ONE
// named commit of origin/main. Coordinator only (lib/lease.ts). One redeploy at a time (a lock beside the lease).
// Refuses a sha that would drop work the operator already runs, unless --rollback. Checks out the sha in the
// operator's worktree, installs dependencies when the lockfile changed, restarts the unit, and waits for the signed
// /metrics to answer with the new sha. If it does not within the timeout, or the boot journal shows a fatal line,
// it puts the previous sha back and restarts again. Every attempt is logged and written on otto/mamoru#83.
import { $ } from 'bun'
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { metricsSignature } from '../../packages/operator-auth/src/index.ts'
import { fetchRefs, isAncestor } from './lib/git.ts'
import { OP_LOCK, requireLease, sessionName, underFlock } from './lib/lease.ts'
import { fatalLines, healthy, refuseDeploy, type MetricsView } from './lib/operator.ts'

const HOME = process.env.HOME!
const root = new URL('../../', import.meta.url).pathname
const opDir = realpathSync(process.env.MAMORU_OPERATOR_DIR ?? `${HOME}/.local/share/mamoru-operator/current`)
const envFile = process.env.MAMORU_OPERATOR_ENV ?? `${HOME}/.config/mamoru-operator/env`
const unit = process.env.MAMORU_OPERATOR_UNIT ?? 'mamoru-operator'
const metricsUrl = process.env.MAMORU_OPERATOR_METRICS ?? 'http://127.0.0.1:8787/metrics'
const logFile = `${HOME}/.local/state/mamoru-operator/deploys.jsonl`
const BOOT_TIMEOUT_MS = 120_000

const argv = process.argv.slice(2)
const sha = argv.find((a) => /^[0-9a-f]{7,40}$/.test(a)) ?? ''
const rollback = argv.includes('--rollback')
const reason = (() => {
  const i = argv.indexOf('--reason')
  return i >= 0 ? (argv[i + 1] ?? '') : ''
})()
function refuse(why: string): never {
  console.error(`refusing: ${why}`)
  process.exit(1)
}

// One coordinator operation at a time, held by the kernel until this process ends (lib/lease.ts).
underFlock(OP_LOCK, { wait: false, busy: 'another coordinator operation (a release or an operator redeploy) is running' })
const who = requireLease(sessionName(argv))

async function metrics(): Promise<MetricsView | null> {
  try {
    const secret = readFileSync(envFile, 'utf8').match(/^OPERATOR_SECRET=(.*)$/m)?.[1]?.replace(/^["']|["']$/g, '')
    if (!secret) return null
    const sig = await metricsSignature(secret, 'GET', '/metrics', Math.floor(Date.now() / 60_000))
    const r = await fetch(metricsUrl, { headers: { 'x-mamoru-sig': sig }, signal: AbortSignal.timeout(5_000) })
    if (!r.ok) return null
    return ((await r.json()) as { operator?: MetricsView }).operator ?? null
  } catch {
    return null
  }
}

const stamp = () => new Date(Date.now() - 1_000).toISOString().replace('T', ' ').slice(0, 19)

/**
 * Puts `target` in place and waits for it: checkout, its own dependencies when the lockfile differs from what is
 * installed, restart, health. Never throws: any failing step is the answer.
 */
async function bringUp(target: string, installDeps: boolean): Promise<{ ok: boolean; why: string }> {
  const since = stamp()
  try {
    await $`git -C ${opDir} checkout -q --detach ${target}`
    if (installDeps) await $`bun install --frozen-lockfile`.cwd(opDir).quiet()
    await $`systemctl --user restart ${unit}`
  } catch (e) {
    return { ok: false, why: `step failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}` }
  }
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await Bun.sleep(3_000)
    const journal = await $`journalctl --user -u ${unit} --since ${since} --no-pager -o cat`.quiet().nothrow().text()
    const fatal = fatalLines(journal)
    if (fatal.length) return { ok: false, why: `boot journal: ${fatal[0]!.slice(0, 200)}` }
    if (healthy(await metrics(), target, wasLive)) return { ok: true, why: '' }
  }
  return { ok: false, why: `/metrics did not answer with ${target.slice(0, 7)} within ${BOOT_TIMEOUT_MS / 1000} s` }
}

function log(entry: Record<string, unknown>): void {
  mkdirSync(`${HOME}/.local/state/mamoru-operator`, { recursive: true })
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), by: who, ...entry })}\n`)
}

async function note83(text: string): Promise<void> {
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ')
  await $`tk comment forgejo:otto/mamoru#83 ${`${at} UTC [operator:deploy] ${text}`}`.quiet().nothrow()
}

const before = (await metrics()) ?? {}
const wasLive = before.live ?? true

await fetchRefs(root, 'main')
const running = (await $`git -C ${opDir} rev-parse HEAD`.text()).trim()
const full = sha.length === 40 ? sha : refuse('the sha is written in full, all 40 characters')
const why = refuseDeploy({
  sha: full,
  running,
  onMain: await isAncestor(root, full, 'origin/main'),
  forward: await isAncestor(root, running, full),
  rollback,
})
if (why) refuse(why)
if (rollback && !reason) refuse('--rollback needs --reason "<why>"')

console.log(`== operator:deploy ${running.slice(0, 7)} -> ${full.slice(0, 7)}${rollback ? ' (rollback)' : ''} by ${who} ==`)
await note83(`${who}: ${running.slice(0, 7)} -> ${full.slice(0, 7)}${rollback ? ` (rollback: ${reason})` : ''}. Starting.`)

const lockChanged = (await $`git -C ${opDir} diff --quiet ${running} ${full} -- bun.lock`.nothrow()).exitCode !== 0
const result = await bringUp(full, lockChanged)
if (result.ok) {
  log({ from: running, to: full, rollback, result: 'ok' })
  await note83(`${who}: operator runs ${full.slice(0, 7)}, /metrics answers. Rollback: bun run operator:deploy ${running} --rollback --reason "..." --as <you>`)
  console.log(`operator runs ${full.slice(0, 7)}`)
  process.exit(0)
}

console.error(`deploy failed: ${result.why}. Putting ${running.slice(0, 7)} back.`)
// The previous sha with its own dependencies installed before it starts, whatever step failed above.
const back = await bringUp(running, lockChanged)
log({ from: running, to: full, rollback, result: 'failed', why: result.why, restored: back.ok })
await note83(`${who}: ${full.slice(0, 7)} FAILED (${result.why}); ${back.ok ? `back on ${running.slice(0, 7)}, healthy` : `restoring ${running.slice(0, 7)} ALSO FAILED (${back.why}): the operator needs a human now`}.`)
process.exit(1)
