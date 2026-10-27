import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Server } from 'bun'
import type { AccountContext } from '@mamoru/domain'
import { verifyMetricsSignature } from '@mamoru/operator-auth'
import { logErr } from './metrics.ts'
import type { SnapshotLoop } from './snapshot.ts'
import type { BridgeOut } from './bridge-out.ts'
import { Admission, authFraming, boundedText, DEFAULT_ADMISSION, type AdmissionLimits, type Bucket } from './admission.ts'
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
 * form, accepted only until LEGACY_HMAC_UNTIL, so the app Worker (apps/mamoru-app) and this operator can be deployed in either order without a window
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

/**
 * otto/mamoru#140: the no-ts (pre-#140) form has no skew check, so a captured legacy request replays for as long as
 * it is accepted. It is accepted only until this date, and every use is logged ([auth] legacy HMAC). Production's
 * app Worker signs without `x-mamoru-ts` until the release that carries it; this date leaves time for that release
 * to soak on beta and reach production. Removal: once the journal shows no legacy use, drop the fallback (and rotate
 * OPERATOR_SECRET if old signed requests may have been captured). If the app release slips, move this date in
 * a reviewed change; never remove the cutoff.
 */
export const LEGACY_HMAC_UNTIL = Date.parse('2026-10-23T00:00:00Z')

function decodeContext(header: string): AccountContext {
  const ctx = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as AccountContext
  if (!ctx || typeof ctx.accountKey !== 'string' || typeof ctx.address !== 'string' || !Array.isArray(ctx.owners) || !ctx.passkey) throw new Error('bad context')
  return ctx
}

// bridge-out and eth-convert (#133, #211): answered by BridgeOut, 404 when the operator has no Ethereum RPC.
const ROUTE = /^\/api\/accounts\/([^/]+)\/(funding|ops|withdraw-assets|activate\/prepare|activate|transfer\/prepare|transfer|stop\/prepare|stop|renew\/prepare|renew|bridge-out\/prepare|bridge-out|eth-convert\/prepare|eth-convert)$/

// Amounts are base-unit strings on the wire; a bigint that slips into a view is sent as its decimal string.
const wire = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, wire), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * GET /metrics payload: RPC traffic (per provider host, never the URL or a key), engine health per
 * account (key shortened to 8 chars), the newest ops across every account (otto/mamoru#129, same
 * trim), gas-reserve alert state per account (otto/mamoru#8) and operator-level facts. No secrets,
 * no session keys, no full account keys, no RPC URLs, no grants, no signatures, no salts, no userOps.
 * See docs/operator-metrics.md.
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
      // otto/mamoru#8: Safes below their gas-reserve alert threshold, detection + alert only (no automatic top-up).
      gasReserveLow: op.gasReserveLowCount(),
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
    // otto/mamoru#129: the newest 300 engine/owner ops across every account, newest first, for the /ops console
    // (mirrored into D1 by apps/mamoru-app's cron). Trimmed to accountKey/kind/state/at/code only — see Operator.recentOps.
    opsRecent: op.recentOps(300),
    // otto/mamoru#8: per-account gas-reserve alert state (native balance vs threshold), running accounts only.
    gasReserve: op.gasReserveSnapshot(),
    // otto/mamoru#26: each account's approval as the operator holds it (policy, pools, validity, usage, cap and its source).
    authorizations: op.authorizationsSnapshot(),
  }
}

/** A Stop body (a passkey assertion, or `{"revokeOnly":true}`) is read before its slot is taken: small and quick. */
const STOP_BODY_BYTES = 4 * 1024
const STOP_BODY_MS = 2_000

