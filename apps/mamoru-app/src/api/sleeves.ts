import type { Context } from 'hono'
import { chainOf, isChainId, type SessionView, type SleeveView } from '@mamoru/domain'
import type { AppEnv } from './context.ts'
import { liveFunds, operatorUrlFor, type Db } from './env.ts'
import { readOpsFlags } from './ops-flags.ts'
import { envOfHostname } from './accounts/env-of-host.ts'
import { ownedAccount, sleevesOfUser, type AccountRow } from './accounts/store.ts'

/**
 * otto/mamoru#67: sleeves per chain. An owner's Base account is the default sleeve; with the `monad_sleeves` ops flag
 * on, an owner signed in on beta.mamoru.lol sees a second sleeve on Monad (143). The sleeve is another accounts
 * row: same user, same passkey, same owners and saltNonce, its own account_key, chain_id, address and `remote_json`.
 * Everything that already routes by account (operator context, yield ledger, D1 projection) then carries the chain on
 * its own. otto/mamoru#251: the app does not create it; the Worker upserts it (remote.ts) when the Base operator
 * reports the remote Safe the owner's one approval provisioned.
 */

export const BASE = 8453
/** Chains a sleeve may be opened on, besides Base. */
export const SLEEVE_CHAINS: readonly number[] = [143]

/**
 * The flag is one row in the D1 that prod and beta share, so prod would see it too: only the beta host honors it.
 * Any other host (app.mamoru.lol, a preview, local) answers off, whatever the row says.
 */
export async function sleevesOn(c: Context<AppEnv>): Promise<boolean> {
  if (envOfHostname(new URL(c.req.url).hostname) !== 'beta') return false
  return (await readOpsFlags(c.env.DB)).monad_sleeves
}

const HEALTH_TTL_MS = 60_000
const HEALTH_TIMEOUT_MS = 3_000
const health = new Map<string, { ok: boolean; at: number }>()

/** Test hook: forget every cached operator /health answer. */
export function resetOperatorHealth(): void {
  health.clear()
}

/**
 * The operator at `url` answers GET /health with `ok: true` and the chain id it runs. One answer per isolate per
 * minute, healthy or not; a timeout, an error or another chain id is unhealthy.
 */
async function operatorServes(c: Context<AppEnv>, url: string, chainId: number): Promise<boolean> {
  const now = c.var.now().getTime()
  const cached = health.get(url)
  if (cached && now - cached.at < HEALTH_TTL_MS) return cached.ok
  let ok = false
  try {
    const res = await c.var.operatorFetch(`${url}/health`, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    const body = res.ok ? ((await res.json()) as { ok?: unknown; chainId?: unknown }) : null
    ok = body?.ok === true && body.chainId === chainId
  } catch (e) {
    console.error(`operator health ${chainId} failed`, e instanceof Error ? e.message : String(e))
  }
  health.set(url, { ok, at: now })
  return ok
}

/**
 * Review of PR #115 (P1 1, 2): a sleeve off Base exists for the owner only while all of this holds, and every route
 * that resolves an account (session, operator, dashboard, yield, kit) asks it, failing closed: the beta host, the
 * `monad_sleeves` flag, live funds with an operator secret, OPERATOR_URL_<chain> set, and that operator's /health
 * reporting this very chain. Otherwise nobody could operate the sleeve, so its address is never offered for a deposit.
 */
export async function chainReady(c: Context<AppEnv>, chainId: number): Promise<boolean> {
  if (chainId === BASE) return true
  if (!SLEEVE_CHAINS.includes(chainId)) return false
  const url = operatorUrlFor(c.env, chainId)
  if (!url || !liveFunds(c.env) || !c.env.OPERATOR_SECRET) return false
  if (!(await sleevesOn(c))) return false
  return operatorServes(c, url, chainId)
}

/** `ownedAccount`, and a sleeve off Base reads as absent (the same 404) unless its chain is ready. */
export async function ownedSleeve(c: Context<AppEnv>, userId: string, accountKey: string): Promise<AccountRow | null> {
  const row = await ownedAccount(c.env.DB, userId, accountKey)
  if (!row || row.chain_id === BASE) return row
  return (await chainReady(c, row.chain_id)) ? row : null
}

export function sleeveView(row: AccountRow): SleeveView {
  return { accountKey: row.account_key, chainId: row.chain_id, chain: chainOf(row.chain_id).name, address: row.address }
}

/** The session fields Monad sleeves add, or {} when the gate is off (the session reads exactly as before). */
export async function sessionSleeves(c: Context<AppEnv>, db: Db, userId: string): Promise<Pick<SessionView, 'sleeves'>> {
  if (!(await sleevesOn(c))) return {}
  const rows = await sleevesOfUser(db, userId)
  if (!rows.some((r) => r.chain_id === BASE)) return {}
  const ready = new Set<number>([BASE])
  for (const id of SLEEVE_CHAINS) if (await chainReady(c, id)) ready.add(id)
  return { sleeves: rows.filter((r) => isChainId(r.chain_id) && ready.has(r.chain_id)).map(sleeveView) }
}
