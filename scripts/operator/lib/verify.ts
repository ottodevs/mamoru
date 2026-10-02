// Post-restart verification: is the process that is actually running the one we just deployed, and
// is there more than one operator process alive at once (the transient/durable overlap hazard, or
// a previous deploy leaving an orphan behind)? Both are read-only OS inspection (/proc, pgrep), not
// anything the operator or systemd tells us about itself — so a bug in the app cannot make this
// check lie.
import { realpath } from 'node:fs/promises'

export type RunningFromResult = { ok: boolean; pid: number | null; actualCwd: string | null; expectedDir: string }

/**
 * True if the process at `getPid()`'s cwd resolves to exactly `expectedDir` — proof the restarted
 * process is actually running from that code, not a stale process that failed to restart. Under
 * the releases/<sha> layout (checkout.ts) `expectedDir`'s basename IS the sha, so this single check
 * verifies both the cwd and the sha in one step: there is nothing else to separately ask the
 * process about its own version. `getPid` is injected (normally `() => unitMainPid(unit)`) so this
 * is testable without systemd.
 */
export async function verifyRunningFrom(expectedDir: string, getPid: () => Promise<number | null>): Promise<RunningFromResult> {
  const expected = await realpath(expectedDir)
  const pid = await getPid()
  if (!pid) return { ok: false, pid: null, actualCwd: null, expectedDir: expected }
  try {
    const actualCwd = await realpath(`/proc/${pid}/cwd`)
    return { ok: actualCwd === expected, pid, actualCwd, expectedDir: expected }
  } catch {
    return { ok: false, pid, actualCwd: null, expectedDir: expected }
  }
}

/** PIDs of running processes whose command line contains `needle`, excluding `excludePid`. `pgrep -f`, read-only; exit code 1 (no match) is not an error. */
export async function pgrepByCommand(needle: string, excludePid: number): Promise<number[]> {
  const proc = Bun.spawn(['pgrep', '-f', needle], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== excludePid)
}

/** A message to refuse the deploy with, or null if it is safe to proceed. More than one process
 * running the operator's entrypoint at once means the transient/durable migration overlapped, or a
 * previous deploy left an orphan — exactly the double-engine-loop hazard the operator must never
 * hit (it would double-submit owner/engine transactions against the same relayer nonce). */
export function duplicateProcessCheck(pids: number[]): string | null {
  return pids.length > 1 ? `found ${pids.length} operator processes already running (pids: ${pids.join(', ')}), expected at most one; refusing to deploy while more than one could be active` : null
}
