// Stats mockup (spec 013 amendment A1). Real aggregates from stats-data.js; nothing is invented.
import D from './stats-data.js'

const NS = 'http://www.w3.org/2000/svg'
const usd = (v) => (v == null ? '—' : v >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`)
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const PLACE = { 'Stable vaults': '#2f5d50', 'Liquidity pools': '#7a9a8c', Idle: '#bdb39f' }

// (i) element: the app's icon, opens on click, closes on Escape / outside click.
customElements.define('i-tip', class extends HTMLElement {
  connectedCallback() {
    if (this._ready) return
    this._ready = true
    const text = this.textContent.trim()
    this.textContent = ''
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('aria-label', 'How this is computed')
    b.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.3"/><path d="M8 7.3v4" stroke-linecap="round"/><circle cx="8" cy="4.6" r=".75" fill="currentColor" stroke="none"/></svg>'
    const p = document.createElement('span')
    p.className = 'panel'
    p.setAttribute('role', 'tooltip')
    p.textContent = text
    this.append(b, p)
    b.addEventListener('click', (e) => { e.stopPropagation(); this.toggleAttribute('open'); this.place() })
    b.addEventListener('mouseenter', () => { this.setAttribute('open', ''); this.place() })
    b.addEventListener('mouseleave', () => this.removeAttribute('open'))
    document.addEventListener('click', () => this.removeAttribute('open'))
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.removeAttribute('open'))
  }
  place() { this.classList.toggle('flip', this.getBoundingClientRect().left > innerWidth - 280) }
})

// Figures
const fig = { S1: usd(D.S1), S2: usd(D.S2), S3: usd(D.S3), S4: usd(D.S4), S5: usd(D.S5), S6: pct(D.S6), S7: D.S7.toLocaleString('en-US'), S8: usd(D.S8), S9: usd(D.S9), S10: pct(D.S10, 0) }
for (const el of document.querySelectorAll('[data-k]')) el.textContent = fig[el.dataset.k]

// Where the money is: one bar, three places
const alloc = document.getElementById('alloc')
const keys = document.getElementById('alloc-keys')
alloc.setAttribute('aria-label', D.byPlace.map((p) => `${p.k} ${usd(p.usd)}, ${pct(p.usd / D.S1, 0)}`).join('; '))
const ORDER = ['Stable vaults', 'Liquidity pools', 'Idle']
D.byPlace.sort((a, b) => ORDER.indexOf(a.k) - ORDER.indexOf(b.k)).forEach((p, i) => {
  const s = document.createElement('span')
  s.style.flex = String(p.usd)
  s.style.background = PLACE[p.k] ?? '#8a8578'
  s.style.animationDelay = `${i * 60}ms`
  s.title = `${p.k}: ${usd(p.usd)}`
  alloc.append(s)
  const li = document.createElement('li')
  li.innerHTML = `<span class="sw" style="background:${PLACE[p.k] ?? '#8a8578'}"></span><span class="n">${p.k}</span><span class="v">${usd(p.usd)}<small>${pct(p.usd / D.S1, 0)}</small></span>`
  keys.append(li)
})

// Distributions as ranked bars
function bars(id, rows, note = {}) {
  const ul = document.getElementById(id)
  const max = Math.max(...rows.map((r) => r.usd))
  rows.forEach((r, i) => {
    const li = document.createElement('li')
    li.innerHTML = `<span class="n">${r.k}${note[r.k] ? `<small>${note[r.k]}</small>` : ''}</span><span class="track"><span class="fill" style="width:${(r.usd / max) * 100}%;animation-delay:${i * 50}ms"></span></span><span class="v">${usd(r.usd)}<small>${pct(r.usd / D.S1)}</small></span>`
    ul.append(li)
  })
}
bars('tok', D.byToken, { Other: D.tokenOther.join(', ') })
bars('ch', D.byChain)

// Charts
function niceMax(v) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p
  return 10 * p
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}
// Ticks on round steps (1, 2, 2.5, 5 × 10^n); the axis top is the first step at or above the data.
function scale(vmax) {
  const step = niceStep((vmax || 1) / 4)
  const top = Math.ceil((vmax || 1) / step) * step
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) }
}

function plot(el, rows, o) {
  // o: { h, series: [{k, kind: 'line'|'dots'|'bars', main?}], fmt, tip(row) }
  el.innerHTML = ''
  const W = el.clientWidth, H = o.h, L = 44, R = 8, T = 10, B = 24
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('height', H)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', o.label)
  const vals = rows.flatMap((r) => o.series.map((s) => r[s.k])).filter((v) => v != null)
  const sc = scale(Math.max(...vals, 0))
  const ymax = sc.top
  const n = rows.length
  const band = (W - L - R) / n
  const x = (i) => L + band * i + band / 2
  const y = (v) => T + (H - T - B) * (1 - v / ymax)
  const add = (tag, attrs, parent = svg) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.append(e); return e }
  for (const t of sc.ticks) {
    add('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? 'base' : 'grid' })
    const tx = add('text', { x: L - 8, y: y(t) + 3.5, 'text-anchor': 'end' })
    tx.textContent = o.fmt(t, true)
  }
  const every = Math.max(1, Math.ceil(n / (W < 500 ? 4 : 7)))
  rows.forEach((r, i) => {
    if ((n - 1 - i) % every) return
    const tx = add('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' })
    tx.textContent = dayLabel(r.d)
  })
  for (const s of o.series) {
    if (s.kind === 'bars') {
      const bw = Math.max(3, Math.min(18, band * 0.62))
      rows.forEach((r, i) => {
        const v = r[s.k]
        if (v == null || v <= 0) return
        const h = Math.max(1, y(0) - y(v))
        add('path', { d: `M${x(i) - bw / 2},${y(0)} v${-(h - 2)} q0,-2 2,-2 h${bw - 4} q2,0 2,2 v${h - 2} z`, fill: '#2f5d50' })
      })
    } else if (s.kind === 'dots') {
      rows.forEach((r, i) => { if (r[s.k] != null) add('circle', { cx: x(i), cy: y(r[s.k]), r: 3, fill: '#8a8578' }) })
    } else {
      const pts = rows.map((r, i) => (r[s.k] == null ? null : [x(i), y(r[s.k])]))
      let d = '', pen = false
      for (const p of pts) { if (!p) { pen = false; continue } d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`; pen = true }
      const path = add('path', { d, fill: 'none', stroke: '#2f5d50', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'line-draw' })
      requestAnimationFrame(() => path.style.setProperty('--len', path.getTotalLength()))
    }
  }
  // hover: crosshair + tooltip, hit band per day
  const hair = add('line', { y1: T, y2: H - B, class: 'hair', opacity: 0 })
  const tip = document.createElement('div')
  tip.className = 'tip'
  el.append(svg, tip)
  rows.forEach((r, i) => {
    const hit = add('rect', { x: L + band * i, y: T, width: band, height: H - T - B, fill: 'transparent' })
    const show = () => {
      hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.setAttribute('opacity', 1)
      tip.innerHTML = o.tip(r)
      tip.classList.add('on')
      const tw = tip.offsetWidth
      tip.style.left = `${Math.min(Math.max(0, x(i) - tw / 2), W - tw)}px`
      tip.style.top = `${-8}px`
    }
    hit.addEventListener('mouseenter', show)
    hit.addEventListener('touchstart', show, { passive: true })
    hit.addEventListener('mouseleave', () => { hair.setAttribute('opacity', 0); tip.classList.remove('on') })
    if (o.showAt === i) setTimeout(show, 700)
  })
}

