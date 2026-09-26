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
