import { Hono, type Context } from 'hono'
import type { AccountContext } from '@mamoru/domain'
import type { AppEnv } from '../context.ts'
import { liveFunds, operatorUrlFor } from '../env.ts'
import { accountNotFound, apiError } from '../errors.ts'
import { ACCOUNT_KEY } from '../onboarding/account.ts'
import { ownersOf, sleevesOfUser, type AccountRow } from './store.ts'
import { BASE, chainReady, ownedSleeve } from '../sleeves.ts'

/** otto/mamoru#214: the policy a renewal of a Base account may move to only once the owner's Monad sleeve runs. */
export const MULTICHAIN_POLICY = 'conservador-live-v6'
/** Review of PR #141: its fork twin is guarded the same way; otto/mamoru#225: v7 (v6 in one session per pool) too. */
const MULTICHAIN_POLICIES: ReadonlySet<string> = new Set([MULTICHAIN_POLICY, 'conservador-lab-v6', 'conservador-live-v7', 'conservador-lab-v7'])
export const MONAD = 143

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

/**
 * otto/mamoru#214: a Base account's renewal that targets conservador-live-v6 (its funding view's `upgradePolicy`, or the
 * policy it already runs) is refused unless the owner's Monad sleeve exists at the same address as the Base Safe (the
 * bridge-out grant mints only to that address) and its operator reports it active: v6 sends part of the savings to that
 * sleeve, and funds bridged to a sleeve nobody runs would sit idle. Review of PR #141 (P1 1): checked whatever the
 * `multichain_v6` ops flag says here, since the operator decides the target from its own pulled copy of it (which can
 * lag) and an account already on v6 renews as v6 either way. `null`: nothing to refuse; else the response.
 */
async function guardV6Renewal(c: Context<AppEnv>, operatorFetch: OperatorFetch, userId: string, row: AccountRow): Promise<Response | null> {
  if (row.chain_id !== BASE) return null
  const funding = (await operatorGet(c, operatorFetch, row, 'funding')) as { approval?: { upgradePolicy?: string; policyId?: string } | null } | null
  if (!funding) return unavailable(c)
  const a = funding.approval
  if (![a?.upgradePolicy, a?.policyId].some((id) => id !== undefined && MULTICHAIN_POLICIES.has(id))) return null
  const notActive = () => apiError(c, 409, 'Open and start your Monad sleeve first: this version sends part of your savings to it. Nothing was changed.', 'SLEEVE_NOT_ACTIVE')
  const sleeve = (await sleevesOfUser(c.env.DB, userId)).find((r) => r.chain_id === MONAD)
  if (!sleeve || sleeve.address.toLowerCase() !== row.address.toLowerCase() || !(await chainReady(c, MONAD))) return notActive()
  const view = (await operatorGet(c, operatorFetch, sleeve, 'funding')) as { active?: unknown } | null
  if (!view) return unavailable(c)
  return view.active === true ? null : notActive()
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

    // otto/mamoru#214: before the operator prepares or accepts a renewal, a v6 target needs a running Monad sleeve.
    if (method === 'POST' && (c.req.path.endsWith(`/${accountKey}/renew/prepare`) || c.req.path.endsWith(`/${accountKey}/renew`))) {
      const refused = await guardV6Renewal(c, operatorFetch, session.userId, row)
      if (refused) return refused
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
  for (const action of ['activate', 'transfer', 'stop', 'renew', 'bridge-out', 'eth-convert']) {
    routes.post(`/:accountKey/${action}/prepare`, forward)
    routes.post(`/:accountKey/${action}`, forward)
  }
  return routes
}
