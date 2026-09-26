import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Server } from 'bun'
import type { AccountContext } from '@mamoru/domain'
import { HttpError, type Operator } from './operator.ts'

/** hex HMAC-SHA256(secret, `${method} ${path}\n${header}\n${body}`), path with its query string. */
export function operatorSignature(secret: string, method: string, path: string, header: string, body: string): string {
  return createHmac('sha256', secret).update(`${method} ${path}\n${header}\n${body}`).digest('hex')
}

function decodeContext(header: string): AccountContext {
  const ctx = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as AccountContext
  if (!ctx || typeof ctx.accountKey !== 'string' || typeof ctx.address !== 'string' || !Array.isArray(ctx.owners) || !ctx.passkey) throw new Error('bad context')
  return ctx
}

const ROUTE = /^\/api\/accounts\/([^/]+)\/(funding|ops|withdraw-assets|activate\/prepare|activate|transfer\/prepare|transfer|stop\/prepare|stop)$/

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function startServer(op: Operator, opts: { secret: string; hostname: string; port: number }): Server<undefined> {
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
      const m = ROUTE.exec(url.pathname)
      if (!m) return json(404, { error: 'not found' })
      const body = req.method === 'POST' ? await req.text() : ''
      const header = req.headers.get('x-mamoru-account') ?? ''
      const sig = req.headers.get('x-mamoru-sig') ?? ''
      const expected = operatorSignature(opts.secret, req.method, path, header, body)
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
            return json(200, await op.funding(ctx))
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
          default:
            return json(405, { error: 'method not allowed' })
        }
      } catch (e) {
        if (e instanceof HttpError) return json(e.status, { error: e.message, code: e.code })
        console.error(`[http] ${route} ${(e as Error).message.split('\n')[0]}`)
        return json(500, { error: (e as Error).message.split('\n')[0], code: 'OPERATOR_ERROR' })
      }
    },
  })
}
