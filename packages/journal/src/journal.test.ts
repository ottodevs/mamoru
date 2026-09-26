import { describe, expect, test } from 'bun:test'
import { checkTransition, isTerminal, signBlocker, type SignContext } from './index.ts'

describe('checkTransition', () => {
  test('follows the happy path of plan §10', () => {
    expect(checkTransition('proposed', 'prepared', 'EHG_OK').ok).toBe(true)
    expect(checkTransition('prepared', 'simulated', 'EHG_OK').ok).toBe(true)
    expect(checkTransition('simulated', 'signed', 'OP_SIGNED').ok).toBe(true)
    expect(checkTransition('signed', 'submitted', 'BUNDLER_ACCEPTED').ok).toBe(true)
    expect(checkTransition('submitted', 'included', 'OP_INCLUDED').ok).toBe(true)
    expect(checkTransition('included', 'confirmed', 'EXEC_OK').ok).toBe(true)
  })

  test('accepts code families on discard edges', () => {
    expect(checkTransition('proposed', 'discarded', 'EHG_PRICE_DIVERGENCE').ok).toBe(true)
    expect(checkTransition('prepared', 'discarded', 'POLICY_DENIED_AMOUNT').ok).toBe(true)
    expect(checkTransition('simulated', 'discarded', 'DRY_RUN_STOP').ok).toBe(true)
  })

  test('never cancels a signed operation', () => {
    for (const from of ['signed', 'submitted', 'pending_reconciliation'] as const) {
      const r = checkTransition(from, 'discarded', 'OP_PREEMPTED_BY_EXIT')
      expect(r.ok).toBe(false)
    }
  })

  test('refuses a code that does not belong to the edge', () => {
    const r = checkTransition('included', 'confirmed', 'OP_INCLUDED')
    expect(r).toEqual({ ok: false, code: 'SIGN_STATE_INVALID', detail: 'OP_INCLUDED does not move included -> confirmed' })
  })

  test('refuses to skip states', () => {
    expect(checkTransition('proposed', 'signed', 'OP_SIGNED').ok).toBe(false)
  })

  test('terminal states', () => {
    expect(['discarded', 'confirmed', 'failed'].every((s) => isTerminal(s as never))).toBe(true)
    expect(isTerminal('pending_reconciliation')).toBe(false)
  })
})

describe('signBlocker', () => {
  const lab: SignContext = {
    mode: 'lab',
    chainId: 31337,
    signingChainIds: [31337],
    observationAgeSeconds: 5,
    observationTtlSeconds: 120,
    observationCanonical: true,
    preparedNonce: 7n,
    chainNonce: 7n,
  }

  test('lets the lab sign on the fork chain', () => {
    expect(signBlocker(lab)).toBeNull()
  })

  test('production never signs', () => {
    expect(signBlocker({ ...lab, mode: 'production' })).toBe('DRY_RUN_STOP')
  })

  test('Base and Base Sepolia are refused even when listed', () => {
    expect(signBlocker({ ...lab, chainId: 8453, signingChainIds: [8453] })).toBe('SIGN_CHAIN_NOT_ALLOWED')
    expect(signBlocker({ ...lab, chainId: 84532, signingChainIds: [84532] })).toBe('SIGN_CHAIN_NOT_ALLOWED')
  })

  test('live signs only on Base with MAMORU_LIVE=1', () => {
    const prev = process.env.MAMORU_LIVE
    const live = { ...lab, mode: 'live' as const, chainId: 8453, signingChainIds: [8453] }
    try {
      delete process.env.MAMORU_LIVE
      expect(signBlocker(live)).toBe('SIGN_CHAIN_NOT_ALLOWED')
      process.env.MAMORU_LIVE = '1'
      expect(signBlocker(live)).toBeNull()
      expect(signBlocker({ ...live, chainId: 31337, signingChainIds: [31337] })).toBe('SIGN_CHAIN_NOT_ALLOWED')
      expect(signBlocker({ ...live, chainId: 84532, signingChainIds: [84532] })).toBe('SIGN_CHAIN_NOT_ALLOWED')
    } finally {
      if (prev === undefined) delete process.env.MAMORU_LIVE
      else process.env.MAMORU_LIVE = prev
    }
  })

  test('stale, reorged and moved nonce', () => {
    expect(signBlocker({ ...lab, observationAgeSeconds: 121 })).toBe('EHG_OBSERVATION_STALE')
    expect(signBlocker({ ...lab, observationCanonical: false })).toBe('EHG_OBSERVATION_REORGED')
    expect(signBlocker({ ...lab, chainNonce: 8n })).toBe('OP_NONCE_MOVED')
  })
})
