#!/usr/bin/env bun
// `bun run operator:deploy <sha> --as <session> [--unit <systemd unit>] [--check] [--rollback] [--reason "<why>"]` — moves the
// live operator (default unit mamoru-operator; mamoru-operator-monad for Monad) to ONE
// named commit of origin/main. Coordinator only (lib/lease.ts). One redeploy at a time (a lock beside the lease).
// Refuses a sha that would drop work the operator already runs, unless --rollback. Checks out the sha in the
// operator's worktree, installs dependencies when the lockfile changed, restarts the unit, and waits for the signed
// /metrics to answer with the new sha. Then (otto/mamoru#369) it waits for the engines to observe: every engine that
// observed before the redeploy must have a review that reached a decision, within MAMORU_DEPLOY_OBSERVE_MS (default
// 4 min). If the boot is not healthy within the timeout, the boot journal shows a fatal line, or an engine fails to
// observe (OBSERVE_FAIL_AFTER failed reviews in a row, or none that decides in time), it puts the previous sha back
// and restarts again, by itself. Every attempt is logged and written on otto/mamoru#83.
import { $ } from 'bun'
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { metricsSignature } from '../../packages/operator-auth/src/index.ts'
import { fetchRefs, isAncestor } from './lib/git.ts'
import { OP_LOCK, refuseLeftoverWork, requireLease, sessionName, underFlock, WORK_LOCK } from './lib/lease.ts'
import { engineBaseline, envReads, fatalLines, healthy, loopsStarted, newEnv, observeTimeout, observeVerdict, refuseDeploy, signedOk, unitTarget, type EngineView, type MetricsView } from './lib/operator.ts'

const HOME = process.env.HOME!
const root = new URL('../../', import.meta.url).pathname
const argv = process.argv.slice(2)
function refuse(why: string): never {
  console.error(`refusing: ${why}`)
  process.exit(1)
}
const unitArg = (() => {
  const i = argv.indexOf('--unit')
  if (i < 0) return undefined
  const v = argv[i + 1]
  return v && !v.startsWith('-') ? v : refuse('--unit needs a unit name (mamoru-operator or mamoru-operator-monad)')
})()
if (unitArg !== undefined && process.env.MAMORU_OPERATOR_UNIT !== undefined && unitArg !== process.env.MAMORU_OPERATOR_UNIT) refuse(`--unit ${unitArg} and MAMORU_OPERATOR_UNIT=${process.env.MAMORU_OPERATOR_UNIT} disagree`)
const unit = unitArg ?? process.env.MAMORU_OPERATOR_UNIT ?? 'mamoru-operator'
// otto/mamoru#241: dir, env file and metrics come from the unit; the MAMORU_OPERATOR_* overrides may only agree with it.
const target = (() => {
  const show = (p: string) => {
    const r = Bun.spawnSync(['systemctl', '--user', 'show', unit, '-p', p, '--value'], { stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) refuse(`systemctl show ${unit} -p ${p} failed: ${r.stderr.toString().trim()}`)
    return r.stdout.toString().trim()
  }
  const t = unitTarget(
    unit,
    {
      workingDirectory: show('WorkingDirectory'),
      environment: show('Environment'),
      envFileText: (path) => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return null
        }
      },
      realpath: (p) => realpathSync(p.replace(/^~(?=\/)/, HOME)),
    },
    { dir: process.env.MAMORU_OPERATOR_DIR, envFile: process.env.MAMORU_OPERATOR_ENV, metricsUrl: process.env.MAMORU_OPERATOR_METRICS },
    `${HOME}/.config/mamoru-operator/env`,
  )
  return typeof t === 'string' ? refuse(t) : t
})()
const opDir = target.dir
const envFile = target.envFile
const metricsUrl = target.metricsUrl
const logFile = `${HOME}/.local/state/mamoru-operator/deploys.jsonl`
const BOOT_TIMEOUT_MS = 120_000
// otto/mamoru#369: how long the engines have, once the boot is healthy, to observe. Read before anything moves.
const OBSERVE_MS = (() => {
  const t = observeTimeout(process.env.MAMORU_DEPLOY_OBSERVE_MS)
  return typeof t === 'string' ? refuse(t) : t
})()

