import { describe, expect, test } from 'bun:test'
import type { FundingView } from '@mamoru/domain'
import { totalScopeNote } from '../../src/web/components/money-map.tsx'
import { BRAIS_MONAD_SAFE, BRAIS_TOTAL, braisFunding, withFailedTransfer, withMonadOnlyPositions, withMonadPosition, withoutMoney, withPartialBase, withStaleMonad, withUnreadMonad, type BraisMoment } from '../../src/web/fixtures/money.ts'
import { moneyTotal, split, wholeMoney } from '../../src/web/lib/money.ts'
import { clockTime } from '../../src/web/lib/time.ts'
import { hasMoney } from '../../src/web/routes/add-money.tsx'
import { poolAddress } from '../../src/web/lib/positions.ts'
import { Balance, Idle, rangeHoldCopy, Working } from '../../src/web/routes/home.tsx'
import { render } from './render.ts'

// otto/mamoru#269: Home shows the whole money. Brais's 2.075638 USDC crossed Base to Monad by CCTP; Home showed 11.70
// for 15 minutes and, afterwards, left his Monad Safe out. In every moment the total is 13.78.

const NOW = Date.parse('2026-11-01T10:30:00.000Z')
const home = (f: FundingView) => render(<Balance s={split(f, null)} total={moneyTotal(f)} scopeNote={totalScopeNote(f, true)} onAdd={() => {}} onWithdraw={() => {}} />).text

describe('the total is the whole money in every moment of the crossing', () => {
  for (const moment of ['before', 'flight', 'minted'] as BraisMoment[]) {
    test(moment, () => {
      const f = braisFunding(moment, NOW)
      expect(moneyTotal(f)).toBe(BRAIS_TOTAL)
      const text = home(f)
      expect(text).toContain('13.78 USDC')
      expect(text).not.toContain('11.70')
      expect(text).not.toContain('Showing Base only')
    })
  }

  test('without the money map the Base balance would have said 11.70 (the incident)', () => {
    expect(split(braisFunding('flight', NOW), null).total).toBe(11_704_362n)
  })
})

// otto/mamoru#350 (Brais, 3 Nov): no "Where your money is" card; each Working row names its chain's Safe, largest first.
const rowsOf = (html: string) => html.split('data-testid="position"').slice(1)

describe('Working names each chain\'s Safe, largest position first', () => {
  test('a Base row links the Base Safe and a Monad row the Monad Safe', () => {
    const f = withMonadPosition(braisFunding('minted', NOW), '2000000')
    const { f: w, s } = wholeMoney(f)
    const { text, html } = render(<Working f={w} s={s} onStop={null} />)
    const [base, monad] = rowsOf(html)
    expect(base).toContain('href="https://basescan.org/address/0x7a3C5f0e8D21b94E6f0A1c2B3d4E5F60718293aB"')
    expect(monad).toContain(`href="https://monadscan.com/address/${BRAIS_MONAD_SAFE}"`)
    expect(monad).not.toContain('basescan.org/address/0x7a3C')
    expect(text).toContain('Base · Safe 0x7a3C')
    expect(text).toContain('Monad · Safe ')
    expect(text).not.toContain('Where your money is')
  })

  test('rows go from the largest USDC value to the smallest, whatever the API order', () => {
    const f = withMonadPosition(braisFunding('minted', NOW), '20000000')
    const { f: w, s } = wholeMoney(f)
    expect((w.positions[0] as { chainId?: number }).chainId).toBe(8453)
    const [first, second] = rowsOf(render(<Working f={w} s={s} onStop={null} />).html)
    expect(first).toContain('Monad')
    expect(second).toContain('Base')
  })

  test('two Safes on one chain (current and retired): each row links the Safe that holds it', () => {
    const f = withMonadPosition(braisFunding('minted', NOW), '2000000')
    const retired = '0x1111111111111111111111111111111111111111'
    const current = f.money!.chains.find((c) => c.chainId === 143)!
    f.money!.chains.push({ ...structuredClone(current), safe: retired, positions: [{ ...current.positions[0]!, tokenId: '9002', valueUsdc: '1000000' }] })
    const { f: w, s } = wholeMoney(f)
    const rows = rowsOf(render(<Working f={w} s={s} onStop={null} />).html)
    expect(rows.find((r) => r.includes('monadscan') && r.includes(BRAIS_MONAD_SAFE))).toBeDefined()
    expect(rows.filter((r) => r.includes(`monadscan.com/address/${retired}`)).length).toBe(1)
    expect(rows.filter((r) => r.includes(`monadscan.com/address/${BRAIS_MONAD_SAFE}`)).length).toBe(1)
  })

  test('an old operator without the money map links the home Safe', () => {
    const f = withoutMoney(braisFunding('minted', NOW))
    const html = render(<Working f={f} s={split(f, null)} onStop={null} />).html
    expect(html).toContain(`href="https://basescan.org/address/${f.address}"`)
  })
})

