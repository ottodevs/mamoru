// otto/mamoru#450: an e2e never forks through, nor boots an operator with, the live operator's providers.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearProductionEnv, e2eBaseEnv, LIVE_BASE_POLICY, PUBLIC_UPSTREAM } from './e2e-env.ts'

describe('e2e environment (otto/mamoru#450)', () => {
  test('no e2e script reads the live operator env or the provider endpoints file', () => {
    for (const f of readdirSync(import.meta.dir).filter((f) => /^e2e-.+\.ts$/.test(f) && !f.startsWith('e2e-env'))) {
      const s = readFileSync(join(import.meta.dir, f), 'utf8')
      expect(s.includes('.config/mamoru-operator/env'), f).toBe(false)
      expect(s.includes('quicknode/endpoints.env'), f).toBe(false)
    }
  })

  test('production providers, peers, settings and keys are cleared; anything else is kept', () => {
    const env: Record<string, string | undefined> = { RPC_URL: 'k', BASE_RPC_URL: 'k', MONAD_RPC_URL: 'k', MAMORU_RPC_TRUSTED: 'k', MAMORU_PEER_OPERATORS: 'p', MAMORU_SETTINGS_URL: 's', ALCHEMY_KEY_2: 'k', QUICKNODE_BASE_MAINNET_HTTP: 'k', E2E_RPC_URL: 'e', FORK_CUPS: '5', PATH: '/bin' }
    clearProductionEnv(env)
    expect(env).toEqual({ E2E_RPC_URL: 'e', FORK_CUPS: '5', PATH: '/bin' })
  })

  test('a Base e2e forks E2E_RPC_URL or the public node, never a shell RPC_URL, and sets the live policy only where unset', () => {
    const saved = { ...process.env }
    try {
      Object.assign(process.env, { RPC_URL: 'https://live.example/key', MAMORU_RPC_TRUSTED: 'https://live.example/key', MAMORU_GAS_POLICY_ADDRESS: '0x1111111111111111111111111111111111111111' })
      delete process.env.E2E_RPC_URL
      expect(e2eBaseEnv({ livePolicy: true })).toBe(PUBLIC_UPSTREAM.base)
      expect(process.env.RPC_URL).toBe(PUBLIC_UPSTREAM.base)
      expect(process.env.MAMORU_RPC_TRUSTED).toBeUndefined()
      expect(process.env.MAMORU_ACTION_POLICY_ADDRESS).toBe(LIVE_BASE_POLICY.MAMORU_ACTION_POLICY_ADDRESS)
      expect(process.env.MAMORU_GAS_POLICY_ADDRESS).toBe('0x1111111111111111111111111111111111111111')
      process.env.E2E_RPC_URL = 'https://e2e.example/'
      expect(e2eBaseEnv()).toBe('https://e2e.example/')
      expect(process.env.RPC_URL).toBe('https://e2e.example/')
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
})
