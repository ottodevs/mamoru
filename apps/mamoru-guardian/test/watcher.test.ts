import { describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { runPass } from '../src/watcher.ts'
import { A, makeWorld, setup, type World } from './helpers.ts'

const withReg = (w: World) => { w.regLogs.push({ args: { ...w.event } }) }

describe('setReady', () => {
  test('all checks match: setReady once, then nothing more; state file is 0600', async () => {
    const w = makeWorld(); withReg(w)
    const s = setup(w)
    expect(await runPass(s.cfg, s.deps)).toEqual([])
    expect(s.sent).toEqual([{ account: w.event.account, domain: w.event.domain, remote: w.event.remote }])
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
    expect(statSync(s.store.file).mode & 0o777).toBe(0o600)
  })

  const mismatches: [string, (w: World) => void, string][] = [
    ['no code', (w) => { w.remote.code = '0x' }, 'code'],
    ['owners differ', (w) => { w.remote.owners = [A(0xbad)] }, 'owners'],
    ['owner order differs', (w) => { w.home.owners = [A(1), A(2)]; w.remote.owners = [A(2), A(1)] }, 'owners'],
    ['threshold differs', (w) => { w.remote.threshold = 2n }, 'threshold'],
    ['home owners changed', (w) => { w.home.ownersHash = `0x${'11'.repeat(32)}` }, 'ownersHash'],
    ['smartsession not installed', (w) => { w.remote.ssInstalled = false }, 'smartSession'],
    ['safe7579 not enabled', (w) => { w.remote.modules = [] }, 'safe7579Module'],
    ['an extra module beside Safe7579 (review of #202, P1-6)', (w) => { w.remote.modules = [...w.remote.modules, A(0xbad)] }, 'safe7579Module'],
    ['a transaction guard (P1-6)', (w) => { w.remote.guard = A(0xbad) }, 'guard'],
    ['a second 7579 validator (r2, Opus 5)', (w) => { w.remote.validators = [...w.remote.validators, A(0xbad)] }, 'validators7579'],
    ['a 7579 executor (r2, Opus 5)', (w) => { w.remote.executors = [A(0xbad)] }, 'executors7579'],
    ['a 7579 hook (r2, Opus 5)', (w) => { w.remote.hook = A(0xbad) }, 'hook7579'],
    ['wrong fallback handler', (w) => { w.remote.handler = A(0xbad) }, 'fallbackHandler'],
    ['permission not enabled', (w) => { w.remote.permEnabled = false }, 'permissionEnabled'],
    ['extra permission', (w) => { w.remote.permIds = [...w.remote.permIds, `0x${'22'.repeat(32)}`] }, 'permissionIds'],
    ['other permission', (w) => { w.remote.permIds = [`0x${'22'.repeat(32)}`] }, 'permissionIds'],
    ['no permission', (w) => { w.remote.permIds = [] }, 'permissionIds'],
    ['non canonical remote', (w) => { w.event.remote = A(0xbad); w.home.remoteOf = A(0xbad); w.regLogs.length = 0; withReg(w) }, 'remoteAddress'],
  ]
  for (const [name, mutate, failed] of mismatches) {
    test(`mismatch (${name}): no setReady, one alert naming ${failed}`, async () => {
      const w = makeWorld(); withReg(w); mutate(w)
      const s = setup(w)
      await runPass(s.cfg, s.deps)
      expect(s.sent).toEqual([])
      expect(s.alerts.length).toBe(1)
      expect(s.alerts[0]).toContain(`${failed}:`)
      // Retried next pass, but the same failure alerts once (dedup within the window).
      await runPass(s.cfg, s.deps)
      expect(s.alerts.length).toBe(1)
      expect(s.sent).toEqual([])
    })
  }

  test('a repaired remote is marked ready on a later pass', async () => {
    const w = makeWorld(); withReg(w); w.remote.permEnabled = false
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(0)
    w.remote.permEnabled = true
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
  })

  test('superseded registration is skipped without alert', async () => {
    const w = makeWorld(); withReg(w); w.home.remoteOf = A(0x99)
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([])
    expect(s.alerts).toEqual([])
    expect(Object.keys(s.store.state.registrations)).toEqual([])
  })

  test('already ready is skipped, remote chain never read', async () => {
    const w = makeWorld(); withReg(w); w.home.ready = true
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([])
    expect(w.reads.filter((r) => r.startsWith('remote.'))).toEqual([])
  })

  test('readyOf names the remote but isReady is false (stale owners hash): read back and setReady sent again (review of #202, P1-5)', async () => {
    const w = makeWorld(); withReg(w); w.home.readyRemote = w.event.remote
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([{ account: w.event.account, domain: w.event.domain, remote: w.event.remote }])
  })

  test('dry-run reads and alerts but never sends', async () => {
    const w = makeWorld(); withReg(w)
    const s = setup(w, { dryRun: true })
    s.deps.send = async () => { throw new Error('must not send') }
    expect(await runPass(s.cfg, s.deps)).toEqual([])
    expect(s.alerts.length).toBe(1)
    expect(s.alerts[0]).toContain('[dry-run]')
  })

  test('a failed send keeps the registration and alerts', async () => {
    const w = makeWorld(); withReg(w)
    const s = setup(w)
    s.deps.send = async () => { throw new Error('boom') }
    await runPass(s.cfg, s.deps)
    expect(s.alerts[0]).toContain('failed to send')
    expect(Object.keys(s.store.state.registrations).length).toBe(1)
  })

  test('log paging with a checkpoint: next pass does not rescan', async () => {
    const w = makeWorld()
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.store.cursor('reg')).toBe(11n) // head 10 + 1
    expect(s.store.cursor(`queued:8453`)).toBe(11n)
  })
})

