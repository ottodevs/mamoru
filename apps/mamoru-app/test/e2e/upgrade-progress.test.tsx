import { describe, expect, test } from 'bun:test'
import type { OpView } from '@mamoru/domain'
import { UpgradeProgress } from '../../src/web/components/upgrade-progress.tsx'
import { braisToday } from '../../src/web/fixtures/money.ts'
import { braisUpgrade, type UpgradeMoment } from '../../src/web/fixtures/journey.ts'
import { DONE_FOR_MS, upgradeJourney } from '../../src/web/lib/upgrade-steps.ts'
import { count, render } from './render.ts'

// otto/mamoru#263: Brais's move to v6 on 1 Nov took ten steps over twenty minutes and Home showed none of them. The card
// says the current step in words, how far it got, and every step with its state, time and transactions.

const NOW = Date.parse('2026-11-01T10:45:00.000Z')
const journey = (m: UpgradeMoment) => {
  const { funding, ops } = braisUpgrade(m, NOW)
  return upgradeJourney(funding, ops, NOW)!
}
const states = (m: UpgradeMoment) => journey(m).steps.map((s) => `${s.id}:${s.state}`)

describe('the steps at each moment of the move', () => {
  test('signing: the approval is being confirmed, nothing else has started', () => {
    expect(states('signing')).toEqual(['approve:active', 'safe:pending', 'rebalance:pending', 'bridge:pending', 'arrive:pending', 'lp:pending'])
    expect(journey('signing').title).toBe('Confirming your approval on Base')
  })

  test('rebalancing: two approvals done, the Monad Safe ready, Base being adjusted', () => {
    const j = journey('rebalancing')
    expect(states('rebalancing')).toEqual(['approve:done', 'safe:done', 'rebalance:active', 'bridge:pending', 'arrive:pending', 'lp:pending'])
    expect(j.steps[0]!.detail).toBe('2 approvals')
    expect(j.title).toBe('Adjusting your Base positions')
  })

  test('bridging: sent, waiting for Circle to confirm, with the 13 to 19 minute window', () => {
    const j = journey('bridging')
    expect(states('bridging')).toEqual(['approve:done', 'safe:done', 'rebalance:done', 'bridge:done', 'arrive:active', 'lp:pending'])
    expect(j.current).toBe(4)
    expect(j.title).toBe('Waiting for Circle to confirm')
    expect(render(<UpgradeProgress upgrade={j} now={NOW} />).text).toContain('Usually 13 to 19 minutes.')
  })

  test('waiting: arrived on Monad, the USDC waits in the Monad Safe (the beta\'s state from 10:40)', () => {
    const j = journey('waiting')
    expect(states('waiting')).toEqual(['approve:done', 'safe:done', 'rebalance:done', 'bridge:done', 'arrive:done', 'lp:waiting'])
    expect(j.steps[5]!.detail).toBe('2.07 USDC is in your Monad Safe, waiting to be invested.')
    expect(j.title).toBe('Waiting to invest on Monad')
  })

  test('done: every step done, and it says so', () => {
    const j = journey('done')
    expect(j.done).toBe(true)
    expect(j.title).toBe('Your new mix is in place on Base and Monad')
  })
})

describe('times never say a later step finished first', () => {
  test('Base kept placing after the burn: the rebalance time is before the send, the later work has its own time', () => {
    const j = journey('done')
    const at = (id: string) => Date.parse(j.steps.find((s) => s.id === id)!.at!)
    expect(at('rebalance')).toBeLessThanOrEqual(at('bridge'))
    expect(at('bridge')).toBeLessThanOrEqual(at('arrive'))
    expect(j.steps.find((s) => s.id === 'rebalance')!.detail).toMatch(/^Base finished its part at .+, while the Monad share was on its way\.$/)
  })
})

describe('the card', () => {
  test('step n of 6, a bar, and one row per step; no reason code anywhere', () => {
    const { html, text } = render(<UpgradeProgress upgrade={journey('bridging')} now={NOW} />)
    expect(text).toContain('Step 5 of 6')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="4"')
    expect(count(html, 'data-testid="upgrade-step"')).toBe(6)
    expect(text).not.toMatch(/[A-Z]{3,}_[A-Z]/)
  })

  test('each transaction on its own chain\'s explorer, the Monad Safe on Monadscan', () => {
    const { html } = render(<UpgradeProgress upgrade={journey('done')} now={NOW} />)
    expect(html).toContain('https://basescan.org/tx/0xb94175f234bd3503f4d594977e7929914a6876231c39b5db9175c901f297ac8b')
    expect(html).toContain('https://basescan.org/tx/0x9d4b22ca017956d4e48bfad5973c52b9d4f275bbe2fb62f8ef9c4c3189df31dd')
    expect(html).toContain('https://monadscan.com/tx/0x51298f68e43b0f2425acaba4e9ff621cb6e8e1cf61e7518094d92180d2edfe72')
    expect(html).toContain('https://monadscan.com/address/0xD72A7cB9773Dc58a9B944f9737996F45dBD1F108')
    expect(html).not.toContain('basescan.org/tx/0x51298f68')
  })

  test('a failed approval says it needs another try, nothing moved', () => {
    const { funding, ops } = braisUpgrade('signing', NOW)
    const failed = ops.map((o) => (o.opId === 'own-14-renew' ? { ...o, state: 'failed' as const } : o))
    const j = upgradeJourney(funding, failed, NOW)!
    expect(j.steps[0]!.state).toBe('failed')
    expect(j.title).toBe('Your approval needs another try')
    expect(j.steps[0]!.detail).toBe('Needs another approval. Nothing has moved.')
  })
})

describe('when there is nothing to show', () => {
  test('no approval at all', () => {
    expect(upgradeJourney(braisToday(NOW), [], NOW)).toBeNull()
  })

  test('a routine renewal of an account already working on Monad', () => {
    const renew: OpView = { opId: 'own-20-renew', kind: 'renew', state: 'confirmed', txHash: `0x${'a'.repeat(64)}`, updatedAt: new Date(NOW - 5 * 60_000).toISOString() }
    expect(upgradeJourney(braisToday(NOW), [renew], NOW)).toBeNull()
  })

  test('a finished move, more than a day later', () => {
    const { funding, ops } = braisUpgrade('done', NOW)
    expect(upgradeJourney(funding, ops, NOW + DONE_FOR_MS + 60_000)).toBeNull()
  })

  test('a renewal of a Base-only policy', () => {
    const { funding, ops } = braisUpgrade('waiting', NOW)
    funding.approval = { validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v5' }
    expect(upgradeJourney(funding, ops, NOW)).toBeNull()
  })
})
