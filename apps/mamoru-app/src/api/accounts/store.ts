import type { Address, Hex } from '@mamoru/domain'
import type { Db } from '../env.ts'

export type AccountRow = {
  account_key: string
  user_id: string
  chain_id: number
  address: Address
  owners_json: string
  passkey_credential_id: string
  passkey_x: Hex
  passkey_y: Hex
  salt_nonce: string
  preset: string
  policy_version: string
  recovery_ack_at: string | null
  created_at: string
  /** Last WebAuthn signature counter seen at sign-in (migration 0005; 0 until then). */
  passkey_sign_count?: number
  /** 'prod' | 'beta', from the hostname that served the onboarding request (migration ...accounts_env, otto/mamoru#130). */
  env: 'prod' | 'beta'
  /** 1 for Ot's test account and any coordinator smoke-test account; 0 for a real signup (same migration). */
  is_test: number
}

export function accountOfUser(db: Db, userId: string): Promise<AccountRow | null> {
  return db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at LIMIT 1').bind(userId).first<AccountRow>()
}

/** The account this credential id owns on this chain. At most one: the pair is unique (migration 0005). */
export function accountByCredential(db: Db, chainId: number, credentialId: string): Promise<AccountRow | null> {
  return db.prepare('SELECT * FROM accounts WHERE passkey_credential_id = ? AND chain_id = ?').bind(credentialId, chainId).first<AccountRow>()
}

/** Stores a signature counter only if it is higher than the one stored. False when it is not: a replayed or cloned authenticator. */
export async function advanceSignCount(db: Db, accountKey: string, count: number): Promise<boolean> {
  const row = await db
    .prepare('UPDATE accounts SET passkey_sign_count = ? WHERE account_key = ? AND passkey_sign_count < ? RETURNING account_key')
    .bind(count, accountKey, count)
    .first<{ account_key: string }>()
  return row !== null
}

/** The account only if it belongs to this user; a foreign key reads as absent. */
export function ownedAccount(db: Db, userId: string, accountKey: string): Promise<AccountRow | null> {
  return db.prepare('SELECT * FROM accounts WHERE account_key = ? AND user_id = ?').bind(accountKey, userId).first<AccountRow>()
}

/**
 * False when the credential id already owns an account on this chain (unique index, migration 0005).
 * Falls back to the pre-otto/mamoru#130 13-column INSERT when `env`/`is_test` are not on this D1 yet —
 * the coordinator applies the migration by hand, after this Worker deploys, so the first requests to land
 * must not 500 (or, worse, misread the schema error as a credential race and tear down the session the
 * caller just built).
 */
export async function insertAccount(db: Db, row: AccountRow): Promise<boolean> {
  try {
    await db
    .prepare(
      `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y,
        salt_nonce, preset, policy_version, recovery_ack_at, created_at, env, is_test) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.account_key, row.user_id, row.chain_id, row.address, row.owners_json, row.passkey_credential_id, row.passkey_x, row.passkey_y,
      row.salt_nonce, row.preset, row.policy_version, row.recovery_ack_at, row.created_at, row.env, row.is_test,
    )
    .run()
    return true
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/UNIQUE constraint failed/i.test(message)) return false
    if (/no such column/i.test(message)) return insertAccountLegacy(db, row)
    throw e
  }
}

/** The exact 13-column INSERT this function always ran before migration 0007_accounts_env.sql. */
async function insertAccountLegacy(db: Db, row: AccountRow): Promise<boolean> {
  try {
    await db
    .prepare(
      `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y,
        salt_nonce, preset, policy_version, recovery_ack_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.account_key, row.user_id, row.chain_id, row.address, row.owners_json, row.passkey_credential_id, row.passkey_x, row.passkey_y,
      row.salt_nonce, row.preset, row.policy_version, row.recovery_ack_at, row.created_at,
    )
    .run()
    return true
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))) return false
    throw e
  }
}

export async function acknowledgeRecovery(db: Db, accountKey: string, at: string): Promise<void> {
  await db.prepare('UPDATE accounts SET recovery_ack_at = COALESCE(recovery_ack_at, ?) WHERE account_key = ?').bind(at, accountKey).run()
}

export function ownersOf(row: AccountRow): Address[] {
  return JSON.parse(row.owners_json) as Address[]
}
