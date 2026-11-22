import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type Log } from 'viem'
import { address, baseRegistry } from '@mamoru/registry'
import { clampSavings, clipBooks, savingsObs, savingsOf, savingsOutOf, savingsView, type VaultRead } from '../src/savings.ts'
import type { StoredOp } from '../src/state.ts'
import { factsFromLogs } from '../src/yield-receipts.ts'

// otto/mamoru#413 (spec 012 savings-layer.md): the savings books, derived from the stored ops.
const POOL = 'pool:WETH/USDC/500'
const pool = baseRegistry.entries.find((e) => e.name === POOL)!
const usdcSide = pool.token0 === 'USDC' ? 'fee0' : 'fee1'
const VAULT = 'vault:gtUSDCp'
const USDC = 1_000_000n
/** 1.25 USDC per share, 18-decimal shares. */
const E18 = 10n ** 18n
const sharesFor = (assets: bigint, rate = 1_250_000n) => (assets * E18) / rate
const at = (s: number) => new Date(s * 1000).toISOString()

const eng = (n: number, extra: Partial<StoredOp>): StoredOp => ({ opId: `eng-${n}`, kind: 'reduce', state: 'confirmed', updatedAt: at(n), block: n, pool: POOL, ...extra }) as StoredOp
const harvest = (n: number, usdcFee: bigint, flagged = true) =>
  eng(n, { step: 'harvest', ...(flagged ? { savingsIn: true as const } : {}), facts: { at: at(n), gasWei: '1', fees: [{ tokenId: '1', pool: POOL, fee0: usdcSide === 'fee0' ? usdcFee.toString() : '7', fee1: usdcSide === 'fee1' ? usdcFee.toString() : '7' }] } })
const sale = (n: number, usdcIn: bigint) => eng(n, { kind: 'enter', step: 'enter_swap', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: '7', savingsIn: true, userOpHash: `0x${'cd'.repeat(32)}`, facts: { at: at(n), gasWei: '1', fees: [], usdcNet: usdcIn.toString() } })
const deposit = (n: number, assets: bigint, read = true, rate = 1_250_000n) =>
  eng(n, {
    kind: 'enter',
    step: 'vault_deposit',
    pool: VAULT,
    tokenIn: 'USDC',
    tokenOut: VAULT,
    amountIn: assets.toString(),
    savings: true,
    ...(read ? { facts: { at: at(n), gasWei: '1', fees: [], vaultFlows: [{ vault: VAULT, kind: 'deposit' as const, assets: assets.toString(), shares: sharesFor(assets, rate).toString(), logIndex: 1 }] } } : {}),
  })
const stop = (n: number) => ({ opId: `own-${n}`, kind: 'exit', state: 'confirmed', updatedAt: at(n), block: n }) as StoredOp
const withdrawal = (n: number, out: { pending: bigint; shares?: bigint }) =>
  ({ opId: `own-${n}`, kind: 'transfer', state: 'confirmed', updatedAt: at(n), block: n, amountUsdc: '1', savingsOut: { pending: out.pending.toString(), shares: out.shares ? { [VAULT]: out.shares.toString() } : {} } }) as StoredOp
const read = (shares: bigint, rate = 1_250_000n): VaultRead[] => [{ name: VAULT, shares, assets: (shares * rate) / E18 }]

