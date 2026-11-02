// otto/mamoru#293, review of #202 r5 (Sol 1 + 2). (1) A config error exits 78 (EX_CONFIG; the unit stops restarting, enters
// `failed`, OnFailure pages) and the OnFailure helper pages through its own channel, never the guardian's webhook file.
// (2) A journal-only alert is never "delivered": not recorded, the cursor holds, and a later webhook replays it.
import { describe, expect, test } from 'bun:test'
import { chmodSync, linkSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleAlerter, MattermostAlerter, TeeAlerter } from '../src/alerts.ts'
import { alerterFrom, ConfigError, EX_CONFIG, exitCodeOf, run, type MakeClient } from '../src/main.ts'
import { pageUnitFailure, unitAlerterFrom, unitOf } from '../src/unit-alert.ts'
import { runPass } from '../src/watcher.ts'
import { A, makeWorld, setup } from './helpers.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'guardian-deliv-'))
const hookFile = (url = 'https://mm.example/hooks/SECRET') => {
  const f = join(tmp(), 'hook')
  writeFileSync(f, `${url}\n`, { mode: 0o600 })
  return f
}
const okFetch = (posts: string[]) => (async (_u: string, init: RequestInit) => { posts.push(JSON.parse(String(init.body)).text); return new Response('ok') }) as unknown as typeof fetch
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const w = console.warn
  const e = console.error
  console.warn = () => {}
  console.error = () => {}
  try { return await f() } finally { console.warn = w; console.error = e }
}
const baseEnv = () => ({ MAMORU_GUARDIAN_HOME_RPC_URL: 'http://127.0.0.1:9/', MAMORU_GUARDIAN_V4_ADDRESS: '0x00000000000000000000000000000000000000a2', MAMORU_GUARDIAN_GAS_POLICY_ADDRESS: '0x00000000000000000000000000000000000000a3', MAMORU_GUARDIAN_STATE_DIR: tmp(), MAMORU_GUARDIAN_FROM_BLOCK_8453: '1', MAMORU_GUARDIAN_DRY_RUN: '1' } as Record<string, string | undefined>)
const onChain = (id: number, guardian = A(0x9)): MakeClient => () => ({ getChainId: async () => id, readContract: async () => guardian }) as never
const failOf = async (env: Record<string, string | undefined>, mk: MakeClient = onChain(8453)) => quiet(() => run(env, new ConsoleAlerter() as never, mk, true).then(() => null, (e) => e))

describe('delivery results', () => {
  test('console never delivers; the webhook delivers; the tee delivers only through the webhook', async () => {
    const posts: string[] = []
    expect(await quiet(() => new ConsoleAlerter().alert('x'))).toEqual({ delivered: false })
    expect(await new MattermostAlerter('https://mm.example/hooks/x', okFetch(posts)).alert('x')).toEqual({ delivered: true })
    expect(await quiet(() => new TeeAlerter([new ConsoleAlerter()]).alert('x'))).toEqual({ delivered: false })
    expect(await quiet(() => new TeeAlerter([new ConsoleAlerter(), new MattermostAlerter('https://mm.example/hooks/x', okFetch(posts))]).alert('x'))).toEqual({ delivered: true })
    expect(await quiet(() => alerterFrom({}).alert('x'))).toEqual({ delivered: false })
  })

  test('dev mode (no webhook): a Queued and an owner-tx alert are logged, not recorded, cursors hold; a webhook configured later delivers them once', async () => {
    const w = makeWorld()
    w.regLogs.push({ args: { ...w.event } })
    w.home.ready = true
    w.queuedLogs.push({ args: { id: `0x${'aa'.repeat(32)}`, kind: 0, key: `0x${'bb'.repeat(32)}`, params: '0x', nonce: 0n, eta: 1n } })
    const unknown = `0x${'dd'.repeat(32)}`
    w.execLogs.push({ args: { txHash: unknown, payment: 0n } })
    const s = setup(w, { registryAt: { 8453: A(0x88) } })

    s.deps.alerter = await quiet(async () => alerterFrom({}))
    for (let i = 0; i < 2; i++) expect(await quiet(() => runPass(s.cfg, s.deps))).toEqual([])
    expect(Object.keys(s.store.state.alerted ?? {}).filter((k) => k.startsWith('queued:') || k.startsWith('exec:'))).toEqual([])
    expect(s.store.cursor('queued:8453')).toBeUndefined() // held at the page with the logged alert
    const k = Object.keys(s.store.state.safes)[0]!
    expect(s.store.state.safes[k]!.next).toBe('3') // the deploy block: not past the owner-tx page
    expect(s.store.cursor('reg')).toBe(11n) // a stream without alerts moves

    const posts: string[] = []
    s.deps.alerter = await quiet(async () => alerterFrom({ MAMORU_GUARDIAN_WEBHOOK_FILE: hookFile() }, okFetch(posts)))
    await quiet(() => runPass(s.cfg, s.deps))
    await quiet(() => runPass(s.cfg, s.deps))
    expect(posts.length).toBe(2)
    expect(posts.some((p) => p.includes('MamoruRegistry Queued'))).toBe(true)
    expect(posts.some((p) => p.includes(unknown))).toBe(true)
    expect(s.store.cursor('queued:8453')).toBe(11n)
    expect(s.store.state.safes[k]!.next).toBe('11')
  })

  test('an unknown deploy block logged only to the journal: the start block is not fixed, a webhook later delivers it', async () => {
    const w = makeWorld()
    w.regLogs.push({ args: { ...w.event } })
    w.home.ready = true
    const s = setup(w)
    const c = s.deps.clients[143]!
    const plain = c.getCode
    c.getCode = async (a) => { if (a.blockNumber !== undefined) throw new Error('missing trie node'); return plain(a) }
    s.deps.alerter = await quiet(async () => alerterFrom({}))
    await quiet(() => runPass(s.cfg, s.deps))
    const k = Object.keys(s.store.state.safes)[0]!
    expect(s.store.state.safes[k]!.next).toBe('')
    const posts: string[] = []
    s.deps.alerter = await quiet(async () => alerterFrom({ MAMORU_GUARDIAN_WEBHOOK_FILE: hookFile() }, okFetch(posts)))
    await quiet(() => runPass(s.cfg, s.deps))
    expect(posts.some((p) => p.includes('deploy block unknown'))).toBe(true)
    expect(s.store.state.safes[k]!.next).toBe('11')
  })
})

