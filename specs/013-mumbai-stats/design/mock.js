// Mockup charts for spec 013. Hand-written SVG, no library (plan: no chart lib in the app). Rules: design.md §4.
const NS = 'http://www.w3.org/2000/svg'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// `#static` in the URL turns motion off, for screenshots.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || location.hash.includes('static')

const day = (s) => new Date(s + 'T00:00:00Z')
const longDate = (s) => { const d = day(s); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }

// Money: cents under $100, whole dollars to $9,999, one decimal compact from $10K.
export function money(v) {
  if (v == null) return '—'
  const a = Math.abs(v)
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `$${(v / 1e3).toFixed(1)}K`
  if (a < 100) return `$${v.toFixed(2)}`
  return `$${Math.round(v).toLocaleString('en-US')}`
}
// Axis ticks: compact, no decimals unless needed.
function tickMoney(v) {
  if (v === 0) return '$0'
  if (v >= 1e6) return `$${+(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${+(v / 1e3).toFixed(1)}K`
  return `$${v}`
}
// 1-2-5 steps, y from 0.
function niceTicks(max, count) {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw)
  const ticks = []
  for (let t = 0; t <= max + step * 0.001; t += step) ticks.push(t)
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step)
  return ticks
}
// x ticks by span: ≤ 8 days daily, ≤ 45 days weekly (Mondays), else monthly.
function xTicks(points) {
  const n = points.length
  if (n <= 8) return points.map((p, i) => [i, `${DOW[day(p.d).getUTCDay()]} ${day(p.d).getUTCDate()}`])
  if (n <= 45) return points.map((p, i) => [i, p]).filter(([, p]) => day(p.d).getUTCDay() === 1).map(([i, p]) => [i, `${day(p.d).getUTCDate()} ${MONTHS[day(p.d).getUTCMonth()]}`])
  return points.map((p, i) => [i, p]).filter(([, p]) => day(p.d).getUTCDate() === 1).map(([i, p]) => [i, MONTHS[day(p.d).getUTCMonth()]])
}
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  if (parent) parent.appendChild(n)
  return n
}

