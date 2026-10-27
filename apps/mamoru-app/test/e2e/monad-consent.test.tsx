import { describe, expect, test } from 'bun:test'
import { isMultichainTarget, MonadIntro, monadCopy, SplitTable, splitRows } from '../../src/web/components/monad-consent.tsx'
import { ApprovalRow, approvalTitle } from '../../src/web/routes/home.tsx'
import { render } from './render.ts'

// otto/mamoru#201, #216: an account on Base is asked once to let Mamoru also work on Monad, with the mix before and
// after taken from the two policies themselves.

const v6Upgrade = { validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v5', upgrade: true, upgradePolicy: 'conservador-live-v6' }

describe('the mix before and after (conservador-live-v5 to v6)', () => {
  test('every pool of either policy, its chain and its share; cbBTC closes, WMON/USDC on Monad opens', () => {
    expect(splitRows('conservador-live-v5', 'conservador-live-v6')).toEqual([
      { pool: 'USDC / USDT', chain: 'Base', fromBps: 5000, toBps: 5000 },
      { pool: 'USDC / WETH', chain: 'Base', fromBps: 1000, toBps: 3500 },
      { pool: 'USDC / WMON', chain: 'Monad', fromBps: null, toBps: 1500 },
      { pool: 'USDC / cbBTC', chain: 'Base', fromBps: 4000, toBps: 0 },
    ])
  })

  test('the same from v2, the policy most running accounts are on', () => {
    expect(splitRows('conservador-live-v2', 'conservador-live-v6').map((r) => [r.pool, r.fromBps, r.toBps])).toEqual([
      ['USDC / USDT', 5000, 5000],
      ['USDC / WETH', 1000, 3500],
      ['USDC / WMON', null, 1500],
      ['USDC / cbBTC', 4000, 0],
    ])
  })

  test('an unknown policy gives no rows rather than guessed ones', () => {
    expect(splitRows('conservador-live-v5', 'nope')).toEqual([])
  })

  test('only a policy with a share on another chain counts as the Monad move', () => {
    expect(isMultichainTarget('conservador-live-v6')).toBe(true)
    expect(isMultichainTarget('conservador-live-v5')).toBe(false)
    expect(isMultichainTarget(undefined)).toBe(false)
  })
})

describe('the dialog and the row', () => {
  test('the intro shows the mix, says nothing moves before approval, and asks to continue', () => {
    const { text } = render(<MonadIntro rows={splitRows('conservador-live-v5', 'conservador-live-v6')} onContinue={() => {}} onLater={() => {}} />)
    expect(text).toContain(monadCopy.lead)
    expect(text).toContain('USDC / WMON Monad — 15%')
    expect(text).toContain('USDC / cbBTC Base 40% closed')
    expect(text).toContain('Nothing moves until you approve')
    expect(text).toContain('Two signatures')
    expect(text).toContain(monadCopy.continue)
  })

  test('the table marks every row that changes', () => {
    const { html } = render(<SplitTable rows={splitRows('conservador-live-v5', 'conservador-live-v6')} />)
    expect(html.split('split-change').length - 1).toBe(3)
  })

  test('the row offers the Monad move in its own words, never "one tap, nothing is moved"', () => {
    expect(approvalTitle(v6Upgrade)).toContain('Monad')
    const { text } = render(<ApprovalRow approval={v6Upgrade} onOpen={() => {}} />)
    expect(text).toContain('Two taps with your passkey')
    expect(text).toContain('See what changes')
    expect(text).not.toContain('Nothing is moved')
  })

  test('a due renewal still reads as a renewal, even with the Monad move offered', () => {
    const due = { ...v6Upgrade, renewDue: true }
    expect(render(<ApprovalRow approval={due} onOpen={() => {}} />).text).toContain('Renew approval')
  })
})

describe('share against target (otto/mamoru#216)', () => {
  test("each position's bucket target comes from the account's policy, as a share of the whole account", async () => {
    const { poolTargets } = await import('../../src/web/lib/policies.ts')
    const v5 = poolTargets('conservador-live-v5')
    expect([v5.get('pool:USDC/USDT/100'), v5.get('pool:USDC/cbBTC/500'), v5.get('pool:WETH/USDC/3000')]).toEqual([50, 40, 10])
    const v6 = poolTargets('conservador-live-v6')
    expect([v6.get('pool:USDC/USDT/100'), v6.get('pool:WETH/USDC/3000'), v6.get('pool:WMON/USDC/3000'), v6.get('pool:USDC/cbBTC/500')]).toEqual([50, 35, 15, 0])
    expect(poolTargets('nope').size).toBe(0)
  })

  test('in the mix with Monad, WETH/USDC is Balance and WMON/USDC is Growth; other mixes keep their labels', async () => {
    const { bucketOf } = await import('../../src/web/lib/rates.ts')
    expect(bucketOf('pool:WETH/USDC/3000', undefined, 'conservador-live-v6')).toBe('Balanced')
    expect(bucketOf('pool:WMON/USDC/3000', undefined, 'conservador-live-v6')).toBe('Growth')
    expect(bucketOf('pool:USDC/USDT/100', undefined, 'conservador-live-v6')).toBe('Stable')
    expect(bucketOf('pool:WETH/USDC/3000', undefined, 'conservador-live-v5')).toBe('Growth')
    expect(bucketOf('pool:WETH/USDC/3000')).toBe('Growth')
  })
})
