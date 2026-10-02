import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyEngineError, classifyRpcError, cuFor, CU_TABLE, DEFAULT_CU, EngineHealthTracker, logErr, redactSecrets, RpcMetrics, safeMetrics, type EngineErrorClass } from '../src/metrics.ts'

const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-metrics-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Intercepts console.error for the duration of `fn`, returning each call joined as one line. */
function capture(fn: () => void): string[] {
  const lines: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => lines.push(args.join(' '))
  try {
    fn()
  } finally {
    console.error = orig
  }
  return lines
}

/** A revoked Proxy: every operation on it (property reads, `instanceof`, coercion) throws. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return proxy
}

describe('cuFor', () => {
  test('known methods use the static table', () => {
    expect(cuFor('eth_call')).toBe(26)
    expect(cuFor('eth_getLogs')).toBe(75)
    expect(cuFor('eth_sendRawTransaction')).toBe(250)
    expect(cuFor('eth_chainId')).toBe(0)
    expect(Object.keys(CU_TABLE).length).toBeGreaterThan(5)
  })

  test('unknown methods fall back to the default', () => {
    expect(cuFor('eth_subscribe')).toBe(DEFAULT_CU)
  })
})

describe('classifyRpcError', () => {
  test('invalid params takes priority over everything else', () => {
    expect(classifyRpcError(400, { code: -32602, message: 'rate limited but also invalid' })).toBe('invalidParams')
    expect(classifyRpcError(undefined, { message: 'invalid params for eth_call' })).toBe('invalidParams')
  })

  test('timeout is distinguished from rate/capacity even though both share the word "timeout"', () => {
    expect(classifyRpcError(undefined, { message: 'request timeout' })).toBe('timeout')
    expect(classifyRpcError(undefined, { message: 'the request was aborted' })).toBe('timeout')
  })

  test('rate/capacity refusals', () => {
    expect(classifyRpcError(429, undefined)).toBe('rateCapacity')
    expect(classifyRpcError(undefined, { code: -32005 })).toBe('rateCapacity')
    expect(classifyRpcError(undefined, { message: 'exceeded compute units per second' })).toBe('rateCapacity')
  })

  test('anything else is other', () => {
    expect(classifyRpcError(500, { message: 'internal server error' })).toBe('other')
  })

  describe('totality: never throws for any err/err.message shape', () => {
    const ODD_ERRS: unknown[] = [
      undefined,
      null,
      {},
      { message: undefined },
      { message: null },
      { message: 42 },
      { message: Object.create(null) },
      {
        message: {
          toString: () => {
            throw new Error('toString boom')
          },
        },
      },
      {
        message: {
          [Symbol.toPrimitive]: () => {
            throw new Error('toPrimitive boom')
          },
        },
      },
      { message: revokedProxy() },
      revokedProxy() as { code?: number; message?: unknown },
    ]

    test('every odd err (with and without a status) classifies without throwing', () => {
      for (const err of ODD_ERRS) {
        for (const status of [undefined, 429, 500]) {
          expect(() => classifyRpcError(status, err as { code?: number; message?: unknown } | null | undefined)).not.toThrow()
        }
      }
    })
  })
})

describe('RpcMetrics', () => {
  test('counts requests, errors and fallbacks per provider and method', () => {
    const m = new RpcMetrics(tmpDir())
    m.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_call', false)
    m.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_call', false)
    m.recordError('base-mainnet.g.alchemy.com#1', 'eth_call', 'rateCapacity')
    m.recordFallback('base-mainnet.g.alchemy.com#1', 'eth_call')
    const snap = m.snapshot()
    const c = snap.cumulative['base-mainnet.g.alchemy.com#1']!.eth_call!
    expect(c.requests).toBe(2)
    expect(c.errors.rateCapacity).toBe(1)
    expect(c.errors.invalidParams).toBe(0)
    expect(c.fallbacks).toBe(1)
  })

  test('estimates Alchemy compute units from the static table, never for non-Alchemy providers', () => {
    const m = new RpcMetrics(tmpDir())
    m.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_getLogs', false)
    m.recordRequest('base-rpc.publicnode.com', 'eth_getLogs', false)
    const snap = m.snapshot()
    expect(snap.cumulative['base-mainnet.g.alchemy.com#1']!.eth_getLogs!.cuEstimate).toBe(75)
    expect(snap.cumulative['base-rpc.publicnode.com']!.eth_getLogs!.cuEstimate).toBe(0)
    expect(snap.cuEstimateTotal).toBe(75)
  })

  test('getLogs chunk calls are counted separately from plain requests', () => {
    const m = new RpcMetrics(tmpDir())
    m.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_getLogs', true)
    m.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_getLogs', true)
    m.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_getLogs', false)
    const c = m.snapshot().cumulative['base-mainnet.g.alchemy.com#1']!.eth_getLogs!
    expect(c.requests).toBe(3)
    expect(c.getLogsChunks).toBe(2)
  })

  test('the 48h ring buckets by hour and only keeps the last 48 hours', () => {
    const m = new RpcMetrics(tmpDir())
    const hour = 3_600_000
    const base = Date.parse('2026-10-01T00:00:00.000Z')
    m.recordRequest('host', 'eth_call', false, base) // hour 0
    m.recordRequest('host', 'eth_call', false, base + hour) // hour 1
    // 100h later: hours 0 and 1 are both well outside a 48h window and must be pruned.
    m.recordRequest('host', 'eth_call', false, base + 100 * hour)
    const snap = m.snapshot(base + 100 * hour)
    const hourStarts = snap.last48h.map((e) => e.hourStart)
    expect(hourStarts).not.toContain(new Date(base).toISOString())
    expect(hourStarts).not.toContain(new Date(base + hour).toISOString())
    expect(hourStarts).toContain(new Date(base + 100 * hour).toISOString())
    expect(hourStarts.length).toBe(1)
    // Cumulative is never pruned: it keeps every request ever recorded.
    expect(snap.cumulative.host!.eth_call!.requests).toBe(3)
  })

  test('persists atomically and reloads on construction (a restart does not lose history)', () => {
    const dir = tmpDir()
    const m1 = new RpcMetrics(dir)
    m1.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_call', false)
    m1.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_call', false)
    m1.recordError('base-mainnet.g.alchemy.com#1', 'eth_call', 'timeout')
    m1.persist()

    const raw = JSON.parse(readFileSync(join(dir, 'rpc-usage.json'), 'utf8'))
    expect(raw.cumulative['base-mainnet.g.alchemy.com#1'].eth_call.requests).toBe(2)

    const m2 = new RpcMetrics(dir)
    const snap = m2.snapshot()
    expect(snap.cumulative['base-mainnet.g.alchemy.com#1']!.eth_call!.requests).toBe(2)
    expect(snap.cumulative['base-mainnet.g.alchemy.com#1']!.eth_call!.errors.timeout).toBe(1)

    // A further record on the reloaded instance accumulates on top of what was loaded.
    m2.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_call', false)
    expect(m2.snapshot().cumulative['base-mainnet.g.alchemy.com#1']!.eth_call!.requests).toBe(3)
  })

  test('two providers sharing a host still produce distinct, parseable entries when labelled #1/#2 by the caller', () => {
    const m = new RpcMetrics(tmpDir())
    m.recordRequest('alchemy.example.com#1', 'eth_call', false)
    m.recordRequest('alchemy.example.com#2', 'eth_call', false)
    const snap = m.snapshot()
    expect(snap.cumulative['alchemy.example.com#1']!.eth_call!.requests).toBe(1)
    expect(snap.cumulative['alchemy.example.com#2']!.eth_call!.requests).toBe(1)
  })
})

describe('classifyEngineError', () => {
  test('OBS_RPC_UNAVAILABLE is rpc_other', () => {
    expect(classifyEngineError('OBS_RPC_UNAVAILABLE')).toBe('rpc_other')
  })

  test('a thrown REVIEW_ERROR with an RPC-shaped message is classified precisely', () => {
    expect(classifyEngineError('REVIEW_ERROR', 'exceeded compute units per second')).toBe('rpc_rate_limit')
    expect(classifyEngineError('REVIEW_ERROR', 'invalid params for eth_call')).toBe('rpc_invalid_params')
    expect(classifyEngineError('REVIEW_ERROR', 'request timeout')).toBe('rpc_timeout')
  })

  test('a thrown REVIEW_ERROR with an unrecognized message is internal, not a misleading rpc_other', () => {
    expect(classifyEngineError('REVIEW_ERROR', 'Cannot read properties of undefined')).toBe('internal')
  })

  test('bundler/simulation/observation code families', () => {
    expect(classifyEngineError('BUNDLER_REJECTED')).toBe('bundler_rejected')
    expect(classifyEngineError('BUNDLER_UNAVAILABLE')).toBe('bundler_rejected')
    expect(classifyEngineError('EHG_SIM_REVERT')).toBe('simulation_reverted')
    expect(classifyEngineError('EXEC_INNER_REVERT')).toBe('simulation_reverted')
    expect(classifyEngineError('CHAIN_REVERTED_EXECUTION')).toBe('simulation_reverted')
    expect(classifyEngineError('OBS_BLOCK_INCONSISTENT')).toBe('observation_inconsistent')
    expect(classifyEngineError('RECON_REORGED')).toBe('observation_inconsistent')
  })

  test('null or an unrecognized code is internal', () => {
    expect(classifyEngineError(null)).toBe('internal')
    expect(classifyEngineError('SOMETHING_NEW_AND_UNMAPPED')).toBe('internal')
  })

  describe('totality: never throws, always returns one of the 8 classes, for any input shape', () => {
    const VALID: EngineErrorClass[] = ['rpc_rate_limit', 'rpc_invalid_params', 'rpc_timeout', 'rpc_other', 'bundler_rejected', 'simulation_reverted', 'observation_inconsistent', 'internal']

    // Every input a well-typed caller could never produce, but a replayed state file, a dynamic
    // caller, or a future bug might: non-string codes (numbers, booleans, arrays, plain objects,
    // functions, a Symbol), and non-Error/non-string details (null, undefined, an object with no
    // `message`, a circular-free object, a number, a Symbol).
    const ODD_CODES: unknown[] = [undefined, 0, 1, -1, NaN, Infinity, true, false, '', [], ['BUNDLER_REJECTED'], {}, { code: 'BUNDLER_REJECTED' }, () => 'BUNDLER_REJECTED', Symbol('code'), new Date(), new Map(), /regex/]
    // `detail` becomes `err.message` inside `classifyRpcError` (via the REVIEW_ERROR branch), so it is
    // exactly the set of values a naive `String(x)` coercion can choke on: a null-prototype object has
    // no inherited `toString`/`valueOf` at all, an object can define a `toString`/`Symbol.toPrimitive`
    // that throws on purpose, and every operation on a revoked Proxy throws, including `instanceof`.
    const nullProtoDetail: unknown = Object.create(null)
    ;(nullProtoDetail as Record<string, unknown>).hint = 'no inherited toString'
    const ODD_DETAILS: unknown[] = [
      undefined,
      null,
      0,
      false,
      '',
      [],
      {},
      { message: undefined },
      { message: null },
      { message: 42 },
      Symbol('detail'),
      () => {},
      new Error('a real error, as detail'),
      nullProtoDetail,
      { toString: () => { throw new Error('toString boom') } },
      { [Symbol.toPrimitive]: () => { throw new Error('toPrimitive boom') } },
      revokedProxy(),
    ]

    test('every odd code (with no detail) classifies without throwing', () => {
      for (const code of ODD_CODES) {
        let result: EngineErrorClass | undefined
        expect(() => {
          result = classifyEngineError(code as string | null)
        }).not.toThrow()
        expect(VALID).toContain(result!)
      }
    })

    test('every odd code crossed with every odd detail classifies without throwing', () => {
      for (const code of ODD_CODES) {
        for (const detail of ODD_DETAILS) {
          let result: EngineErrorClass | undefined
          expect(() => {
            result = classifyEngineError(code as string | null, detail)
          }).not.toThrow()
          expect(VALID).toContain(result!)
        }
      }
    })

    test('a valid code crossed with every odd detail still classifies without throwing', () => {
      for (const detail of ODD_DETAILS) {
        expect(() => classifyEngineError('REVIEW_ERROR', detail)).not.toThrow()
        expect(() => classifyEngineError('OBS_RPC_UNAVAILABLE', detail)).not.toThrow()
        expect(() => classifyEngineError('BUNDLER_REJECTED', detail)).not.toThrow()
      }
    })
  })
})

describe('EngineHealthTracker', () => {
  test('tracks last review, decision code and resets consecutive errors on success', () => {
    const t = new EngineHealthTracker()
    const now = Date.parse('2026-10-02T09:00:00.000Z')
    t.record('acc-1', false, 'OBS_RPC_UNAVAILABLE', 'rpc_other', now)
    t.record('acc-1', false, 'OBS_RPC_UNAVAILABLE', 'rpc_other', now + 1000)
    let s = t.snapshot('acc-1', now + 1000)
    expect(s.consecutiveErrors).toBe(2)
    expect(s.lastErrorClass).toBe('rpc_other')
    expect(s.lastErrorAt).toBe(new Date(now + 1000).toISOString())
    expect(s.lastDecisionCode).toBe('OBS_RPC_UNAVAILABLE')

    t.record('acc-1', true, 'DECIDE_HOLD', undefined, now + 2000)
    s = t.snapshot('acc-1', now + 2000)
    expect(s.consecutiveErrors).toBe(0)
    expect(s.lastDecisionCode).toBe('DECIDE_HOLD')
    expect(s.reviewsLastHour).toBe(3)
    expect(s.errorsLastHour).toBe(2)
    // A successful review does not clear the last error class/time: it is "last seen", not "current".
    expect(s.lastErrorClass).toBe('rpc_other')
  })

  test('shortens the account key to 8 chars in the snapshot', () => {
    const t = new EngineHealthTracker()
    t.record('3f9a7c21-aaaa-4bbb-8ccc-ddddeeeeffff', true, 'DECIDE_HOLD', undefined)
    expect(t.snapshot('3f9a7c21-aaaa-4bbb-8ccc-ddddeeeeffff').account).toBe('3f9a7c21')
  })

  test('an account never reviewed reports nulls and zero counts', () => {
    const t = new EngineHealthTracker()
    const s = t.snapshot('never-seen')
    expect(s.lastReviewAt).toBeNull()
    expect(s.lastDecisionCode).toBeNull()
    expect(s.lastErrorClass).toBeNull()
    expect(s.lastErrorAt).toBeNull()
    expect(s.consecutiveErrors).toBe(0)
    expect(s.reviewsLastHour).toBe(0)
  })

  test('reviewsLastHour/errorsLastHour reset once the clock hour moves on', () => {
    const t = new EngineHealthTracker()
    const h0 = Date.parse('2026-10-02T09:00:00.000Z')
    t.record('acc-1', false, 'X', 'internal', h0)
    const h1 = Date.parse('2026-10-02T10:00:01.000Z')
    const s = t.snapshot('acc-1', h1)
    expect(s.reviewsLastHour).toBe(0)
    expect(s.errorsLastHour).toBe(0)
    // Consecutive errors (and the last error class/time) are not hourly stats: they persist across the hour boundary.
    expect(s.consecutiveErrors).toBe(1)
    expect(s.lastErrorClass).toBe('internal')
  })
})

describe('RpcMetrics is immune to prototype-pollution-shaped provider/method labels', () => {
  const DANGEROUS = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty', '__defineGetter__']

  test('a method name equal to an Object.prototype member never throws and counts correctly', () => {
    const m = new RpcMetrics(tmpDir())
    for (const method of DANGEROUS) {
      expect(() => m.recordRequest('some-host', method, false)).not.toThrow()
      expect(() => m.recordError('some-host', method, 'other')).not.toThrow()
      expect(() => m.recordFallback('some-host', method)).not.toThrow()
    }
    // All of them are unknown methods, so they fold into the same "other" bucket.
    const other = m.snapshot().cumulative['some-host']!.other!
    expect(other.requests).toBe(DANGEROUS.length)
    expect(other.errors.other).toBe(DANGEROUS.length)
    expect(other.fallbacks).toBe(DANGEROUS.length)
  })

  test('a provider label equal to an Object.prototype member never throws and counts correctly', () => {
    const m = new RpcMetrics(tmpDir())
    for (const provider of DANGEROUS) expect(() => m.recordRequest(provider, 'eth_call', false)).not.toThrow()
    const snap = m.snapshot()
    for (const provider of DANGEROUS) expect(snap.cumulative[provider]!.eth_call!.requests).toBe(1)
  })

  test('a once-malformed persisted file (a prototype-shaped key with inherited junk) is dropped, not trusted, on load', () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'rpc-usage.json'),
      JSON.stringify({
        cumulative: {
          'good-host': { eth_call: { requests: 5, errors: { rateCapacity: 0, invalidParams: 0, timeout: 0, other: 0 }, fallbacks: 0, getLogsChunks: 0, cuEstimate: 0 } },
          'bad-host': { eth_call: { requests: 'not-a-number' } }, // malformed: must be dropped, not crash the load
          toString: { eth_call: 'nonsense' },
        },
        ring: 'not-an-array',
      }),
    )
    const m = new RpcMetrics(dir)
    const snap = m.snapshot()
    expect(snap.cumulative['good-host']!.eth_call!.requests).toBe(5)
    expect(snap.cumulative['bad-host']).toBeUndefined()
    expect(snap.last48h).toEqual([])
    // The file loaded without throwing and the tracker is still usable afterward.
    expect(() => m.recordRequest('good-host', 'eth_call', false)).not.toThrow()
  })

  test('a syntactically corrupt persisted file does not crash construction and logs a redacted line', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'rpc-usage.json'), '{not valid json')
    let m: RpcMetrics | undefined
    const lines = capture(() => {
      m = new RpcMetrics(dir)
    })
    expect(m).toBeDefined()
    expect(m!.snapshot().cumulative).toEqual({})
    expect(lines[0]).toContain('[metrics] failed to load')
    expect(lines[0]).toContain('starting empty')
  })

  test('the load-failure log line is redacted the same way logErr redacts, not the raw exception text', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'rpc-usage.json'), '{}')
    const origParse = JSON.parse
    JSON.parse = () => {
      throw new Error('while parsing https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-')
    }
    let lines: string[] = []
    try {
      lines = capture(() => new RpcMetrics(dir))
    } finally {
      JSON.parse = origParse
    }
    expect(lines[0]).toContain('https://base-mainnet.g.alchemy.com')
    expect(lines[0]).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-')
  })

  test('a persist failure (state dir path blocked by an existing file) does not throw and logs a redacted line', () => {
    const dir = tmpDir()
    const blocked = join(dir, 'blocked-state-dir')
    writeFileSync(blocked, 'not a directory')
    let m: RpcMetrics | undefined
    let lines: string[] = []
    expect(() => {
      lines = capture(() => {
        m = new RpcMetrics(blocked)
        m!.recordRequest('host', 'eth_call', false)
        m!.persist()
      })
    }).not.toThrow()
    expect(lines.some((l) => l.includes('[metrics] failed to persist'))).toBe(true)
  })
})

describe('RpcMetrics bounded cardinality', () => {
  test('methods outside the known-method table fold into "other" instead of creating unbounded buckets', () => {
    const m = new RpcMetrics(tmpDir())
    for (let i = 0; i < 500; i++) m.recordRequest('host', `made_up_method_${i}`, false)
    const byMethod = m.snapshot().cumulative.host!
    expect(Object.keys(byMethod)).toEqual(['other'])
    expect(byMethod.other!.requests).toBe(500)
  })

  test('providers beyond the cap fold into a shared "other" provider bucket', () => {
    const m = new RpcMetrics(tmpDir())
    for (let i = 0; i < 200; i++) m.recordRequest(`provider-${i}`, 'eth_call', false)
    const snap = m.snapshot().cumulative
    // 16 real distinct providers are retained (the cap), plus one "other" catch-all.
    expect(Object.keys(snap).length).toBeLessThanOrEqual(17)
    expect(snap.other).toBeDefined()
  })
})

describe('safeMetrics', () => {
  test('swallows a throw and never propagates it', () => {
    expect(() =>
      safeMetrics(() => {
        throw new Error('boom')
      }),
    ).not.toThrow()
  })

  test('runs the function normally when it does not throw', () => {
    let ran = false
    safeMetrics(() => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test('the ignored-failure log line is redacted, never the raw exception message', () => {
    const lines = capture(() =>
      safeMetrics(() => {
        throw new Error('upstream https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_- failed')
      }),
    )
    expect(lines[0]).toContain('[metrics] recording failed, ignored:')
    expect(lines[0]).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-')
    expect(lines[0]).toContain('https://base-mainnet.g.alchemy.com')
  })

  test('a throw whose value cannot be stringified (a revoked Proxy) never propagates and never crashes the log line itself', () => {
    expect(() =>
      safeMetrics(() => {
        throw revokedProxy()
      }),
    ).not.toThrow()
    const lines = capture(() =>
      safeMetrics(() => {
        throw revokedProxy()
      }),
    )
    expect(lines[0]).toContain('[metrics] recording failed, ignored:')
  })
})

describe('redactSecrets', () => {
  test('collapses a URL to scheme+host, dropping the path where an API key lives', () => {
    expect(redactSecrets('rate limited https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_- try again')).toBe(
      'rate limited https://base-mainnet.g.alchemy.com try again',
    )
  })

  test('redacts a key=/token=/secret=-shaped fragment', () => {
    expect(redactSecrets('invalid key=sk_live_1234567890abcdef')).toBe('invalid key=[redacted]')
    expect(redactSecrets('auth=abcDEF123456789012345678')).toBe('auth=[redacted]')
    // "Bearer <token>" is two words: the key=value pattern only grabs "Bearer", and the long
    // opaque-token pattern independently catches the token itself right after.
    expect(redactSecrets('auth: Bearer abcDEF123456789012345678')).toBe('auth=[redacted] [redacted]')
  })

  test('redacts a long opaque run even without a key= prefix or a URL', () => {
    expect(redactSecrets('token 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddccbbaa9988')).toBe('token [redacted]')
  })

  test('leaves an ordinary short error message untouched', () => {
    expect(redactSecrets('eth_call reverted: insufficient funds')).toBe('eth_call reverted: insufficient funds')
  })

  test('caps length', () => {
    const long = 'x '.repeat(200)
    const out = redactSecrets(long)
    expect(out.length).toBeLessThanOrEqual(161)
    expect(out.endsWith('…')).toBe(true)
  })

  test('handles non-string input without throwing', () => {
    expect(redactSecrets(undefined)).toBe('')
    expect(redactSecrets(null)).toBe('')
    expect(() => redactSecrets({ weird: 'object' })).not.toThrow()
  })

  test('handles hostile input without throwing: null-prototype object, throwing toString/Symbol.toPrimitive, a revoked Proxy', () => {
    const nullProto: unknown = Object.create(null)
    ;(nullProto as Record<string, unknown>).secretish = 'https://x.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-'
    expect(() => redactSecrets(nullProto)).not.toThrow()
    expect(() =>
      redactSecrets({
        toString: () => {
          throw new Error('toString boom')
        },
      }),
    ).not.toThrow()
    expect(() =>
      redactSecrets({
        [Symbol.toPrimitive]: () => {
          throw new Error('toPrimitive boom')
        },
      }),
    ).not.toThrow()
    expect(() => redactSecrets(revokedProxy())).not.toThrow()
    // None of these can be meaningfully stringified; failing safe to '' is correct, never a crash.
    expect(redactSecrets(revokedProxy())).toBe('')
  })
})

describe('logErr', () => {
  test('redacts an Error message before printing it', () => {
    const lines = capture(() => logErr('[owner] op-1', new Error('upstream https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_- failed')))
    expect(lines).toEqual(['[owner] op-1 upstream https://base-mainnet.g.alchemy.com failed'])
  })

  test('accepts a plain string', () => {
    const lines = capture(() => logErr('[bundler] 0xabc refused:', 'invalid params for eth_call'))
    expect(lines).toEqual(['[bundler] 0xabc refused: invalid params for eth_call'])
  })

  test('only the first line of a multi-line message is logged', () => {
    const lines = capture(() => logErr('[engine x]', new Error('first line\nsecond line with a secret')))
    expect(lines).toEqual(['[engine x] first line'])
  })

  test('an empty/undefined error prints just the tag', () => {
    expect(capture(() => logErr('[engine x] observation failed OBS_OK:', undefined))).toEqual(['[engine x] observation failed OBS_OK:'])
  })

  test('a non-Error, non-string value is stringified then redacted', () => {
    const lines = capture(() => logErr('[owner] simulation reverts:', { code: -32000, message: 'execution reverted' }))
    expect(lines[0]).toContain('[owner] simulation reverts:')
    expect(lines[0]).toContain('execution reverted')
  })
})

describe('classifyEngineError with the thrown value itself', () => {
  test('an Error keeps its RPC class', () => {
    expect(classifyEngineError('REVIEW_ERROR', new Error('Invalid parameters were provided to the RPC method.'))).toBe(classifyEngineError('REVIEW_ERROR', 'Invalid parameters were provided to the RPC method.'))
  })
  test('values that throw when read or coerced classify without throwing', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const hostile = { get message(): string { throw new Error('boom') }, toString() { throw new Error('boom') } }
    for (const v of [revoked.proxy, hostile, Object.create(null), Symbol('x'), 10n, () => {}]) {
      expect(() => classifyEngineError('REVIEW_ERROR', v)).not.toThrow()
    }
  })
})