describe('savingsOf: what enters and leaves the books', () => {
  test('a flagged harvest adds its USDC fees, a harvest sale the USDC it received; the volatile side is not savings', () => {
    const b = savingsOf([harvest(1, 300_000n), sale(2, 2n * USDC)], baseRegistry)
    expect(b.pending).toBe(2_300_000n)
    expect(b.vaults).toEqual({})
    expect(b.partial).toBe(false)
  })

  test('ops stored before the savings code (no flag) count for nothing: no backfill', () => {
    expect(savingsOf([harvest(1, 300_000n, false), eng(2, { step: 'vault_deposit', tokenOut: VAULT, amountIn: '1000000' })], baseRegistry).pending).toBe(0n)
  })

  test('harvest → sale → savings deposit: pending moves into the vault, shares and basis from the receipt (SAV-S1)', () => {
    const b = savingsOf([harvest(1, 500_000n), sale(2, 1_500_000n), deposit(3, 2n * USDC)], baseRegistry)
    expect(b.pending).toBe(0n)
    expect(b.vaults[VAULT]).toEqual({ shares: sharesFor(2n * USDC), basis: 2n * USDC })
  })

  test('small harvests add up before one deposit; later harvests start a new pending (SAV-S2)', () => {
    const b = savingsOf([harvest(1, 400_000n), harvest(2, 400_000n), harvest(3, 400_000n), deposit(4, 1_200_000n), harvest(5, 100_000n)], baseRegistry)
    expect(b.pending).toBe(100_000n)
    expect(b.vaults[VAULT]!.basis).toBe(1_200_000n)
  })

  test('a deposit whose receipt is not read yet counts at the vault rate of the read, floored, and marks the books partial', () => {
    const b = savingsOf([harvest(1, 2n * USDC), deposit(2, 2n * USDC, false)], baseRegistry, { rates: read(sharesFor(1_000n * USDC), 1_300_000n) })
    expect(b.pending).toBe(0n)
    expect(b.vaults[VAULT]!.shares).toBe(sharesFor(2n * USDC, 1_300_000n))
    expect(b.partial).toBe(true)
  })

  test('a harvest or sale whose receipt is not read yet adds nothing yet (partial): pending is never overstated', () => {
    const b = savingsOf([harvest(1, USDC), eng(2, { step: 'harvest', savingsIn: true })], baseRegistry)
    expect(b.pending).toBe(USDC)
    expect(b.partial).toBe(true)
  })

  test('a withdrawal takes its stored savings-first split, never more than held; basis goes pro rata (SAV-S5)', () => {
    const ops = [harvest(1, 11n * USDC), deposit(2, 10n * USDC), withdrawal(3, { pending: USDC, shares: sharesFor(4n * USDC) })]
    const b = savingsOf(ops, baseRegistry)
    expect(b.pending).toBe(0n)
    expect(b.vaults[VAULT]!.shares).toBe(sharesFor(10n * USDC) - sharesFor(4n * USDC))
    expect(b.vaults[VAULT]!.basis).toBe(6n * USDC)
    const all = savingsOf([...ops.slice(0, 2), withdrawal(3, { pending: 50n * USDC, shares: sharesFor(500n * USDC) })], baseRegistry)
    expect(all.pending).toBe(0n)
    expect(all.vaults).toEqual({})
  })

  test('a Stop empties the books; a later Start re-tags nothing (SAV-S6)', () => {
    const b = savingsOf([harvest(1, 3n * USDC), deposit(2, 2n * USDC), stop(3), harvest(4, 0n)], baseRegistry)
    expect(b).toEqual({ epoch: 'own-3', pending: 0n, vaults: {}, partial: false })
  })

  test('only ops at or before the read block count; order is by block, not by array', () => {
    const ops = [deposit(3, 2n * USDC), harvest(1, 2n * USDC)]
    expect(savingsOf(ops, baseRegistry).vaults[VAULT]!.basis).toBe(2n * USDC)
    expect(savingsOf(ops, baseRegistry, { atBlock: 2 })).toMatchObject({ pending: 2n * USDC, vaults: {} })
  })

  test('review of #395: in one block, the harvest that funds a deposit counts first whatever the stored order', () => {
    const b = savingsOf([deposit(5, 2n * USDC), harvest(5, 2n * USDC)], baseRegistry)
    expect(b.pending).toBe(0n)
    expect(b.vaults[VAULT]!.basis).toBe(2n * USDC)
  })

  test('review of #395: a deposit read without its Deposit flow deposited nothing: pending stays (partial)', () => {
    const noFlow = { ...deposit(2, 2n * USDC), facts: { at: at(2), gasWei: '1', fees: [] } } as StoredOp
    const b = savingsOf([harvest(1, 2n * USDC), noFlow], baseRegistry, { rates: read(sharesFor(100n * USDC)) })
    expect(b.pending).toBe(2n * USDC)
    expect(b.vaults).toEqual({})
    expect(b.partial).toBe(true)
  })

  test('review of #395: a sale whose facts are not scoped to its userOp adds nothing (partial)', () => {
    const { userOpHash: _h, ...unscoped } = sale(2, 2n * USDC)
    const b = savingsOf([unscoped as StoredOp], baseRegistry)
    expect(b.pending).toBe(0n)
    expect(b.partial).toBe(true)
  })

  test('unconfirmed ops do not count', () => {
    expect(savingsOf([{ ...harvest(1, USDC), state: 'submitted' } as StoredOp], baseRegistry).pending).toBe(0n)
  })
})