export function startServer(op: Operator, opts: { secret: string; hostname: string; port: number; rpcMetrics: RpcMetrics; gitSha: string; bootedAt: number; snapshot?: SnapshotLoop | null; /** Ethereum → Base moves (#133); routes answer 404 without it. */ bridgeOut?: BridgeOut | null; admission?: Partial<AdmissionLimits>; /** Tests only: the legacy cutoff (default LEGACY_HMAC_UNTIL). */ legacyHmacUntil?: number }): Server<undefined> {
  const legacyUntil = opts.legacyHmacUntil ?? LEGACY_HMAC_UNTIL
  const admission = new Admission({ ...DEFAULT_ADMISSION, ...opts.admission })
  return Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    idleTimeout: 120,
    // otto/mamoru#140 (part2 #7): Bun's own ceiling, under the 128 MB default; account routes are held to a far smaller one below.
    maxRequestBodySize: 256 * 1024,
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
        // otto/mamoru#136: the latest snapshot, signed like /metrics. 404 while the loop is off: either this
        // operator never constructs one (not Base, or no MULTICALL3), or it does but the `yield_ledger` ops flag
        // (otto/mamoru#129) is off right now — `isRunning`, not `current`, decides that, so a loop stopped after
        // the flag flipped off never hands out the snapshot it read while it was still on.
        if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
        const sig = req.headers.get('x-mamoru-sig')
        if (!(await verifyMetricsSignature(opts.secret, 'GET', '/snapshot', sig))) return json(401, { error: 'unauthorized', code: 'OPERATOR_AUTH' })
        if (!opts.snapshot?.isRunning) return json(404, { error: 'snapshot off' })
        const snap = opts.snapshot.current
        if (!snap) return json(503, { error: 'no snapshot yet', lastError: opts.snapshot.lastError })
        return json(200, { ...snap, safes: snap.safes.map((x) => ({ ...x, accountKey: x.accountKey.slice(0, 8) })), lastError: opts.snapshot.lastError })
      }
      const m = ROUTE.exec(url.pathname)
      if (!m) return json(404, { error: 'not found' })
      // otto/mamoru#140 (part2 #7): headers that cannot carry a valid signature are refused before the body is read,
      // and no more than maxInFlight account requests are open at once.
      if (!authFraming(admission.limits, req.headers.get('x-mamoru-account'), req.headers.get('x-mamoru-sig'), req.headers.get('x-mamoru-ts'))) return json(401, { error: 'unauthorized', code: 'OPERATOR_AUTH' })
      // Stop (prepare and submit) has its own bucket in every limit: other traffic never keeps an owner from revoking.
      // Its slots are taken only once the signature is verified (Sol review #5): unauthenticated slow bodies cannot fill
      // them. Its body is read first, without a slot, under a tighter size and deadline.
      const bucket: Bucket = m[2]!.startsWith('stop') ? 'stop' : 'other'
      if (bucket === 'stop') return account(req, url, path, m, bucket)
      if (!admission.enter(bucket)) return json(503, { error: 'the operator is busy, try again in a moment', code: 'OPERATOR_BUSY' })
      try {
        return await account(req, url, path, m, bucket)
      } finally {
        admission.leave(bucket)
      }
    },
  })

  async function account(req: Request, url: URL, path: string, m: RegExpExecArray, bucket: Bucket): Promise<Response> {
    const stop = bucket === 'stop'
    const body = req.method === 'POST' ? await boundedText(req, stop ? STOP_BODY_BYTES : admission.limits.maxBodyBytes, stop ? STOP_BODY_MS : admission.limits.bodyTimeoutMs) : ''
    if (body === null) return json(413, { error: 'request body too large', code: 'BODY_TOO_LARGE' })
    const header = req.headers.get('x-mamoru-account') ?? ''
    const sig = req.headers.get('x-mamoru-sig') ?? ''
    const ts = req.headers.get('x-mamoru-ts')
    // otto/mamoru#140: a signed ts outside the accepted clock skew is a replay of an old captured request, not a
    // forged one — refused before the signature is even checked, with the same unauthorized shape either way.
    if (ts !== null && (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts) * 1000) > REQUEST_SKEW_MS)) {
      return json(401, { error: 'unauthorized', code: 'OPERATOR_AUTH' })
    }
    // otto/mamoru#140: the no-ts form only until the cutoff; past it, refused like any bad signature.
    if (ts === null && Date.now() >= legacyUntil) {
      console.log(`[auth] legacy HMAC refused (past ${new Date(legacyUntil).toISOString()}): ${req.method} ${m[2]}`)
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
    // Every accepted legacy request, so its removal can be planned on what the journal shows (account key shortened).
    if (ts === null) console.log(`[auth] legacy HMAC (no x-mamoru-ts) ${route} account ${ctx.accountKey.slice(0, 8)}`)
    // Authenticated from here: one account holds at most maxInFlightPerAccount requests open, and prepares (chain
    // reads and simulations) are rate-limited per account and overall. "Account" is the Safe, not the accountKey: a
    // caller with the secret can name any accountKey, but every one for this Safe shares its limits. The bucket comes
    // from the path, which the signature covers.
    const who = ctx.address.toLowerCase()
    if (route.endsWith('/prepare') && !admission.allowPrepare(who, Date.now(), bucket)) return json(429, { error: 'too many prepares for this account, wait a minute', code: 'PREPARE_RATE_LIMIT' })
    if (stop && !admission.enter(bucket)) return json(503, { error: 'the operator is busy, try again in a moment', code: 'OPERATOR_BUSY' })
    if (!admission.enterAccount(who, bucket)) {
      if (stop) admission.leave(bucket)
      return json(429, { error: 'this account already has requests in progress', code: 'ACCOUNT_BUSY' })
    }
    try {
      return await dispatch(route, ctx, url, body)
    } finally {
      admission.leaveAccount(who, bucket)
      if (stop) admission.leave(bucket)
    }
  }

  function bridge(): BridgeOut {
    if (!opts.bridgeOut) throw new HttpError(404, 'BRIDGE_OFF', 'moves from Ethereum are not available')
    return opts.bridgeOut
  }

  async function dispatch(route: string, ctx: AccountContext, url: URL, body: string): Promise<Response> {
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
          return json(200, await op.prepareStop(ctx, { revokeOnly: parse()?.revokeOnly === true }))
        case 'POST stop':
          return json(200, await op.submit(ctx, 'stop', parse()))
        case 'POST renew/prepare':
          return json(200, await op.prepareRenew(ctx))
        case 'POST renew':
          return json(200, await op.submit(ctx, 'renew', parse()))
        case 'POST bridge-out/prepare':
          return json(200, await bridge().prepare(ctx))
        case 'POST bridge-out':
          return json(200, await bridge().submit(ctx, parse()))
        case 'GET bridge-out':
          return json(200, await bridge().status(ctx))
        case 'POST eth-convert/prepare':
          return json(200, await bridge().prepareConvert(ctx))
        case 'POST eth-convert':
          return json(200, await bridge().submitConvert(ctx, parse()))
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
  }
}