const sha = argv.find((a) => /^[0-9a-f]{7,40}$/.test(a)) ?? ''
const rollback = argv.includes('--rollback')
const reason = (() => {
  const i = argv.indexOf('--reason')
  return i >= 0 ? (argv[i + 1] ?? '') : ''
})()

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

async function payload(): Promise<{ operator?: MetricsView; engines?: EngineView[] } | null> {
  try {
    const secret = readFileSync(envFile, 'utf8').match(/^OPERATOR_SECRET=(.*)$/m)?.[1]?.replace(/^["']|["']$/g, '')
    if (!secret) return null
    const sig = await metricsSignature(secret, 'GET', '/metrics', Math.floor(Date.now() / 60_000))
    const r = await fetch(metricsUrl, { headers: { 'x-mamoru-sig': sig }, signal: AbortSignal.timeout(5_000) })
    if (!r.ok) return null
    return (await r.json()) as { operator?: MetricsView; engines?: EngineView[] }
  } catch {
    return null
  }
}
async function metrics(): Promise<MetricsView | null> {
  return (await payload())?.operator ?? null
}

/**
 * Puts `target` in place and waits for it: checkout, its own dependencies when the lockfile differs from what is
 * installed, restart, health. Never throws: any failing step is the answer.
 */
async function bringUp(target: string, installDeps: boolean, observe: boolean): Promise<{ ok: boolean; why: string }> {
  // systemd sets NRestarts back to 0 on a manual restart (ours) and counts each automatic one after it: anything but
  // 0 means the boot we started crashed and systemd started another.
  const nRestarts = async () => (await $`systemctl --user show -p NRestarts --value ${unit}`.quiet().nothrow().text()).trim()
  // Reviews the new boot makes are the ones after this instant (the engine tracker also starts empty at boot).
  const restartedAt = Date.now()
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
    if (!sameBoot || (await nRestarts()) !== '0') return { ok: false, why: 'the unit restarted on its own after the redeploy (crash loop?)' }
    if (healthy(await metrics(), target, wasLive) && loopsStarted(journal) >= activeAccounts) return observe ? await observed(target, invocation, restartedAt) : { ok: true, why: '' }
  }
  return { ok: false, why: `/metrics did not answer with ${target.slice(0, 7)} and ${activeAccounts} engine loops within ${BOOT_TIMEOUT_MS / 1000} s` }
}

/**
 * otto/mamoru#369: a boot that started its loops is not yet one that observes (4 Nov 2026, ottodevs/mamoru#281: every
 * Monad review failed OBS_RPC_UNAVAILABLE for 10 minutes behind a healthy /metrics). Waits up to OBSERVE_MS for every
 * engine that observed before to observe again on `target`; a fatal line, a restart or an engine failing its reviews
 * ends the wait as a failure.
 */
async function observed(target: string, invocation: string, since: number): Promise<{ ok: boolean; why: string }> {
  console.log(`boot healthy on ${target.slice(0, 7)}; waiting up to ${OBSERVE_MS / 1000} s for ${baseline.required ? baseline.required.size : 'every'} engine(s) to observe`)
  const deadline = Date.now() + OBSERVE_MS
  let last = ''
  for (;;) {
    const timedOut = Date.now() >= deadline
    const journal = invocation ? await $`journalctl --user _SYSTEMD_INVOCATION_ID=${invocation} --no-pager -o cat`.quiet().nothrow().text() : ''
    const fatal = fatalLines(journal)
    if (fatal.length) return { ok: false, why: `boot journal: ${fatal[0]!.slice(0, 200)}` }
    if ((await $`systemctl --user show -p InvocationID --value ${unit}`.quiet().nothrow().text()).trim() !== invocation) return { ok: false, why: 'the unit restarted on its own after the redeploy (crash loop?)' }
    const p = await payload()
    // /metrics must still answer with the target: a process that stopped answering observes nothing we can see.
    const v = p && healthy(p.operator ?? null, target, wasLive) ? observeVerdict(p.engines, activeAccounts, baseline.required, since, timedOut) : timedOut ? { state: 'fail' as const, why: `/metrics stopped answering with ${target.slice(0, 7)}` } : { state: 'wait' as const, pending: ['/metrics'] }
    if (v.state === 'ok') return { ok: true, why: '' }
    if (v.state === 'fail') return { ok: false, why: `engines do not observe: ${v.why}` }
    const now = `waiting on ${v.pending.slice(0, 6).join(', ')}${v.pending.length > 6 ? ', ...' : ''}`
    if (now !== last) console.log(now)
    last = now
    await Bun.sleep(Math.min(5_000, Math.max(0, deadline - Date.now())) || 1_000)
  }
}

function log(entry: Record<string, unknown>): void {
  mkdirSync(`${HOME}/.local/state/mamoru-operator`, { recursive: true })
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), by: who, ...entry })}\n`)
}

async function note83(text: string): Promise<void> {
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ')
  await $`tk comment forgejo:otto/mamoru#83 ${`${at} UTC [operator:deploy] ${text}`}`.quiet().nothrow()
}