describe('config errors exit 78 (EX_CONFIG); transient ones exit 1', () => {
  test('missing or malformed settings, a non-V4 chain, an RPC on another chain, a bad or wrong key', async () => {
    const cases: [string, Record<string, string | undefined>, MakeClient?][] = [
      ['MAMORU_GUARDIAN_HOME_RPC_URL is required', { ...baseEnv(), MAMORU_GUARDIAN_HOME_RPC_URL: undefined }],
      ['MAMORU_GUARDIAN_V4_ADDRESS: not an address', { ...baseEnv(), MAMORU_GUARDIAN_V4_ADDRESS: '0xnope' }],
      ['is not a V4 chain', { ...baseEnv(), MAMORU_GUARDIAN_HOME_CHAIN_ID: '1' }],
      ['MAMORU_GUARDIAN_INTERVAL_SECONDS: not a non-negative integer', { ...baseEnv(), MAMORU_GUARDIAN_INTERVAL_SECONDS: 'soon' }],
      ['MAMORU_GUARDIAN_FROM_BLOCK_8453: not a block number', { ...baseEnv(), MAMORU_GUARDIAN_FROM_BLOCK_8453: '-4' }],
      ['MAMORU_GUARDIAN_FROM_BLOCK_8453 is required on first start', { ...baseEnv(), MAMORU_GUARDIAN_FROM_BLOCK_8453: undefined }],
      ['answers another chain id', baseEnv(), onChain(1)],
      ['MAMORU_GUARDIAN_KEY_FILE is required', { ...baseEnv(), MAMORU_GUARDIAN_DRY_RUN: undefined }],
      ['MAMORU_GUARDIAN_KEY_FILE: ENOENT', { ...baseEnv(), MAMORU_GUARDIAN_KEY_FILE: '/nonexistent/key' }],
    ]
    const open = join(tmp(), 'key')
    writeFileSync(open, `0x${'0'.repeat(63)}1\n`)
    chmodSync(open, 0o644)
    cases.push(['permissions too open', { ...baseEnv(), MAMORU_GUARDIAN_KEY_FILE: open }])
    const other = join(tmp(), 'key')
    writeFileSync(other, `0x${'0'.repeat(63)}1\n`, { mode: 0o600 })
    cases.push(['the guardian key is not V4.GUARDIAN', { ...baseEnv(), MAMORU_GUARDIAN_KEY_FILE: other }])
    for (const [why, env, mk] of cases) {
      const e = await failOf(env, mk)
      expect(e, why).toBeInstanceOf(ConfigError)
      expect((e as Error).message, why).toContain(why)
      expect(exitCodeOf(e)).toBe(EX_CONFIG)
    }
  })

  test('an RPC that is down is not a config error: exit 1, the unit restarts with backoff', async () => {
    const down: MakeClient = () => ({ getChainId: async () => { throw new Error('HTTP request failed.') } }) as never
    const e = await failOf(baseEnv(), down)
    expect(e).not.toBeInstanceOf(ConfigError)
    expect(exitCodeOf(e)).toBe(1)
  })

  test('the unit template: restarts forever except on 78, which lands in failed and runs OnFailure', () => {
    const unit = readFileSync(join(import.meta.dir, '../../../ops/systemd/mamoru-guardian.service'), 'utf8')
    expect(unit).toMatch(/^Restart=always$/m)
    expect(unit).toMatch(/^RestartPreventExitStatus=78$/m)
    expect(unit).toMatch(/^StartLimitIntervalSec=0$/m)
    expect(unit).toMatch(/^OnFailure=mamoru-guardian-alert@%N\.service$/m)
  })
})

