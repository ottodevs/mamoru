import { beforeEach, describe, expect, test } from 'bun:test'
import { feeGrowthInside, positionFees } from '@mamoru/uniswap-v3/fees'
import { memoryD1 } from './d1.ts'
import {
  writeReceipts,
  type DayReceiptWire,
  dayOf,
  feeReadinessUsd,
  fetchSnapshot,
  pullYieldLedger,
  writeAccountSnapshot,
  writeYieldLedger,
  type OperatorFetch,
  type PositionWire,
  type SafeWire,
  type SnapshotWire,
} from '../../src/api/yield-ledger.ts'

const CHAIN_ID = 8453
const SAFE = '0xAbCdEf0000000000000000000000000000001234'
const ACCOUNT_KEY = 'acct-yield-1'

function seedAccount(db: ReturnType<typeof memoryD1>) {
  db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('u1', 'a@b.c', '2026-10-01T00:00:00.000Z')`)
  db.raw.exec(
    `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at)
     VALUES ('${ACCOUNT_KEY}', 'u1', ${CHAIN_ID}, '${SAFE.toLowerCase()}', '[]', 'cred', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z')`,
  )
}

// A real position: liquidity 1_000_000, fee growth moved by Q128/2 inside the range since the checkpoint, nothing
// owed — the same arithmetic packages/uniswap-v3/src/fees.ts verifies against a simulated collect (#136).
const Q128 = 1n << 128n
const inside = feeGrowthInside(0, -100, 100, Q128, Q128 / 2n, { feeGrowthOutside0X128: 0n, feeGrowthOutside1X128: 0n }, { feeGrowthOutside0X128: 0n, feeGrowthOutside1X128: 0n })
const fees = positionFees({ liquidity: 1_000_000n, feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n, tokensOwed0: 0n, tokensOwed1: 0n }, inside)

function position(over: Partial<PositionWire> = {}): PositionWire {
  return {
    tokenId: '42',
    pool: 'pool:USDC/cbBTC/500',
    token0: 'USDC',
    token1: 'cbBTC',
    liquidity: '1000000',
    tickLower: -100,
    tickUpper: 100,
    inRange: true,
    amount0: '5000000',
    amount1: '0',
    accrued0: fees.accrued0.toString(),
    accrued1: fees.accrued1.toString(),
    owed0: '0',
    owed1: '0',
    collectable0: fees.collectable0.toString(),
    collectable1: fees.collectable1.toString(),
    valueUsdc: '5000000',
    feesUsdc: fees.accrued0.toString(),
    owedUsdc: '0',
    holdValueUsdc: '5000000',
    entryAmount0: '5000000',
    entryAmount1: '0',
    entryBlock: 1000,
    entryDay: '2026-10-16',
    ...over,
  }
}

function safe(over: Partial<SafeWire> = {}): SafeWire {
  return {
    accountKey: ACCOUNT_KEY.slice(0, 8),
    safe: SAFE,
    active: true,
    armed: false,
    deployed: true,
    eth: '0',
    tokens: {},
    positions: [position()],
    idleUsdc: '1000000',
    lpUsdc: '5000000',
    feesUsdc: fees.accrued0.toString(),
    owedUsdc: '0',
    totalUsdc: '6000000',
    ...over,
  }
}

function snapshot(over: Partial<SnapshotWire> = {}): SnapshotWire {
  return {
    chainId: CHAIN_ID,
    block: '1000',
    readAt: '2026-10-16T09:00:00.000Z',
    pools: { 'pool:USDC/cbBTC/500': { sqrtPriceX96: (1n << 96n).toString(), tick: 0, feeGrowthGlobal0X128: '0', feeGrowthGlobal1X128: '0' } },
    safes: [safe()],
    calls: 6,
    lastError: null,
    ...over,
  }
}

