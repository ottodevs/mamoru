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

/**
 * A lock held for as long as a whole operation runs (a redeploy), released on exit. Taken atomically; one older than
 * `staleMs` is from a run that died, and is broken.
 */
export function holdDirLock(dir: string, staleMs: number): () => void {
  mkdirSync(dirname(dir), { recursive: true })
  try {
    mkdirSync(dir)
  } catch {
    let age = 0
    try {
      age = Date.now() - statSync(dir).mtimeMs
    } catch {}
    if (age <= staleMs) {
      console.error(`refusing: ${dir} is held (${Math.round(age / 1000)} s ago): another run is in progress`)
      process.exit(1)
    }
    rmdirSync(dir)
    mkdirSync(dir)
  }
  const release = () => {
    try {
      rmdirSync(dir)
    } catch {}
  }
  process.on('exit', release)
  return release
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