describe('a chain read that failed or never happened', () => {
  test('a stale chain keeps its last value in the total, and the balance says when it was read', () => {
    const f = withStaleMonad(braisFunding('minted', NOW), NOW)
    expect(f.money!.complete).toBe(true)
    expect(moneyTotal(f)).toBe(BRAIS_TOTAL)
    const text = home(f)
    expect(text).toContain('13.78 USDC')
    expect(text).toContain(`Monad could not be read just now. Showing its last value, read at ${clockTime(new Date(NOW - 6 * 60_000).toISOString())}.`)
    expect(home(braisFunding('minted', NOW))).not.toContain('could not be read')
  })

  test('a chain never read is not shown as 0: the balance says it is missing', () => {
    const f = withUnreadMonad(braisFunding('minted', NOW))
    expect(f.money!.complete).toBe(false)
    const balance = home(f)
    expect(balance).toContain('11.70 USDC')
    expect(balance).toContain('Monad could not be read yet, so it is not in this total.')
  })
})

describe('an operator without the money map', () => {
  test('the Base balance stands in and the balance says Base only', () => {
    const f = withoutMoney(braisFunding('minted', NOW))
    expect(f.money).toBeUndefined()
    expect(moneyTotal(f)).toBe(split(f, null).total)
    expect(home(f)).toContain('Showing Base only. Your other chains are not in this total yet.')
  })

  test('a Base-only account on an old operator gets no notice', () => {
    const f = { ...withoutMoney(braisFunding('before', NOW)), approval: null }
    expect(totalScopeNote(f, false)).toBeNull()
  })
})

