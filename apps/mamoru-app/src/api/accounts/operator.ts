import { Hono, type Context } from 'hono'
import type { AccountContext } from '@mamoru/domain'
import type { AppEnv } from '../context.ts'
import { liveFunds, operatorUrlFor } from '../env.ts'
import { accountNotFound, apiError } from '../errors.ts'
import { ACCOUNT_KEY } from '../onboarding/account.ts'
import { ownedAccount, ownersOf, type AccountRow } from './store.ts'

// Live funds (sprint amendment 2026-09-26 21:40): after the device session proves it owns the account,
// the Worker forwards the same route to the operator with a signed account context (app-api.ts AccountContext).

export type OperatorFetch = (input: string, init: RequestInit) => Promise<Response>

export const MAX_BODY_BYTES = 8 * 1024
export const OPERATOR_TIMEOUT_MS = 90_000

export function accountContext(row: AccountRow): AccountContext {
  return {
    accountKey: row.account_key,
    chainId: row.chain_id,
    address: row.address,
    owners: ownersOf(row),
    saltNonce: row.salt_nonce,
    passkey: { credentialId: row.passkey_credential_id, x: row.passkey_x, y: row.passkey_y },
  }
}

export function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Raw HMAC-SHA256(secret, "x-mamoru-ts-v1") bytes, used as the key below — the exact same 32 bytes the operator's
 * `tsKey` (server.ts, node:crypto `.digest()` with no encoding) derives, so both sides key the ts-signed scheme
 * identically without agreeing on a string encoding for the intermediate value.
 */
async function tsKey(secret: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode('x-mamoru-ts-v1')))
}

/**
 * hex HMAC-SHA256(tsKey(secret), `${method} ${path}\n${header}\n${ts}\n${body}`), as the operator verifies it
 * (otto/mamoru#140 part1 #6: `ts`, unix seconds, is signed so a captured request cannot be replayed past the
 * operator's skew window; a key derived from, not equal to, `secret` keeps this scheme from colliding with the
 * pre-#140 3-line one — see server.ts's `tsKey` comment).
 */
export async function operatorSignature(secret: string, method: string, path: string, header: string, body: string, ts: string): Promise<string> {
  const enc = new TextEncoder()
  // The cast works around a TS lib nuance (Uint8Array<ArrayBufferLike> vs <ArrayBuffer>) with no DOM lib loaded
  // here; the derived key is always a plain, non-shared Uint8Array.
  const key = await crypto.subtle.importKey('raw', (await tsKey(secret)) as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${method} ${path}\n${header}\n${ts}\n${body}`)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

const unavailable = (c: Context) => apiError(c, 503, 'The operator is not reachable. Nothing was sent. Try again.', 'OPERATOR_UNAVAILABLE')
const tooLarge = (c: Context) => apiError(c, 413, 'Request body too large.', 'BODY_TOO_LARGE')

export function operatorRoutes(operatorFetch: OperatorFetch) {
  const routes = new Hono<AppEnv>()

  const forward = async (c: Context<AppEnv>) => {
    const session = await c.var.auth.current(c)
    if (!session) return apiError(c, 401, 'Sign in first.', 'AUTH_REQUIRED')
    const accountKey = c.req.param('accountKey') ?? ''
    if (!ACCOUNT_KEY.test(accountKey)) return accountNotFound(c)
    const row = await ownedAccount(c.env.DB, session.userId, accountKey)
    if (!row) return accountNotFound(c)
    c.set('accountKey', row.account_key)

    const method = c.req.method
    let body = ''
    if (method !== 'GET') {
      const declared = Number(c.req.header('content-length') ?? '0')
      if (declared > MAX_BODY_BYTES) return tooLarge(c)
      body = await c.req.text()
      if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return tooLarge(c)
    }

    const env = c.env
    const operatorUrl = operatorUrlFor(env, row.chain_id)
    if (!liveFunds(env) || !env.OPERATOR_SECRET || !operatorUrl) return unavailable(c)
    const url = new URL(c.req.url)
    const path = url.pathname + url.search
    const header = base64url(JSON.stringify(accountContext(row)))
    const ts = Math.floor(Date.now() / 1000).toString()
    const sig = await operatorSignature(env.OPERATOR_SECRET, method, path, header, body, ts)
    const headers: Record<string, string> = { 'x-mamoru-account': header, 'x-mamoru-sig': sig, 'x-mamoru-ts': ts, accept: 'application/json' }
    if (method !== 'GET') headers['content-type'] = 'application/json'

    let res: Response
    let text: string
    try {
      res = await operatorFetch(operatorUrl + path, {
        method,
        headers,
        ...(method !== 'GET' ? { body } : {}),
        signal: AbortSignal.timeout(OPERATOR_TIMEOUT_MS),
      })
      text = await res.text()
    } catch (e) {
      console.error('operator unreachable', e instanceof Error ? e.message : String(e))
      return unavailable(c)
    }
    return new Response(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
    })
  }

  routes.get('/:accountKey/funding', forward)
  routes.get('/:accountKey/ops', forward)
  routes.get('/:accountKey/withdraw-assets', forward)
  routes.get('/:accountKey/bridge-out', forward)
  for (const action of ['activate', 'transfer', 'stop', 'renew', 'bridge-out']) {
    routes.post(`/:accountKey/${action}/prepare`, forward)
    routes.post(`/:accountKey/${action}`, forward)
  }
  return routes
}
