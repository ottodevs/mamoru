import { describe, expect, test } from 'bun:test'
import type { OpView } from '@mamoru/domain'
import { UpgradeProgress } from '../../src/web/components/upgrade-progress.tsx'
import { braisToday } from '../../src/web/fixtures/money.ts'
import { braisUpgrade, type UpgradeMoment } from '../../src/web/fixtures/journey.ts'
import { DONE_FOR_MS, PRE_SEND_MS, upgradeJourney } from '../../src/web/lib/upgrade-steps.ts'
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

describe('review r1', () => {
  const at = (min: number) => new Date(NOW + min * 60_000).toISOString()

  test('a failed approval retried and confirmed is done, not "Confirming" forever', () => {
    const { funding, ops } = braisUpgrade('waiting', NOW)
    const retried = [{ ...ops[0]!, opId: 'own-12-renew', state: 'failed' as const, txHash: undefined, updatedAt: new Date(Date.parse(ops[0]!.updatedAt) - 60_000).toISOString() }, ...ops]
    const j = upgradeJourney(funding, retried, NOW)!
    expect(j.steps[0]!.state).toBe('done')
    expect(j.steps[0]!.detail).toBe('2 approvals')
  })

  test('a failed send is said as failed, not pending with a green bar', () => {
    const { funding, ops } = braisUpgrade('bridging', NOW)
    funding.money!.inFlight = funding.money!.inFlight.map((x) => ({ ...x, stage: 'failed' as const }))
    const j = upgradeJourney(funding, ops.map((o) => (o.bridge ? { ...o, bridge: { ...o.bridge, state: 'failed' as const } } : o)), NOW)!
    const bridge = j.steps.find((s) => s.id === 'bridge')!
    expect(bridge.state).toBe('failed')
    expect(bridge.detail).toBe('The send did not go through. That money is still on Base.')
    expect(j.title).toBe('This step did not complete')
  })

  test('Monad money that predates the send is no arrival', () => {
    const { funding, ops } = braisUpgrade('rebalancing', NOW)
    funding.money!.chains.push({ chainId: 143, safe: funding.remote!.address, explorerUrl: '', read: { block: 1, at: at(0), stale: false }, idle: [{ token: 'USDC', amount: '500000', decimals: 6, valueUsdc: '500000' }], positions: [], gas: { symbol: 'MON', amount: '0' }, totalUsdc: '500000' })
    const j = upgradeJourney(funding, ops, NOW)!
    expect(j.steps.find((s) => s.id === 'arrive')!.state).toBe('pending')
    expect(j.steps.find((s) => s.id === 'lp')!.state).toBe('pending')
  })

  test('between two Base moves, before the send, rebalancing is still active', () => {
    const { funding, ops } = braisUpgrade('rebalancing', NOW)
    funding.progress = null
    const j = upgradeJourney(funding, ops.filter((o) => o.state === 'confirmed'), NOW)!
    expect(j.steps.find((s) => s.id === 'rebalance')!.state).toBe('active')
    expect(j.title).toBe('Adjusting your Base positions')
  })

  test('an op in a Monad pool is no Base move: not linked on Basescan, does not pull rebalance back', () => {
    const { funding, ops } = braisUpgrade('waiting', NOW)
    const monadOp: OpView = { opId: 'eng-9-1-a-enter_mint', kind: 'enter', step: 'enter_mint', state: 'submitted', pool: 'pool:WMON/USDC/3000', txHash: `0x${'9'.repeat(64)}`, updatedAt: at(-1) }
    const j = upgradeJourney(funding, [...ops, monadOp], NOW)!
    expect(j.steps.find((s) => s.id === 'rebalance')!.state).toBe('done')
    expect(render(<UpgradeProgress upgrade={j} now={NOW} />).html).not.toContain(`basescan.org/tx/0x${'9'.repeat(64)}`)
  })

  test('a renewal of an account that sent money to Monad before shows nothing, even with no Monad position now', () => {
    const { funding, ops } = braisUpgrade('waiting', NOW)
    const renew: OpView = { opId: 'own-30-renew', kind: 'renew', state: 'confirmed', txHash: `0x${'e'.repeat(64)}`, updatedAt: at(2 * 24 * 60) }
    expect(upgradeJourney(funding, [...ops, renew], NOW + 2 * DONE_FOR_MS + 10 * 60_000)).toBeNull()
  })

  test('a move stuck for more than a day stays on Home', () => {
    const { funding, ops } = braisUpgrade('waiting', NOW)
    expect(upgradeJourney(funding, ops, NOW + 3 * DONE_FOR_MS)).not.toBeNull()
  })
})

describe('review r2: the move has an end', () => {
  const later = (min: number) => new Date(NOW + min * 60_000).toISOString()
  const routine = (min: number, state: OpView['state'] = 'confirmed'): OpView => ({ opId: `eng-9-${min}-a-rerange`, kind: 'reduce', step: 'rerange', state, pool: 'pool:WETH/USDC/3000', ...(state === 'confirmed' ? { txHash: `0x${'7'.repeat(64)}` } : {}), updatedAt: later(min) })

  test('routine Base work after the move neither extends the done card nor joins its links', () => {
    const { funding, ops } = braisUpgrade('done', NOW)
    const daily = [routine(60 * 20), routine(60 * 44)]
    expect(upgradeJourney(funding, [...ops, ...daily], NOW + DONE_FOR_MS + 60_000)).toBeNull()
    const j = upgradeJourney(funding, [...ops, routine(60)], NOW + 2 * 60 * 60_000)!
    expect(j.done).toBe(true)
    expect(render(<UpgradeProgress upgrade={j} now={NOW} />).html).not.toContain(`0x${'7'.repeat(64)}`)
  })

  test('a routine op in progress after the move does not reopen it', () => {
    const { funding, ops } = braisUpgrade('done', NOW)
    funding.progress = { step: 'reranging', pool: 'pool:WETH/USDC/3000', since: later(120) }
    const j = upgradeJourney(funding, [...ops, routine(120, 'submitted')], NOW + 121 * 60_000)!
    expect(j.done).toBe(true)
  })

  test('a later top-up to Monad does not replace this move\'s transfer', () => {
    const { funding, ops } = braisUpgrade('done', NOW)
    const topUp: OpView = { opId: 'eng-9-9-a-bridge_out', kind: 'enter', step: 'bridge_out', state: 'confirmed', pool: 'pool:WMON/USDC/3000', bridge: { chainId: 143, amountUsdc: '500000', state: 'burned', burnTx: `0x${'8'.repeat(64)}`, burnedAt: later(300) }, txHash: `0x${'8'.repeat(64)}`, updatedAt: later(300) }
    const j = upgradeJourney(funding, [...ops, topUp], NOW + 301 * 60_000)!
    expect(j.done).toBe(true)
    expect(j.steps.find((x) => x.id === 'bridge')!.transfer!.burnTx).not.toBe(`0x${'8'.repeat(64)}`)
  })

  test('an approval on the mix with no send after it is no move once the send window has passed', () => {
    const { funding, ops } = braisUpgrade('rebalancing', NOW)
    funding.progress = null
    const approvalsOnly = ops.filter((o) => o.opId.startsWith('own-'))
    expect(upgradeJourney(funding, approvalsOnly, NOW)).not.toBeNull()
    expect(upgradeJourney(funding, approvalsOnly, NOW + PRE_SEND_MS + 60_000)).toBeNull()
  })
})

