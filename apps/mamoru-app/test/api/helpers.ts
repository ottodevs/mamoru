import type { PasskeyOwner } from '@mamoru/domain'
import { createApp, type AppOptions } from '../../src/api/app.ts'
import type { Env } from '../../src/api/env.ts'
import { memoryD1 } from './d1.ts'

export const ORIGIN = 'https://app.mamoru.lol'
export const SECRET = 'test-secret-with-at-least-thirty-two-characters'

// Public keys of the fixed test scalars a1 and a2 from packages/scenarios/webauthn (test material only).
export const PASSKEY_A: PasskeyOwner = {
  credentialId: 'dGVzdC1jcmVkZW50aWFsLWEx',
  x: '0x984225585d2285c138033d6140e3cef8b91859704e53c313f8b636ba4f967649',
  y: '0x9734144f46fd19a767a545287c4396b97b69dd38faaea8981adc1a4fed9b401e',
}
export const PASSKEY_B: PasskeyOwner = {
  credentialId: 'dGVzdC1jcmVkZW50aWFsLWEy',
  x: '0xb0c9b23dbe2da93634265119a5f60ff0e0ff38695b6214b4bc934a4fe8a43124',
  y: '0xbbdfe38eb01ecd82ffa5b6dc3d139f4c5f2bc579e8cb8ff24a317bf5f5fca859',
}

export function harness(now = () => new Date('2026-09-26T18:00:00Z'), opts: { env?: Partial<Env>; operatorFetch?: AppOptions['operatorFetch'] } = {}) {
  const db = memoryD1()
  const env: Env = { DB: db, MODE: 'production', CHAIN_ID: '8453', CORE_DRY_RUN: 'true', SESSION_SECRET: SECRET, ...opts.env }
  const app = createApp({ now, ...(opts.operatorFetch ? { operatorFetch: opts.operatorFetch } : {}) })
  const request = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.cookie) headers.set('cookie', init.cookie)
    return app.request(`${ORIGIN}${path}`, { ...init, headers }, env)
  }
  const post = (path: string, body: unknown, opts: { cookie?: string; origin?: string | null } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN
    return request(path, { method: 'POST', body: JSON.stringify(body), headers, cookie: opts.cookie })
  }
  return { db, env, app, request, post }
}

/** The session cookie pair (name=value) from a response. */
export function sessionCookie(res: Response): string {
  const set = res.headers.get('set-cookie')
  if (!set) throw new Error('no session cookie')
  return set.split(';')[0]!
}
