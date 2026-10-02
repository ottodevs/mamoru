// Backs up accounts.json (session keys) before a deploy touches the checkout running it, keeping
// only the last `keep` copies. Never reads session key *values*; it only copies/hashes bytes.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BACKUP_RE = /^accounts\.json\.bak-(\d+)(?:-[0-9a-f]+)?$/

/** `accounts.json.bak-<n>[-<suffix>]` filenames among `names`, oldest (smallest numeric prefix) first. Accepts both this tool's new name shape and the older `bak-<n>` shape already on disk. */
export function sortBackups(names: string[]): string[] {
  return names.filter((n) => BACKUP_RE.test(n)).sort((a, b) => Number(BACKUP_RE.exec(a)![1]) - Number(BACKUP_RE.exec(b)![1]) || a.localeCompare(b))
}

/**
 * Which of `names` to delete so at most `keep` remain, oldest first. Never prunes the single
 * newest entry, even if `keep` is misconfigured to 0 or negative: a backup rotation must never be
 * able to delete every backup there is.
 */
export function backupsToPrune(names: string[], keep: number): string[] {
  const sorted = sortBackups(names)
  const safeKeep = Math.max(keep, 1)
  const excess = sorted.length - safeKeep
  return excess > 0 ? sorted.slice(0, excess) : []
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Copies `stateDir/accounts.json` to a uniquely-named backup that is created exclusively (fails
 * rather than overwriting anything that already exists), fsynced, and verified byte-for-byte
 * against the exact bytes read from the source before this function did anything else with them —
 * so a concurrent write to accounts.json by the live operator can only ever produce a backup of
 * one consistent snapshot or the other, never a hash mismatch from reading the source twice at
 * different times. Only prunes down to `keep` after the new backup verifies good, and never the
 * newest (see `backupsToPrune`). Returns the backup path, or null if there is no accounts.json yet
 * (a fresh operator). Throws (without touching the source) if the new backup cannot be verified.
 */
export function backupAccounts(stateDir: string, keep = 10, now: number = Date.now()): string | null {
  const file = join(stateDir, 'accounts.json')
  if (!existsSync(file)) return null

  const srcBuf = readFileSync(file) // one consistent snapshot; never re-read the source after this line
  const srcHash = sha256(srcBuf)

  const ms = Math.floor(now)
  let dest = ''
  const maxAttempts = 8
  for (let attempt = 0; ; attempt++) {
    const candidate = join(stateDir, `accounts.json.bak-${ms}-${randomBytes(4).toString('hex')}`)
    try {
      writeFileSync(candidate, srcBuf, { mode: 0o600, flag: 'wx' }) // 'wx': fails with EEXIST rather than overwriting
      dest = candidate
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= maxAttempts) throw e
      // name collision (same millisecond AND same random suffix): vanishingly unlikely, retry with a fresh suffix
    }
  }

  const fd = openSync(dest, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  const destBuf = readFileSync(dest)
  if (destBuf.length !== srcBuf.length || sha256(destBuf) !== srcHash) {
    unlinkSync(dest)
    throw new Error(`accounts.json backup verification failed (size/hash mismatch after write), removed ${dest}`)
  }

  for (const stale of backupsToPrune(readdirSync(stateDir), keep)) unlinkSync(join(stateDir, stale))
  return dest
}

/** Size + sha256 of `path`, for an external caller that wants to double-check a backup independently of `backupAccounts`'s own verification. */
export function fileDigest(path: string): { size: number; sha256: string } {
  const buf = readFileSync(path)
  return { size: statSync(path).size, sha256: sha256(buf) }
}
