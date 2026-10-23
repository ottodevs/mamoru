import { describe, expect, test } from 'bun:test'
import { readOpsFlags } from '../../src/api/ops-flags.ts'
import { memoryD1 } from './d1.ts'

function insert(db: ReturnType<typeof memoryD1>, flag: string, enabled: 0 | 1, createdAt = '2026-10-18T00:00:00Z') {
  db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES (?, ?, ?, ?, ?)`).run(flag, enabled, 'ot', 'test', createdAt)
}

describe('readOpsFlags (otto/mamoru#129, migrations/d1/0012_ops_flags.sql)', () => {
  test('migration not applied (no table): every flag off, not an error', async () => {
    const db = memoryD1()
    db.raw.exec('DROP TABLE ops_flag_changes')
    expect(await readOpsFlags(db)).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false })
  })

  test('table applied, no row for a flag: off', async () => {
    const db = memoryD1()
    expect(await readOpsFlags(db)).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false })
  })

  test('the newest row wins, whichever way it flips', async () => {
    const db = memoryD1()
    insert(db, 'yield_ledger', 1, '2026-10-18T00:00:00Z')
    expect((await readOpsFlags(db)).yield_ledger).toBe(true)
    insert(db, 'yield_ledger', 0, '2026-10-18T01:00:00Z')
    expect((await readOpsFlags(db)).yield_ledger).toBe(false)
    insert(db, 'yield_ledger', 1, '2026-10-18T02:00:00Z')
    expect((await readOpsFlags(db)).yield_ledger).toBe(true)
  })

  test('a name this code does not know is ignored, not a crash', async () => {
    const db = memoryD1()
    insert(db, 'some_future_flag', 1)
    expect(await readOpsFlags(db)).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false })
  })
})
