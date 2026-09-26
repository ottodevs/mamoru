import type { ScenarioTape, TapeFrame, TapeGate } from '@mamoru/domain'
import { useEffect, useState } from 'react'
import { Brand } from '../components/ui.tsx'
import { shortHex } from '../lib/format.ts'
import { TapeChart } from './chart.tsx'
import { currentKey, fmt, fmtDec, harvestMath, keyIndices, nextKey, prevKey, SPEEDS, stepDelay, type Speed } from './tape.ts'

export const labCopy = {
  title: 'Lab',
  empty: 'No recorded scenarios',
  emptyBody: 'Recorded fork runs appear here once a tape is committed.',
  funds: 'not your funds',
}

const VERDICT: Record<TapeGate['verdict'], string> = {
  GO: 'border-emerald! text-emerald!',
  NO_GO: 'border-alert! text-alert-ink!',
  EXIT: 'border-alert! text-alert-ink!',
  SKIP: '',
}

function Summary({ f, asset }: { f: TapeFrame; asset: string }) {
  const p = f.position
  const status = p === null ? { label: 'No position', cls: 'text-stone' } : p.inRange ? { label: 'In range', cls: 'text-emerald' } : { label: 'Out of range', cls: 'text-alert' }
  const cells: [string, string, string][] = [
    ['Pool', f.pool.name, ''],
    ['Status', status.label, status.cls],
    ['Fees', p ? `${fmtDec(p.feesValue)} ${asset}` : '—', ''],
    ['Principal', p ? `${fmtDec(p.principalValue)} ${asset}` : '—', ''],
  ]
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-5 gap-y-3 min-[761px]:grid-cols-4" data-testid="lab-summary">
      {cells.map(([k, v, cls]) => (
        <div key={k} className="min-w-0">
          <dt className="kicker">{k}</dt>
          <dd className={`m-0 mt-1 text-[1.05rem] tabular-nums ${cls}`} data-testid={`lab-${k.toLowerCase()}`}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Decision({ f, asset }: { f: TapeFrame; asset: string }) {
  const m = harvestMath(f)
  return (
    <section className="card" aria-label="Decision" data-testid="lab-decision">
      <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="code text-[0.85rem]!" data-testid="lab-code">
          {f.decision.code}
        </span>
        <span className="kicker">{f.decision.kind}</span>
      </p>
      <p className="mt-2 mb-0 text-[1.02rem] leading-[1.5]">{f.note}</p>
      {m ? (
        <p className="mt-2 mb-0 font-mono text-[0.8rem] tracking-[0.02em] text-stone" data-testid="lab-math">
          fees {fmt(m.fees)} <span className={m.sign === '>' ? 'text-emerald' : 'text-ink'}>{m.sign}</span> cost {fmt(m.opCost)} × {m.factor} = {fmt(m.line)} {asset}
        </p>
      ) : null}
      {f.decision.trail.length ? (
        <ul className="m-0 mt-3 flex list-none flex-wrap gap-[0.35rem] p-0" aria-label="Gate trail">
          {f.decision.trail.map((g, i) => (
            <li key={`${g.gate}-${i}`} className={`chip ${VERDICT[g.verdict]}`} title={g.reason}>
              {g.gate} · {g.verdict}
            </li>
          ))}
        </ul>
      ) : null}
      {f.tx ? (
        <p className="mt-3 mb-0 font-mono text-[0.78rem] text-stone" data-testid="lab-tx">
          {f.tx.label} · <span className={f.tx.ok ? 'text-ink' : 'text-alert-ink'}>{shortHex(f.tx.hash)}</span>
          {f.tx.ok ? '' : ' · reverted'}
        </p>
      ) : null}
    </section>
  )
}

function Transport(props: {
  frames: readonly TapeFrame[]
  at: number
  playing: boolean
  speed: Speed
  seek: (i: number) => void
  toggle: () => void
  setSpeed: (s: Speed) => void
}) {
  const { frames, at, playing, speed, seek, toggle, setSpeed } = props
  const last = frames.length - 1
  const chapter = currentKey(frames, at)
  const pct = (i: number) => (last > 0 ? (i / last) * 100 : 50)
  return (
    <section className="card grid gap-3" aria-label="Playback">
      <div className="flex flex-wrap items-center gap-[0.5rem]">
        <button type="button" className="chipbtn" onClick={() => seek(prevKey(frames, at))} aria-label="Previous keyframe">
          ◂ Key
        </button>
        <button type="button" className="act min-w-[5.5rem]" onClick={toggle} data-testid="lab-play">
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="chipbtn" onClick={() => seek(nextKey(frames, at))} aria-label="Next keyframe">
          Key ▸
        </button>
        <span className="ml-auto flex gap-1" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={`chipbtn ${s === speed ? 'bg-ink! text-rice!' : ''}`} aria-pressed={s === speed} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={at}
          onChange={(e) => seek(Number(e.currentTarget.value))}
          className="block w-full accent-[var(--color-emerald)]"
          aria-label="Frame"
          aria-valuetext={`Frame ${at + 1} of ${frames.length}`}
        />
        <div className="relative mx-[0.45rem] h-3" aria-hidden="true">
          {keyIndices(frames).map((k) => (
            <button
              key={k}
              type="button"
              tabIndex={-1}
              title={frames[k]?.title}
              onClick={() => seek(k)}
              className={`absolute top-0 h-3 w-[3px] -translate-x-1/2 cursor-pointer border-0 p-0 ${k <= at ? 'bg-emerald' : 'bg-wash'}`}
              style={{ left: `${pct(k)}%` }}
            />
          ))}
        </div>
      </div>
      <p className="m-0 flex flex-wrap justify-between gap-x-4 font-mono text-[0.72rem] tracking-[0.04em] text-stone">
        <span data-testid="lab-chapter">{chapter?.title ?? '—'}</span>
        <span>
          frame {at + 1}/{frames.length} · block {frames[at]?.block}
        </span>
      </p>
    </section>
  )
}

/** Replays one recorded fork run frame by frame. Space plays or pauses, arrows jump between keyframes. */
export function Lab({ tapes }: { tapes: readonly ScenarioTape[] }) {
  return (
    <main className="page">
      <title>Mamoru · Lab</title>
      <header className="mb-7">
        <Brand />
      </header>
      <LabBody tapes={tapes} />
    </main>
  )
}

export function LabBody({ tapes }: { tapes: readonly ScenarioTape[] }) {
  const [ti, setTi] = useState(0)
  const [at, setAt] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)
  const tape = tapes[ti]
  const frames = tape?.frames ?? []
  const last = frames.length - 1

  useEffect(() => {
    if (!playing) return
    if (at >= last) {
      setPlaying(false)
      return
    }
    const t = setTimeout(() => setAt((i) => Math.min(i + 1, last)), stepDelay(speed))
    return () => clearTimeout(t)
  }, [playing, at, last, speed])

  const toggle = () => {
    if (!playing && at >= last) setAt(0)
    setPlaying((p) => !p)
  }
  const seek = (i: number) => setAt(Math.max(0, Math.min(i, last)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest('select, textarea, input:not([type=range])')) return
      if (e.key === ' ') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        seek(nextKey(frames, at))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seek(prevKey(frames, at))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const f = frames[at]
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="m-0 text-[2rem] font-normal leading-none">{labCopy.title}</h1>
        {tape ? (
          <>
            <span className="chip" data-testid="lab-fork">
              {tape.forkOf} fork @ {tape.forkBlock} · {labCopy.funds}
            </span>
            <select
              className="field mono ml-auto w-auto! max-w-full py-[0.35rem]! text-[0.8rem]!"
              aria-label="Scenario"
              value={ti}
              onChange={(e) => {
                setTi(Number(e.currentTarget.value))
                setAt(0)
                setPlaying(false)
              }}
            >
              {tapes.map((t, i) => (
                <option key={t.id} value={i}>
                  {t.title}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
      {tape && f ? (
        <>
          <p className="mt-0 mb-5 text-[0.95rem] text-stone">{tape.summary}</p>
          <Summary f={f} asset={tape.savingsAsset} />
          <div className="mt-6">
            <TapeChart frames={frames} at={at} />
          </div>
          <Transport frames={frames} at={at} playing={playing} speed={speed} seek={seek} toggle={toggle} setSpeed={setSpeed} />
          <Decision f={f} asset={tape.savingsAsset} />
        </>
      ) : (
        <section className="card" data-testid="lab-empty">
          <p className="title heavy m-0">{labCopy.empty}</p>
          <p className="sub">{labCopy.emptyBody}</p>
        </section>
      )}
    </>
  )
}
