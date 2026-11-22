import { describe, expect, test } from 'bun:test'
import { memoryD1 } from './d1.ts'
import { writeSavings } from '../../src/api/savings-ledger.ts'
import type { SafeWire, SnapshotWire } from '../../src/api/yield-ledger.ts'

// otto/mamoru#413: the savings layer of each account, per UTC day, from the snapshot.
const CHAIN_ID = 8453
const SAFE = '0xAbCdEf0000000000000000000000000000005678'
const KEY = 'acct-savings-1'

function seeded() {
  const db = memoryD1()
  db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('u1', 'a@b.c', '2026-10-01T00:00:00.000Z')`)
  db.raw.exec(
    `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at)
     VALUES ('${KEY}', 'u1', ${CHAIN_ID}, '${SAFE.toLowerCase()}', '[]', 'cred', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z')`,
  )
  return db
}

const savings = (usdc: string) => ({ usdc, basisUsdc: '2000000', pendingUsdc: '500000', vaults: [{ vault: 'vault:gtUSDCp', shares: '1234', usdc: '1600000', basisUsdc: '1500000' }], status: 'counted' as const })
const snap = (block: string, readAt: string, s?: SafeWire['savings'], safe = SAFE): SnapshotWire =>
  ({ chainId: CHAIN_ID, block, readAt, pools: {}, calls: 1, lastError: null, safes: [{ safe, ...(s ? { savings: s } : {}) } as SafeWire] }) as SnapshotWire

describe('writeSavings', () => {
  test('one row per account and day; the day\'s latest read wins, an older one never overwrites it', async () => {
    const db = seeded()
    expect(await writeSavings(db, snap('100', '2026-11-22T10:00:00.000Z', savings('2100000')), new Date())).toBe(1)
    await writeSavings(db, snap('120', '2026-11-22T11:00:00.000Z', savings('2200000')), new Date())
    await writeSavings(db, snap('110', '2026-11-22T10:30:00.000Z', savings('9999999')), new Date())
    const rows = db.raw.query('SELECT day, account_key, usdc, basis_usdc, pending_usdc, status, vaults_json, block FROM account_savings_daily').all()
    expect(rows).toEqual([{ day: '2026-11-22', account_key: KEY, usdc: 2_200_000, basis_usdc: 2_000_000, pending_usdc: 500_000, status: 'counted', vaults_json: JSON.stringify(savings('1').vaults), block: 120 }])
  })

  test('no figure, an unknown Safe or a malformed amount: nothing written', async () => {
    const db = seeded()
    expect(await writeSavings(db, snap('100', '2026-11-22T10:00:00.000Z'), new Date())).toBe(0)
    expect(await writeSavings(db, snap('100', '2026-11-22T10:00:00.000Z', savings('1'), '0x0000000000000000000000000000000000000001'), new Date())).toBe(0)
    expect(await writeSavings(db, snap('100', '2026-11-22T10:00:00.000Z', { ...savings('1'), usdc: '-5' }), new Date())).toBe(0)
    expect(db.raw.query('SELECT COUNT(*) AS n FROM account_savings_daily').get()).toEqual({ n: 0 })
  })
})
