// Shared mockup charts (spec 013 A1): smooth area line, donut. Plain SVG, no library.
const NS = 'http://www.w3.org/2000/svg'
export const EMERALD = '#2f5d50'
export const CATS = ['#2f5d50', '#c08a3e', '#5b7a99'] // fixed order; validated vs the paper surface (labels carry identity)
let uid = 0

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, attrs[k])
  parent?.append(e)
  return e
}

export const usd = (v) => (v == null ? '—' : Math.abs(v) >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
export const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`)
export const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}
export function scale(vmax, n = 4) {
  // The first round step (1, 2, 2.5, 5 x 10^n) whose top sits within 30 % of the data, with 3 to 6 intervals.
  const v = vmax || 1
  const p = 10 ** Math.floor(Math.log10(v / n))
  const steps = [1, 2, 2.5, 5, 10, 20, 25, 50].map((m) => m * p)
  const step = steps.find((s) => { const k = Math.ceil(v / s); return k >= 3 && k <= 6 && (k * s) / v <= 1.3 }) ?? steps.find((s) => Math.ceil(v / s) <= 6)
  const top = Math.ceil(v / step) * step
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) }
}

// Monotone cubic (Fritsch–Carlson): smooth, never overshoots the data, so a flat stretch stays flat.
function monotone(pts) {
  const n = pts.length
  if (n < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : ''
  const dx = [], dy = [], m = []
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; dy[i] = (pts[i + 1][1] - pts[i][1]) / dx[i] }
  m[0] = dy[0]; m[n - 1] = dy[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = dy[i - 1] * dy[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / dy[i - 1] + (dx[i] + 2 * dx[i - 1]) / dy[i])
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += ` C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + m[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - m[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`
  }
  return d
}

/**
 * Area chart: smooth line, soft gradient fill, end-point marker, draw-in, hover/tap tooltip with value and date.
 * `axes: false` is the schematic form (Portfolio): no grid, no axis labels.
 */
export function area(host, rows, o) {
  host.innerHTML = ''
  host.classList.add('plot')
  const W = host.clientWidth, H = o.h
  const L = o.axes ? 46 : 6, R = o.axes ? 10 : 10, T = o.axes ? 12 : 14, B = o.axes ? 24 : 10
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label })
  const vals = rows.map((r) => r.v)
  const sc = scale(Math.max(...vals))
  const lo = o.axes ? 0 : Math.min(...vals) * 0.92
  const hi = o.axes ? sc.top : Math.max(...vals) * 1.04
  const x = (i) => L + ((W - L - R) * i) / Math.max(1, rows.length - 1)
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1))
  const id = `g${++uid}`
  const defs = el('defs', {}, svg)
  const g = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs)
  el('stop', { offset: '0%', 'stop-color': EMERALD, 'stop-opacity': o.axes ? 0.22 : 0.26 }, g)
  el('stop', { offset: '100%', 'stop-color': EMERALD, 'stop-opacity': 0 }, g)
  if (o.axes) {
    for (const t of sc.ticks) {
      el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? 'base' : 'grid' }, svg)
      el('text', { x: L - 8, y: y(t) + 3.5, 'text-anchor': 'end' }, svg).textContent = o.fmt(t)
    }
    const every = Math.max(1, Math.ceil(rows.length / (W < 500 ? 4 : 6)))
    rows.forEach((r, i) => { if (!((rows.length - 1 - i) % every)) el('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = dayLabel(r.d) })
  }
  const pts = rows.map((r, i) => [x(i), y(r.v)])
  const line = monotone(pts)
  el('path', { d: `${line} L${pts.at(-1)[0]},${y(lo)} L${pts[0][0]},${y(lo)} Z`, fill: `url(#${id})`, class: 'area-fill' }, svg)
  const path = el('path', { d: line, fill: 'none', stroke: EMERALD, 'stroke-width': o.axes ? 2 : 2.25, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'line-draw' }, svg)
  requestAnimationFrame(() => path.style.setProperty('--len', path.getTotalLength()))
  const end = pts.at(-1)
  el('circle', { cx: end[0], cy: end[1], r: 7, fill: EMERALD, opacity: 0.14, class: 'pulse' }, svg)
  el('circle', { cx: end[0], cy: end[1], r: 3.6, fill: '#f8f5ef', stroke: EMERALD, 'stroke-width': 2, class: 'end' }, svg)
  // hover
  const hair = el('line', { y1: T, y2: H - B, class: 'hair', opacity: 0 }, svg)
  const dot = el('circle', { r: 4.5, fill: EMERALD, stroke: '#f8f5ef', 'stroke-width': 2, opacity: 0 }, svg)
  const tip = document.createElement('div')
  tip.className = 'tip'
  host.append(svg, tip)
  const show = (i) => {
    const [px, py] = pts[i]
    hair.setAttribute('x1', px); hair.setAttribute('x2', px); hair.setAttribute('opacity', 1)
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('opacity', 1)
    tip.innerHTML = `<b>${o.fmtTip(rows[i].v)}</b>${o.when(rows[i])}`
    tip.classList.add('on')
    const tw = tip.offsetWidth, th = tip.offsetHeight
    tip.style.left = `${Math.min(Math.max(0, px - tw / 2), W - tw)}px`
    tip.style.top = `${Math.max(-th - 4, py - th - 14)}px`
  }
  const hide = () => { hair.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.classList.remove('on') }
  const nearest = (cx) => Math.max(0, Math.min(rows.length - 1, Math.round(((cx - L) / (W - L - R)) * (rows.length - 1))))
  const at = (e) => { const r = svg.getBoundingClientRect(); return nearest(((e.touches?.[0]?.clientX ?? e.clientX) - r.left) * (W / r.width)) }
  svg.addEventListener('pointermove', (e) => show(at(e)))
  svg.addEventListener('pointerdown', (e) => show(at(e)))
  svg.addEventListener('pointerleave', hide)
  if (o.showAt != null) setTimeout(() => { tip.style.transition = 'none'; show(o.showAt < 0 ? rows.length + o.showAt : o.showAt) }, 300)
}

/** Donut with 2 px gaps, centre label, legend with $ and %. */
export function donut(host, rows, o) {
  host.innerHTML = ''
  host.classList.add('donut')
  const total = rows.reduce((n, r) => n + r.usd, 0)
  const S = o.size ?? 168, r = S / 2 - 2, w = o.thick ?? 18, rr = r - w / 2
  const svg = el('svg', { viewBox: `0 0 ${S} ${S}`, width: S, height: S, role: 'img', 'aria-label': rows.map((x) => `${x.k} ${pct(x.usd / total)}`).join(', ') })
  const C = 2 * Math.PI * rr
  const gap = rows.length > 1 ? 2.5 : 0
  let acc = 0
  rows.forEach((x, i) => {
    const len = (x.usd / total) * C
    const seg = el('circle', { cx: S / 2, cy: S / 2, r: rr, fill: 'none', stroke: CATS[i % CATS.length], 'stroke-width': w, 'stroke-dasharray': `${Math.max(0.5, len - gap)} ${C}`, 'stroke-dashoffset': -acc, transform: `rotate(-90 ${S / 2} ${S / 2})`, class: 'seg-arc' }, svg)
    seg.style.animationDelay = `${i * 70}ms`
    acc += len
  })
  const c = document.createElement('div')
  c.className = 'centre'
  c.innerHTML = `<b>${o.centre.value}</b><span>${o.centre.label}</span>`
  const ring = document.createElement('div')
  ring.className = 'ring'
  ring.style.width = ring.style.height = `${S}px`
  ring.append(svg, c)
  const ul = document.createElement('ul')
  ul.className = 'legend'
  rows.forEach((x, i) => {
    const li = document.createElement('li')
    li.innerHTML = `<span class="sw" style="background:${CATS[i % CATS.length]}"></span><span class="n">${x.k}${x.note ? `<small>${x.note}</small>` : ''}</span><span class="p">${pct(x.usd / total, 1)}</span><span class="v">${usd(x.usd)}</span>`
    ul.append(li)
  })
  host.append(ring, ul)
}