describe('writeAccountSnapshot (otto/mamoru#129, phase 2 of #136)', () => {
  let db: ReturnType<typeof memoryD1>
  beforeEach(() => {
    db = memoryD1()
    seedAccount(db)
  })

  test('resolves account_key by address and writes account_snapshot_latest', async () => {
    const { written, unmatched } = await writeAccountSnapshot(db, snapshot(), new Date('2026-10-16T09:00:05Z'))
    expect(written).toBe(1)
    expect(unmatched).toBe(0)
    const row = db.raw.query('SELECT * FROM account_snapshot_latest WHERE chain_id = ? AND address = ?').get(CHAIN_ID, SAFE.toLowerCase()) as Record<string, unknown>
    expect(row.account_key).toBe(ACCOUNT_KEY)
    expect(row.env).toBe('prod')
    expect(row.total_usdc).toBe(6_000_000)
  })

  test('rows carry the account environment (#130): beta stays beta, a test account is test', async () => {
    db.raw.exec(`UPDATE accounts SET env = 'beta' WHERE account_key = '${ACCOUNT_KEY}'`)
    await writeAccountSnapshot(db, snapshot(), new Date('2026-10-16T09:00:05Z'))
    const latest = () => db.raw.query('SELECT env FROM account_snapshot_latest WHERE address = ?').get(SAFE.toLowerCase()) as { env: string }
    const daily = () => db.raw.query('SELECT env FROM account_daily WHERE address = ?').get(SAFE.toLowerCase()) as { env: string }
    expect(latest().env).toBe('beta')
    expect(daily().env).toBe('beta')
    db.raw.exec(`UPDATE accounts SET is_test = 1 WHERE account_key = '${ACCOUNT_KEY}'`)
    await writeAccountSnapshot(db, snapshot(), new Date('2026-10-16T09:10:05Z'))
    expect(latest().env).toBe('test')
    expect(daily().env).toBe('test')
  })

  test('a row written as unknown before the account had an environment is corrected on the next pull', async () => {
    await writeAccountSnapshot(db, snapshot(), new Date('2026-10-16T09:00:05Z'))
    db.raw.exec(`UPDATE account_snapshot_latest SET env = 'unknown'`)
    db.raw.exec(`UPDATE account_daily SET env = 'unknown'`)
    await writeAccountSnapshot(db, snapshot(), new Date('2026-10-16T09:10:05Z'))
    expect((db.raw.query('SELECT env FROM account_snapshot_latest').get() as { env: string }).env).toBe('prod')
    expect((db.raw.query('SELECT env FROM account_daily').get() as { env: string }).env).toBe('prod')
  })

  test('a safe with no matching account is skipped, not written, not an error', async () => {
    const { written, unmatched } = await writeAccountSnapshot(db, snapshot({ safes: [safe({ safe: '0x0000000000000000000000000000000000dEaD' })] }), new Date())
    expect(written).toBe(0)
    expect(unmatched).toBe(1)
  })

  test('account_daily: first call of the day opens; a later call the same day only moves the close columns', async () => {
    await writeAccountSnapshot(db, snapshot({ readAt: '2026-10-16T09:00:00.000Z', block: '1000' }), new Date('2026-10-16T09:00:05Z'))
    await writeAccountSnapshot(db, snapshot({ readAt: '2026-10-16T18:00:00.000Z', block: '1500', safes: [safe({ totalUsdc: '7000000' })] }), new Date('2026-10-16T18:00:05Z'))
    const row = db.raw.query('SELECT * FROM account_daily WHERE day = ? AND chain_id = ? AND address = ?').get('2026-10-16', CHAIN_ID, SAFE.toLowerCase()) as Record<string, unknown>
    expect(row.block_open).toBe(1000)
    expect(row.block_close).toBe(1500)
    expect(row.total_open_usdc).toBe(6_000_000)
    expect(row.total_close_usdc).toBe(7_000_000)
  })

  test('collected_usdc and gas_paid_wei stay null until a receipt carries them, and a later call without one does not erase them', async () => {
    const now = new Date('2026-10-16T09:00:05Z')
    await writeAccountSnapshot(db, snapshot(), now)
    let row = db.raw.query('SELECT collected_usdc, gas_paid_wei FROM account_daily WHERE day = ?').get('2026-10-16') as Record<string, unknown>
    expect(row.collected_usdc).toBeNull()
    expect(row.gas_paid_wei).toBeNull()

    const receipts = new Map([[ACCOUNT_KEY, { collectedUsd: 42, gasWei: '12345' }]])
    await writeAccountSnapshot(db, snapshot(), now, receipts)
    row = db.raw.query('SELECT collected_usdc, gas_paid_wei FROM account_daily WHERE day = ?').get('2026-10-16') as Record<string, unknown>
    expect(row.collected_usdc).toBe(42)
    expect(row.gas_paid_wei).toBe('12345')

    await writeAccountSnapshot(db, snapshot(), now)
    row = db.raw.query('SELECT collected_usdc, gas_paid_wei FROM account_daily WHERE day = ?').get('2026-10-16') as Record<string, unknown>
    expect(row.collected_usdc).toBe(42)
    expect(row.gas_paid_wei).toBe('12345')
  })
})

