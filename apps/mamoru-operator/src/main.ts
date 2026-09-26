import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bootOperator } from './boot.ts'

// Env file: ~/.config/mamoru-operator/env (BASE_RPC_URL/RPC_URL, OPERATOR_SECRET). Loaded here so the URL never goes through argv.
const envFile = process.env.MAMORU_OPERATOR_ENV ?? join(homedir(), '.config/mamoru-operator/env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
}
if (!process.env.OPERATOR_SECRET) {
  const secret = randomBytes(32).toString('hex')
  appendFileSync(envFile, `OPERATOR_SECRET=${secret}\n`, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  process.env.OPERATOR_SECRET = secret
  console.log(`[operator] generated OPERATOR_SECRET into ${envFile}`)
}
const rpcUrl = process.env.BASE_RPC_URL ?? process.env.RPC_URL
if (!rpcUrl) throw new Error('BASE_RPC_URL (or RPC_URL) is not set')

const num = (v: string | undefined) => (v ? Number(v) : undefined)
const op = await bootOperator({
  rpcUrl,
  secret: process.env.OPERATOR_SECRET,
  stateDir: process.env.MAMORU_OPERATOR_STATE_DIR ?? join(homedir(), '.local/state/mamoru-operator'),
  port: num(process.env.PORT) ?? 8787,
  policyId: process.env.MAMORU_POLICY,
  reviewMs: num(process.env.MAMORU_REVIEW_MS),
  waitBlockMs: num(process.env.MAMORU_WAIT_BLOCK_MS),
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (op.stop(), process.exit(0)))
