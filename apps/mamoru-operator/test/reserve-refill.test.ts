// otto/mamoru#262: a running account's gas reserve is refilled by the relayer before it reaches the floor where the
// engine stops acting (c23e94e1, 2 Nov 2026: 0.000297 ETH under the 0.0003 floor held a merge and every other action).
import { describe, expect, test } from 'bun:test'
import type { Observation } from '@mamoru/decide'
import { POLICIES } from '@mamoru/policy'
import type { Operator } from '../src/operator.ts'
import { reserveRefillWei } from '../src/gas-reserve.ts'
import { DEFAULT_SPONSOR, RESERVE_REFILLS_PER_DAY, activationRefusal, sponsorRefusal, type SponsorEntry } from '../src/sponsorship.ts'
import type { AccountState } from '../src/state.ts'
import { SAFE, ctx, quiet, world } from './owner-world.ts'

type Privates = { refillReserve(a: AccountState, obs: Observation): Promise<void> }
const priv = (op: Operator) => op as unknown as Privates

const POLICY = POLICIES['conservador-live-v2']!
/** Floor 0.0003 ETH + two prefunds at Base's minimum fee (the world's 0.01 gwei is under it). */
const THRESHOLD = 412_200_000_000_000n
const MARGIN = 200_000_000_000_000n

function account(over: Partial<AccountState> = {}): AccountState {
  return { accountKey: 'k', ctx, active: true, policyId: POLICY.policyId, grants: [], ops: [], ...over } as unknown as AccountState
}

function observation(native: bigint, over: Partial<Observation> = {}): Observation {
  return {
    account: { address: SAFE },
    native,
    gas: { maxFeePerGas: 1_000_000n, opGasUnits: 5_100_000n },
    positions: [{ tokenId: 1n, liquidity: 10n }],
    balances: {},
    ...over,
  } as unknown as Observation
}

function setup(native: bigint, acc = account()) {
  const w = world(0n)
  w.chain.safeEth = native
  w.state.accounts.k = acc
  return { w, acc }
}

const refills = (w: ReturnType<typeof world>) => w.sent.filter((t) => t.to.toLowerCase() === SAFE.toLowerCase() && !t.data)

describe('reserveRefillWei (#262)', () => {
  test('up to the alert threshold plus the activation margin, nothing at or above the threshold', () => {
    expect(reserveRefillWei(297_285_472_318_240n, THRESHOLD, MARGIN)).toBe(THRESHOLD + MARGIN - 297_285_472_318_240n)
    expect(reserveRefillWei(THRESHOLD, THRESHOLD, MARGIN)).toBe(0n)
    expect(reserveRefillWei(THRESHOLD + 1n, THRESHOLD, MARGIN)).toBe(0n)
  })
})

describe('sponsorship of refills (#262)', () => {
  const now = Date.parse('2026-11-02T12:00:00Z')
  const at = new Date(now - 60_000).toISOString()
  test('a refill spends the daily activation budget', () => {
    const ceiling = DEFAULT_SPONSOR.activationWeiPerDay!
    const refill: SponsorEntry = { at, wei: (ceiling - 10n).toString(), kind: 'refill' }
    expect(activationRefusal(DEFAULT_SPONSOR, [refill], 10n, now)).toBeNull()
    expect(activationRefusal(DEFAULT_SPONSOR, [refill], 11n, now)).toMatchObject({ code: 'SPONSOR_DAILY_BUDGET' })
  })
  test('and never the owner transactions\' count or budget', () => {
    const many: SponsorEntry[] = Array.from({ length: 10 }, () => ({ at, wei: DEFAULT_SPONSOR.weiPerDay.toString(), kind: 'refill' }))
    expect(sponsorRefusal(DEFAULT_SPONSOR, many, many, 'transfer', 1n, now)).toBeNull()
  })
})

describe('Operator refillReserve (#262)', () => {
  test('a low Safe with money to manage gets ETH up to the threshold plus the margin, recorded as a refill', async () => {
    const native = 297_285_472_318_240n
    const { w, acc } = setup(native)
    await quiet(() => priv(w.op).refillReserve(acc, observation(native)))
    expect(refills(w)).toMatchObject([{ to: SAFE, value: THRESHOLD + MARGIN - native }])
    const entry = acc.sponsored!.find((e) => e.kind === 'refill')!
    // Settled at what it cost: the value plus the relayer's gas (200,000 at the world's 0.01 gwei).
    expect(BigInt(entry.wei)).toBe(THRESHOLD + MARGIN - native + 200_000n * 10_000_000n)
  })

  test('not low, stopped, or nothing left to manage: nothing is sent', async () => {
    for (const [native, acc, obs] of [
      [THRESHOLD, account(), observation(THRESHOLD)],
      [1n, account({ active: false }), observation(1n)],
      [1n, account(), observation(1n, { positions: [{ tokenId: 1n, liquidity: 0n }] as never, balances: { USDC: 999_999n } })],
    ] as const) {
      const { w } = setup(native, acc)
      await quiet(() => priv(w.op).refillReserve(acc, obs))
      expect(refills(w)).toEqual([])
    }
  })

  test('savings alone are money to manage', async () => {
    const { w, acc } = setup(1n)
    await quiet(() => priv(w.op).refillReserve(acc, observation(1n, { positions: [], balances: { USDC: 1_000_000n } })))
    expect(refills(w)).toHaveLength(1)
  })

  test('at most RESERVE_REFILLS_PER_DAY a day per account', async () => {
    const at = new Date(Date.now() - 60_000).toISOString()
    const done = Array.from({ length: RESERVE_REFILLS_PER_DAY }, (): SponsorEntry => ({ at, wei: '1', kind: 'refill' }))
    const { w, acc } = setup(1n, account({ sponsored: done }))
    await quiet(() => priv(w.op).refillReserve(acc, observation(1n)))
    expect(refills(w)).toEqual([])
  })

  test('the Safe is read again at send time: a deposit since the observation needs nothing', async () => {
    const { w, acc } = setup(THRESHOLD + 1n)
    await quiet(() => priv(w.op).refillReserve(acc, observation(1n)))
    expect(refills(w)).toEqual([])
    expect(acc.sponsored ?? []).toEqual([])
  })

  test('the daily activation budget used up: nothing is sent and nothing reserved', async () => {
    const other = account({ accountKey: 'o', sponsored: [{ at: new Date().toISOString(), wei: DEFAULT_SPONSOR.activationWeiPerDay!.toString(), kind: 'activation' }] })
    const { w, acc } = setup(1n)
    w.state.accounts.o = other
    await quiet(() => priv(w.op).refillReserve(acc, observation(1n)))
    expect(refills(w)).toEqual([])
    expect(acc.sponsored ?? []).toEqual([])
  })

  test('a relayer that fails before signing leaves no reservation', async () => {
    const { w, acc } = setup(1n)
    const relayer = (w.op as unknown as { relayer: { send: unknown } }).relayer
    relayer.send = async () => {
      throw new Error('insufficient funds for gas')
    }
    await quiet(() => priv(w.op).refillReserve(acc, observation(1n)))
    expect(acc.sponsored ?? []).toEqual([])
  })

  test('two reviews at once send one refill', async () => {
    const { w, acc } = setup(1n)
    await quiet(() => Promise.all([priv(w.op).refillReserve(acc, observation(1n)), priv(w.op).refillReserve(acc, observation(1n))]).then(() => undefined))
    expect(refills(w)).toHaveLength(1)
  })
})
