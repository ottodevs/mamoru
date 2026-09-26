import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ANVIL_DEV_KEYS } from '../fixtures/lab.ts'

export type StepResult = {
  step: string
  ok: boolean
  detail?: string
  codes?: string[]
}

export type ScenarioResult = {
  id: string
  file: string
  requirements: string[]
  /** `not-executed`: a pre-step gate stopped the scenario (LAB_P256_UNAVAILABLE). Never a pass. */
  status: 'pass' | 'fail' | 'not-executed'
  kt1?: string[]
  gate?: string
  steps: StepResult[]
  invariants: Record<string, { ok: boolean; detail?: string }>
  codes: string[]
  durationMs: number
  error?: string
}

export function artifactsRoot(root: string): string {
  return join(root, 'scenarios/.artifacts')
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
}

export function sha256File(path: string): string {
  return new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex')
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const KEYED_URL = /https?:\/\/[^\s"']*(?:[?&](?:key|apikey|api_key|token)=|\/v[0-9]+\/[A-Za-z0-9_-]{16,})/gi
const PRIVATE_KEY = /0x[0-9a-fA-F]{64}/g

/**
 * LAB-06 / FR-OPS-004 / FR-OPS-006: no secret or personal data in artifacts
 * and logs. Looks for the upstream RPC URL and its host, keyed URLs, emails,
 * and private keys other than anvil's public development keys.
 */
export function secretScan(dirs: string[], secretEnvVars: string[] = ['RPC_URL']): { files: number; findings: string[] } {
  const secrets: string[] = []
  for (const v of secretEnvVars) {
    const value = process.env[v]
    if (!value) continue
    secrets.push(value)
    try {
      secrets.push(new URL(value).host)
    } catch {}
  }
  const devKeys = new Set(ANVIL_DEV_KEYS.map((k) => k.toLowerCase()))
  const findings: string[] = []
  let files = 0
  for (const d of dirs) {
    for (const f of walk(d)) {
      files++
      const buf = readFileSync(f)
      const text = buf.toString('latin1')
      for (const s of secrets) if (text.includes(s)) findings.push(`${f}: carries a secret environment value`)
      for (const m of text.match(KEYED_URL) ?? []) findings.push(`${f}: keyed URL pattern ${m.slice(0, 12)}…`)
      for (const m of text.match(EMAIL) ?? []) findings.push(`${f}: email-like string`)
      if (f.endsWith('.json') || f.endsWith('.log')) {
        for (const m of text.match(PRIVATE_KEY) ?? []) {
          if (devKeys.has(m.toLowerCase())) continue
          if (/(private|secret|key)["':=\s]{1,4}$/i.test(text.slice(Math.max(0, text.indexOf(m) - 16), text.indexOf(m)))) {
            findings.push(`${f}: private key next to a key label`)
          }
        }
      }
    }
  }
  return { files, findings }
}

/** The command line of a running process, as the process list shows it. */
export function processCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  } catch {
    return []
  }
}