describe('clampSavings: never above what the Safe holds, and kept down', () => {
  test('pending above the USDC held is cut at that block; the cut stays when USDC comes back', () => {
    const ops = [harvest(1, 5n * USDC)]
    const first = clampSavings(ops, baseRegistry, { block: 10, usdc: 2n * USDC, vaults: [] })
    expect(first.books.pending).toBe(2n * USDC)
    expect(first.cuts).toEqual({ epoch: '', cuts: [{ block: 10, usdc: (2n * USDC).toString() }] })
    // An owner deposit of 100 later: the books stay at 2, the deposit is bucket money.
    const later = clampSavings(ops, baseRegistry, { block: 20, usdc: 102n * USDC, vaults: [] }, first.cuts)
    expect(later.books.pending).toBe(2n * USDC)
    expect(later.cuts).toEqual(first.cuts)
  })

  test('savings shares above the shares held are cut, basis pro rata; a vault the read did not return is never cut', () => {
    const ops = [harvest(1, 10n * USDC), deposit(2, 10n * USDC)]
    const held = sharesFor(4n * USDC)
    const r = clampSavings(ops, baseRegistry, { block: 10, usdc: 0n, vaults: read(held) })
    expect(r.books.vaults[VAULT]!.shares).toBe(held)
    expect(r.books.vaults[VAULT]!.basis).toBe(4n * USDC)
    const unread = clampSavings(ops, baseRegistry, { block: 10, usdc: 0n, vaults: [] })
    expect(unread.books.vaults[VAULT]!.shares).toBe(sharesFor(10n * USDC))
    expect(unread.cuts.cuts).toEqual([])
  })

  test('review of #395: a cap holds whatever lands late: a withdrawal is never counted twice, an unrelated op keeps it', () => {
    const ops = [harvest(1, 5n * USDC)]
    const sent = { ...withdrawal(9, { pending: 3n * USDC }), state: 'submitted', txHash: '0xab' } as StoredOp
    // The withdrawal's 3 already left the Safe at block 9: 2 USDC held, books still 5. The read caps at 2.
    const during = clampSavings([...ops, sent], baseRegistry, { block: 10, usdc: 2n * USDC, vaults: [] })
    expect(during.books.pending).toBe(2n * USDC)
    expect(during.cuts.cuts).toEqual([{ block: 10, usdc: (2n * USDC).toString() }])
    // It confirms at block 9 (or lands late after being given up on): 5 - 3 = 2 under a cap of 2, not 2 - 3.
    const confirmed = [...ops, { ...sent, state: 'confirmed' } as StoredOp]
    expect(savingsOf(confirmed, baseRegistry, { cuts: during.cuts }).pending).toBe(2n * USDC)
    // An op that spent USDC outside the books lands late at block 9; the owner then deposits 100: still 2.
    const spend = eng(9, { step: 'enter_swap', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '3000000' })
    const later = clampSavings([...ops, spend], baseRegistry, { block: 20, usdc: 102n * USDC, vaults: [] }, during.cuts)
    expect(later.books.pending).toBe(2n * USDC)
  })

  test('review of #395: a balance the read did not return caps nothing; an over-estimated deposit is replaced by its receipt', () => {
    const ops = [harvest(1, 5n * USDC)]
    expect(clampSavings(ops, baseRegistry, { block: 10, usdc: undefined, vaults: [] }).cuts.cuts).toEqual([])
    // An unread deposit counted at a rate a little off sits a few units above what it minted: capped at the held shares.
    const held = sharesFor(10n * USDC)
    const unread = [harvest(1, 10n * USDC), deposit(2, 10n * USDC, false)]
    const r = clampSavings(unread, baseRegistry, { block: 10, usdc: 0n, vaults: read(held - 5n) })
    expect(r.books.vaults[VAULT]!.shares).toBe(held - 5n)
    // Its receipt says it minted held - 5: the cap is a no-op, nothing lost.
    const readOps = [harvest(1, 10n * USDC), { ...deposit(2, 10n * USDC), facts: { at: at(2), gasWei: '1', fees: [], vaultFlows: [{ vault: VAULT, kind: 'deposit' as const, assets: (10n * USDC).toString(), shares: (held - 5n).toString(), logIndex: 1 }] } } as StoredOp]
    expect(savingsOf(readOps, baseRegistry, { cuts: r.cuts }).vaults[VAULT]!.shares).toBe(held - 5n)
  })

  test('review of #395: an unread deposit with no rate at all keeps its assets pending, and no cap is stored', () => {
    const ops = [harvest(1, 10n * USDC), deposit(2, 10n * USDC, false)]
    const r = clampSavings(ops, baseRegistry, { block: 10, usdc: 0n, vaults: [] })
    expect(r.books.unpriced).toBe(true)
    expect(r.cuts.cuts).toEqual([])
    // With an earlier receipt of the same vault, its rate prices the new one.
    const withHistory = [harvest(1, 20n * USDC), deposit(2, 10n * USDC), deposit(3, 10n * USDC, false)]
    expect(savingsOf(withHistory, baseRegistry).vaults[VAULT]!.shares).toBe(2n * sharesFor(10n * USDC))
  })

  test('a Stop starts a new epoch: the older cuts are dropped and do not touch the new books', () => {
    const before = clampSavings([harvest(1, 5n * USDC)], baseRegistry, { block: 10, usdc: 0n, vaults: [] })
    const ops = [harvest(1, 5n * USDC), stop(11), harvest(12, 3n * USDC)]
    const r = clampSavings(ops, baseRegistry, { block: 20, usdc: 50n * USDC, vaults: [] }, before.cuts)
    expect(r.books.pending).toBe(3n * USDC)
    expect(r.cuts).toEqual({ epoch: 'own-11', cuts: [] })
  })

  test('savings + bucket = what is held, after deposits, a bucket redeem and a withdrawal (no double count, SAV-S7)', () => {
    // Vault: 100 of bucket money, then 10 of savings; the bucket redeems 30; a withdrawal of 6 takes savings first.
    const ops = [harvest(1, 10n * USDC), deposit(2, 10n * USDC)]
    let vaultShares = sharesFor(100n * USDC) + sharesFor(10n * USDC)
    vaultShares -= sharesFor(30n * USDC)
    let b = clampSavings(ops, baseRegistry, { block: 5, usdc: 0n, vaults: read(vaultShares) }).books
    expect(b.vaults[VAULT]!.shares).toBe(sharesFor(10n * USDC))
    const out = savingsOutOf(b, 6n * USDC, read(vaultShares))!
    vaultShares -= sharesFor(6n * USDC)
    b = clampSavings([...ops, withdrawal(6, { pending: BigInt(out.pending), shares: BigInt(out.shares[VAULT]!) })], baseRegistry, { block: 7, usdc: 0n, vaults: read(vaultShares) }).books
    const savings = b.vaults[VAULT]!.shares
    const bucket = vaultShares - savings
    expect(savings + bucket).toBe(vaultShares)
    // Savings paid the 6 first: 4 of savings left, the bucket's 70 untouched (to a share unit of rounding).
    expect(savings).toBe(sharesFor(10n * USDC) - BigInt(out.shares[VAULT]!))
    const seventy = sharesFor(70n * USDC)
    expect(bucket >= seventy - 2n && bucket <= seventy + 2n).toBe(true)
  })
})

