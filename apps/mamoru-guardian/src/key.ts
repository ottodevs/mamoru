// otto/mamoru#293 (spec 010 I7): the guardian key lives only in a file, never in env, argv or logs.
import { readFileSync, statSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'

/** Loads the key from `path`; refuses a file readable by group/other. Errors never carry the file content. */
export function loadGuardianAccount(path: string) {
  const st = statSync(path)
  if (!st.isFile()) throw new Error('MAMORU_GUARDIAN_KEY_FILE: not a regular file')
  if ((st.mode & 0o077) !== 0) throw new Error('MAMORU_GUARDIAN_KEY_FILE: permissions too open, chmod 600 it')
  const raw = readFileSync(path, 'utf8').trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('MAMORU_GUARDIAN_KEY_FILE: expected 0x + 64 hex characters')
  return privateKeyToAccount(raw as `0x${string}`)
}
