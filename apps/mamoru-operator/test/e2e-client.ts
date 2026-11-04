// The e2e scripts' one signed client for the operator's HTTP API. The next auth change touches this file only
// (the legacy HMAC went away on 23 Oct, otto/mamoru#140; e2e audit 4 Nov).
import { operatorSignature } from '../src/server.ts'

const RETRIES = 3

/** One request signed like the Worker's: `x-mamoru-ts` (unix seconds) plus the timestamped HMAC. `fetchFn` for scripts that stub the global fetch. */
export async function signedCall<T>(
  baseUrl: string,
  secret: string,
  method: 'GET' | 'POST',
  path: string,
  accountHeader: string,
  body?: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: number; json: T }> {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const header = { 'x-mamoru-account': accountHeader, 'content-type': 'application/json' }
  // A prepare on a cold fork over a public RPC can outlast the operator's 120 s idle timeout; the client then re-sends the
  // request with its old `x-mamoru-ts`, which is stale by then (401: refused, nothing done). Sign again and ask again. A
  // request that failed in transit is asked again only for a GET: a POST the operator may have handled is never replayed.
  for (let attempt = 1; ; attempt++) {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = operatorSignature(secret, method, path, accountHeader, raw, ts)
    let res: Response
    try {
      res = await fetchFn(baseUrl + path, { method, headers: { ...header, 'x-mamoru-ts': ts, 'x-mamoru-sig': sig }, body: method === 'POST' ? raw : undefined })
    } catch (e) {
      if (method === 'POST' || attempt >= RETRIES) throw e
      continue
    }
    if (res.status === 401 && attempt < RETRIES) continue
    return { status: res.status, json: (await res.json()) as T }
  }
}
