// app.mamoru.lol/stats (spec 013 amendment A1, design approved by Ot and Brais on 6 Nov): every Mamoru account added
// up, public, no session. Where the money is, what it earns, whether the return holds, then the accounts. A block whose
// figures the API did not send (incomplete, stale or backed by fewer than 3 accounts) is not drawn.
import type { StatsAprPoint, StatsSlice, StatsView } from '@mamoru/domain'
import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { useSession, useStats } from '../api/queries.ts'
import { AreaChart, dayLabel, DayChart, Donut } from '../components/charts.tsx'
import { MainTabs, TabBar } from '../components/nav.tsx'
import { Brand, InfoPopover } from '../components/ui.tsx'
import '../stats.css'

const usd = (v: number) => (Math.abs(v) >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const axisUsd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K` : v >= 1 || v === 0 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`)
const pct = (v: number, d = 1) => `${v.toFixed(d)}%`

export const statsCopy = {
  title: 'Stats',
  sub: 'Every Mamoru account, added up.',
  deposits: 'Total deposits',
  depositsTip: 'Value held in every Mamoru account, on every chain: positions, vaults, uncollected fees and money not placed yet.',
  working: 'Money working',
  workingTip: 'Share of all deposits placed in liquidity pools and lending vaults right now. The rest is idle: new deposits in progress, or waiting for pool depth or limits.',
  earned24h: 'Earned in the last 24h',
  earned24hTip: 'Fees and vault yield earned in the last 24 hours, every token valued in US dollars.',
  totalEarned: 'Total earned',
  totalEarnedTip: 'All fees and vault yield earned since launch, every token valued in US dollars.',
  apr7d: '7-day APR',
  apr7dTip: 'What the money working earned over the last 7 days, as a yearly rate, weighted by capital, before compounding.',
  depositsChartTip: "Value held in every account at each day's close, UTC.",
  perDay: 'Earned per day',
  perDayTip: 'Fees and vault yield earned each UTC day, in US dollars.',
  byAsset: 'By asset',
  byAssetTip: 'Exposure to each token: every pool position split into its two tokens at today’s amounts; vaults hold USDC.',
  byChain: 'By chain',
  byChainTip: 'Value held on each chain.',
  apr: 'APR over time',
  aprTip: 'Each dot is one day: what a dollar working earned that day, as a yearly rate. The line is the 7-day average, which shows whether a rate holds.',
  accounts: 'Total accounts',
  accountsTip: 'Accounts created in Mamoru.',
  average: 'Average account',
  averageTip: 'Average value of an account with funds.',
  largest: 'Largest account',
  largestTip: 'Value of the largest single account. No account is named.',
  signIn: 'Sign in',
  failed: 'Stats did not load.',
  retry: 'Try again',
  source: (at: string) =>
    `Read from Base and Monad at ${new Date(at).toISOString().slice(11, 16)} UTC, ${dayLabel(at.slice(0, 10))} ${at.slice(0, 4)}. Accounts are added up; any group of fewer than 3 accounts is shown inside a larger one.`,
}

function Lab({ children, tip }: { children: ReactNode; tip: string }) {
  return (
    <span className="sx-lab">
      {children}
      <InfoPopover label={`How "${String(children)}" is computed`}>{tip}</InfoPopover>
    </span>
  )
}

const PLACES = ['Stable vaults', 'Liquidity pools', 'Idle'] as const
const PLACE_COLOUR: Record<(typeof PLACES)[number], string> = { 'Stable vaults': '#2f5d50', 'Liquidity pools': '#7a9a8c', Idle: '#bdb39f' }

/** The API's places (stable vaults, stable and volatile pairs, idle) in the three the approved design shows. */
export function placesOf(slices: StatsSlice[]): { name: (typeof PLACES)[number]; usd: number; pct: number }[] {
  const sum = new Map<(typeof PLACES)[number], number>()
  for (const s of slices) {
    const k = s.key === 'Stable vaults' || s.key === 'Idle' ? s.key : 'Liquidity pools'
    sum.set(k, (sum.get(k) ?? 0) + s.usd)
  }
  const total = [...sum.values()].reduce((a, v) => a + v, 0) || 1
  return PLACES.filter((k) => sum.has(k)).map((k) => ({ name: k, usd: sum.get(k)!, pct: (sum.get(k)! / total) * 100 }))
}

