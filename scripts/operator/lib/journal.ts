// Watches the unit's journal right after a restart so a regression is caught before the coordinator
// walks away, not just whenever someone next looks. The line source is a small injectable seam
// (`JournalSource`) so the matching logic is unit-testable without a real journalctl process.
//
// Two bugs a previous version of this file had, both fixed here:
//   1. The watch started "from now" only after /health had already succeeded, so anything logged
//      during the restart/startup window (the part most likely to show a crash) was missed. Fixed
//      by recording a journal cursor BEFORE the restart (`journalCursor`) and reading
//      `--after-cursor` from there, so the window covers the entire restart, not just the tail of it.
//   2. A premature end of the journal stream (EOF) was treated the same as "the window elapsed with
//      nothing to report" — i.e. success. journalctl is a `-f` follower: it should never exit on its
//      own before we kill it. If it does, that is a failure of the check itself, not a clean bill of
//      health, and is now reported as `failed: true` rather than silently returning `hits: []`.
import { $ } from 'bun'

/** Lines that mean a review actually failed, not routine chatter (see operator.ts/rpc-proxy.ts logging). */
export const REVIEW_ERROR_PATTERNS: RegExp[] = [/review error:/i, /observation failed/i, /OWNER_TX_(ERROR|FAILED|REVERTS)/, /\[rpc] .*refused/i]

export function linesMatchingAny(lines: string[], patterns: RegExp[] = REVIEW_ERROR_PATTERNS): string[] {
  return lines.filter((l) => patterns.some((p) => p.test(l)))
}

export type JournalSource = {
  /** Next line, or null at EOF (the follower process ended on its own — never expected while we are still watching). */
  read(): Promise<string | null>
  /** Resolves once the process has exited. `killedByUs` distinguishes "we told it to stop" (expected, at the end of the window) from any other exit (unexpected, a failure of the check). */
  exitCode(): Promise<{ code: number | null; killedByUs: boolean }>
  stop(): void
}

/** The current journal cursor for `unit`, so a later `--after-cursor` read starts exactly here — not "now" (racy: anything logged between recording the cursor and starting the follower would be missed by `--since now`, and anything logged before a health check completes would be missed entirely by a "start after health" design). Read-only; does not affect the unit. */
export async function journalCursor(unit: string): Promise<string | null> {
  const out = await $`journalctl --user -u ${unit} --show-cursor -n 0`.quiet().text()
  const m = /-- cursor: (.+)/.exec(out)
  return m ? m[1]!.trim() : null
}

/** `journalctl --user -u <unit> -f --after-cursor=<cursor>` (or `--since now` if no cursor is available), line-buffered. Real I/O: not used directly in tests. */
export function journalFollow(unit: string, afterCursor: string | null): JournalSource {
  const args = ['journalctl', '--user', '-u', unit, '-f', '--no-pager', '-o', 'cat', ...(afterCursor ? [`--after-cursor=${afterCursor}`] : ['--since', 'now'])]
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' })
  let killedByUs = false
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  return {
    async read() {
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          return line
        }
        const { value, done } = await reader.read()
        if (done) return null
        buf += decoder.decode(value, { stream: true })
      }
    },
    async exitCode() {
      const code = await proc.exited
      return { code, killedByUs }
    },
    stop() {
      killedByUs = true
      proc.kill()
    },
  }
}

export type TailResult = { hits: string[]; failed: boolean; reason?: string }

/**
 * Reads from `source` for `seconds`. `failed` is true if any line matched `patterns`, OR if the
 * source ended on its own before the window closed (journalctl died/errored: that is a failed
 * check, not a clean one — we genuinely do not know what happened during the gap). Always stops
 * the source before returning.
 */
export async function tailForErrors(source: JournalSource, seconds: number, patterns: RegExp[] = REVIEW_ERROR_PATTERNS): Promise<TailResult> {
  const hits: string[] = []
  const deadline = Date.now() + seconds * 1_000
  const timedOut: unique symbol = Symbol('timed out')
  let prematureEnd = false
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const line: string | null | typeof timedOut = await Promise.race([source.read(), Bun.sleep(remaining).then((): typeof timedOut => timedOut)])
      if (line === timedOut) break
      if (line === null) {
        prematureEnd = true
        break
      }
      if (patterns.some((p) => p.test(line))) hits.push(line)
    }
  } finally {
    source.stop()
  }
  if (prematureEnd) {
    const { code } = await source.exitCode()
    return { hits, failed: true, reason: `journalctl ended before the ${seconds}s window closed (exit ${code ?? 'unknown'}); treating as failed, not clean` }
  }
  return hits.length > 0 ? { hits, failed: true, reason: `${hits.length} error-shaped line(s) found` } : { hits, failed: false }
}
