// Every time on screen is in the viewer's own time zone. Data stays ISO/UTC.
const hm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dm = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const dmy = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "Today 22:32", "Yesterday 09:05", "26 Sep, 22:32", "3 Jan 2025, 10:00". */
export function localTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const t = hm.format(d)
  if (sameDay(d, now)) return `Today ${t}`
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (sameDay(d, y)) return `Yesterday ${t}`
  return `${d.getFullYear() === now.getFullYear() ? dm.format(d) : dmy.format(d)}, ${t}`
}

/** "10:36" today; with the date ("2 Nov, 00:12") when `iso` is not on the same local day as `now`, so a window across midnight is not ambiguous. */
export function clockOrDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return sameDay(d, now) ? hm.format(d) : `${dm.format(d)}, ${hm.format(d)}`
}

/** "10:36": the clock time of an ISO instant in the viewer's time zone; empty for an unreadable one. */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : hm.format(d)
}