describe('writeYieldLedger (otto/mamoru#129): reconciliation against the fee math', () => {
  let db: ReturnType<typeof memoryD1>
  beforeEach(() => {
    db = memoryD1()
    seedAccount(db)
  })

  test('accrued0_close/accrued1_close/accrued_usd_close match packages/uniswap-v3/src/fees.ts exactly', async () => {
    const { written, skipped } = await writeYieldLedger(db, snapshot(), new Date('2026-10-16T09:00:05Z'))
    expect(written).toBe(1)
    expect(skipped).toBe(0)
    const row = db.raw.query('SELECT * FROM yield_ledger_position_daily WHERE day = ? AND token_id = ?').get('2026-10-16', 42) as Record<string, unknown>
    expect(row.env).toBe('prod')
    expect(BigInt(row.accrued0_close as string)).toBe(fees.accrued0)
    expect(BigInt(row.accrued1_close as string)).toBe(fees.accrued1)
    expect(row.accrued_usd_close).toBe(Number(fees.accrued0))
  })

  test('a position without holdValueUsdc (the yield_ledger flag off on the operator) is skipped, not written with a guessed baseline', async () => {
    const { written, skipped } = await writeYieldLedger(db, snapshot({ safes: [safe({ positions: [position({ holdValueUsdc: undefined })] })] }), new Date())
    expect(written).toBe(0)
    expect(skipped).toBe(1)
  })

  test('a position missing just one entry* field is skipped too, even with holdValueUsdc present (code-review finding: these four must travel together)', async () => {
    const { written, skipped } = await writeYieldLedger(db, snapshot({ safes: [safe({ positions: [position({ entryDay: undefined })] })] }), new Date())
    expect(written).toBe(0)
    expect(skipped).toBe(1)
  })

  test('the entry baseline is captured once and never moved by a later read with different amounts', async () => {
    await writeYieldLedger(db, snapshot(), new Date('2026-10-16T09:00:00Z'))
    await writeYieldLedger(db, snapshot({ readAt: '2026-10-16T18:00:00Z', safes: [safe({ positions: [position({ amount0: '9999999' })] })] }), new Date('2026-10-16T18:00:00Z'))
    const entry = db.raw.query('SELECT * FROM yield_ledger_position_entry WHERE token_id = 42').get() as Record<string, unknown>
    expect(entry.entry_amount0).toBe('5000000')
    expect(entry.env).toBe('prod')
  })

  test('yield_ledger_position_entry stores entryAmount0/1, not the position\'s current amount0/1, even when they differ (code-review finding, PR #43)', async () => {
    // The operator's baseline (entryAmount0) can differ from the position's amount0 on the very tick the Worker
    // first observes it: a reorder/rerange between the operator's capture and the Worker's pull, for example.
    await writeYieldLedger(db, snapshot({ safes: [safe({ positions: [position({ amount0: '123456', entryAmount0: '5000000' })] })] }), new Date())
    const entry = db.raw.query('SELECT entry_amount0 FROM yield_ledger_position_entry WHERE token_id = 42').get() as Record<string, unknown>
    expect(entry.entry_amount0).toBe('5000000')
    expect(entry.entry_amount0).not.toBe('123456')
  })

  test('value vs hold is derivable from stored columns: equal entry and current value means zero drift', async () => {
    await writeYieldLedger(db, snapshot(), new Date())
    const row = db.raw.query('SELECT value_usd, hold_value_usd FROM yield_ledger_position_daily WHERE token_id = 42').get() as Record<string, unknown>
    expect(row.value_usd).toBe(row.hold_value_usd)
  })

  test('fee readiness: collected_usd from a receipt sets fee_accrued_usd to 10%, stored, and survives a later call without one', async () => {
    const receipts = new Map([['42', { collectedUsd: 100, collected0: '100000000', collected1: '0' }]])
    await writeYieldLedger(db, snapshot(), new Date('2026-10-16T09:00:00Z'), receipts)
    let row = db.raw.query('SELECT collected_usd, fee_accrued_usd FROM yield_ledger_position_daily WHERE token_id = 42').get() as Record<string, unknown>
    expect(row.collected_usd).toBe(100)
    expect(row.fee_accrued_usd).toBe(10)
    expect(feeReadinessUsd(100)).toBe(10)
    expect(feeReadinessUsd(null)).toBeNull()

    await writeYieldLedger(db, snapshot({ readAt: '2026-10-16T18:00:00Z' }), new Date('2026-10-16T18:00:00Z'))
    row = db.raw.query('SELECT collected_usd, fee_accrued_usd FROM yield_ledger_position_daily WHERE token_id = 42').get() as Record<string, unknown>
    expect(row.collected_usd).toBe(100)
    expect(row.fee_accrued_usd).toBe(10)
  })
})

