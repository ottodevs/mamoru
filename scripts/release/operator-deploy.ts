#!/usr/bin/env bun
// `bun run operator:deploy <sha> --as <session> [--check] [--rollback] [--reason "<why>"]` — moves the live operator to ONE
// named commit of origin/main. Coordinator only (lib/lease.ts). One redeploy at a time (a lock beside the lease).
// Refuses a sha that would drop work the operator already runs, unless --rollback. Checks out the sha in the
// operator's worktree, installs dependencies when the lockfile changed, restarts the unit, and waits for the signed
// /metrics to answer with the new sha. If it does not within the timeout, or the boot journal shows a fatal line,
// it puts the previous sha back and restarts again. Every attempt is logged and written on otto/mamoru#83.
import { $ } from 'bun'
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { metricsSignature } from '../../packages/operator-auth/src/index.ts'
import { fetchRefs, isAncestor } from './lib/git.ts'
import { OP_LOCK, refuseLeftoverWork, requireLease, sessionName, underFlock, WORK_LOCK } from './lib/lease.ts'
import { envReads, fatalLines, healthy, loopsStarted, newEnv, refuseDeploy, signedOk, type MetricsView } from './lib/operator.ts'

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

// The whole redeploy (change, verification and any restore) runs as its own transient systemd unit, so it finishes
// even when the session that started it is killed: the caller only waits for it and prints its log.
if (!process.env.MAMORU_DEPLOY_IN_UNIT) {
  const name = `mamoru-operator-deploy-${Date.now()}`
  // Every MAMORU_* setting reaches the unit (the operator dir, unit, env file and metrics URL overrides included).
  const mamoru = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('MAMORU_') && v !== undefined)) as Record<string, string>
  const env = { ...mamoru, PATH: process.env.PATH ?? '', HOME, MAMORU_COORD_AS: sessionName(argv) ?? '', MAMORU_DEPLOY_IN_UNIT: '1' }
  const setenv = Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`)
  console.log(`running as unit ${name} (journalctl --user -u ${name} -f to follow; it carries on if this session ends)`)
  const r = Bun.spawnSync(['systemd-run', '--user', '--quiet', '--collect', '--wait', `--unit=${name}`, `--working-directory=${root}`, ...setenv, process.execPath, import.meta.path, ...argv], { stdio: ['ignore', 'inherit', 'inherit'] })
  const log = Bun.spawnSync(['journalctl', '--user', `_SYSTEMD_USER_UNIT=${name}.service`, '-o', 'cat', '--no-pager'], { stdout: 'pipe' })
  process.stdout.write(log.stdout)
  process.exit(r.exitCode ?? 1)
}

// One coordinator operation at a time, held by the kernel until this process ends (lib/lease.ts).
underFlock(OP_LOCK, { wait: false, busy: 'another coordinator operation (a release or an operator redeploy) is running' })
refuseLeftoverWork()
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

/**
 * Puts `target` in place and waits for it: checkout, its own dependencies when the lockfile differs from what is
 * installed, restart, health. Never throws: any failing step is the answer.
 */
async function bringUp(target: string, installDeps: boolean): Promise<{ ok: boolean; why: string }> {
  try {
    // One process for the whole change, under WORK_LOCK: if this script dies mid-way, the checkout, install and
    // restart still run to the end holding the lock, and nothing starts beside them.
    const steps = [`git -C '${opDir}' checkout -q --detach ${target}`, ...(installDeps ? [`(cd '${opDir}' && bun install --frozen-lockfile)`] : []), `systemctl --user restart ${unit}`].join(' && ')
    await $`flock ${WORK_LOCK} sh -c ${steps}`.quiet()
  } catch (e) {
    return { ok: false, why: `step failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}` }
  }
  // This boot's own log lines only: the invocation the restart just started. Healthy also means it is still that
  // invocation (no automatic restart since) and it started a loop for every account that was active before.
  const invocation = (await $`systemctl --user show -p InvocationID --value ${unit}`.quiet().nothrow().text()).trim()
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await Bun.sleep(3_000)
    const journal = invocation ? await $`journalctl --user _SYSTEMD_INVOCATION_ID=${invocation} --no-pager -o cat`.quiet().nothrow().text() : ''
    const fatal = fatalLines(journal)
    if (fatal.length) return { ok: false, why: `boot journal: ${fatal[0]!.slice(0, 200)}` }
    const sameBoot = (await $`systemctl --user show -p InvocationID --value ${unit}`.quiet().nothrow().text()).trim() === invocation
    if (!sameBoot) return { ok: false, why: 'the unit restarted on its own after the redeploy (crash loop?)' }
    if (healthy(await metrics(), target, wasLive) && loopsStarted(journal) >= activeAccounts) return { ok: true, why: '' }
  }
  return { ok: false, why: `/metrics did not answer with ${target.slice(0, 7)} and ${activeAccounts} engine loops within ${BOOT_TIMEOUT_MS / 1000} s` }
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
// Engine loops the new boot must start: one per account active now.
const activeAccounts = (before as { accounts?: { active?: number } }).accounts?.active ?? 0

await fetchRefs(root, 'main')
// What runs is what /metrics says, not what is checked out: a run that died after its checkout leaves the two apart.
const runningShort = before.gitSha ?? refuse('the operator does not answer /metrics: find out why first (journalctl --user -u mamoru-operator)')
const running = (await $`git -C ${root} rev-parse ${`${runningShort}^{commit}`}`.text()).trim()
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

// Reviewed means on main and signed by an allowed key, for the target and for the sha a failed redeploy goes back to.
async function signature(rev: string): Promise<boolean> {
  const out = (await $`git -C ${root} log -1 --format=%G?%x09%GF ${rev}`.quiet().nothrow().text()).trim().split('\t')
  return signedOk(out[0] ?? '', out[1] ?? '')
}
if (!(await signature(full))) refuse(`${full.slice(0, 7)} is not signed by an allowed key (git log --format=%G?%GF)`)
if (!(await signature(running))) refuse(`the operator runs ${running.slice(0, 7)}, which is not signed by an allowed key: a failed redeploy could not roll back to reviewed code; fix that by hand first`)
if ((await $`git -C ${opDir} status --porcelain`.text()).trim()) refuse(`${opDir} has local changes`)

// What the new code reads from the environment that the running code did not: named, with whether the env file sets it.
const reads = async (rev: string) => envReads(await $`git -C ${root} grep -h -o ${'process\\.env\\.[A-Z0-9_]*'} ${rev} -- apps/mamoru-operator/src`.quiet().nothrow().text())
const added = newEnv(await reads(running), await reads(full), (() => {
  try {
    return readFileSync(envFile, 'utf8')
  } catch {
    return ''
  }
})())
if (added.length) console.log(`environment read by ${full.slice(0, 7)} and not by ${running.slice(0, 7)}: ${added.map((v) => `${v.name} (${v.set ? 'set' : 'NOT set'})`).join(', ')}`)

// --check: every check above, then the plan, and nothing moves.
if (argv.includes('--check')) {
  console.log(`check only: would move ${unit} ${running.slice(0, 7)} -> ${full.slice(0, 7)}, expecting ${activeAccounts} engine loops`)
  process.exit(0)
}

console.log(`== operator:deploy ${running.slice(0, 7)} -> ${full.slice(0, 7)}${rollback ? ' (rollback)' : ''} by ${who} ==`)
await note83(`${who}: ${running.slice(0, 7)} -> ${full.slice(0, 7)}${rollback ? ` (rollback: ${reason})` : ''}. Starting.${added.length ? ` New env: ${added.map((v) => `${v.name}${v.set ? '' : ' (not set)'}`).join(', ')}.` : ''}`)

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
