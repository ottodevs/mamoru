// app.mamoru.lol/stats (spec 013 amendment A1, design approved by Ot and Brais on 6 Nov): every Mamoru account added
// up, public, no session. Where the money is, what it earns, whether the return holds, then the accounts. A block whose
// figures the API did not send (incomplete, stale or backed by fewer than 3 accounts) is not drawn.
import type { StatsSlice, StatsView } from '@mamoru/domain'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSession, useStats } from '../api/queries.ts'
import { AreaChart, CATS, dayLabel, DayChart } from '../components/charts.tsx'
import { MainTabs, TabBar } from '../components/nav.tsx'
import { Brand, InfoPopover } from '../components/ui.tsx'
import '../stats.css'

const usd = (v: number) => (Math.abs(v) >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const axisUsd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K` : v >= 1 || v === 0 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`)
const pct = (v: number, d = 1) => `${v.toFixed(d)}%`

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** A figure that eases from what it showed to the new value (0.6 s), so a fresh read shows as a change, not a jump. */
function Num({ value, fmt }: { value: number; fmt: (v: number) => string }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    if (start === value || reducedMotion()) {
      from.current = value
      setShown(value)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 600)
      const v = start + (value - start) * (1 - (1 - k) ** 3)
      from.current = v
      setShown(k < 1 ? v : value)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{fmt(shown)}</>
}

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

type Split = 'asset' | 'chain'

/** The split to draw, on every render: a refresh can withhold the one picked (By asset has stricter completeness
 * checks than By chain) without a remount, and then the bar shows the other instead of disappearing. */
export function resolveSplit(picked: Split, byToken?: StatsSlice[], byChain?: StatsSlice[]): Split {
  if (picked === 'asset') return byToken?.length ? 'asset' : 'chain'
  return byChain?.length ? 'chain' : 'asset'
}

