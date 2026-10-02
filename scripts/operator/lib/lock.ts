// Exclusive, non-blocking advisory lock via flock(2), so a second concurrent deploy fails fast
// instead of racing the first one (checking out a sha mid-install, restarting mid-restart, etc).
// flock is tied to the open file descriptor, not to the process tidying up after itself: the lock
// releases automatically even if the holder is killed (-9) or crashes, so it can never wedge.
//
// This lock file lives in the DEPLOY TOOL's own state dir (MAMORU_DEPLOY_STATE_DIR, default
// ~/.local/state/mamoru-operator-deploy), never in the operator's own state dir
// (~/.local/state/mamoru-operator, which holds accounts.json/relayer.key and must only ever be
// touched by the operator itself and this tool's read-only backup step).
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { dlopen, FFIType } from 'bun:ffi'

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

function openLibc() {
  let lastErr: unknown
  for (const name of ['libc.so.6', 'libc.so']) {
    try {
      return dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('could not load libc for flock(2)')
}

let libc: ReturnType<typeof openLibc> | null = null
function flock(fd: number, op: number): number {
  libc ??= openLibc()
  return libc.symbols.flock(fd, op)
}

export class LockHeldError extends Error {}

export type Lock = { release: () => void }

/**
 * Acquires an exclusive, non-blocking lock on `lockFile` (created if missing). Throws
 * `LockHeldError` immediately if another process already holds it — never blocks/waits. Call
 * `release()` when done (also safe to just let the process exit: the OS releases it either way).
 */
export function acquireLock(lockFile: string): Lock {
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 })
  const fd = openSync(lockFile, 'a')
  const rc = flock(fd, LOCK_EX | LOCK_NB)
  if (rc !== 0) {
    closeSync(fd)
    throw new LockHeldError(`${lockFile} is held by another deploy; refusing to run two at once`)
  }
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      flock(fd, LOCK_UN)
      closeSync(fd)
    },
  }
}
