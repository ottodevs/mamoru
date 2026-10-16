import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Server } from 'bun'
import type { AccountContext } from '@mamoru/domain'
import { verifyMetricsSignature } from '@mamoru/operator-auth'
import { logErr } from './metrics.ts'
import type { SnapshotLoop } from './snapshot.ts'
import type { RpcMetrics } from './metrics.ts'
import { HttpError, type Operator } from './operator.ts'

/**
 * The old (pre-#140) 3-line payload has no `ts` segment, so it is just `${method} ${path}\n${header}\n${body}`
 * with `body` unconstrained free text. If the new, ts-signed payload reused the same key, a captured 4-line
 * signature (ts, body) would also verify a 3-line request whose body is literally `${ts}\n${body}` — the ts
 * line "shifts" into the body slot. A different, derived key for the ts-signed form closes that: no string the
 * old form's body can take ever reproduces a MAC made under a different key, independent of any byte shuffling.
 */
/** Raw digest (not hex): a Buffer used directly as HMAC key bytes needs no agreement on a string encoding with
 * the Web Crypto side (apps/mamoru-app), which derives the exact same 32 raw bytes from `crypto.subtle.sign`. */
function tsKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('x-mamoru-ts-v1').digest()
}

/**
 * hex HMAC-SHA256(key, `${method} ${path}\n${header}\n${ts}\n${body}`), `ts` the caller's unix-seconds clock
 * (header `x-mamoru-ts`), path with its query string, `key` = tsKey(secret). otto/mamoru#140 (part1 #6): `ts` is
 * signed, not read as a separate unauthenticated field, and the verifier below rejects one more than
 * REQUEST_SKEW_MS off its own clock — a captured request (header, sig, body) cannot be replayed past that window.
 *
 * `ts` omitted (`null`) signs the old 3-line payload under `secret` directly, with no skew check: the transition
 * form, so the app Worker (apps/mamoru-app) and this operator can be deployed in either order without a window
 * where requests fail. Deploy the operator first — it already verifies both forms — then the app Worker, the side
 * that starts sending `x-mamoru-ts`. Once every caller has run with it for a while, drop the no-ts fallback in a
 * follow-up change.
 */
export function operatorSignature(secret: string, method: string, path: string, header: string, body: string, ts: string | null = null): string {
  if (ts !== null) return createHmac('sha256', tsKey(secret)).update(`${method} ${path}\n${header}\n${ts}\n${body}`).digest('hex')
  return createHmac('sha256', secret).update(`${method} ${path}\n${header}\n${body}`).digest('hex')
}

/** How far a request's `x-mamoru-ts` may sit from this operator's clock before it is refused as stale. */
export const REQUEST_SKEW_MS = 60_000

function decodeContext(header: string): AccountContext {
  const ctx = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as AccountContext
  if (!ctx || typeof ctx.accountKey !== 'string' || typeof ctx.address !== 'string' || !Array.isArray(ctx.owners) || !ctx.passkey) throw new Error('bad context')
  return ctx
}

const ROUTE = /^\/api\/accounts\/([^/]+)\/(funding|ops|withdraw-assets|activate\/prepare|activate|transfer\/prepare|transfer|stop\/prepare|stop|renew\/prepare|renew)$/

// Amounts are base-unit strings on the wire; a bigint that slips into a view is sent as its decimal string.
const wire = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, wire), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * GET /metrics payload: RPC traffic (per provider host, never the URL or a key), engine health per
 * account (key shortened to 8 chars) and operator-level facts. No secrets, no session keys, no full
 * account keys, no RPC URLs. See docs/operator-metrics.md.
 */
async function buildMetricsPayload(op: Operator, rpcMetrics: RpcMetrics, gitSha: string, bootedAt: number): Promise<unknown> {
  const rpc = rpcMetrics.snapshot()
  const relayerBalance = await op.relayerBalance()
  return {
    generatedAt: new Date().toISOString(),
    operator: {
      uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
      gitSha,
      chainId: op.cfg.chainId,
      live: op.cfg.live,
      policyId: op.cfg.policy.policyId,
      relayer: { address: op.relayer.address, balanceWei: relayerBalance.wei, balanceCachedAgeMs: relayerBalance.cachedAgeMs },
      accounts: op.accountsSummary(),
      // Spec 006 (otto/mamoru#147): the engine settings versions applied, where they came from, and any env override.
      settings: op.settingsStatus(),
    },
    rpc: {
      cumulative: rpc.cumulative,
      cuEstimateTotal: rpc.cuEstimateTotal,
      last48h: rpc.last48h,
      // eth_getLogs ranges per provider since boot: accepted with a witness, or rejected (no_witness, hash_mismatch, provider_error).
      logRanges: rpc.logRanges,
      // The same requests by component (engine reviews, armed watcher, operator, relayer) and method.
      byComponent: rpc.byComponent,
      note: 'cuEstimate is a static per-method estimate (see metrics.ts CU_TABLE), not Alchemy\'s billed figure',
    },
    engines: op.engineHealthSnapshot(),
  }
}

