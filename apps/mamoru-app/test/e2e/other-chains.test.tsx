import { describe, expect, test } from 'bun:test'
import type { FundingView, OtherChainsView } from '@mamoru/domain'
import { fundsElsewhere, OtherChainNotice, otherChainCopy } from '../../src/web/components/other-chain-notice.tsx'
import { fixtureFunding } from '../../src/web/fixtures/client.ts'
import { FIXTURE_ADDRESS } from '../../src/web/fixtures/empty-account.ts'
import { overCapOf, split } from '../../src/web/lib/money.ts'
import { addCopy, hasMoney } from '../../src/web/routes/add-money.tsx'
import { render } from './render.ts'

const at = '2026-10-07T10:00:00.000Z'
const view = (chains: OtherChainsView['chains']): OtherChainsView => ({ address: FIXTURE_ADDRESS, accountChainId: 8453, chains })
const onEthereum = view([{ chainId: 1, name: 'Ethereum', status: 'observed', block: 21_000_000, usdc: '150000000', eth: '0', observedAt: at }])

describe('wrong-network notice (#117)', () => {
  test('says the amount, that it is on Ethereum and not on Base, and that it is not in the balance', () => {
    const { text, html } = render(<OtherChainNotice view={onEthereum} />)
    expect(text).toContain('150.00 USDC at your address on Ethereum, not on Base')
    expect(text).toContain('not part of your Mamoru balance')
    expect(text).toContain('Mamoru has not moved it')
    expect(text).toContain('Do not send more on Ethereum')
    expect(text).toContain('Ethereum block 21000000')
    expect(html).toContain('data-chain-id="1"')
  })

  test('nothing is shown when nothing is there, when it was not observed, or before the answer', () => {
    const empty = view([{ chainId: 1, name: 'Ethereum', status: 'observed', block: 1, usdc: '0', eth: '0', observedAt: at }])
    const unknown = view([{ chainId: 1, name: 'Ethereum', status: 'not_observed', observedAt: at }])
    for (const v of [empty, unknown, view([]), undefined]) {
      expect(fundsElsewhere(v)).toEqual([])
      expect(render(<OtherChainNotice view={v} />).html).toBe('')
    }
  })

  test("a row on the account's own chain is never shown as money elsewhere", () => {
    const own = view([{ chainId: 8453, name: 'Base', status: 'observed', block: 1, usdc: '5000000', eth: '0', observedAt: at }])
    expect(fundsElsewhere(own)).toEqual([])
  })

  test('ETH alone is reported too, in ETH', () => {
    const eth = view([{ chainId: 1, name: 'Ethereum', status: 'observed', block: 1, usdc: '0', eth: '20000000000000000', observedAt: at }])
    expect(otherChainCopy.title(fundsElsewhere(eth)[0]!)).toBe('0.02 ETH at your address on Ethereum, not on Base')
  })

  test('money on Ethereum does not make the Base account funded, over the cap, or larger', () => {
    const base: FundingView = { ...fixtureFunding, usdc: '0' }
    expect(fundsElsewhere(onEthereum)).toHaveLength(1)
    expect(hasMoney(base)).toBe(false)
    expect(overCapOf(base)).toBeNull()
    expect(split(base, null).total).toBe(0n)
  })

  test('Add capital says that only Base arrives', () => {
    expect(addCopy.baseOnly).toContain('Only USDC sent on the Base network arrives')
  })
})