describe('mamoru-guardian-alert@ pages through its own channel', () => {
  test('the alert unit loads its own env file, and the guardian one only optionally (to learn its webhook path)', () => {
    const unit = readFileSync(join(import.meta.dir, '../../../ops/systemd/mamoru-guardian-alert@.service'), 'utf8')
    expect(unit).toMatch(/^EnvironmentFile=%h\/\.config\/mamoru-guardian-alert\/env$/m)
    expect(unit).toMatch(/^EnvironmentFile=-%h\/\.config\/mamoru-guardian\/env$/m)
    expect(unit).not.toMatch(/^EnvironmentFile=%h\/\.config\/mamoru-guardian\/env$/m)
  })

  test('refuses the guardian webhook: same path, a symlink to it, a hard link to it, the same URL in another file; exits 1', async () => {
    const posts: string[] = []
    const g = hookFile('https://mm.example/hooks/GUARD')
    const sym = join(tmp(), 'sym')
    symlinkSync(g, sym)
    const hard = join(tmp(), 'hard')
    linkSync(g, hard)
    const copy = hookFile('https://mm.example/hooks/GUARD')
    for (const alertFile of [g, sym, hard, copy]) {
      const env = { MAMORU_GUARDIAN_WEBHOOK_FILE: g, MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: alertFile }
      expect(() => unitAlerterFrom(env, okFetch(posts)), alertFile).toThrow('must not be the guardian webhook')
      expect(await quiet(() => pageUnitFailure(env, 'mamoru-guardian', okFetch(posts)))).toBe(1)
    }
    // The guardian's path is a symlink to the alert file: refused too.
    const own = hookFile('https://mm.example/hooks/OPS')
    const gsym = join(tmp(), 'gsym')
    symlinkSync(own, gsym)
    expect(() => unitAlerterFrom({ MAMORU_GUARDIAN_WEBHOOK_FILE: gsym, MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: own }, okFetch(posts))).toThrow('must not be the guardian webhook')
    expect(posts).toEqual([])
  })

  test('a different webhook pages; a guardian webhook file that is missing or broken does not stop it', async () => {
    const posts: string[] = []
    const own = hookFile('https://mm.example/hooks/OPS')
    const broken = join(tmp(), 'broken')
    writeFileSync(broken, 'not a url\n', { mode: 0o600 })
    for (const g of [hookFile('https://mm.example/hooks/GUARD'), '/nonexistent/hook', broken])
      expect(await pageUnitFailure({ MAMORU_GUARDIAN_WEBHOOK_FILE: g, MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: own }, 'mamoru-guardian', okFetch(posts))).toBe(0)
    expect(posts.length).toBe(3)
  })

  test('any failure to post exits non-zero (the alert unit lands in failed): HTTP error, network error, invalid or missing file', async () => {
    const http500 = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch
    const netDown = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const bad = join(tmp(), 'bad')
    writeFileSync(bad, 'nope\n', { mode: 0o600 })
    expect(await quiet(() => pageUnitFailure({ MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: hookFile() }, 'mamoru-guardian', http500))).toBe(1)
    expect(await quiet(() => pageUnitFailure({ MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: hookFile() }, 'mamoru-guardian', netDown))).toBe(1)
    expect(await quiet(() => pageUnitFailure({ MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: bad }, 'mamoru-guardian', okFetch([])))).toBe(1)
    expect(await quiet(() => pageUnitFailure({ MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: '/nonexistent/hook' }, 'mamoru-guardian', okFetch([])))).toBe(1)
    expect(await quiet(() => pageUnitFailure({}, 'mamoru-guardian', okFetch([])))).toBe(1)
  })

  test('it ignores MAMORU_GUARDIAN_WEBHOOK_FILE: without its own variable it does not page through the guardian webhook', async () => {
    const posts: string[] = []
    expect(() => unitAlerterFrom({ MAMORU_GUARDIAN_WEBHOOK_FILE: hookFile() }, okFetch(posts))).toThrow('MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE is not set')
    expect(await quiet(() => pageUnitFailure({ MAMORU_GUARDIAN_WEBHOOK_FILE: hookFile() }, 'mamoru-guardian', okFetch(posts)))).toBe(1)
    expect(posts).toEqual([])
  })

  test('with its own webhook: one fixed line naming the unit, no URL; exit 0', async () => {
    const posts: string[] = []
    // A broken guardian webhook file (one of the failures it reports) does not stop it.
    expect(await pageUnitFailure({ MAMORU_GUARDIAN_WEBHOOK_FILE: '/nonexistent/hook', MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: hookFile('https://mm.example/hooks/OPS') }, 'mamoru-guardian', okFetch(posts))).toBe(0)
    expect(posts.length).toBe(1)
    expect(posts[0]).toContain('mamoru-guardian failed')
    expect(posts[0]).not.toContain('OPS')
    const failing = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch
    expect(await quiet(() => pageUnitFailure({ MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: hookFile() }, 'mamoru-guardian', failing))).toBe(1)
  })

  test('refuses a unit name it does not own', async () => {
    expect(unitOf('mamoru-guardian@base')).toBe('mamoru-guardian@base')
    expect(unitOf('sshd; rm -rf')).toBeNull()
    expect(await pageUnitFailure({ MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE: hookFile() }, 'other.service', okFetch([]))).toBe(2)
  })
})