describe('Working: shares are against the whole money', () => {
  test('the position is 10.60 of 13.78, with the transfer counted, not of 11.70', () => {
    const f: FundingView = { ...braisFunding('flight', NOW), approval: { validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v6' } }
    const { text } = render(<Working f={f} s={split(f, null)} onStop={null} />)
    // 10.60 / 13.78 = 77 %; against the Base balance alone it would read 91 %.
    expect(text).toContain('Share 77% target 50%')
    expect(text).not.toContain('Share 91%')
  })
})

// PR 1: `inFlight` holds exactly what the total counts there (sending, burned, and minted above the Monad read); a failed
// burn left nothing and is not in it. So the failed row is shown but never added.
const counted = (f: FundingView) => f.money!.inFlight.filter((t) => t.stage !== 'failed').reduce((a, t) => a + BigInt(t.amountUsdc), 0n)

describe('Working + Idle + in flight = Total balance', () => {
  const moments: [string, FundingView][] = [
    ['before', braisFunding('before', NOW)],
    ['flight', braisFunding('flight', NOW)],
    ['minted', braisFunding('minted', NOW)],
    ['minted on Monad, Monad read still before the mint', braisFunding('arriving', NOW)],
    ['before, a failed transfer beside it', withFailedTransfer(braisFunding('before', NOW), NOW)],
    ['minted, Monad stale', withStaleMonad(braisFunding('minted', NOW), NOW)],
  ]
  for (const [name, f] of moments) {
    test(name, () => {
      const { f: w, s } = wholeMoney(f)
      const flying = counted(f)
      expect(s.working + s.idle + flying).toBe(moneyTotal(f))
      expect(s.working + s.idle + flying).toBe(BRAIS_TOTAL)
      expect(w.positions.every((p) => (p as { chainId?: number }).chainId !== undefined)).toBe(true)
    })
  }

  test('minted: Idle is 3.18 with Base 1.10 and Monad 2.07; the position is tagged Base', () => {
    const f = braisFunding('minted', NOW)
    const { f: w, s } = wholeMoney(f)
    const idle = render(<Idle f={w} s={s} />).text
    expect(idle).toContain('3.18 USDC')
    expect(idle).toContain('Base 1.10 · Monad 2.07')
    expect(render(<Working f={w} s={s} onStop={null} />).text).toContain('Uniswap v3 · Base')
  })

  test('a position on Monad is listed under Working and tagged Monad', () => {
    const f = braisFunding('minted', NOW)
    const monad = f.money!.chains.find((c) => c.chainId === 143)!
    monad.positions = [{ tokenId: '9001', chainId: 143, pool: 'pool:WMON/USDC/3000', liquidity: '1', inRange: true, amountUsdc: '1000000', amountCbbtc: '0', valueUsdc: '2000000', amounts: [{ token: 'WMON', amount: '1000000000000000000', decimals: 18, valueUsdc: '1000000' }, { token: 'USDC', amount: '1000000', decimals: 6, valueUsdc: '1000000' }] }]
    monad.idle = []
    monad.totalUsdc = '2000000'
    const { f: w, s } = wholeMoney(f)
    expect(s.working).toBe(12_600_000n)
    const text = render(<Working f={w} s={s} onStop={null} />).text
    expect(text).toContain('Uniswap v3 · Monad')
    expect(text).toContain('Uniswap v3 · Base')
  })

  test('an old operator keeps its own view', () => {
    const f = withoutMoney(braisFunding('minted', NOW))
    const { f: w, s } = wholeMoney(f)
    expect(w).toBe(f)
    expect(s.total).toBe(split(f, null).total)
  })
})

describe('links are built here, never taken from the operator', () => {
  test('a hostile explorerUrl is ignored; a malformed Safe gets no link', () => {
    const f = braisFunding('flight', NOW)
    f.money!.chains[0]!.explorerUrl = 'https://evil.example/phish'
    const ok = render(<Working f={wholeMoney(f).f} s={wholeMoney(f).s} onStop={null} />).html
    expect(ok).not.toContain('evil.example')
    expect(ok).toContain('https://basescan.org/address/0x7a3C5f0e8D21b94E6f0A1c2B3d4E5F60718293aB')

    const bad = braisFunding('flight', NOW)
    bad.money!.chains[0]!.safe = 'javascript:alert(1)' as never
    bad.money!.chains[0]!.explorerUrl = 'https://evil.example/x'
    const html = render(<Working f={wholeMoney(bad).f} s={wholeMoney(bad).s} onStop={null} />).html
    expect(html).not.toContain('evil.example')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data-testid="position-safe"')
  })
})

describe('operator version skew and odd rows', () => {
  test('an unknown chain: raw label, no links, still in the totals, no wrong-chain links on its position', () => {
    const f = braisFunding('minted', NOW)
    const monad = f.money!.chains.find((c) => c.chainId === 143)!
    monad.chainId = 42161
    monad.positions = [{ tokenId: '9001', chainId: 42161, pool: 'pool:USDC/USDT/100', liquidity: '1', inRange: true, amountUsdc: '1000000', amountCbbtc: '0', valueUsdc: '2000000', amounts: [{ token: 'USDC', amount: '1000000', decimals: 6, valueUsdc: '1000000' }, { token: 'USDT', amount: '1000000', decimals: 6, valueUsdc: '1000000' }] }]
    monad.idle = [{ token: 'USDC', amount: '75638', decimals: 6, valueUsdc: '75638' }]
    monad.totalUsdc = '2075638'
    expect(moneyTotal(f)).toBe(BRAIS_TOTAL)
    const { f: w, s } = wholeMoney(f)
    expect(s.working + s.idle).toBe(BRAIS_TOTAL)
    const working = render(<Working f={w} s={s} onStop={null} />)
    expect(working.text).toContain('chain 42161')
    // Only Base's position links to its pool and its Safe; the unknown chain's gets neither (never Basescan for it).
    expect(working.html.match(/<a class="seg"/g)?.length).toBe(2)
    expect(working.html).not.toContain('monadscan')
    expect(rowsOf(working.html).find((r) => r.includes('chain 42161'))).not.toContain('<a ')
    expect(render(<Idle f={w} s={s} />).text).toContain('Base 1.10 · chain 42161 0.07')
  })

  test('minted but not yet read on Monad, or a failed transfer: counted once, never twice', () => {
    expect(moneyTotal(braisFunding('arriving', NOW))).toBe(BRAIS_TOTAL)
    expect(moneyTotal(withFailedTransfer(braisFunding('before', NOW), NOW))).toBe(BRAIS_TOTAL)
  })
})

describe('only one place per amount; positions only on Monad', () => {
  test('Monad idle shows once in the Idle breakdown, not in Working', () => {
    const f = braisFunding('minted', NOW)
    const { f: w, s } = wholeMoney(f)
    const idle = render(<Idle f={w} s={s} />).text
    const working = render(<Working f={w} s={s} onStop={null} />).text
    expect(idle.match(/Monad 2\.07/g)?.length).toBe(1)
    expect(working).not.toContain('2.07')
  })

  test('the only position is on Monad: Working lists it, Stop is offered, the invariant holds', () => {
    const f = withMonadOnlyPositions(NOW)
    expect(f.positions).toEqual([])
    const { f: w, s } = wholeMoney(f)
    expect(s.working).toBe(10_600_000n)
    expect(s.working + s.idle + counted(f)).toBe(BRAIS_TOTAL)
    const { text, html } = render(<Working f={w} s={s} onStop={() => {}} />)
    expect(text).toContain('Uniswap v3 · Monad')
    expect(text).toContain('Stop allocation')
    expect(html).toContain('https://monadscan.com/address/')
  })

  test('two positions with the same tokenId on two chains both render', () => {
    const f = braisFunding('minted', NOW)
    const monad = f.money!.chains.find((c) => c.chainId === 143)!
    monad.positions = [{ ...structuredClone(f.money!.chains[0]!.positions[0]!), chainId: 143, pool: 'pool:WMON/USDC/3000' }]
    const { f: w, s } = wholeMoney(f)
    expect(w.positions.length).toBe(2)
    expect(w.positions[0]!.tokenId).toBe(w.positions[1]!.tokenId)
    expect(render(<Working f={w} s={s} onStop={null} />).text).toContain('2 positions')
  })
})

describe('an unsure transfer (PR 1: a check failed, the total is still counted)', () => {
  test('the balance says the total is being confirmed', () => {
    const f = braisFunding('flight', NOW)
    f.money!.inFlight[0]!.unsure = true
    f.money!.complete = false
    expect(moneyTotal(f)).toBe(BRAIS_TOTAL)
    const text = home(f)
    expect(text).toContain('The total is being confirmed.')
    expect(text).not.toContain('could not be read')
  })

  test('incomplete for an unread chain still says unread, not confirming', () => {
    expect(totalScopeNote(withUnreadMonad(braisFunding('minted', NOW)), true)).toContain('could not be read yet')
  })
})

describe('review round 2', () => {
  const v6 = { validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v6' }

  test('P1-1: no share is set against a partial total (chain never read, or an unsure transfer)', () => {
    for (const f of [withUnreadMonad(braisFunding('minted', NOW)), (() => { const u = braisFunding('flight', NOW); u.money!.complete = false; u.money!.inFlight[0]!.unsure = true; return u })()]) {
      const g: FundingView = { ...f, approval: v6 }
      const text = render(<Working f={wholeMoney(g).f} s={wholeMoney(g).s} onStop={null} />).text
      expect(text).not.toContain('target 50%')
      expect(text).not.toContain('Share 91%')
    }
  })

  test('P1-2: a range hold on token 5101 applies to the home chain position, not to the same id on Monad', () => {
    const f = braisFunding('minted', NOW)
    const home = f.money!.chains[0]!
    home.positions[0]!.inRange = false
    const monad = f.money!.chains.find((c) => c.chainId === 143)!
    monad.positions = [{ ...structuredClone(home.positions[0]!), chainId: 143, pool: 'pool:WMON/USDC/3000' }]
    const g: FundingView = { ...f, engine: { placing: false, nextReviewAt: null, rangeHolds: [{ tokenId: '5101', code: 'DECIDE_RANGE_COOLDOWN' }] } }
    const { f: w, s } = wholeMoney(g)
    const html = render(<Working f={w} s={s} onStop={null} />).html
    const rows = html.split('data-testid="position"').slice(1)
    expect(rows.length).toBe(2)
    const cooldown = rangeHoldCopy('DECIDE_RANGE_COOLDOWN')
    expect(rows.filter((r) => r.includes(cooldown)).length).toBe(1)
    expect(rows[0]).toContain(cooldown)
  })

  test('P1-3: money present means the separate Monad read is never used (Working ignores it, the share is the map\'s)', () => {
    const f: FundingView = { ...braisFunding('flight', NOW), approval: v6 }
    const { f: w, s } = wholeMoney(f)
    expect(render(<Working f={w} s={s} otherChainsUsdc={999_000_000n} onStop={null} />).text).toContain('Share 77% target 50%')
  })

  test('P1-4: Start is funded by Base money only; Monad or in-flight money does not count', () => {
    const f = withMonadOnlyPositions(NOW)
    f.usdc = '0'
    f.idle = []
    expect(f.money!.totalUsdc).toBe(BRAIS_TOTAL.toString())
    expect(hasMoney(f)).toBe(false)
    expect(hasMoney(braisFunding('before', NOW))).toBe(true)
  })

  test('pools resolve per chain: a Base name has no address on Monad or on an unknown chain', () => {
    expect(poolAddress('pool:USDC/USDT/100', 8453)).toBe('0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1')
    expect(poolAddress('pool:USDC/USDT/100', 143)).toBeNull()
    expect(poolAddress('pool:USDC/USDT/100', 42161)).toBeNull()
  })

  test('idle reason is said of Base idle, never of money on another chain', () => {
    const f = withMonadOnlyPositions(NOW)
    const base = f.money!.chains[0]!
    base.idle = []
    base.totalUsdc = '0'
    const g: FundingView = { ...f, usdc: '0', idle: [] }
    const { f: w, s } = wholeMoney(g)
    const text = render(<Idle f={w} s={s} home={split(g, null)} />).text
    expect(text).not.toContain('waiting to be placed')
    expect(text).not.toContain('being placed')
    expect(text).toContain('2.07 USDC')
  })
})

describe('a partial chain read', () => {
  test('the balance says positions are missing and the total may be short', () => {
    const f = withPartialBase(braisFunding('before', NOW))
    expect(home(f)).toContain('Some positions on Base could not be listed, so the total may be short.')
    const g: FundingView = { ...f, approval: { validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v6' } }
    expect(render(<Working f={wholeMoney(g).f} s={wholeMoney(g).s} onStop={null} />).text).not.toContain('target 50%')
  })

  test('a stale chain whose positions are also partial: the balance says both', () => {
    const f = withPartialBase(withStaleMonad(braisFunding('minted', NOW), NOW))
    const note = totalScopeNote(f, true)!
    expect(note).toContain('Monad could not be read just now')
    expect(note).toContain('Some positions on Base could not be listed, so the total may be short.')
  })

  test('every gap is said on its own: unread, partial and an unsure transfer together', () => {
    const f = withPartialBase(withUnreadMonad(braisFunding('flight', NOW)))
    f.money!.inFlight[0]!.unsure = true
    const note = totalScopeNote(f, true)!
    expect(note).toContain('Monad could not be read yet, so it is not in this total.')
    expect(note).toContain('Some positions on Base could not be listed, so the total may be short.')
    expect(note).toContain('The total is being confirmed.')
    expect(note).not.toContain('could not be read just now')
  })

  test('an unread chain still wins the note over a partial one', () => {
    expect(totalScopeNote(withPartialBase(withUnreadMonad(braisFunding('minted', NOW))), true)).toContain('could not be read yet')
  })
})