export function chart(host, all, { kind = 'line', height = 260, label = '', animate = true } = {}) {
  const plot = host.querySelector('.plot')
  let points = all
  let svg, tip, idx = -1
  const narrow = () => plot.clientWidth < 520
  const render = (fade) => {
    plot.querySelectorAll('svg,.tip').forEach((n) => n.remove())
    const W = plot.clientWidth, H = height
    const m = { l: narrow() ? 40 : 48, r: 8, t: 10, b: 26 }
    const iw = W - m.l - m.r, ih = H - m.t - m.b
    const vals = points.map((p) => p.v).filter((v) => v != null)
    const ticks = niceTicks(Math.max(...vals, 0), narrow() ? 3 : 4)
    const yMax = ticks[ticks.length - 1]
    const n = points.length
    const band = iw / n
    const x = (i) => m.l + (kind === 'bar' ? band * i + band / 2 : n === 1 ? iw / 2 : (iw * i) / (n - 1))
    const y = (v) => m.t + ih - (v / yMax) * ih
    svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', tabindex: '0', 'aria-label': label }, plot)
    if (fade) svg.classList.add('fade-in')
    const defs = el('defs', {}, svg)
    const pat = el('pattern', { id: `h-${label.length}-${kind}`, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs)
    el('line', { x1: 0, y1: 0, x2: 0, y2: 4, stroke: '#8a8578', 'stroke-width': 1 }, pat)
    const grad = el('linearGradient', { id: `g-${label.length}`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs)
    el('stop', { offset: '0', 'stop-color': '#2f5d50', 'stop-opacity': '.14' }, grad)
    el('stop', { offset: '1', 'stop-color': '#2f5d50', 'stop-opacity': '0' }, grad)
    // grid + y ticks
    for (const t of ticks) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: t === 0 ? '#0f0f0e' : '#d9d2c3', 'stroke-width': t === 0 ? 1 : 1, 'shape-rendering': 'crispEdges' }, svg)
      const tx = el('text', { x: m.l - 8, y: y(t) + 3.5, 'text-anchor': 'end', 'font-family': 'IBM Plex Mono', 'font-size': 10.5, fill: '#5e5a52' }, svg)
      tx.textContent = tickMoney(t)
    }
    for (const [i, s] of xTicks(points)) {
      const tx = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono', 'font-size': 10.5, fill: '#5e5a52' }, svg)
      tx.textContent = s
    }
    // gaps: hatched band, never interpolated
    points.forEach((p, i) => {
      if (p.v != null) return
      const w = kind === 'bar' ? band : Math.max(iw / Math.max(n - 1, 1), 6)
      el('rect', { x: x(i) - w / 2, y: m.t, width: w, height: ih, fill: `url(#h-${label.length}-${kind})`, opacity: .5 }, svg)
    })
    if (kind === 'line') {
      // segments split at nulls
      const segs = []; let cur = []
      points.forEach((p, i) => { if (p.v == null) { if (cur.length) segs.push(cur); cur = [] } else cur.push(i) })
      if (cur.length) segs.push(cur)
      for (const s of segs) {
        const d = s.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(points[i].v).toFixed(1)}`).join('')
        if (s.length > 1) el('path', { d: `${d}L${x(s[s.length - 1])},${y(0)}L${x(s[0])},${y(0)}Z`, fill: `url(#g-${label.length})` }, svg)
        const path = el('path', { d, fill: 'none', stroke: '#2f5d50', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg)
        if (animate && !reduced && !fade) { const len = path.getTotalLength(); path.style.setProperty('--len', len); path.classList.add('line-draw') }
        if (s.length === 1) el('circle', { cx: x(s[0]), cy: y(points[s[0]].v), r: 3, fill: '#2f5d50' }, svg)
      }
      points.forEach((p, i) => { if (p.partial && p.v != null) el('circle', { cx: x(i), cy: y(p.v), r: 4.5, fill: '#f8f5ef', stroke: '#2f5d50', 'stroke-width': 2 }, svg) })
      if (points.some((p) => p.baseOnly) && !points.every((p) => p.baseOnly)) {
        const first = points.findIndex((p) => p.baseOnly), last = points.length - 1 - [...points].reverse().findIndex((p) => p.baseOnly)
        const x0 = first === 0 ? m.l : x(first), x1 = last === n - 1 ? W - m.r : x(last)
        el('line', { x1: x0, x2: x1, y1: m.t + ih + 3, y2: m.t + ih + 3, stroke: '#8a8578', 'stroke-width': 3, opacity: .55 }, svg)
      }
    } else {
      const bw = Math.max(Math.min(band - 2, 28), 2)
      points.forEach((p, i) => {
        if (p.v == null || p.v === 0) return
        const h = Math.max(ih - (y(p.v) - m.t), 1)
        const r = Math.min(2, bw / 2)
        const bx = x(i) - bw / 2, by = y(p.v)
        el('path', { d: `M${bx},${by + h}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + bw - r}Q${bx + bw},${by} ${bx + bw},${by + r}V${by + h}Z`, fill: p.partial ? 'none' : '#2f5d50', stroke: p.partial ? '#2f5d50' : 'none', 'stroke-width': p.partial ? 1.5 : 0, 'data-i': i, class: 'bar' }, svg)
      })
    }
    const cross = el('line', { y1: m.t, y2: m.t + ih, stroke: '#0f0f0e', 'stroke-width': 1, opacity: 0, 'pointer-events': 'none' }, svg)
    const dot = el('circle', { r: 4.5, fill: '#2f5d50', stroke: '#f8f5ef', 'stroke-width': 2, opacity: 0, 'pointer-events': 'none' }, svg)
    tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('aria-live', 'polite'); plot.appendChild(tip)
    const show = (i) => {
      idx = Math.max(0, Math.min(n - 1, i))
      const p = points[idx]
      cross.setAttribute('x1', x(idx)); cross.setAttribute('x2', x(idx)); cross.setAttribute('opacity', kind === 'line' ? .35 : 0)
      if (kind === 'line' && p.v != null) { dot.setAttribute('cx', x(idx)); dot.setAttribute('cy', y(p.v)); dot.setAttribute('opacity', 1) } else dot.setAttribute('opacity', 0)
      svg.querySelectorAll('.bar').forEach((b) => b.setAttribute('opacity', +b.dataset.i === idx || kind !== 'bar' ? 1 : .45))
      tip.replaceChildren()
      const b = document.createElement('b'); b.textContent = p.v == null ? (p.reason || 'Not counted') : money(p.v)
      const s = document.createElement('span'); s.textContent = `${longDate(p.d)}${p.partial ? ' · so far' : ''}${p.baseOnly ? ' · Base only' : ''}`
      tip.append(b, s)
      tip.classList.add('on')
      const tw = tip.offsetWidth
      let left = x(idx) + 12; if (left + tw > W) left = x(idx) - tw - 12
      tip.style.left = `${Math.max(0, left)}px`
      tip.style.top = `${(p.v != null && kind === 'line' ? y(p.v) : m.t + 8) - 10}px`
    }
    const hide = () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.classList.remove('on'); svg.querySelectorAll('.bar').forEach((b) => b.setAttribute('opacity', 1)) }
    const nearest = (cx) => kind === 'bar' ? Math.floor((cx - m.l) / band) : Math.round(((cx - m.l) / iw) * (n - 1))
    svg.addEventListener('pointermove', (e) => { const r = svg.getBoundingClientRect(); show(nearest((e.clientX - r.left) * (W / r.width))) })
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide() })
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show((idx < 0 ? n : idx) + (e.key === 'ArrowRight' ? 1 : -1)) }
      if (e.key === 'Escape') hide()
    })
    svg.addEventListener('blur', hide)
    host._show = show
  }
  render(false)
  host._range = (days) => { points = days ? all.slice(-days) : all; idx = -1; render(true) }
  new ResizeObserver(() => render(true)).observe(plot)
  return host
}

// One range control scopes every chart below it (dataviz: filters in one row above the charts).
export function rangeControl(seg, charts) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b))
    const days = +b.dataset.days || 0
    charts.forEach((c) => c._range(days))
  })
}

// Headline figures count up once, ≤ 600 ms; none under reduced motion.
export function countUp(root = document) {
  root.querySelectorAll('[data-count]').forEach((n) => {
    const target = +n.dataset.count
    if (reduced) { n.textContent = money(target); return }
    const t0 = performance.now()
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 600), e = 1 - (1 - k) ** 3
      n.textContent = money(target * e)
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
}

// Session state for the mockup: #signed-in shows the signed-in menu.
export function session() {
  const on = location.hash.includes('signed-in')
  document.documentElement.dataset.session = on ? 'in' : 'out'
  return on
}
