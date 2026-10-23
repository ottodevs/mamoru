import { describe, expect, test } from 'bun:test'
import type { FundingView, OpView, SessionView, SleeveView } from '@mamoru/domain'
import { monadRegistry, address } from '@mamoru/registry'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiContext } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { SleeveSwitch } from '../../src/web/components/sleeves.tsx'
import { fixtureClient, fixtureConfig, fixtureFunding, fixtureSession } from '../../src/web/fixtures/client.ts'
import { FIXTURE_ACCOUNT_KEY, FIXTURE_ADDRESS } from '../../src/web/fixtures/empty-account.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { ChainProvider } from '../../src/web/lib/chain.tsx'
import { DepositDetails } from '../../src/web/routes/add-money.tsx'
import { History, Working } from '../../src/web/routes/home.tsx'
import { split } from '../../src/web/lib/money.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BasescanLink } from '../../src/web/components/ui.tsx'
import { render } from './render.ts'

// otto/mamoru#67: a Monad sleeve shows its chain, its positions, Monad links and Monad's USDC; Base is unchanged.

const MONAD_KEY = 'acct_monad_test'
const sleeves: SleeveView[] = [
  { accountKey: FIXTURE_ACCOUNT_KEY, chainId: 8453, chain: 'Base', address: FIXTURE_ADDRESS },
  { accountKey: MONAD_KEY, chainId: 143, chain: 'Monad', address: FIXTURE_ADDRESS },
]
const monadFunding: FundingView = {
  ...fixtureFunding,
  deployed: true,
  active: true,
  usdc: '420000',
  idle: [{ token: 'USDC', amount: '420000', decimals: 6, valueUsdc: '420000' }],
  positions: [
    {
      tokenId: '9001', pool: 'pool:WMON/USDC/3000', liquidity: '1', inRange: true, amountUsdc: '24050000', amountCbbtc: '0', valueUsdc: '48120000',
      amounts: [
        { token: 'WMON', amount: '682140000000000000000', decimals: 18, valueUsdc: '24070000' },
        { token: 'USDC', amount: '24050000', decimals: 6, valueUsdc: '24050000' },
      ],
    },
  ],
}
const ops: OpView[] = [{ opId: 'eng-m1-enter_mint', kind: 'enter', state: 'confirmed', pool: 'pool:WMON/USDC/3000', txHash: `0x${'5'.repeat(64)}`, updatedAt: '2026-10-23T06:00:00.000Z' }]

function client(session: SessionView) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(queryKeys.config, { ...fixtureConfig, fundsGate: 'live', dryRun: false })
  qc.setQueryData(queryKeys.session, session)
  qc.setQueryData(queryKeys.pools, poolsResponse)
  qc.setQueryData(queryKeys.funding(MONAD_KEY), monadFunding)
  qc.setQueryData(queryKeys.funding(FIXTURE_ACCOUNT_KEY), fixtureFunding)
  qc.setQueryData(queryKeys.ops(MONAD_KEY), { ops })
  return qc
}

const wrap = (el: React.ReactElement, session: SessionView = { ...fixtureSession, sleeves, addableChains: [] }) => (
  <ApiContext.Provider value={fixtureClient}>
    <QueryClientProvider client={client(session)}>{el}</QueryClientProvider>
  </ApiContext.Provider>
)

describe('Monad sleeve on Home', () => {
  test('positions in WMON/USDC, the pool and every tx on Monadscan, never Basescan', () => {
    const s = split(monadFunding, null)
    expect(s.total).toBe(48_540_000n)
    const { html, text } = render(
      wrap(
        <ChainProvider chainId={143}>
          <Working f={monadFunding} s={s} onStop={null} />
          <History ops={ops} />
        </ChainProvider>,
      ),
    )
    expect(text).toContain('WMON/USDC')
    expect(text).toContain('682.14 WMON')
    expect(text).toContain('Opened USDC/WMON position')
    expect(html).toContain(`https://monadscan.com/address/${address('pool:WMON/USDC/3000', monadRegistry)}`)
    expect(html).toContain(`https://monadscan.com/tx/0x${'5'.repeat(64)}`)
    expect(html).not.toContain('basescan.org')
  })

  test('the switch names each chain with its address and total, and offers what can be added', () => {
    const both = render(wrap(<SleeveSwitch sleeves={sleeves} addable={[]} selected={MONAD_KEY} onSelect={() => {}} />)).text
    expect(both).toContain('Base')
    expect(both).toContain('Monad 48.54 USDC')
    const offer = render(wrap(<SleeveSwitch sleeves={sleeves.slice(0, 1)} addable={[143]} selected={FIXTURE_ACCOUNT_KEY} onSelect={() => {}} />)).text
    expect(offer).toContain('Add a Monad sleeve')
    // Base alone with nothing to add (the flag off): nothing is drawn.
    expect(render(wrap(<SleeveSwitch sleeves={sleeves.slice(0, 1)} addable={[]} selected={FIXTURE_ACCOUNT_KEY} onSelect={() => {}} />)).html).toBe('')
  })
})

describe('deposit names the chain and its USDC contract', () => {
  test('Monad: the address on Monad, Monad USDC from the registry, no Base wording', () => {
    const { html, text } = render(wrap(<ChainProvider chainId={143}><DepositDetails address={FIXTURE_ADDRESS} /></ChainProvider>))
    expect(text).toContain('Your address on Monad')
    expect(text).toContain('Send USDC on Monad.')
    expect(text).toContain(`USDC on Monad ${address('USDC', monadRegistry)}`)
    expect(text).toContain("Only USDC on Monad. Any other token or network won't reach this Monad balance.")
    expect(text).not.toContain('Send USDC on Base')
    expect(html).toContain(`https://monadscan.com/address/${address('USDC', monadRegistry)}`)
  })

  // Review of PR #115 (P1 3): Base is compared with the markup origin/main rendered before this change, not with
  // itself. __golden__/*.html were rendered from origin/main's add-money.tsx and ui.tsx (2026-10-23) with these props;
  // deposit-base.html again with otto/mamoru#191's bordered Base-only notice (the one intended change).
  test('Base: the deposit and the explorer link are byte-identical to origin/main, inside or outside the provider', () => {
    const golden = (f: string) => readFileSync(join(import.meta.dir, '__golden__', f), 'utf8').trimEnd()
    const deposit = golden('deposit-base.html')
    expect(render(wrap(<DepositDetails address={FIXTURE_ADDRESS} capUsdc="100000000" />)).html).toBe(deposit)
    expect(render(wrap(<ChainProvider chainId={8453}><DepositDetails address={FIXTURE_ADDRESS} capUsdc="100000000" /></ChainProvider>)).html).toBe(deposit)
    expect(render(<BasescanLink tx={`0x${'5'.repeat(64)}`} />).html).toBe(golden('explorer-link-base.html'))
    expect(deposit).not.toContain('deposit-chain')
  })
})