const state = { chain: 'all', range: 0 }
const fmtPct = (v) => `${Math.round(v * 100)}%`
const fmtUsd = (v, axis) => (axis ? (v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K` : v >= 1 || v === 0 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`) : usd(v))
const last = (rows) => (state.range ? rows.slice(-state.range) : rows)
const today = D.daily.at(-1).d
const asOf = new Date(D.readAt).toISOString().slice(11, 16)
const when = (r) => `${dayLabel(r.d)}${r.d === today ? `, until ${asOf} UTC` : ''}`
const showAt = location.hash.includes('tip') ? Math.floor(D.daily.length * 0.8) : null

function draw() {
  const k = state.chain
  const aprRows = last(D.daily.map((r) => ({ d: r.d, a: r[k === 'all' ? 'apr' : k], m: r[k === 'all' ? 'apr7' : `${k}7`] })))
  plot(document.getElementById('apr'), aprRows, {
    h: 280, label: 'APR by day and 7-day average', fmt: fmtPct, showAt: showAt == null ? null : Math.min(showAt, aprRows.length - 2),
    series: [{ k: 'a', kind: 'dots' }, { k: 'm', kind: 'line' }],
    tip: (r) => `${when(r)}<b>${pct(r.m)} <span style="font-size:.75rem;opacity:.7">7-day average</span></b>${pct(r.a)} that day`,
  })
  const rows = last(D.daily)
  plot(document.getElementById('epd'), rows, { h: 200, label: 'Earned per day, USD', fmt: fmtUsd, series: [{ k: 'earned', kind: 'bars' }], tip: (r) => `${when(r)}<b>${usd(r.earned)}</b>` })
  plot(document.getElementById('tvl'), rows, { h: 200, label: 'Total deposits at each day close, USD', fmt: fmtUsd, series: [{ k: 'tvl', kind: 'line' }], tip: (r) => `${when(r)}<b>${usd(r.tvl)}</b>` })
}
function seg(id, key, parse) {
  const g = document.getElementById(id)
  g.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    for (const x of g.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b))
    state[key] = parse(b.dataset.v)
    draw()
  })
}
seg('chain', 'chain', String)
seg('range', 'range', Number)
const q = new URLSearchParams(location.hash.slice(1))
if (q.get('chain')) document.querySelector(`#chain [data-v="${q.get('chain')}"]`)?.click()
draw()
addEventListener('resize', draw)

document.getElementById('src').innerHTML = `<span class="ok"></span>Read from Base and Monad at ${asOf} UTC, ${dayLabel(today)} 2026. Accounts are added up; any group of fewer than 3 accounts is shown inside a larger one.`
