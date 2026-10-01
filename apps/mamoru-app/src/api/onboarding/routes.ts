import { Hono, type Context } from 'hono'
import type { OwnerResponse } from '@mamoru/domain'
import { conservadorV1 } from '@mamoru/policy'
import { recoveryKit } from '@mamoru/account/recovery'
import type { AppEnv } from '../context.ts'
import { accountNotFound, apiError } from '../errors.ts'
import { acknowledgeRecovery, accountOfUser, insertAccount, ownedAccount, ownersOf, type AccountRow } from '../accounts/store.ts'
import { ACCOUNT_KEY, counterfactualAccount, passkeySigner } from './account.ts'
import { parsePasskey } from './passkey.ts'

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return null
  const body: unknown = await c.req.json().catch(() => null)
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

function ownerResponse(row: AccountRow): OwnerResponse {
  return { accountKey: row.account_key, chainId: row.chain_id, address: row.address, owners: ownersOf(row), deployed: false }
}

export const onboarding = new Hono<AppEnv>()

// FR-ONB-003/005: the passkey becomes the owner of a counterfactual Safe on Base. Nothing is signed or sent.
onboarding.post('/owner', async (c) => {
  const body = await jsonBody(c)
  if (!body) return apiError(c, 400, 'Send a JSON body with the passkey.')
  const passkey = parsePasskey(body.passkey)
  if (!passkey) return apiError(c, 400, 'The passkey is not a valid P-256 public key with a credential id.')
  // FR-ONB-004: a backup owner needs a signature over an API challenge, which this contract does not carry yet.
  if (body.backupOwner !== undefined) return apiError(c, 400, 'A backup owner needs a signed challenge first.', 'ONB_BACKUP_UNPROVEN')

  const session = await c.var.auth.ensure(c)
  const db = c.env.DB
  const existing = await accountOfUser(db, session.userId)
  if (existing) {
    c.set('accountKey', existing.account_key)
    if (existing.passkey_credential_id === passkey.credentialId) return c.json(ownerResponse(existing))
    return apiError(c, 409, 'This session already has an account with another passkey.', 'INTENT_REJECTED_STATE')
  }

  const accountKey = crypto.randomUUID()
  const account = counterfactualAccount(accountKey, passkey)
  const row: AccountRow = {
    account_key: accountKey,
    user_id: session.userId,
    chain_id: c.var.settings.chainId,
    address: account.address,
    owners_json: JSON.stringify(account.owners),
    passkey_credential_id: passkey.credentialId,
    passkey_x: passkey.x,
    passkey_y: passkey.y,
    salt_nonce: account.saltNonce.toString(),
    preset: conservadorV1.preset,
    policy_version: conservadorV1.version,
    recovery_ack_at: null,
    created_at: c.var.now().toISOString(),
  }
  await insertAccount(db, row)
  return c.json(ownerResponse(row), 201)
})

onboarding.post('/recovery-ack', async (c) => {
  const session = await c.var.auth.current(c)
  if (!session) return apiError(c, 401, 'Sign in first.', 'AUTH_REQUIRED')
  const body = await jsonBody(c)
  const accountKey = body?.accountKey
  if (typeof accountKey !== 'string' || !ACCOUNT_KEY.test(accountKey)) return accountNotFound(c)
  const row = await ownedAccount(c.env.DB, session.userId, accountKey)
  if (!row) return accountNotFound(c)
  c.set('accountKey', row.account_key)
  await acknowledgeRecovery(c.env.DB, accountKey, c.var.now().toISOString())
  return c.json({ ok: true as const })
})

// FR-ONB-006: public data only, rebuilt from the stored owners, saltNonce and passkey, and checked against the stored address.
onboarding.get('/kit', async (c) => {
  const session = await c.var.auth.current(c)
  if (!session) return apiError(c, 401, 'Sign in first.', 'AUTH_REQUIRED')
  const accountKey = c.req.query('accountKey')
  if (!accountKey || !ACCOUNT_KEY.test(accountKey)) return accountNotFound(c)
  const row = await ownedAccount(c.env.DB, session.userId, accountKey)
  if (!row) return accountNotFound(c)
  c.set('accountKey', row.account_key)
  const kit = recoveryKit({ chainId: row.chain_id, owners: ownersOf(row), saltNonce: BigInt(row.salt_nonce), webauthn: passkeySigner(row.passkey_x, row.passkey_y), permissionIds: [], tokenIds: [] })
  if (kit.address.toLowerCase() !== row.address.toLowerCase()) return apiError(c, 500, 'The recovery kit does not match the stored account address.')
  c.header('content-disposition', `attachment; filename="mamoru-recovery-kit-${row.address}.json"`)
  c.header('cache-control', 'no-store')
  return c.json(kit)
})
