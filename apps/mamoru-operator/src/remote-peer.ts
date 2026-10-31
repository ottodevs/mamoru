import type { AccountContext, Address } from '@mamoru/domain'
import { getAddress } from 'viem'
import { operatorSignature } from './server.ts'

/** What the remote operator answers a provision with: the Safe runs (`active`), or it is not provisioned yet and why. */
export type RemoteProvision = { state: 'active'; address: Address } | { state: 'pending'; code: string }

/**
 * otto/mamoru#251: the Base operator's client of the operator that runs the account's own Safe on another chain (Monad),
 * over that operator's account routes, signed exactly as the Worker signs them (same OPERATOR_SECRET, `x-mamoru-ts`, the
 * account context in `x-mamoru-account`): the remote operator verifies a request from here the way it verifies one from
 * the Worker, and rebuilds every address from the keys in the context.
 * - `key`: the session key the remote operator signs that Safe's userOps with (generated there once, never sent here).
 * - `provision`: deploy that Safe if it has no code, check it on chain, and run it. Idempotent.
 */
export class RemotePeer {
  constructor(
    readonly chainId: number,
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 30_000,
  ) {}

  private async post(ctx: AccountContext, route: string): Promise<{ status: number; body: unknown }> {
    const path = `/api/accounts/${encodeURIComponent(ctx.accountKey)}/${route}`
    const header = Buffer.from(JSON.stringify(ctx), 'utf8').toString('base64url')
    const ts = String(Math.floor(this.now() / 1000))
    const res = await this.fetchFn(this.url + path, {
      method: 'POST',
      headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts, 'x-mamoru-sig': operatorSignature(this.secret, 'POST', path, header, '{}', ts), 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  /** The remote session key for the Base account of `base`. Throws when the peer does not give one. */
  async key(base: AccountContext): Promise<Address> {
    const { status, body } = await this.post(base, 'remote-key')
    const k = (body as { sessionKey?: unknown } | null)?.sessionKey
    if (status !== 200 || typeof k !== 'string') throw new Error(`remote operator of chain ${this.chainId} gave no session key (${status} ${(body as { code?: string } | null)?.code ?? ''})`)
    return getAddress(k)
  }

  /** Asks the peer to provision the remote Safe of `remote` (its context: chain, address and spec). */
  async provision(remote: AccountContext): Promise<RemoteProvision> {
    const { status, body } = await this.post(remote, 'provision')
    const b = body as { state?: unknown; address?: unknown; code?: unknown } | null
    if (status === 200 && b?.state === 'active' && typeof b.address === 'string') return { state: 'active', address: getAddress(b.address) }
    return { state: 'pending', code: typeof b?.code === 'string' ? b.code : `HTTP_${status}` }
  }
}