describe('writeReceipts (otto/mamoru#129): the operator\'s per-day gas and collected fees', () => {
  let db: ReturnType<typeof memoryD1>
  beforeEach(() => {
    db = memoryD1()
    seedAccount(db)
  })
  const day = '2026-10-16'
  const now = new Date('2026-10-16T09:00:05Z')
  const withReceipts = (days: DayReceiptWire[], safeAddr: string = SAFE) => snapshot({ receipts: [{ safe: safeAddr, days }] })
  const accountRow = () => db.raw.query('SELECT collected_usdc, gas_paid_wei FROM account_daily WHERE day = ?').get(day) as Record<string, unknown>
  const positionRow = () => db.raw.query('SELECT collected0, collected1, collected_usd, fee_accrued_usd FROM yield_ledger_position_daily WHERE day = ? AND token_id = 42').get(day) as Record<string, unknown>
  const collectedRow = (tokenId: number) => db.raw.query('SELECT account_key, env, collected0, collected1, collected_usd FROM yield_ledger_position_collected WHERE day = ? AND token_id = ?').get(day, tokenId) as Record<string, unknown> | null

  test('fills the day\'s rows, and writing the same totals again changes nothing', async () => {
    await writeAccountSnapshot(db, snapshot(), now)
    await writeYieldLedger(db, snapshot(), now)
    const r = withReceipts([{ day, gasWei: '777', collectedUsdc: '500', positions: [{ tokenId: '42', collected0: '500', collected1: '3', collectedUsdc: '500' }] }])
    await writeReceipts(db, r, now)
    await writeReceipts(db, r, now)
    expect(accountRow()).toEqual({ collected_usdc: 500, gas_paid_wei: '777' })
    expect(positionRow()).toEqual({ collected0: '500', collected1: '3', collected_usd: 500, fee_accrued_usd: 50 })
    expect(collectedRow(42)).toEqual({ account_key: ACCOUNT_KEY, env: 'prod', collected0: '500', collected1: '3', collected_usd: 500 })
    expect(db.raw.query('SELECT COUNT(*) AS n FROM yield_ledger_position_collected').get()).toEqual({ n: 1 })
  })

  test('a day not priced yet keeps the stored USD figure but still takes the gas and raw amounts', async () => {
    await writeAccountSnapshot(db, snapshot(), now)
    await writeYieldLedger(db, snapshot(), now)
    await writeReceipts(db, withReceipts([{ day, gasWei: '1', collectedUsdc: '9', positions: [{ tokenId: '42', collected0: '9', collected1: '0', collectedUsdc: '9' }] }]), now)
    await writeReceipts(db, withReceipts([{ day, gasWei: '2', positions: [{ tokenId: '42', collected0: '10', collected1: '0' }] }]), now)
    expect(accountRow()).toEqual({ collected_usdc: 9, gas_paid_wei: '2' })
    expect(positionRow()).toEqual({ collected0: '10', collected1: '0', collected_usd: 9, fee_accrued_usd: 1 })
    expect(collectedRow(42)?.collected_usd).toBe(9)
  })

  test('a position burned before any snapshot of the day saw it keeps its collected fees', async () => {
    await writeAccountSnapshot(db, snapshot(), now)
    await writeReceipts(db, withReceipts([{ day, gasWei: '5', collectedUsdc: '70', positions: [{ tokenId: '77', collected0: '70', collected1: '0', collectedUsdc: '70' }] }]), now)
    expect(db.raw.query('SELECT COUNT(*) AS n FROM yield_ledger_position_daily WHERE token_id = 77').get()).toEqual({ n: 0 })
    expect(collectedRow(77)?.collected_usd).toBe(70)
    expect(accountRow().collected_usdc).toBe(70)
  })

  const receiptsRow = (d = day) => db.raw.query('SELECT account_key, gas_paid_wei, collected_usdc FROM yield_ledger_account_receipts WHERE day = ?').get(d) as Record<string, unknown> | null

  test('a day with no snapshot row (account stopped right after an op) is kept in the account receipts, never as an invented account_daily row', async () => {
    await writeReceipts(db, withReceipts([{ day, gasWei: '5', collectedUsdc: '0', positions: [] }]), now)
    expect(db.raw.query('SELECT COUNT(*) AS n FROM account_daily').get()).toEqual({ n: 0 })
    expect(receiptsRow()).toEqual({ account_key: ACCOUNT_KEY, gas_paid_wei: '5', collected_usdc: 0 })
  })

  test('an unchanged day is skipped by digest; a changed or long-past day is written', async () => {
    const d = { day, gasWei: '5', collectedUsdc: '1', positions: [] }
    await writeReceipts(db, withReceipts([d]), now)
    db.raw.exec(`UPDATE yield_ledger_account_receipts SET gas_paid_wei = 'tampered'`)
    await writeReceipts(db, withReceipts([d]), now)
    expect(receiptsRow()?.gas_paid_wei).toBe('tampered')
    await writeReceipts(db, withReceipts([{ ...d, gasWei: '6' }, { day: '2025-01-01', gasWei: '9', positions: [] }]), now)
    expect(receiptsRow()?.gas_paid_wei).toBe('6')
    expect(receiptsRow('2025-01-01')?.gas_paid_wei).toBe('9')
  })

  test('a snapshot row created after the day\'s receipt was delivered (stopped, then restarted) still carries it', async () => {
    await writeReceipts(db, withReceipts([{ day, gasWei: '5', collectedUsdc: '95', positions: [{ tokenId: '42', collected0: '95', collected1: '0', collectedUsdc: '95' }] }]), now)
    await writeAccountSnapshot(db, snapshot(), now)
    await writeYieldLedger(db, snapshot(), now)
    expect(accountRow()).toEqual({ collected_usdc: 95, gas_paid_wei: '5' })
    expect(positionRow()).toEqual({ collected0: '95', collected1: '0', collected_usd: 95, fee_accrued_usd: 10 })
    await writeAccountSnapshot(db, snapshot({ readAt: '2026-10-16T18:00:00.000Z' }), now)
    expect(accountRow()).toEqual({ collected_usdc: 95, gas_paid_wei: '5' })
  })

  test('skips a safe no account owns', async () => {
    await writeAccountSnapshot(db, snapshot(), now)
    await writeReceipts(db, withReceipts([{ day, gasWei: '5', positions: [{ tokenId: '9', collected0: '1', collected1: '1' }] }], '0x0000000000000000000000000000000000dEaD'), now)
    expect(accountRow().gas_paid_wei).toBeNull()
    expect(collectedRow(9)).toBeNull()
    expect(db.raw.query('SELECT COUNT(*) AS n FROM yield_ledger_account_receipts').get()).toEqual({ n: 0 })
  })
})

