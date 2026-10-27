import { describe, expect, test } from 'bun:test'
import { parseScope, readOpsFlagState, readOpsFlags } from '../../src/api/ops-flags.ts'
import { memoryD1 } from './d1.ts'

function insert(db: ReturnType<typeof memoryD1>, flag: string, enabled: 0 | 1, createdAt = '2026-10-18T00:00:00Z') {
  db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES (?, ?, ?, ?, ?)`).run(flag, enabled, 'ot', 'test', createdAt)
}

describe('readOpsFlags (otto/mamoru#129, migrations/d1/0012_ops_flags.sql)', () => {
  test('migration not applied (no table): every flag off, not an error', async () => {
    const db = memoryD1()
    db.raw.exec('DROP TABLE ops_flag_changes')
    expect(await readOpsFlags(db)).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false, multichain_v6: false, merged_grants_v7: false })
  })

  test('table applied, no row for a flag: off', async () => {
    const db = memoryD1()
    expect(await readOpsFlags(db)).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false, multichain_v6: false, merged_grants_v7: false })
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
    expect(await readOpsFlags(db)).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false, multichain_v6: false, merged_grants_v7: false })
  })
})

describe('scoped flags (otto/mamoru#217, migrations/d1/0021_ops_flag_accounts.sql)', () => {
  let t = 0
  const row = (db: ReturnType<typeof memoryD1>, flag: string, enabled: 0 | 1, accounts: string | null) =>
    db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at, accounts) VALUES (?, ?, 'ot', 'test', ?, ?)`).run(flag, enabled, `2026-10-27T00:00:${String(t++ % 60).padStart(2, '0')}Z`, accounts)

  test('no scope ever: enabled for everyone, flags true, scopedFlags null (explicit)', async () => {
    const db = memoryD1()
    insert(db, 'multichain_v6', 1)
    const s = await readOpsFlagState(db)
    expect(s.flags.multichain_v6).toBe(true)
    expect(s.scopedFlags).toEqual({ multichain_v6: null })
  })

  test('a list: flags reads FALSE (old operators see off), scopedFlags carries it; comma or JSON, lowercased', async () => {
    const db = memoryD1()
    row(db, 'multichain_v6', 1, ' Acct_X, 0xABC ,')
    let s = await readOpsFlagState(db)
    expect(s.flags.multichain_v6).toBe(false)
    expect(s.scopedFlags).toEqual({ multichain_v6: ['acct_x', '0xabc'] })
    row(db, 'multichain_v6', 1, '["A","0xB"]')
    s = await readOpsFlagState(db)
    expect(s.scopedFlags).toEqual({ multichain_v6: ['a', '0xb'] })
  })

  test('an /ops flip (accounts NULL) inherits the previous scope, off and on again; "*" widens explicitly', async () => {
    const db = memoryD1()
    row(db, 'multichain_v6', 1, 'acct_x')
    row(db, 'multichain_v6', 0, null)
    expect(await readOpsFlagState(db)).toMatchObject({ flags: { multichain_v6: false }, scopedFlags: {} })
    row(db, 'multichain_v6', 1, null)
    const s = await readOpsFlagState(db)
    expect(s.flags.multichain_v6).toBe(false)
    expect(s.scopedFlags).toEqual({ multichain_v6: ['acct_x'] })
    row(db, 'multichain_v6', 1, '*')
    expect(await readOpsFlagState(db)).toMatchObject({ flags: { multichain_v6: true }, scopedFlags: { multichain_v6: null } })
    row(db, 'multichain_v6', 1, null)
    expect((await readOpsFlagState(db)).scopedFlags).toEqual({ multichain_v6: null })
  })

  test('malformed or empty scope is an empty list (nobody), never everyone', async () => {
    for (const bad of ['', '  ', '[oops', '{"a":1}', '[1,2]']) expect(parseScope(bad)).toEqual([])
    const db = memoryD1()
    row(db, 'multichain_v6', 1, '[oops')
    expect(await readOpsFlagState(db)).toMatchObject({ flags: { multichain_v6: false }, scopedFlags: { multichain_v6: [] } })
  })

  test('other flags ignore the column and keep their boolean', async () => {
    const db = memoryD1()
    row(db, 'yield_ledger', 1, 'acct_x')
    const s = await readOpsFlagState(db)
    expect(s.flags.yield_ledger).toBe(true)
    expect(s.scopedFlags).toEqual({})
  })

  test('table without the accounts column (migration not applied): flags as before, no scope, no error', async () => {
    const db = memoryD1()
    db.raw.exec('ALTER TABLE ops_flag_changes DROP COLUMN accounts')
    insert(db, 'multichain_v6', 1)
    insert(db, 'yield_ledger', 1)
    const s = await readOpsFlagState(db)
    expect(s.flags).toMatchObject({ multichain_v6: true, yield_ledger: true })
    expect(s.scopedFlags).toEqual({ multichain_v6: null })
    expect((await readOpsFlags(db)).yield_ledger).toBe(true)
  })

  test('no table at all: everything off', async () => {
    const db = memoryD1()
    db.raw.exec('DROP TABLE ops_flag_changes')
    expect(await readOpsFlagState(db)).toMatchObject({ scopedFlags: {} })
  })
})
