import { Hono, type Context } from 'hono'
import { chainOf, isChainId, type SessionView, type SleeveView } from '@mamoru/domain'
import { baseRegistry, registryFor, type Registry } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import type { AppEnv } from './context.ts'
import { liveFunds, operatorUrlFor, type Db } from './env.ts'
import { apiError } from './errors.ts'
import { readOpsFlags } from './ops-flags.ts'
import { envOfHostname } from './accounts/env-of-host.ts'
import { accountOfUser, insertAccount, ownedAccount, ownersOf, sleevesOfUser, type AccountRow } from './accounts/store.ts'
import { passkeySigner } from './onboarding/account.ts'

/**
 * otto/mamoru#67: sleeves per chain. An owner's Base account is the default sleeve; with the `monad_sleeves` ops flag
 * on, an owner signed in on beta.mamoru.lol can open a second sleeve on Monad (143). The sleeve is another accounts
 * row: same user, same passkey, same owners and saltNonce, its own account_key and chain_id. Everything that already
 * routes by account (operator context, yield ledger, D1 projection) then carries the chain on its own.
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

/**
 * Every contract whose address or code goes into the counterfactual Safe address (packages/account/safe and
 * recovery): the factory and its proxy creation code, the singleton, the 7579 adapter and launchpad, the validator,
 * the attester, the passkey signer, the MultiSend the setup delegatecalls and the P-256 verifier. ModuleRegistry is
 * not passed by the launchpad init, so it is not part of the address.
 */
export const SAFE_DERIVATION_NAMES = [
  'SafeProxyFactory_141',
  'SafeL2_141',
  'Safe7579',
  'Safe7579Launchpad',
  'SmartSession',
  'RhinestoneAttester',
  'SafeWebAuthnSharedSigner',
  'MultiSend_141',
  'P256Verifier',
] as const

/** The names whose address or pinned code hash differ between the two registries (or are missing on one): [] when the Safe address is the same on both chains. */
export function safeDerivationDiff(a: Registry, b: Registry): string[] {
  return SAFE_DERIVATION_NAMES.filter((name) => {
    const x = a.entries.find((e) => e.name === name)
    const y = b.entries.find((e) => e.name === name)
    return !x || !y || x.address.toLowerCase() !== y.address.toLowerCase() || x.codeHash === null || x.codeHash !== y.codeHash
  })
}

/**
 * The sleeve's address on `chainId`. The derivation code reads Base's registry, so it answers for another chain only
 * when every contract it reads is the same there (safeDerivationDiff is empty); then the address is Base's, rebuilt
 * here and checked against the stored one. Otherwise null: no address is claimed until the derivation takes the
 * chain's registry (left for the account package, see the pull request).
 */
export function sleeveAddress(base: AccountRow, chainId: number): AccountRow['address'] | null {
  if (safeDerivationDiff(baseRegistry, registryFor(chainId)).length > 0) return null
  const rebuilt = counterfactualAddress(accountSetup(ownersOf(base), BigInt(base.salt_nonce), passkeySigner(base.passkey_x, base.passkey_y)))
  return rebuilt.toLowerCase() === base.address.toLowerCase() ? base.address : null
}

export function sleeveView(row: AccountRow): SleeveView {
  return { accountKey: row.account_key, chainId: row.chain_id, chain: chainOf(row.chain_id).name, address: row.address }
}

/** The session fields Monad sleeves add, or {} when the gate is off (the session reads exactly as before). */
export async function sessionSleeves(c: Context<AppEnv>, db: Db, userId: string): Promise<Pick<SessionView, 'sleeves' | 'addableChains'>> {
  if (!(await sleevesOn(c))) return {}
  const rows = await sleevesOfUser(db, userId)
  if (!rows.some((r) => r.chain_id === BASE)) return {}
  const ready = new Set<number>([BASE])
  for (const id of SLEEVE_CHAINS) if (await chainReady(c, id)) ready.add(id)
  const have = new Set(rows.map((r) => r.chain_id))
  return {
    sleeves: rows.filter((r) => isChainId(r.chain_id) && ready.has(r.chain_id)).map(sleeveView),
    addableChains: SLEEVE_CHAINS.filter((id) => ready.has(id) && !have.has(id)),
  }
}

export const sleeves = new Hono<AppEnv>()

// POST /api/sleeves { chainId } -> the owner's sleeve on that chain, created if it is not there yet. Nothing is signed
// or sent: like onboarding, the Safe is counterfactual until the first owner action on that chain deploys it.
sleeves.post('/', async (c) => {
  const session = await c.var.auth.current(c)
  if (!session) return apiError(c, 401, 'Sign in first.', 'AUTH_REQUIRED')
  if (!(await sleevesOn(c))) return apiError(c, 404, 'No such API route.')
  const body = (await c.req.json().catch(() => null)) as { chainId?: unknown } | null
  const chainId = typeof body?.chainId === 'number' ? body.chainId : NaN
  if (!SLEEVE_CHAINS.includes(chainId)) return apiError(c, 400, 'Mamoru does not open a sleeve on that chain.', 'CHAIN_UNSUPPORTED')
  // No operator for the chain (or not healthy): no sleeve is opened, so no address is ever offered for a deposit.
  if (!(await chainReady(c, chainId))) return apiError(c, 503, 'Mamoru cannot open a sleeve on that chain right now. Nothing was created.', 'OPERATOR_UNAVAILABLE')

  const db = c.env.DB
  const base = await accountOfUser(db, session.userId)
  if (!base) return apiError(c, 409, 'Create your account on Base first.', 'INTENT_REJECTED_STATE')
  c.set('accountKey', base.account_key)
  const existing = (await sleevesOfUser(db, session.userId)).find((r) => r.chain_id === chainId)
  if (existing) return c.json(sleeveView(existing))

  const address = sleeveAddress(base, chainId)
  if (!address) {
    console.log(`sleeve refused: Safe derivation differs on ${chainId}: ${safeDerivationDiff(baseRegistry, registryFor(chainId)).join(', ') || 'stored address'}`)
    return apiError(c, 409, `Mamoru cannot confirm your address on ${chainOf(chainId).name} yet. Nothing was created.`, 'CHAIN_ADDRESS_UNVERIFIED')
  }
  const row: AccountRow = {
    ...base,
    account_key: crypto.randomUUID(),
    chain_id: chainId,
    address,
    recovery_ack_at: null,
    created_at: c.var.now().toISOString(),
    passkey_sign_count: 0,
  }
  if (!(await insertAccount(db, row))) {
    // Lost a race with another tab: answer with the sleeve that won.
    const won = (await sleevesOfUser(db, session.userId)).find((r) => r.chain_id === chainId)
    return won ? c.json(sleeveView(won)) : apiError(c, 409, 'Try again.', 'INTENT_REJECTED_STATE')
  }
  return c.json(sleeveView(row), 201)
})