describe('dayOf', () => {
  test('is the UTC date of an ISO timestamp', () => {
    expect(dayOf('2026-10-16T23:59:59.999Z')).toBe('2026-10-16')
  })
})

function fetcher(status: number, body: unknown): OperatorFetch {
  return async () => new Response(JSON.stringify(body), { status })
}

describe('fetchSnapshot', () => {
  test('404 (loop off) and 503 (no read yet) both answer null, never throw', async () => {
    expect(await fetchSnapshot('http://op', 'secret', fetcher(404, { error: 'snapshot off' }))).toBeNull()
    expect(await fetchSnapshot('http://op', 'secret', fetcher(503, { error: 'no snapshot yet' }))).toBeNull()
  })

  test('an unreachable operator answers null instead of throwing', async () => {
    const broken: OperatorFetch = async () => {
      throw new Error('connect refused')
    }
    expect(await fetchSnapshot('http://op', 'secret', broken)).toBeNull()
  })

  test('200 parses the body as the snapshot', async () => {
    const snap = snapshot()
    expect(await fetchSnapshot('http://op', 'secret', fetcher(200, snap))).toEqual(snap)
  })
})

describe('pullYieldLedger: one cron tick end to end', () => {
  test('null when the operator has nothing to say; writes both tables when it does', async () => {
    const db = memoryD1()
    seedAccount(db)
    expect(await pullYieldLedger(db, 'http://op', 'secret', fetcher(404, {}), new Date())).toBeNull()
    const result = await pullYieldLedger(db, 'http://op', 'secret', fetcher(200, snapshot()), new Date())
    expect(result).toEqual({ accounts: 1, positions: 1 })
  })
})
