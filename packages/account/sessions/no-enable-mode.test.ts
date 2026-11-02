import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// otto/mamoru#292, review of PR #200 (GPT-6 Sol r2, P1): a SmartSession ENABLE payload signed by the owner survives
// removeSession (SmartSession verifies it over $signerNonce[permissionId][account], which removeSession leaves as is).
// The V4 migration revokes the nonce of every old id it knows of, but an id it does not know of could carry a
// signed, unused payload that re-enables an old session outside V4. Mamoru therefore never asks the passkey to sign a
// SmartSession ENABLE payload: owner signatures are Safe transaction hashes only (enableSessions inside
// execTransaction; remote sessions committed in the Safe setup). This test keeps that true. A future multichain-enable
// design (#230) must revoke by nonce and get its own security review before this guard is relaxed.

const ROOT = join(import.meta.dir, '..', '..', '..')
const SCANNED = ['apps', 'packages']
/** Test-only code may build ENABLE-mode ops against forks. */
const EXEMPT_DIRS = ['packages/scenarios', 'node_modules', 'dist', 'fixtures', 'test', 'tests', '__fixtures__']
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|mjs)$/

/** The one line allowed to name the mode: its declaration next to SMART_SESSION_MODE_USE. */
const DECLARATION = { file: 'packages/account/sessions/index.ts', line: "export const SMART_SESSION_MODE_ENABLE = '0x01'" }

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'SMART_SESSION_MODE_ENABLE', re: /SMART_SESSION_MODE_ENABLE/ },
  { name: "0x01 as the first byte of a SmartSession signature", re: /concat\(\s*\[\s*['"`]0x01['"`]/ },
  { name: 'SmartSessionMode.ENABLE', re: /SmartSessionMode\.ENABLE\b/ },
  { name: 'an enable-signature digest helper', re: /getSessionDigest|sessionDigest|permissionEnableSig|hashesAndChainIds|chainDigestIndex|MULTICHAIN_SESSION_TYPEHASH|ChainDigest\b|EnableSession\b/ },
]

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const rel = relative(ROOT, path)
    if (EXEMPT_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`) || name === d)) continue
    if (statSync(path).isDirectory()) sources(path, out)
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) out.push(path)
  }
  return out
}

function violations(file: string): string[] {
  const rel = relative(ROOT, file)
  const found: string[] = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (rel === DECLARATION.file && line.trim() === DECLARATION.line) return
      for (const f of FORBIDDEN) if (f.re.test(line)) found.push(`${rel}:${i + 1}: ${f.name}`)
    })
  return found
}

describe('no owner-signed SmartSession ENABLE payloads (#292)', () => {
  test('no production file under apps/ or packages/ builds or signs an ENABLE-mode payload', () => {
    const files = SCANNED.flatMap((d) => sources(join(ROOT, d)))
    expect(files.some((f) => relative(ROOT, f) === DECLARATION.file)).toBe(true) // the scan reaches the sessions code
    expect(files.flatMap(violations)).toEqual([])
  })

  test('the guard catches what it is meant to catch (the test-only fixture uses the ENABLE mode)', () => {
    const fixture = join(ROOT, 'packages/scenarios/fixtures/session-op.ts')
    expect(violations(fixture).length).toBeGreaterThan(0)
    expect(sources(join(ROOT, 'packages')).includes(fixture)).toBe(false) // and it is exempt as test-only
  })
})
