import { Hono, type Context } from 'hono'
import { chainOf, isChainId, type SessionView, type SleeveView } from '@mamoru/domain'
import { baseRegistry, registryFor, type Registry } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import type { AppEnv } from './context.ts'
import type { Db } from './env.ts'
import { apiError } from './errors.ts'
import { readOpsFlags } from './ops-flags.ts'
import { envOfHostname } from './accounts/env-of-host.ts'
import { accountOfUser, insertAccount, ownersOf, sleevesOfUser, type AccountRow } from './accounts/store.ts'
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
  const have = new Set(rows.map((r) => r.chain_id))
  return { sleeves: rows.filter((r) => isChainId(r.chain_id)).map(sleeveView), addableChains: SLEEVE_CHAINS.filter((id) => !have.has(id)) }
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
