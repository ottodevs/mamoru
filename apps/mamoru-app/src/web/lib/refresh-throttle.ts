import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * #255: a refresh the owner asks for (pull down, tap the live mark) is a help, not a free loop. One is let through at
 * most every REFRESH_GAP_MS and at most REFRESH_BURST times in REFRESH_WINDOW_MS, and never while the page's last
 * reading is younger than REFRESH_FRESH_MS (nothing newer to fetch). A refused one costs no request: the page says it
 * is up to date instead. The regular polls are not counted; the Worker's per-account read limit backs this up for
 * anything that does not go through the page.
 */
export const REFRESH_GAP_MS = 10_000
export const REFRESH_FRESH_MS = 5_000
export const REFRESH_WINDOW_MS = 5 * 60_000
export const REFRESH_BURST = 6

export type RefreshVerdict = { ok: true } | { ok: false; reason: 'fresh' | 'cooldown' }

/** Pure: whether a manual refresh at `now` goes through, given when earlier ones did (`past`) and the last reading. */
export function refreshVerdict(now: number, past: readonly number[], lastReadAt: number): RefreshVerdict {
  if (lastReadAt && now - lastReadAt < REFRESH_FRESH_MS) return { ok: false, reason: 'fresh' }
  const last = past.length ? past[past.length - 1]! : 0
  if (last && now - last < REFRESH_GAP_MS) return { ok: false, reason: 'cooldown' }
  if (past.filter((t) => now - t < REFRESH_WINDOW_MS).length >= REFRESH_BURST) return { ok: false, reason: 'cooldown' }
  return { ok: true }
}

/** How long the "Up to date" note stays by the control that was refused. */
export const NOTE_MS = 1_800

/**
 * `run` refreshes through the throttle and resolves `true` when it read again, `false` when it was refused; `note` is
 * the short line to show by the live mark for NOTE_MS after a refusal (`{ note: false }`: the caller says it itself).
 */
export function useThrottledRefresh(refresh: () => Promise<unknown>, lastReadAt: number) {
  const past = useRef<number[]>([])
  const [note, setNote] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const run = useCallback(async ({ note = true }: { note?: boolean } = {}): Promise<boolean> => {
    const now = Date.now()
    const v = refreshVerdict(now, past.current, lastReadAt)
    if (!v.ok) {
      if (!note) return false
      setNote('Up to date')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setNote(null), NOTE_MS)
      return false
    }
    past.current = [...past.current.filter((t) => now - t < REFRESH_WINDOW_MS), now]
    setNote(null)
    await refresh().catch(() => undefined)
    return true
  }, [refresh, lastReadAt])
  return { run, note }
}