describe('the figures the engine, the app and the fee read', () => {
  test('clipBooks: within what a read holds, nothing stored; a missing balance or vault clips nothing', () => {
    const b = { epoch: '', pending: 5n * USDC, vaults: { [VAULT]: { shares: sharesFor(10n * USDC), basis: 10n * USDC } }, partial: false }
    const c = clipBooks(b, 2n * USDC, read(sharesFor(4n * USDC)))
    expect(c.pending).toBe(2n * USDC)
    expect(c.vaults[VAULT]).toEqual({ shares: sharesFor(4n * USDC), basis: 4n * USDC })
    expect(b.pending).toBe(5n * USDC)
    expect(clipBooks(b, undefined, [])).toEqual(b)
  })

  test('savingsObs: empty books are absent, so the observation hashes as before', () => {
    expect(savingsObs({ epoch: '', pending: 0n, vaults: {}, partial: false })).toBeUndefined()
    expect(savingsObs({ epoch: '', pending: 5n, vaults: { [VAULT]: { shares: 9n, basis: 1n } }, partial: false })).toEqual({ pending: 5n, shares: { [VAULT]: 9n } })
  })

  test('savingsView: value at the vault rate, basis and pending, as decimal strings; partial is said', () => {
    const b = savingsOf([harvest(1, 10n * USDC), deposit(2, 8n * USDC, true, 1_250_000n)], baseRegistry)
    const v = savingsView(b, read(sharesFor(100n * USDC), 1_500_000n))
    // 8 USDC of shares bought at 1.25, now worth 1.50 each: 9.6, plus 2 pending.
    expect(v).toEqual({ usdc: '11600000', basisUsdc: '10000000', pendingUsdc: '2000000', vaults: [{ vault: VAULT, shares: sharesFor(8n * USDC).toString(), usdc: '9600000', basisUsdc: '8000000' }], status: 'counted' })
  })

  test('savingsOutOf: pending first, then shares rounded up and never above the tagged ones; nothing to take is absent', () => {
    const b = { epoch: '', pending: 2n * USDC, vaults: { [VAULT]: { shares: sharesFor(10n * USDC), basis: 10n * USDC } }, partial: false }
    expect(savingsOutOf(b, USDC, read(sharesFor(50n * USDC)))).toEqual({ pending: USDC.toString(), shares: {} })
    const mid = savingsOutOf(b, 5n * USDC, read(sharesFor(50n * USDC)))!
    expect(mid.pending).toBe((2n * USDC).toString())
    expect(BigInt(mid.shares[VAULT]!)).toBe(sharesFor(3n * USDC))
    expect(savingsOutOf(b, 1_000n * USDC, read(sharesFor(50n * USDC)))).toEqual({ pending: (2n * USDC).toString(), shares: { [VAULT]: sharesFor(10n * USDC).toString() } })
    expect(savingsOutOf({ epoch: '', pending: 0n, vaults: {}, partial: false }, USDC, [])).toBeUndefined()
  })
})

