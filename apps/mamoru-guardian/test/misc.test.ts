import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress } from 'viem'
import { v4Remote } from '@mamoru/account/one-auth'
import { address, baseRegistry, monadRegistry } from '@mamoru/registry'
import { MattermostAlerter } from '../src/alerts.ts'
import { checkRemote, type CheckReads, type Passkey } from '../src/checks.ts'
import { loadGuardianAccount } from '../src/key.ts'
import { StateStore } from '../src/state.ts'
import { A, ACCOUNT, CAP, DOMAIN, GAS_POLICY, SESSION_KEY, V4 } from './helpers.ts'

// A public test key (anvil #0), never a real one.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const tmp = () => mkdtempSync(join(tmpdir(), 'guardian-key-'))

describe('guardian key file', () => {
  test('0600 file loads', () => {
    const p = join(tmp(), 'k'); writeFileSync(p, `${KEY}\n`, { mode: 0o600 })
    expect(loadGuardianAccount(p).address).toBe(getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'))
  })
  for (const mode of [0o644, 0o640, 0o604, 0o660]) {
    test(`mode ${mode.toString(8)} refused, error leaks nothing`, () => {
      const p = join(tmp(), 'k'); writeFileSync(p, KEY); chmodSync(p, mode)
      let msg = ''
      try { loadGuardianAccount(p) } catch (e) { msg = (e as Error).message }
      expect(msg).toContain('permissions too open')
      expect(msg).not.toContain(KEY)
    })
  }
  test('malformed content refused without echoing it', () => {
    const p = join(tmp(), 'k'); writeFileSync(p, '0xdeadbeef', { mode: 0o600 })
    expect(() => loadGuardianAccount(p)).toThrow('0x + 64')
  })
})

describe('state file', () => {
  test('a loose existing state file is refused', () => {
    const d = tmp(); writeFileSync(join(d, 'state.json'), '{"v":1,"cursors":{},"registrations":{},"safes":{},"alerted":{}}', { mode: 0o644 })
    expect(() => new StateStore(d)).toThrow('0600')
  })
})

describe('mattermost alerter', () => {
  test('posts { text }; failure does not echo the URL', async () => {
    const calls: { url: string; body: string }[] = []
    const ok = new MattermostAlerter('https://mm.example/hooks/SECRET', (async (url: string, init: RequestInit) => { calls.push({ url, body: String(init.body) }); return new Response('ok') }) as unknown as typeof fetch)
    await ok.alert('hi')
    expect(calls[0]!.body).toBe('{"text":"hi"}')
    const bad = new MattermostAlerter('https://mm.example/hooks/SECRET', (async () => new Response('no', { status: 500 })) as unknown as typeof fetch)
    let msg = ''
    try { await bad.alert('x') } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('500')
    expect(msg).not.toContain('SECRET')
  })
})

// Passkey owner path: the shared signer is an owner, so the readback also compares getConfiguration home vs remote.
describe('passkey readback', () => {
  const shared = address('SafeWebAuthnSharedSigner', baseRegistry)
  const owners = [A(0x0b), shared]
  const pk: Passkey = { x: 5n, y: 6n, verifiers: 7n }
  const exp = v4Remote({ home: ACCOUNT, owners: { owners, threshold: 1n, ...pk }, domain: DOMAIN, homeDomain: 6, sessionKey: SESSION_KEY, capUsd: CAP, deployment: { policy: V4, gasPolicy: GAS_POLICY }, registry: monadRegistry })
  const reads = (remotePk: Passkey): CheckReads => ({
    remoteCode: async () => '0x60',
    owners: async () => owners,
    threshold: async () => 1n,
    passkey: async (side) => (side === 'home' ? pk : remotePk),
    homeOwnersHash: async () => exp.ownersHash,
    smartSessionInstalled: async () => true,
    modules: async () => [address('Safe7579', monadRegistry)],
    guard: async () => '0x0000000000000000000000000000000000000000',
    validators7579: async () => [address('SmartSession', monadRegistry)],
    executors7579: async () => [],
    hook7579: async () => '0x0000000000000000000000000000000000000000',
    fallbackHandler: async () => address('Safe7579', monadRegistry),
    permissionEnabled: async () => true,
    permissionIds: async () => [exp.permissionId],
  })
  const input = { account: ACCOUNT, domain: DOMAIN, homeChainId: 8453, event: { remote: exp.address, ownersHash: exp.ownersHash, sessionKey: SESSION_KEY }, capUsd: CAP, deployment: { policy: V4, gasPolicy: GAS_POLICY }, homeRegistry: baseRegistry, remoteRegistry: monadRegistry }

  test('matching passkey: ok', async () => {
    expect(await checkRemote(input, reads(pk))).toEqual({ ok: true })
  })
  for (const bad of [{ ...pk, x: 9n }, { ...pk, y: 9n }, { ...pk, verifiers: 9n }]) {
    test(`differing passkey ${JSON.stringify(bad, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}: refused`, async () => {
      const r = await checkRemote(input, reads(bad))
      expect(r.ok).toBe(false)
      expect(!r.ok && r.failed).toContain('passkey')
    })
  }
  test('a throwing read fails the check without leaking its message', async () => {
    const r = await checkRemote(input, { ...reads(pk), permissionIds: async () => { throw new Error('https://rpc.example/KEY') } })
    expect(r).toEqual({ ok: false, failed: 'permissionIds: read failed' })
  })
})

describe('allowlist file', () => {
  test('absent = empty; present is lower-cased; malformed throws', async () => {
    const { readAllowlist } = await import('../src/watcher.ts')
    const d = tmp()
    expect(readAllowlist(join(d, 'none.json'))().size).toBe(0)
    expect(readAllowlist(undefined)().size).toBe(0)
    writeFileSync(join(d, 'a.json'), '["0xAB"]')
    expect([...readAllowlist(join(d, 'a.json'))()]).toEqual(['0xab'])
    writeFileSync(join(d, 'b.json'), '{"x":1}')
    expect(() => readAllowlist(join(d, 'b.json'))()).toThrow()
  })
})
