import { ReasonError, type Hex0x, type OwnerTxToSign } from '@mamoru/domain'
import { baseKeyOf, remoteAccountKey } from '@mamoru/account/remote'
import { buildMigrateV4 } from '@mamoru/account/one-auth'
import { ONE_AUTH_V4_REMOTE, V4_DOMAIN_BY_CHAIN } from '@mamoru/policy'
import { accountContext } from './accounts/operator.ts'
import { ownedAccount, type AccountRow } from './accounts/store.ts'
import type { Db } from './env.ts'
import { defaultRemoteRegistry, verifyRemote, type RemoteRegistry } from './remote.ts'

/**
 * otto/mamoru#295 x #293: before the owner is asked to sign a migrate-v4 step, the Worker REBUILDS the transaction instead of
 * parsing the operator's. The prepare carries the `input` the operator built from; the Worker
 *  (a) validates every field of it against what it knows itself (its D1 rows, the registry, the owner's keys), then
 *  (b) calls `buildMigrateV4(input, registry)` and requires its `safeTxHash` and every field of its `safeTx` to equal the
 *      prepare's. Calldata is therefore never read, only compared with what the same function builds.
 * Anything else is `ReasonError('MIGRATE_TX_MISMATCH')`; the route answers 502 and the card shows it. While the V4 contracts
 * are not pinned in the chain's registry json, the builder throws and everything is refused (fail closed).
 *
 * Not checked here, on purpose: `sessionKey` (the operator picks it, and V4's own bounds hold whoever it is) and the id lists
 * `removeIds` / `oldPermissionIds` / `noncesBefore`. The migration's last call is MamoruMigrationCheck.assertMigrated, which
 * reads SmartSession.getPermissionIDs(account) on chain and reverts the whole Safe transaction unless only the V4 session is
 * enabled and every old id's nonce moved (contracts/action-policy/src/MamoruMigrationCheck.sol): a short list cannot leave an
 * old session live.
 */
export const MIGRATE_CHAINS = [8453, 143] as const

const fail = (why: string): never => {
  throw new ReasonError('MIGRATE_TX_MISMATCH', why)
}
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()

/** The two Safes of this account, anchored on the route's own row (never a search over the user's sleeves). */
export async function migrateAnchors(db: Db, route: AccountRow): Promise<{ base: AccountRow | null; monad: AccountRow | null }> {
  if (route.chain_id === 8453) return { base: route, monad: await ownedAccount(db, route.user_id, remoteAccountKey(route.account_key, 143)) }
  if (route.chain_id === 143) {
    const baseKey = baseKeyOf(route.account_key, 143)
    return { base: baseKey ? await ownedAccount(db, route.user_id, baseKey) : null, monad: route }
  }
  return { base: null, monad: null }
}

export function checkMigrateTx(args: { tx: OwnerTxToSign; step: number; base: AccountRow | null; monad: AccountRow | null; capUsdc: string; registryOf?: RemoteRegistry }): void {
  const { tx, step, base, monad, capUsdc, registryOf = defaultRemoteRegistry } = args
  const chainId = MIGRATE_CHAINS[step]
  if (chainId === undefined || (step !== 0 && step !== 1)) return fail(`step ${step} does not exist`)
  const input = tx.input
  const wire = tx.safeTx
  if (!input || !wire || typeof tx.safeTxHash !== 'string') return fail('the prepare carries no input to rebuild from')
  if (!base || base.chain_id !== 8453) return fail('no Base account')

  // (a) every field the Worker can know itself.
  if (input.step !== step || (tx.step !== undefined && tx.step !== step)) return fail('another step')
  if (input.chainId !== chainId || tx.chainId !== chainId) return fail('another chain')
  const own = step === 0 ? base : monad
  if (!own || own.chain_id !== chainId || !same(input.safe, own.address) || !same(tx.safe, own.address)) return fail("not this account's own Safe on this chain")
  if (!same(input.capUsdc, capUsdc)) return fail("not this account's cap")
  if (step === 0) {
    if (BigInt(input.home) !== 0n || input.homeDomain !== 0 || input.moveTo || input.transfers?.length || tx.moveTo) return fail('the Base step moves no funds and has no home')
  } else {
    if (!same(input.home, base.address) || input.homeDomain !== V4_DOMAIN_BY_CHAIN[8453]) return fail("not this account's home")
    // A destination is required, and it is the V4 remote Safe the owner's own keys give (verifyRemote), never the operator's string.
    if (!input.moveTo || !input.transfers?.length) return fail('the Monad step names no destination')
    if (tx.moveTo !== undefined && !same(tx.moveTo, input.moveTo)) return fail('the announced destination is not the one built')
    try {
      verifyRemote(
        accountContext(base),
        {
          chainId,
          address: input.moveTo as Hex0x,
          spec: { chainId, policyId: ONE_AUTH_V4_REMOTE, sessionKey: input.sessionKey, validAfter: 0, validUntil: 0, capUsdc, home: base.address as Hex0x, homeDomain: V4_DOMAIN_BY_CHAIN[8453] },
        },
        registryOf,
      )
    } catch {
      return fail("the destination is not this account's remote Safe")
    }
  }

  // (b) rebuild with the operator's own builder and compare, field by field.
  let built
  try {
    built = buildMigrateV4(input, registryOf(chainId))
  } catch (e) {
    return fail(`it cannot be rebuilt: ${e instanceof Error ? e.message : 'unknown'}`)
  }
  if (!same(built.safeTxHash, tx.safeTxHash)) return fail('the hash is not the one rebuilt')
  for (const k of ['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce'] as const) {
    if (!same(built.safeTx[k], wire[k])) return fail(`the transaction's ${k} is not the one rebuilt`)
  }
}