describe('remote Safe cursors (review of #202, P1-10)', () => {
  test('a newly registered Safe is scanned from its deploy block, persisted; not before it is deployed', async () => {
    const w = makeWorld(); withReg(w); w.home.ready = true
    w.remote.code = undefined
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    const k = Object.keys(s.store.state.safes)[0]!
    expect(s.store.state.safes[k]!.next).toBe('')
    w.remote.code = '0x6080'
    await runPass(s.cfg, s.deps)
    expect(BigInt(s.store.state.safes[k]!.next)).toBe(11n) // scanned from block 3 (deploy) to the head 10
    const { deployBlockOf } = await import('../src/watcher.ts')
    expect(await deployBlockOf(s.deps.clients[143]!, w.event.remote, 10n)).toBe(3n)
  })
})

describe('guardian failures are paged (review of #202 r2, Opus 7)', () => {
  test('a section that throws alerts once per window', async () => {
    const w = makeWorld()
    const s = setup(w)
    s.deps.clients[8453]!.getLogs = async () => { throw new Error('https://rpc.example/KEY down') }
    await runPass(s.cfg, s.deps)
    await runPass(s.cfg, s.deps)
    const paged = s.alerts.filter((a) => a.startsWith('guardian section failed'))
    expect(paged.length).toBeGreaterThan(0)
    expect(new Set(paged).size).toBe(paged.length) // each section once
    expect(paged.join()).not.toContain('KEY')
  })

  test('no historical getCode: the Safe is watched from the head and that is paged', async () => {
    const w = makeWorld(); withReg(w); w.home.ready = true
    const s = setup(w)
    const c = s.deps.clients[143]!
    const plain = c.getCode
    c.getCode = async (a) => { if (a.blockNumber !== undefined) throw new Error('missing trie node'); return plain(a) }
    await runPass(s.cfg, s.deps)
    const k = Object.keys(s.store.state.safes)[0]!
    expect(BigInt(s.store.state.safes[k]!.next)).toBe(11n) // from the head 10, scanned to 10
    expect(s.alerts.some((a) => a.includes('deploy block unknown'))).toBe(true)
  })
})

describe('alerts from logs', () => {
  test('Queued alerts once with kind, key, params, eta', async () => {
    const w = makeWorld()
    w.queuedLogs.push({ args: { id: `0x${'aa'.repeat(32)}`, kind: 0, key: `0x${'bb'.repeat(32)}`, params: '0x1234', nonce: 0n, eta: 1_800_000_000n } })
    const s = setup(w, { registryAt: { 8453: A(0x88) } })
    await runPass(s.cfg, s.deps)
    await runPass(s.cfg, s.deps)
    expect(s.alerts.length).toBe(1)
    expect(s.alerts[0]).toContain('kind=Pool')
    expect(s.alerts[0]).toContain(`key=0x${'bb'.repeat(32)}`)
    expect(s.alerts[0]).toContain('params=0x1234')
    expect(s.alerts[0]).toContain('eta=2027')
  })

  test('unknown ExecutionSuccess alerts; allowlisted does not', async () => {
    const w = makeWorld(); withReg(w); w.home.ready = true // registered (so its Safe is watched), nothing to ready
    const known = `0x${'cc'.repeat(32)}`
    const unknown = `0x${'dd'.repeat(32)}`
    w.execLogs.push({ args: { txHash: known, payment: 0n } }, { args: { txHash: unknown, payment: 0n } })
    const s = setup(w, {}, [known.toUpperCase().replace('0X', '0x')])
    await runPass(s.cfg, s.deps)
    await runPass(s.cfg, s.deps)
    expect(s.alerts.length).toBe(1)
    expect(s.alerts[0]).toContain(unknown)
    expect(s.alerts[0]).toContain(w.event.remote)
  })

  test('a failed delivery does not advance the checkpoint (alert retried)', async () => {
    const w = makeWorld()
    w.queuedLogs.push({ args: { id: `0x${'aa'.repeat(32)}`, kind: 1, key: `0x${'bb'.repeat(32)}`, params: '0x', nonce: 0n, eta: 1n } })
    const s = setup(w, { registryAt: { 8453: A(0x88) } })
    let fail = true
    const alerts: string[] = []
    s.deps.alerter.alert = async (t) => { if (fail) throw new Error('down'); alerts.push(t); return { delivered: true } }
    const errs = await runPass(s.cfg, s.deps)
    expect(errs.length).toBeGreaterThan(0)
    expect(s.store.cursor('queued:8453')).toBeUndefined()
    fail = false
    await runPass(s.cfg, s.deps)
    expect(alerts.length).toBe(1)
  })
})
