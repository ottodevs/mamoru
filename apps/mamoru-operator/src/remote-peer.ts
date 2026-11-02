import type { AccountContext, Address } from '@mamoru/domain'
import { getAddress } from 'viem'
import { operatorSignature } from './server.ts'
import type { ReleaseView } from './release.ts'

/** What the remote operator answers a provision with: the Safe runs (`active`), or it is not provisioned yet and why. */
export type RemoteProvision = { state: 'active'; address: Address } | { state: 'pending'; code: string }

/**
 * otto/mamoru#251: the Base operator's client of the operator that runs the account's own Safe on another chain (Monad),
 * over that operator's account routes, signed exactly as the Worker signs them (same OPERATOR_SECRET, `x-mamoru-ts`, the
 * account context in `x-mamoru-account`): the remote operator verifies a request from here the way it verifies one from
 * the Worker, and rebuilds every address from the keys in the context.
 * - `key`: the session key the remote operator signs that Safe's userOps with (generated there once, never sent here).
 * - `provision`: deploy that Safe if it has no code, check it on chain, and run it. Idempotent.
 * - `release` / `releaseStatus` (#278): send savings of that Safe home, one request one burn.
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

  private async post(ctx: AccountContext, route: string, payload: unknown = {}): Promise<{ status: number; body: unknown }> {
    const path = `/api/accounts/${encodeURIComponent(ctx.accountKey)}/${route}`
    const json = JSON.stringify(payload)
    const header = Buffer.from(JSON.stringify(ctx), 'utf8').toString('base64url')
    const ts = String(Math.floor(this.now() / 1000))
    const res = await this.fetchFn(this.url + path, {
      method: 'POST',
      headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts, 'x-mamoru-sig': operatorSignature(this.secret, 'POST', path, header, json, ts), 'content-type': 'application/json' },
      body: json,
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

  /**
   * otto/mamoru#293: step 1 of the move to V4, on the design-C Safe this peer runs: `prepare` (body: the home account,
   * its C and the new Safe the funds move to, which the peer derives again itself), `submit` (the owner's signature), or
   * `status` ({ done }). An HTTP error is thrown as one with its code, so the app shows it and never retries blindly.
   */
  async migrateV4(remote: AccountContext, phase: 'prepare' | 'submit' | 'status', body: unknown): Promise<unknown> {
    const route = phase === 'prepare' ? 'migrate-v4/prepare' : phase === 'submit' ? 'migrate-v4' : 'migrate-v4/status'
    const { status, body: res } = await this.post(remote, route, body)
    if (status !== 200) {
      const b = res as { code?: unknown; error?: unknown } | null
      throw Object.assign(new Error(`remote operator of chain ${this.chainId}: ${status}`), { status, code: typeof b?.code === 'string' ? b.code : `HTTP_${status}`, error: typeof b?.error === 'string' ? b.error : '' })
    }
    return res
  }

  /**
   * otto/mamoru#278: ask the peer to send `amount` (raw savings units) of the remote Safe of `remote` home, under the
   * request id `id` (the same id again is the same request), or read where that request is. HTTP errors are thrown with
   * their code (RELEASE_OPEN, NOT_A_REMOTE, ...).
   */
  async release(remote: AccountContext, id: string, amount: bigint): Promise<ReleaseView> {
    return this.releaseCall(remote, 'release', { id, amount: amount.toString() })
  }

  async releaseStatus(remote: AccountContext, id?: string): Promise<ReleaseView> {
    return this.releaseCall(remote, 'release/status', id ? { id } : {})
  }

  async releaseCancel(remote: AccountContext, id: string): Promise<ReleaseView> {
    return this.releaseCall(remote, 'release/cancel', { id })
  }

  private async releaseCall(remote: AccountContext, route: string, payload: unknown): Promise<ReleaseView> {
    const { status, body } = await this.post(remote, route, payload)
    if (status !== 200) {
      const b = body as { code?: unknown } | null
      throw Object.assign(new Error(`remote operator of chain ${this.chainId}: ${route} ${status}`), { status, code: typeof b?.code === 'string' ? b.code : `HTTP_${status}` })
    }
    return body as ReleaseView
  }
}
