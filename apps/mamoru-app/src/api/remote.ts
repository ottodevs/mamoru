import { ReasonError, type AccountContext, type Address, type Hex0x, type RemoteSpec } from '@mamoru/domain'
import { registryFor, type Registry } from '@mamoru/registry'
import { assertRemoteSafe, remoteInput } from '@mamoru/account/remote'
import type { Db } from './env.ts'
import { BASE } from './sleeves.ts'
import type { AccountRow } from './accounts/store.ts'

/**
 * otto/mamoru#251: the account's own Safe on a remote bucket's chain. The Base operator offers it (an owner tx's
 * `remote`, a funding view's `remote`); the Worker never takes the address on trust: it rebuilds it from the keys in its
 * own D1 row of the Base account, so the bridge-out recipient the owner is asked to sign is the Safe those keys give.
 */

export type RemoteOffer = { chainId: number; address: Hex0x; spec: RemoteSpec }

/** The chains a remote Safe may live on. */
export const REMOTE_CHAINS: readonly number[] = [143]

/** The registry the remote Safe of a chain is derived against; injectable so a test can pin MamoruActionPolicyV3. */
export type RemoteRegistry = (chainId: number) => Registry

export const defaultRemoteRegistry: RemoteRegistry = registryFor

/** The offer is the remote Safe of `base`'s keys, on a chain the Worker knows. Throws (ReasonError REMOTE_SAFE_MISMATCH or any) when it is not. */
export function verifyRemote(base: Pick<AccountContext, 'owners' | 'saltNonce' | 'passkey'>, offer: RemoteOffer, registryOf: RemoteRegistry = defaultRemoteRegistry): void {
  const spec = offer?.spec
  if (!spec || !REMOTE_CHAINS.includes(offer.chainId) || spec.chainId !== offer.chainId) throw new ReasonError('REMOTE_SAFE_MISMATCH', `remote Safe on chain ${offer?.chainId}: not a chain Mamoru provisions`)
  assertRemoteSafe(remoteInput(base, spec, registryOf(offer.chainId)), offer.address as Address)
}

/** `offer` if the body carries a well-formed `remote` (at the top, as an OwnerTxToSign, or under `ownerTx`, as a plan does); undefined if there is none. */
export function remoteOf(body: unknown): RemoteOffer | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as { remote?: unknown; ownerTx?: { remote?: unknown } | null }
  return (b.remote ?? b.ownerTx?.remote ?? undefined) as RemoteOffer | undefined
}

const SPEC_KEYS: readonly (keyof RemoteSpec)[] = ['chainId', 'policyId', 'sessionKey', 'validAfter', 'validUntil', 'capUsdc']
const sameSpec = (a: RemoteSpec, b: RemoteSpec) => SPEC_KEYS.every((k) => String(a[k]).toLowerCase() === String(b[k]).toLowerCase())

export type RemoteUpsert = 'inserted' | 'updated' | 'unchanged' | 'kept'

/**
 * The owner's account row on `offer.chainId`, from the Base row `base` and a remote Safe already verified against it
 * (verifyRemote). Absent: inserted. Present with the same address and spec: nothing. Present from the old flow (no
 * `remote_json`): repointed. Present with another remote Safe: left as it is and logged, never silently repointed.
 */
export async function upsertRemoteSleeve(db: Db, base: AccountRow, offer: RemoteOffer, now: Date, newKey: () => string = () => crypto.randomUUID()): Promise<RemoteUpsert> {
  if (base.chain_id !== BASE) throw new Error('upsertRemoteSleeve: needs the Base account row')
  const existing = () => db.prepare('SELECT * FROM accounts WHERE user_id = ? AND chain_id = ?').bind(base.user_id, offer.chainId).first<AccountRow>()
  const found = await existing()
  if (found) return reconcile(db, found, offer)
  try {
    await db
      .prepare(
        `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y,
          salt_nonce, preset, policy_version, recovery_ack_at, created_at, env, is_test, remote_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newKey(), base.user_id, offer.chainId, offer.address, base.owners_json, base.passkey_credential_id, base.passkey_x, base.passkey_y,
        base.salt_nonce, base.preset, base.policy_version, null, now.toISOString(), base.env, base.is_test, JSON.stringify(offer.spec),
      )
      .run()
    return 'inserted'
  } catch (e) {
    if (!/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))) throw e
    // Lost a race (another tab, another poll): judge against the row that won.
    const won = await existing()
    if (!won) {
      console.error(`remote Safe ${offer.address} on ${offer.chainId} not stored: its address or passkey is already another account's`)
      return 'kept'
    }
    return reconcile(db, won, offer)
  }
}

async function reconcile(db: Db, found: AccountRow, offer: RemoteOffer): Promise<RemoteUpsert> {
  const stored = found.remote_json ? (JSON.parse(found.remote_json) as RemoteSpec) : null
  if (stored && found.address.toLowerCase() === offer.address.toLowerCase() && sameSpec(stored, offer.spec)) return 'unchanged'
  if (stored) {
    console.error(`remote Safe on ${offer.chainId} for ${found.account_key} not repointed: stored ${found.address}, offered ${offer.address}`)
    return 'kept'
  }
  await db.prepare('UPDATE accounts SET address = ?, remote_json = ? WHERE account_key = ? AND remote_json IS NULL').bind(offer.address, JSON.stringify(offer.spec), found.account_key).run()
  return 'updated'
}