/** The hero bar (Brais, 23 Nov, #455): the split by asset by default, or by chain, in one horizontal bar. */
function Alloc({ byToken, byChain }: { byToken?: StatsSlice[]; byChain?: StatsSlice[] }) {
  const [picked, setSplit] = useState<Split>('asset')
  const split = resolveSplit(picked, byToken, byChain)
  const options: { v: Split; label: string }[] = []
  if (byToken?.length) options.push({ v: 'asset', label: statsCopy.byAsset })
  if (byChain?.length) options.push({ v: 'chain', label: statsCopy.byChain })
  const rows = (split === 'asset' ? byToken : byChain) ?? []
  if (!rows.length) return null
  return (
    <div className="sx-alloc-wrap">
      <div className="sx-alloc-head">
        {options.length > 1 ? <Seg label="Split" value={split} options={options} onChange={setSplit} /> : <span className="sx-lab">{split === 'asset' ? statsCopy.byAsset : statsCopy.byChain}</span>}
        <InfoPopover label={`About "${split === 'asset' ? statsCopy.byAsset : statsCopy.byChain}"`}>{split === 'asset' ? statsCopy.byAssetTip : statsCopy.byChainTip}</InfoPopover>
      </div>
      <div className="sx-alloc" role="img" aria-label={rows.map((p) => `${p.key} ${usd(p.usd)}, ${pct(p.pct, 0)}`).join('; ')}>
        {rows.map((p, i) => (
          <span key={p.key} style={{ flex: p.usd, background: CATS[i % CATS.length], animationDelay: `${i * 60}ms` }} title={`${p.key}: ${usd(p.usd)}`} />
        ))}
      </div>
      <ul className="sx-alloc-keys" data-testid="stats-alloc">
        {rows.map((p, i) => (
          <li key={p.key}>
            <span className="sw" style={{ background: CATS[i % CATS.length] }} />
            <span className="n">{p.key}</span>
            <span className="v">
              {usd(p.usd)}
              <small>{pct(p.pct, 0)}</small>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Hero({ v }: { v: StatsView }) {
  const dep = v.snapshots.totalDeposits
  const work = v.snapshots.moneyWorking
  const d = v.distributions
  if (!dep) return null
  return (
    <section className="sx-hero" aria-labelledby="sx-dep">
      <div className="sx-hero-top">
        <div>
          <div id="sx-dep">
            <Lab tip={statsCopy.depositsTip}>{statsCopy.deposits}</Lab>
          </div>
          <div className="sx-big" data-testid="stats-deposits">
            <Num value={dep.value} fmt={usd} />
          </div>
        </div>
        {work && dep.value > 0 ? (
          <div className="sx-working">
            <Lab tip={statsCopy.workingTip}>{statsCopy.working}</Lab>
            <div className="sx-wv" data-testid="stats-working">
              <Num value={(work.value / dep.value) * 100} fmt={(v) => `${Math.round(v)}%`} />
            </div>
          </div>
        ) : null}
      </div>
      <Alloc byToken={d.byToken} byChain={d.byChain} />
    </section>
  )
}

function Figures({ items, label }: { items: { name: string; tip: string; value: ReactNode | null; id: string }[]; label: string }) {
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

function AprBlock({ apr, asOf }: { apr: NonNullable<StatsView['series']['apr']>; asOf: string | null }) {
  const [range, setRange] = useState<number>(0)
  const rows = range ? apr.all.slice(-range) : apr.all
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
  const series = v.series
  const tvl = series.totalDeposits
  const perDay = series.earnedPerDay
  return (
    <>
      <Hero v={v} />
      <Figures
        label="Earnings"
        items={[
          { id: 'earned24h', name: statsCopy.earned24h, tip: statsCopy.earned24hTip, value: s.earned24h ? <Num value={s.earned24h.value} fmt={usd} /> : null },
          { id: 'total-earned', name: statsCopy.totalEarned, tip: statsCopy.totalEarnedTip, value: s.totalEarned ? <Num value={s.totalEarned.value} fmt={usd} /> : null },
          { id: 'apr7d', name: statsCopy.apr7d, tip: statsCopy.apr7dTip, value: s.apr7d ? <Num value={s.apr7d.value} fmt={(v) => pct(v)} /> : null },
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
      {series.apr ? <AprBlock apr={series.apr} asOf={v.dataAsOf} /> : null}
      <Figures
        label="Accounts"
        items={[
          { id: 'accounts', name: statsCopy.accounts, tip: statsCopy.accountsTip, value: s.totalAccounts ? <Num value={s.totalAccounts.value} fmt={(v) => Math.round(v).toLocaleString('en-US')} /> : null },
          { id: 'average', name: statsCopy.average, tip: statsCopy.averageTip, value: s.averageAccount ? <Num value={s.averageAccount.value} fmt={usd} /> : null },
          { id: 'largest', name: statsCopy.largest, tip: statsCopy.largestTip, value: s.largestAccount ? <Num value={s.largestAccount.value} fmt={usd} /> : null },
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

/** First visit only (later visits show the last read at once): the page's own shape, so nothing jumps when it fills. */
function StatsSkeleton() {
  return (
    <div className="sx-skel" aria-busy="true" aria-label="Loading stats" data-testid="stats-skeleton">
      <section className="sx-hero">
        <div className="sx-hero-top">
          <div>
            <span className="sk sk-lab" />
            <span className="sk sk-big" />
          </div>
          <div className="sx-working">
            <span className="sk sk-lab" />
            <span className="sk sk-wv" />
          </div>
        </div>
        <span className="sk sk-bar" />
      </section>
      <section className="sx-figs">
        {[0, 1, 2].map((i) => (
          <div className="sx-fig" key={i}>
            <span className="sk sk-lab" />
            <span className="sk sk-val" />
          </div>
        ))}
      </section>
      <section className="sx-two">
        {[0, 1].map((i) => (
          <div className="sx-block" key={i}>
            <span className="sk sk-h2" />
            <span className="sk sk-chart" />
          </div>
        ))}
      </section>
    </div>
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
        <div className="sx-body">
          <StatsBody v={stats.data} />
        </div>
      ) : stats.isError ? (
        <p className="err">
          {statsCopy.failed}{' '}
          <button type="button" className="underline" onClick={() => void stats.refetch()}>
            {statsCopy.retry}
          </button>
        </p>
      ) : (
        <StatsSkeleton />
      )}
      <TabBar />
    </main>
  )
}
