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
}

export function accountOfUser(db: Db, userId: string): Promise<AccountRow | null> {
  return db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at LIMIT 1').bind(userId).first<AccountRow>()
}

/** Accounts registered with this credential id, oldest first. Several rows are possible (the id is not proven at onboarding); the key decides. */
export async function accountsByCredential(db: Db, chainId: number, credentialId: string): Promise<AccountRow[]> {
  const rows = await db.prepare('SELECT * FROM accounts WHERE passkey_credential_id = ? AND chain_id = ? ORDER BY created_at LIMIT 8').bind(credentialId, chainId).all<AccountRow>()
  return rows.results
}

/** The account only if it belongs to this user; a foreign key reads as absent. */
export function ownedAccount(db: Db, userId: string, accountKey: string): Promise<AccountRow | null> {
  return db.prepare('SELECT * FROM accounts WHERE account_key = ? AND user_id = ?').bind(accountKey, userId).first<AccountRow>()
}

export async function insertAccount(db: Db, row: AccountRow): Promise<void> {
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
}

export async function acknowledgeRecovery(db: Db, accountKey: string, at: string): Promise<void> {
  await db.prepare('UPDATE accounts SET recovery_ack_at = COALESCE(recovery_ack_at, ?) WHERE account_key = ?').bind(at, accountKey).run()
}

export function ownersOf(row: AccountRow): Address[] {
  return JSON.parse(row.owners_json) as Address[]
}
