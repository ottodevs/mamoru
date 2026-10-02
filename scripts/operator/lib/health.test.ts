import { describe, expect, test } from 'bun:test'
import { waitForHealth } from './health.ts'

describe('waitForHealth', () => {
  test('returns true as soon as /health answers 200 {ok:true}', async () => {
    const calls: string[] = []
    const get = async (url: string) => {
      calls.push(url)
      return { status: 200, json: async () => ({ ok: true }) }
    }
    expect(await waitForHealth('http://127.0.0.1:8787', 1_000, get, 10)).toBe(true)
    expect(calls).toEqual(['http://127.0.0.1:8787/health'])
  })

  test('strips a trailing slash from the base URL', async () => {
    const get = async (url: string) => ({ status: 200, json: async () => ({ url, ok: true }) })
    expect(await waitForHealth('http://127.0.0.1:8787/', 1_000, get, 10)).toBe(true)
  })

  test('retries through a connection refused, then succeeds once the unit is up', async () => {
    let attempt = 0
    const get = async () => {
      attempt++
      if (attempt < 3) throw new Error('connect ECONNREFUSED')
      return { status: 200, json: async () => ({ ok: true }) }
    }
    expect(await waitForHealth('http://127.0.0.1:8787', 1_000, get, 1)).toBe(true)
    expect(attempt).toBe(3)
  })

  test('gives up and returns false after the timeout if it never answers healthy', async () => {
    const get = async () => ({ status: 200, json: async () => ({ ok: false }) })
    expect(await waitForHealth('http://127.0.0.1:8787', 30, get, 10)).toBe(false)
  })
})
