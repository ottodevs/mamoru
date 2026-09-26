import type { PoolView } from '@mamoru/domain'
import type { D1Like, D1Statement } from './env.ts'
import type { AccountRow, AccountState } from './sync/accounts.ts'
import type { Anchor } from './sync/provenance.ts'

export type SourceStateRow = {
  chainId: number
  rpcStatus: 'ok' | 'unavailable'
  block: number | null
  safeBlock: number | null
  observedAt: string
  indexProvider: 'multibaas'
  indexStatus: 'indexing' | 'behind' | 'not_indexing_base' | 'failing' | 'not_configured'
  indexBlock: number | null
  indexCode: string | null
  indexCheckedAt: string
}

export function upsertSourceState(db: D1Like, s: SourceStateRow): D1Statement {
  // A failed read keeps the last known blocks.
  return db
    .prepare(
      `INSERT INTO source_state (chain_id, rpc_status, block, safe_block, observed_at, index_provider, index_status, index_block, index_code, index_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id) DO UPDATE SET rpc_status = excluded.rpc_status,
         block = COALESCE(excluded.block, source_state.block), safe_block = COALESCE(excluded.safe_block, source_state.safe_block),
         observed_at = excluded.observed_at, index_provider = excluded.index_provider, index_status = excluded.index_status,
         index_block = COALESCE(excluded.index_block, source_state.index_block), index_code = excluded.index_code,
         index_checked_at = excluded.index_checked_at`,
    )
    .bind(s.chainId, s.rpcStatus, s.block, s.safeBlock, s.observedAt, s.indexProvider, s.indexStatus, s.indexBlock, s.indexCode, s.indexCheckedAt)
}

export function upsertPoolState(db: D1Like, anchor: Anchor, source: 'chain_rpc' | 'multibaas', view: PoolView): D1Statement {
  return db
    .prepare(
      `INSERT INTO proj_pool_state (chain_id, pool_address, block, block_hash, observed_at, source, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, pool_address) DO UPDATE SET block = excluded.block, block_hash = excluded.block_hash,
         observed_at = excluded.observed_at, source = excluded.source, payload_json = excluded.payload_json`,
    )
    .bind(anchor.chainId, view.pool.address, anchor.blockNumber, anchor.blockHash, anchor.observedAt, source, JSON.stringify(view))
}

export function upsertAccountState(db: D1Like, anchor: Anchor, accountKey: string, s: AccountState): D1Statement {
  return db
    .prepare(
      `INSERT INTO proj_account_state (account_key, chain_id, block, block_hash, observed_at, deployed, tokens_json, total_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_key) DO UPDATE SET chain_id = excluded.chain_id, block = excluded.block, block_hash = excluded.block_hash,
         observed_at = excluded.observed_at, deployed = excluded.deployed, tokens_json = excluded.tokens_json, total_value = excluded.total_value`,
    )
    .bind(accountKey, anchor.chainId, anchor.blockNumber, anchor.blockHash, anchor.observedAt, s.deployed ? 1 : 0, JSON.stringify(s.tokens), s.totalValue)
}

export async function listAccounts(db: D1Like, chainId: number): Promise<AccountRow[]> {
  const { results } = await db.prepare('SELECT account_key, address FROM accounts WHERE chain_id = ? ORDER BY account_key').bind(chainId).all<AccountRow>()
  return results
}