const beforePayload = await payload()
const before = beforePayload?.operator ?? {}
// otto/mamoru#369: the engines that observe now are the ones the new boot must see observing again.
const baseline = engineBaseline(beforePayload?.engines, Date.now())
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
// A failed redeploy goes back to the running sha: it must be reviewed too, on main as well as signed.
if (!(await isAncestor(root, running, 'origin/main'))) refuse(`the operator runs ${running.slice(0, 7)}, which is not a commit of origin/main: a failed redeploy could not roll back to reviewed code; fix that by hand first`)
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
  console.log(`then wait up to ${OBSERVE_MS / 1000} s for ${baseline.required ? `${baseline.required.size} engine(s) that observe now` : 'every engine (the running code publishes none)'} to observe, and roll back by itself when they do not${baseline.failing.length ? `; not observing now (or no recent review), so not required: ${baseline.failing.join(', ')}` : ''}`)
  process.exit(0)
}

console.log(`== operator:deploy ${running.slice(0, 7)} -> ${full.slice(0, 7)}${rollback ? ' (rollback)' : ''} by ${who} ==`)
await note83(`${who}: ${running.slice(0, 7)} -> ${full.slice(0, 7)}${rollback ? ` (rollback: ${reason})` : ''}. Starting.${added.length ? ` New env: ${added.map((v) => `${v.name}${v.set ? '' : ' (not set)'}`).join(', ')}.` : ''}`)

const lockChanged = (await $`git -C ${opDir} diff --quiet ${running} ${full} -- bun.lock`.nothrow()).exitCode !== 0
// Logged before anything moves: an unwritable log stops the redeploy here, not after it (as switch.sh did).
try {
  log({ from: running, to: full, rollback, result: 'start' })
} catch (e) {
  refuse(`cannot write the deploy log ${logFile}: ${e instanceof Error ? e.message : e}`)
}
const result = await bringUp(full, lockChanged, true)
if (result.ok) {
  log({ from: running, to: full, rollback, result: 'ok' })
  await note83(`${who}: operator runs ${full.slice(0, 7)}, /metrics answers. Rollback: bun run operator:deploy ${running} --rollback --reason "..." --as <you>`)
  console.log(`operator runs ${full.slice(0, 7)}`)
  process.exit(0)
}

console.error(`deploy failed: ${result.why}. Putting ${running.slice(0, 7)} back.`)
// The previous sha with its own dependencies installed before it starts, whatever step failed above: the same move
// as `operator:deploy <running> --rollback --reason "<why>"`, run here by itself. Its boot is checked, not its
// engines: it is the code that ran before, and nothing older is left to go back to.
const back = await bringUp(running, lockChanged, false)
log({ from: running, to: full, rollback, result: 'failed', why: result.why, restored: back.ok, autoRollback: { to: running, reason: result.why } })
await note83(`${who}: ${full.slice(0, 7)} FAILED (${result.why}); ${back.ok ? `back on ${running.slice(0, 7)}, healthy` : `restoring ${running.slice(0, 7)} ALSO FAILED (${back.why}): the operator needs a human now`}.`)
process.exit(1)
