import { Hono, type Context } from 'hono'
import type { AccountContext, RemoteSpec } from '@mamoru/domain'
import type { AppEnv } from '../context.ts'
import { liveFunds, operatorUrlFor } from '../env.ts'
import { accountNotFound, apiError } from '../errors.ts'
import { ACCOUNT_KEY } from '../onboarding/account.ts'
import { ownersOf, type AccountRow } from './store.ts'
import { BASE, ownedSleeve } from '../sleeves.ts'
import { defaultRemoteRegistry, remoteOf, upsertRemoteSleeve, verifyRemote, type RemoteRegistry } from '../remote.ts'
import { chainFundingResponse, fundingRpcUrls, type ChainFunding } from './chain-funding.ts'

// Live funds (sprint amendment 2026-09-26 21:40): after the device session proves it owns the account,
// the Worker forwards the same route to the operator with a signed account context (app-api.ts AccountContext).

export type OperatorFetch = (input: string, init: RequestInit) => Promise<Response>

export const MAX_BODY_BYTES = 8 * 1024
export const OPERATOR_TIMEOUT_MS = 90_000
/**
 * otto/mamoru#238: the funding read is a poll, and when the operator does not answer it the Worker has the chain to
 * ask instead, so it does not wait the 90 s a signed owner action may need. Only where an RPC pool is configured:
 * without one there is nothing to fall back to and the read keeps the full time.
 */
export const FUNDING_TIMEOUT_MS = 20_000

export function accountContext(row: AccountRow): AccountContext {
  return {
    accountKey: row.account_key,
    chainId: row.chain_id,
    address: row.address,
    owners: ownersOf(row),
    saltNonce: row.salt_nonce,
    passkey: { credentialId: row.passkey_credential_id, x: row.passkey_x, y: row.passkey_y },
    ...(row.remote_json ? { remote: JSON.parse(row.remote_json) as RemoteSpec } : {}),
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

/** A signed GET of `/api/accounts/<key>/<what>` at the operator of `row`'s chain; null when it cannot be had (unset, unreachable, not OK). */
async function operatorGet(c: Context<AppEnv>, operatorFetch: OperatorFetch, row: AccountRow, what: string): Promise<unknown | null> {
  const env = c.env
  const operatorUrl = operatorUrlFor(env, row.chain_id)
  if (!liveFunds(env) || !env.OPERATOR_SECRET || !operatorUrl) return null
  const path = `/api/accounts/${row.account_key}/${what}`
  const header = base64url(JSON.stringify(accountContext(row)))
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = await operatorSignature(env.OPERATOR_SECRET, 'GET', path, header, '', ts)
  try {
    const res = await operatorFetch(operatorUrl + path, { method: 'GET', headers: { 'x-mamoru-account': header, 'x-mamoru-sig': sig, 'x-mamoru-ts': ts, accept: 'application/json' }, signal: AbortSignal.timeout(OPERATOR_TIMEOUT_MS) })
    return res.ok ? await res.json() : null
  } catch (e) {
    console.error('operator unreachable', e instanceof Error ? e.message : String(e))
    return null
  }
}

const unavailable = (c: Context) => apiError(c, 503, 'The operator is not reachable. Nothing was sent. Try again.', 'OPERATOR_UNAVAILABLE')
const tooLarge = (c: Context) => apiError(c, 413, 'Request body too large.', 'BODY_TOO_LARGE')

/**
 * What the funding route does when the operator could not give funding (otto/mamoru#238): not reachable, timed out,
 * or answering 5xx. A 4xx (sign-in, ownership, a refusal of the operator) never falls back: it says something true.
 */
const operatorFailed = (status: number) => status >= 500

export function operatorRoutes(operatorFetch: OperatorFetch, chain?: ChainFunding, remoteRegistry: RemoteRegistry = defaultRemoteRegistry) {
  const routes = new Hono<AppEnv>()

  /**
   * otto/mamoru#251: the Base operator may offer the account's own Safe on another chain. In a prepare the owner is about to
   * sign a bridge-out that mints only there, so an offer that is not the Safe the owner's own keys give is never passed on
   * (502 REMOTE_SAFE_MISMATCH). In the funding read it is the Worker's record of that Safe: stored if it checks out, ignored if not.
   */
  const checkRemote = async (c: Context<AppEnv>, row: AccountRow, method: string, path: string, text: string): Promise<Response | null> => {
    const prepare = method === 'POST' && path.endsWith('/prepare')
    const funding = method === 'GET' && path.endsWith('/funding')
    if (!prepare && !funding) return null
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return null
    }
    const offer = remoteOf(body)
    if (!offer) return null
    try {
      verifyRemote(accountContext(row), offer, remoteRegistry)
      if (funding) await upsertRemoteSleeve(c.env.DB, row, offer, c.var.now())
      return null
    } catch (e) {
      console.error(`remote Safe offer refused for ${row.account_key}`, e instanceof Error ? e.message : String(e))
      return prepare ? apiError(c, 502, 'Mamoru could not confirm the address of your account on the other chain. Nothing was signed.', 'REMOTE_SAFE_MISMATCH') : null
    }
  }

  const forwardWith = (opts: { timeoutMs?: (c: Context<AppEnv>, row: AccountRow) => number; fallback?: (c: Context<AppEnv>, row: AccountRow) => Promise<Response | null> } = {}) => async (c: Context<AppEnv>) => {
    const session = await c.var.auth.current(c)
    if (!session) return apiError(c, 401, 'Sign in first.', 'AUTH_REQUIRED')
    const accountKey = c.req.param('accountKey') ?? ''
    if (!ACCOUNT_KEY.test(accountKey)) return accountNotFound(c)
    // Review of PR #115 (P1 1): a chain-143 account is forwarded only while its chain is ready (beta host, flag,
    // OPERATOR_URL_143, a healthy operator of 143); otherwise it is the same 404 as a foreign key.
    const row = await ownedSleeve(c, session.userId, accountKey)
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
        signal: AbortSignal.timeout(opts.timeoutMs?.(c, row) ?? OPERATOR_TIMEOUT_MS),
      })
      text = await res.text()
    } catch (e) {
      console.error('operator unreachable', e instanceof Error ? e.message : String(e))
      return (await opts.fallback?.(c, row)) ?? unavailable(c)
    }
    if (opts.fallback && operatorFailed(res.status)) {
      const answer = await opts.fallback(c, row)
      if (answer) return answer
    }
    if (res.ok && row.chain_id === BASE) {
      const refused = await checkRemote(c, row, method, c.req.path, text)
      if (refused) return refused
    }
    return new Response(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
    })
  }

  const forward = forwardWith()
  routes.get('/:accountKey/funding', forwardWith(chain ? { timeoutMs: (c, row) => (fundingRpcUrls(c.env, row.chain_id).length > 0 ? FUNDING_TIMEOUT_MS : OPERATOR_TIMEOUT_MS), fallback: (c, row) => chainFundingResponse(c, row, chain) } : {}))
  routes.get('/:accountKey/ops', forward)
  routes.get('/:accountKey/withdraw-assets', forward)
  routes.get('/:accountKey/bridge-out', forward)
  for (const action of ['activate', 'transfer', 'stop', 'renew', 'bridge-out', 'eth-convert']) {
    routes.post(`/:accountKey/${action}/prepare`, forward)
    routes.post(`/:accountKey/${action}`, forward)
  }
  return routes
}