function Hero({ v }: { v: StatsView }) {
  const dep = v.snapshots.totalDeposits
  const work = v.snapshots.moneyWorking
  const places = v.distributions.byPlace ? placesOf(v.distributions.byPlace) : null
  if (!dep) return null
  return (
    <section className="sx-hero" aria-labelledby="sx-dep">
      <div className="sx-hero-top">
        <div>
          <div id="sx-dep">
            <Lab tip={statsCopy.depositsTip}>{statsCopy.deposits}</Lab>
          </div>
          <div className="sx-big" data-testid="stats-deposits">
            {usd(dep.value)}
          </div>
        </div>
        {work && dep.value > 0 ? (
          <div className="sx-working">
            <Lab tip={statsCopy.workingTip}>{statsCopy.working}</Lab>
            <div className="sx-wv" data-testid="stats-working">
              {Math.round((work.value / dep.value) * 100)}%
            </div>
          </div>
        ) : null}
      </div>
      {places ? (
        <>
          <div className="sx-alloc" role="img" aria-label={places.map((p) => `${p.name} ${usd(p.usd)}, ${pct(p.pct, 0)}`).join('; ')}>
            {places.map((p, i) => (
              <span key={p.name} style={{ flex: p.usd, background: PLACE_COLOUR[p.name], animationDelay: `${i * 60}ms` }} title={`${p.name}: ${usd(p.usd)}`} />
            ))}
          </div>
          <ul className="sx-alloc-keys">
            {places.map((p) => (
              <li key={p.name}>
                <span className="sw" style={{ background: PLACE_COLOUR[p.name] }} />
                <span className="n">{p.name}</span>
                <span className="v">
                  {usd(p.usd)}
                  <small>{pct(p.pct, 0)}</small>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

function Figures({ items, label }: { items: { name: string; tip: string; value: string | null; id: string }[]; label: string }) {
  const shown = items.filter((x) => x.value !== null)
  if (!shown.length) return null
  return (
    <section className={`sx-figs n${shown.length}`} aria-label={label}>
      {shown.map((x) => (
        <div className="sx-fig" key={x.id}>
          <Lab tip={x.tip}>{x.name}</Lab>
          <div className="sx-val" data-testid={`stats-${x.id}`}>
            {x.value}
          </div>
        </div>
      ))}
    </section>
  )
}

function Block({ id, title, tip, side, children }: { id: string; title: string; tip: string; side?: ReactNode; children: ReactNode }) {
  return (
    <div className="sx-block" aria-labelledby={id}>
      <header className="sx-bh">
        <h2 id={id}>
          {title}
          <InfoPopover label={`About "${title}"`}>{tip}</InfoPopover>
        </h2>
        {side}
      </header>
      {children}
    </div>
  )
}

function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="sx-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} type="button" aria-pressed={o.v === value} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

type Chain = 'all' | 'base' | 'monad'

function AprBlock({ apr, asOf }: { apr: NonNullable<StatsView['series']['apr']>; asOf: string | null }) {
  const [chain, setChain] = useState<Chain>('all')
  const [range, setRange] = useState<number>(0)
  const chains: { v: Chain; label: string }[] = [{ v: 'all', label: 'All' }]
  if (apr.base?.length) chains.push({ v: 'base', label: 'Base' })
  if (apr.monad?.length) chains.push({ v: 'monad', label: 'Monad' })
  const all = (chain === 'all' ? apr.all : (apr[chain] ?? apr.all)) as StatsAprPoint[]
  const rows = range ? all.slice(-range) : all
  if (!apr.all.length) return null
  const today = asOf?.slice(0, 10)
  return (
    <section className="sx-apr">
      <Block
        id="sx-apr"
        title={statsCopy.apr}
        tip={statsCopy.aprTip}
        side={
          <div className="sx-ctl">
            {chains.length > 1 ? <Seg label="Chain" value={chain} options={chains} onChange={setChain} /> : null}
            <Seg
              label="Range"
              value={range}
              options={[
                { v: 7, label: '1W' },
                { v: 30, label: '1M' },
                { v: 0, label: 'All' },
              ]}
              onChange={setRange}
            />
          </div>
        }
      >
        <DayChart
          rows={rows}
          h={280}
          label="APR by day and its 7-day average"
          fmtAxis={(v) => `${Math.round(v)}%`}
          series={[
            { key: 'apr', kind: 'dots' },
            { key: 'apr7d', kind: 'line' },
          ]}
          tip={(r) => (
            <>
              {dayLabel(r.day)}
              {r.day === today ? ' (today so far)' : ''}
              {r.apr7d !== undefined ? (
                <b>
                  {pct(r.apr7d)} <span className="sx-tip-sub">7-day average</span>
                </b>
              ) : null}
              {pct(r.apr)} that day
            </>
          )}
        />
        <p className="sx-key">
          <span className="k-line" />
          7-day average <span className="k-dot" />
          daily
        </p>
      </Block>
    </section>
  )
}

export function StatsBody({ v }: { v: StatsView }) {
  const s = v.snapshots
  const d = v.distributions
  const series = v.series
  const chainCount = d.byChain?.length ?? 0
  const tvl = series.totalDeposits
  const perDay = series.earnedPerDay
  return (
    <>
      <Hero v={v} />
      <Figures
        label="Earnings"
        items={[
          { id: 'earned24h', name: statsCopy.earned24h, tip: statsCopy.earned24hTip, value: s.earned24h ? usd(s.earned24h.value) : null },
          { id: 'total-earned', name: statsCopy.totalEarned, tip: statsCopy.totalEarnedTip, value: s.totalEarned ? usd(s.totalEarned.value) : null },
          { id: 'apr7d', name: statsCopy.apr7d, tip: statsCopy.apr7dTip, value: s.apr7d ? pct(s.apr7d.value) : null },
        ]}
      />
      {tvl?.length || perDay?.length ? (
        <section className="sx-two">
          {tvl && tvl.length > 1 ? (
            <Block id="sx-tvl" title={statsCopy.deposits} tip={statsCopy.depositsChartTip}>
              <AreaChart rows={tvl.map((r) => ({ day: r.day, v: r.usd }))} h={220} axes label="Total deposits at each day's close, USD" fmtAxis={axisUsd} fmtTip={usd} />
            </Block>
          ) : null}
          {perDay?.length ? (
            <Block id="sx-epd" title={statsCopy.perDay} tip={statsCopy.perDayTip}>
              <DayChart
                rows={perDay}
                h={220}
                label="Earned per day, USD"
                fmtAxis={axisUsd}
                series={[{ key: 'usd', kind: 'bars' }]}
                tip={(r) => (
                  <>
                    <b>{usd(r.usd)}</b>
                    {dayLabel(r.day)}
                  </>
                )}
              />
            </Block>
          ) : null}
        </section>
      ) : null}
      {d.byToken?.length || d.byChain?.length ? (
        <section className="sx-two sx-holds">
          {d.byToken?.length ? (
            <Block id="sx-tok" title={statsCopy.byAsset} tip={statsCopy.byAssetTip}>
              <Donut
                rows={d.byToken.map((x) => ({ name: x.key, usd: x.usd, pct: x.pct }))}
                centre={s.inStablecoins ? { value: pct(s.inStablecoins.value, 0), label: 'in stablecoins' } : { value: String(d.byToken.length), label: 'assets' }}
                fmtUsd={usd}
              />
            </Block>
          ) : null}
          {d.byChain?.length ? (
            <Block id="sx-ch" title={statsCopy.byChain} tip={statsCopy.byChainTip}>
              <Donut rows={d.byChain.map((x) => ({ name: x.key, usd: x.usd, pct: x.pct }))} centre={{ value: s.totalDeposits ? usd(s.totalDeposits.value) : String(chainCount), label: `on ${chainCount} chain${chainCount === 1 ? '' : 's'}` }} fmtUsd={usd} />
            </Block>
          ) : null}
        </section>
      ) : null}
      {series.apr ? <AprBlock apr={series.apr} asOf={v.dataAsOf} /> : null}
      <Figures
        label="Accounts"
        items={[
          { id: 'accounts', name: statsCopy.accounts, tip: statsCopy.accountsTip, value: s.totalAccounts ? s.totalAccounts.value.toLocaleString('en-US') : null },
          { id: 'average', name: statsCopy.average, tip: statsCopy.averageTip, value: s.averageAccount ? usd(s.averageAccount.value) : null },
          { id: 'largest', name: statsCopy.largest, tip: statsCopy.largestTip, value: s.largestAccount ? usd(s.largestAccount.value) : null },
        ]}
      />
      {v.dataAsOf ? (
        <p className="sx-src">
          <span className="ok" />
          {statsCopy.source(v.dataAsOf)}
        </p>
      ) : null}
    </>
  )
}

export function StatsPage() {
  const stats = useStats()
  const session = useSession()
  return (
    <main className="page sx has-tab-bar">
      <title>Mamoru · Stats</title>
      <header className="sx-top">
        <Brand />
        <MainTabs />
        {session.isSuccess && !session.data?.accountKey ? (
          <Link to="/" search={{ signin: true }} className="sx-signin">
            {statsCopy.signIn}
          </Link>
        ) : null}
      </header>
      <section className="sx-head">
        <h1>{statsCopy.title}</h1>
        <p>{statsCopy.sub}</p>
      </section>
      {stats.data ? (
        <StatsBody v={stats.data} />
      ) : stats.isError ? (
        <p className="err">
          {statsCopy.failed}{' '}
          <button type="button" className="underline" onClick={() => void stats.refetch()}>
            {statsCopy.retry}
          </button>
        </p>
      ) : (
        <div className="card h-40 animate-pulse" aria-hidden="true" />
      )}
      <TabBar />
    </main>
  )
}