describe('usdcNet: what a harvest sale paid into savings, from the receipt', () => {
  const SAFE = '0x1111111111111111111111111111111111111111' as Address
  const OTHER = '0x2222222222222222222222222222222222222222' as Address
  const erc20 = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
  let idx = 0
  const transfer = (token: string, from: Address, to: Address, value: bigint): Log =>
    ({ address: address(token, baseRegistry), topics: encodeEventTopics({ abi: erc20, eventName: 'Transfer', args: { from, to } }) as [Hex, ...Hex[]], data: encodeAbiParameters([{ type: 'uint256' }], [value]), logIndex: idx++, blockNumber: 1n, blockHash: '0x01', transactionHash: '0x02', transactionIndex: 0, removed: false }) as Log

  test('USDC in less USDC out of the Safe; other tokens and other accounts do not count; none: absent', () => {
    const f = factsFromLogs([transfer('WETH', SAFE, OTHER, 10n ** 15n), transfer('USDC', OTHER, SAFE, 2_500_000n), transfer('USDC', SAFE, OTHER, 100_000n), transfer('USDC', OTHER, OTHER, 9n)], SAFE, 1_700_000_000n)
    expect(f.usdcNet).toBe('2400000')
    expect(factsFromLogs([transfer('WETH', SAFE, OTHER, 1n)], SAFE, 1_700_000_000n).usdcNet).toBeUndefined()
  })
})