export function startServer(op: Operator, opts: { secret: string; hostname: string; port: number; rpcMetrics: RpcMetrics; gitSha: string; bootedAt: number; snapshot?: SnapshotLoop | null }): Server<undefined> {
  return Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname + url.search
      if (url.pathname === '/health') {
        return json(200, { ok: true, chainId: op.cfg.chainId, live: op.cfg.live, policy: op.cfg.policy.policyId, relayer: op.relayer.address })
      }
      if (url.pathname === '/metrics') {
        if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
        const sig = req.headers.get('x-mamoru-sig')
        if (!(await verifyMetricsSignature(opts.secret, 'GET', '/metrics', sig))) return json(401, { error: 'unauthorized', code: 'OPERATOR_AUTH' })
        return json(200, await buildMetricsPayload(op, opts.rpcMetrics, opts.gitSha, opts.bootedAt))
      }
      if (url.pathname === '/snapshot') {
        // otto/mamoru#136: the latest snapshot, signed like /metrics. 404 while the loop is off (MAMORU_SNAPSHOT unset).
        if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
        const sig = req.headers.get('x-mamoru-sig')
        if (!(await verifyMetricsSignature(opts.secret, 'GET', '/snapshot', sig))) return json(401, { error: 'unauthorized', code: 'OPERATOR_AUTH' })
        if (!opts.snapshot) return json(404, { error: 'snapshot off' })
        const snap = opts.snapshot.current
        if (!snap) return json(503, { error: 'no snapshot yet', lastError: opts.snapshot.lastError })
        return json(200, { ...snap, safes: snap.safes.map((x) => ({ ...x, accountKey: x.accountKey.slice(0, 8) })), lastError: opts.snapshot.lastError })
      }
      const m = ROUTE.exec(url.pathname)
      if (!m) return json(404, { error: 'not found' })
      const body = req.method === 'POST' ? await req.text() : ''
      const header = req.headers.get('x-mamoru-account') ?? ''
      const sig = req.headers.get('x-mamoru-sig') ?? ''
      const ts = req.headers.get('x-mamoru-ts')
      // otto/mamoru#140: a signed ts outside the accepted clock skew is a replay of an old captured request, not a
      // forged one — refused before the signature is even checked, with the same unauthorized shape either way.
      if (ts !== null && (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts) * 1000) > REQUEST_SKEW_MS)) {
        return json(401, { error: 'unauthorized', code: 'OPERATOR_AUTH' })
      }
      const expected = operatorSignature(opts.secret, req.method, path, header, body, ts)
      if (!header || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return json(401, { error: 'unauthorized', code: 'OPERATOR_AUTH' })
      let ctx: AccountContext
      try {
        ctx = decodeContext(header)
      } catch {
        return json(401, { error: 'bad account context', code: 'OPERATOR_AUTH' })
      }
      if (decodeURIComponent(m[1]!) !== ctx.accountKey) return json(401, { error: 'account mismatch', code: 'OPERATOR_AUTH' })
      const route = `${req.method} ${m[2]}`
      const parse = () => {
        try {
          return JSON.parse(body || '{}')
        } catch {
          throw new HttpError(400, 'BAD_REQUEST', 'body is not JSON')
        }
      }
      try {
        switch (route) {
          case 'GET funding':
            return json(200, await op.funding(ctx, url.searchParams.get('fresh') === '1'))
          case 'GET withdraw-assets':
            return json(200, await op.withdrawAssets())
          case 'GET ops':
            return json(200, op.ops(ctx, url.searchParams.get('after'), url.searchParams.get('all') === '1'))
          case 'POST activate/prepare':
            return json(200, await op.prepareActivate(ctx))
          case 'POST activate':
            return json(200, await op.submit(ctx, 'activate', parse()))
          case 'POST transfer/prepare':
            return json(200, await op.prepareTransfer(ctx, parse()))
          case 'POST transfer':
            return json(200, await op.submit(ctx, 'transfer', parse()))
          case 'POST stop/prepare':
            return json(200, await op.prepareStop(ctx))
          case 'POST stop':
            return json(200, await op.submit(ctx, 'stop', parse()))
          case 'POST renew/prepare':
            return json(200, await op.prepareRenew(ctx))
          case 'POST renew':
            return json(200, await op.submit(ctx, 'renew', parse()))
          default:
            return json(405, { error: 'method not allowed' })
        }
      } catch (e) {
        // HttpError's own message is always one of the fixed, operator-authored strings in
        // operator.ts's SAFE_ERROR_MESSAGE table (or static/safe-dynamic text audited there) —
        // never a raw caught exception's message — so it is safe to return as-is here. Anything
        // that is NOT an HttpError is an unexpected failure: redact it to the journal, never to the client.
        if (e instanceof HttpError) return json(e.status, { error: e.message, code: e.code })
        logErr(`[http] ${route}:`, e)
        return json(500, { error: 'the operator hit an unexpected error handling this request', code: 'OPERATOR_ERROR' })
      }
    },
  })
}
