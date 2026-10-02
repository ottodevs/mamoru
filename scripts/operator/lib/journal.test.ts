import { describe, expect, test } from 'bun:test'
import { linesMatchingAny, REVIEW_ERROR_PATTERNS, tailForErrors, type JournalSource } from './journal.ts'

describe('linesMatchingAny', () => {
  test('matches the documented review-error shapes', () => {
    const lines = [
      '[operator] chain 8453 live=true policy conservador-live-v2 relayer 0xabc (1000 wei) on http://127.0.0.1:8787',
      '[engine 3f9a7c21] review error: RPC_HEAD_STALE',
      '[engine 9b0e41aa] observation failed RPC_HEAD_STALE',
      '[owner] own-1-exit tx 0x.. block 123 ok',
      '[owner] own-2-exit tx 0x.. block 124 FAILED',
    ]
    expect(linesMatchingAny(lines)).toEqual(['[engine 3f9a7c21] review error: RPC_HEAD_STALE', '[engine 9b0e41aa] observation failed RPC_HEAD_STALE'])
  })

  test('ignores ordinary startup/ops chatter', () => {
    const lines = ['[operator] chain 8453 live=true policy conservador-live-v2 relayer 0xabc (1000 wei) sha 5efba44 on http://127.0.0.1:8787', '[engine abc] loop started for 0xdef every 20000ms']
    expect(linesMatchingAny(lines)).toEqual([])
  })

  test('REVIEW_ERROR_PATTERNS is the documented default', () => {
    expect(REVIEW_ERROR_PATTERNS.length).toBeGreaterThan(0)
  })
})

/** A fake JournalSource that yields `lines` one at a time, then blocks forever unless `endsAfter` — simulating either a healthy `-f` follower (blocks) or one that dies partway through (EOF). */
function fakeSource(lines: string[], opts: { endsAfter?: boolean; exitCode?: number } = {}): JournalSource & { stopped: boolean } {
  let i = 0
  const src = {
    stopped: false,
    async read() {
      if (i < lines.length) return lines[i++]!
      if (opts.endsAfter) return null // the follower process ended on its own: unexpected
      return new Promise<string | null>(() => {}) // never resolves: tailForErrors must win the race via its own timeout
    },
    async exitCode() {
      return { code: opts.exitCode ?? 1, killedByUs: src.stopped && !opts.endsAfter }
    },
    stop() {
      src.stopped = true
    },
  }
  return src
}

describe('tailForErrors', () => {
  test('collects matching lines emitted within the window, reports failed, and always stops the source', async () => {
    const source = fakeSource(['hello', '[engine x] review error: boom', 'world'])
    const result = await tailForErrors(source, 0.2)
    expect(result.hits).toEqual(['[engine x] review error: boom'])
    expect(result.failed).toBe(true)
    expect(source.stopped).toBe(true)
  })

  test('reports not failed and stops the source when nothing matches within the window', async () => {
    const source = fakeSource(['all good', 'still good'])
    const result = await tailForErrors(source, 0.1)
    expect(result.hits).toEqual([])
    expect(result.failed).toBe(false)
    expect(source.stopped).toBe(true)
  })

  test('a premature EOF (journalctl ending on its own) is reported as failed, not as a clean window', async () => {
    const lines = ['one', 'two']
    let stopped = false
    let i = 0
    const source: JournalSource = {
      async read() {
        return i < lines.length ? lines[i++]! : null // ends after 2 lines, well before the 5s window
      },
      async exitCode() {
        return { code: 1, killedByUs: false }
      },
      stop() {
        stopped = true
      },
    }
    const result = await tailForErrors(source, 5)
    expect(result.failed).toBe(true)
    expect(result.reason).toMatch(/ended before/)
    expect(stopped).toBe(true)
  })

  test('a premature EOF with no matching lines is still failed (previously this looked identical to success)', async () => {
    const source = fakeSource(['all good', 'still good'], { endsAfter: true })
    const result = await tailForErrors(source, 5)
    expect(result.hits).toEqual([])
    expect(result.failed).toBe(true)
    expect(result.reason).toMatch(/ended before/)
  })

  test('stopping at the end of a clean window (we kill the follower ourselves) is not treated as a failure', async () => {
    const source = fakeSource(['all good'])
    const result = await tailForErrors(source, 0.05)
    expect(result.failed).toBe(false)
  })
})
