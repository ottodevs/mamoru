// The coordinator lease: which session may merge, release and redeploy the operator right now.
// One file on lady, where every session runs. A session names itself (`--as <name>` or MAMORU_COORD_AS);
// the lease lapses when its holder stops renewing it, so a session that died never blocks the others.
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const LEASE_TTL_MS = 3 * 60 * 60 * 1000

export interface Lease {
  holder: string
  claimedAt: string
  heartbeatAt: string
  note: string
}

export type LeaseVerdict = { ok: true } | { ok: false; reason: string }

export function leasePath(): string {
  return process.env.MAMORU_COORD_LEASE ?? `${process.env.HOME}/.local/state/mamoru-coord/lease.json`
}

export function isLive(lease: Lease | null, now: number): boolean {
  return lease !== null && now - Date.parse(lease.heartbeatAt) < LEASE_TTL_MS
}

/** May `who` act as coordinator under `lease`? Only its live holder may. */
export function checkHolder(lease: Lease | null, who: string | undefined, now: number): LeaseVerdict {
  if (!who) return { ok: false, reason: 'no session name: pass --as <name> or set MAMORU_COORD_AS (your session name)' }
  if (!lease || !isLive(lease, now)) return { ok: false, reason: `no live coordinator lease: claim it first (bun run coord claim --as ${who} --note "<what you will do>")` }
  if (lease.holder !== who) return { ok: false, reason: `the coordinator is ${lease.holder} (since ${lease.claimedAt}, last seen ${lease.heartbeatAt}: ${lease.note}). Ask it on otto/mamoru#83, or wait until the lease lapses` }
  return { ok: true }
}

/** The lease after `who` claims it, or why it cannot. A live lease of another session is never taken silently. */
export function claim(lease: Lease | null, who: string, note: string, now: number, take = false): { lease: Lease } | { error: string } {
  const at = new Date(now).toISOString()
  if (lease && isLive(lease, now) && lease.holder !== who && !take) {
    return { error: `held by ${lease.holder} since ${lease.claimedAt} (${lease.note}). Wait, ask on otto/mamoru#83, or \`take\` with a reason if that session is gone` }
  }
  const same = lease !== null && isLive(lease, now) && lease.holder === who
  return { lease: { holder: who, claimedAt: same ? lease!.claimedAt : at, heartbeatAt: at, note: note || (same ? lease!.note : '') } }
}

export function readLease(path = leasePath()): Lease | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Lease
  } catch {
    return null
  }
}

/** Atomic: written beside and renamed, so a reader never sees half a file. */
export function writeLease(lease: Lease | null, path = leasePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(lease))
  renameSync(tmp, path)
}

/**
 * A short critical section across processes: a directory is created atomically or not at all. A lock older than
 * `staleMs` belongs to a process that died, and is broken.
 */
export function withDirLock<T>(dir: string, fn: () => T, staleMs = 30_000): T {
  mkdirSync(dirname(dir), { recursive: true })
  for (let i = 0; ; i++) {
    try {
      mkdirSync(dir)
      break
    } catch {
      try {
        if (Date.now() - statSync(dir).mtimeMs > staleMs) rmdirSync(dir)
      } catch {}
      if (i > 200) throw new Error(`lock ${dir} still held`)
      Bun.sleepSync(50)
    }
  }
  try {
    return fn()
  } finally {
    try {
      rmdirSync(dir)
    } catch {}
  }
}

/** Every coordinator operation (a release, an operator redeploy) holds this lock for its whole run. */
export const OP_LOCK = `${process.env.HOME}/.local/state/mamoru-coord/op.lock`
/** One Codex review at a time, across every session. */
export const REVIEW_LOCK = `${process.env.HOME}/.local/state/mamoru-review/codex.lock`

const HELD = 'MAMORU_FLOCK_HELD'

/**
 * Runs the rest of this script holding `lockFile` with flock(1): the script is started again under `flock`, which
 * the kernel releases when the process ends, however it ends. No stale lock to guess about, none to steal. With
 * `wait: false` a busy lock refuses at once; with `wait: true` it queues.
 */
export function underFlock(lockFile: string, opts: { wait: boolean; busy: string }): void {
  const held = (process.env[HELD] ?? '').split(':').filter(Boolean)
  if (held.includes(lockFile)) return
  mkdirSync(dirname(lockFile), { recursive: true })
  const r = Bun.spawnSync(['flock', ...(opts.wait ? [] : ['-n']), '-E', '75', lockFile, process.execPath, ...process.argv.slice(1)], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, [HELD]: [...held, lockFile].join(':') },
  })
  if (r.exitCode === 75) {
    console.error(`refusing: ${opts.busy}`)
    process.exit(1)
  }
  process.exit(r.exitCode ?? 1)
}

/** True while some process holds `lockFile` (a coordinator operation is running). */
export function lockBusy(lockFile: string): boolean {
  mkdirSync(dirname(lockFile), { recursive: true })
  return Bun.spawnSync(['flock', '-n', '-E', '75', lockFile, 'true']).exitCode === 75
}

/** For scripts that need the lease: refuses (exit 1) unless the caller is its live holder, and renews it. */
export function requireLease(who: string | undefined, path = leasePath()): string {
  // Decided inside the lock, refused outside it: an exit inside would leave the lock behind.
  const verdict = withDirLock(`${path}.lck`, () => {
    const lease = readLease(path)
    const v = checkHolder(lease, who, Date.now())
    if (v.ok) writeLease({ ...lease!, heartbeatAt: new Date().toISOString() }, path)
    return v
  })
  if (!verdict.ok) {
    console.error(`refusing: ${verdict.reason}`)
    process.exit(1)
  }
  return who!
}

/** `--as <name>` from argv, else MAMORU_COORD_AS. */
export function sessionName(argv: string[]): string | undefined {
  const i = argv.indexOf('--as')
  return (i >= 0 ? argv[i + 1] : undefined) ?? process.env.MAMORU_COORD_AS ?? undefined
}
