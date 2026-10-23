import { describe, expect, test } from 'bun:test'
import { randomNonce, signatureFor } from '../src/sign.ts'

/**
 * Fixed vectors for `x-lab-sig = hex HMAC-SHA256(secret, "${method}\n${path}\n${ts}\n${nonce}\n${hex sha256(body)}")`
 * (spec 008 Architecture). Also in the PR body, so the landing session implementing the verifier can check its own
 * implementation against the same numbers without importing this file.
 */
describe('signatureFor (B-05 fixed vectors)', () => {
  test('vector 1: claim, empty body', async () => {
    const sig = await signatureFor('test-lab-runner-secret-v1', 'POST', '/ops/lab/runner/claim', 1_761_220_000, 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', '{}')
    expect(sig).toBe('0ab17ef830b47b5eeecec34a7d99250fc1b2bc3b9e73931ab0f8b218779ced79')
  })

  test('vector 2: result, a real JSON body', async () => {
    const body = JSON.stringify({ jobId: 'job-1', leaseId: 'lease-1', error: 'LAB_SPEC_INVALID' })
    const sig = await signatureFor('test-lab-runner-secret-v1', 'POST', '/ops/lab/runner/result', 1_761_220_030, 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3', body)
    expect(sig).toBe('5cd7bbe6408001cf33a4ab6e5c9c8545bfeb9107b2609e362ac6ccb58e43c6ac')
  })

  test('the signature changes with the body: a captured request cannot carry another body', async () => {
    const a = await signatureFor('s', 'POST', '/ops/lab/runner/result', 1, 'n', '{"a":1}')
    const b = await signatureFor('s', 'POST', '/ops/lab/runner/result', 1, 'n', '{"a":2}')
    expect(a).not.toBe(b)
  })

  test('the signature changes with the method, the path, the ts or the nonce alone', async () => {
    const base = await signatureFor('s', 'POST', '/ops/lab/runner/claim', 1_000, 'n'.repeat(32), '{}')
    expect(await signatureFor('s', 'GET', '/ops/lab/runner/claim', 1_000, 'n'.repeat(32), '{}')).not.toBe(base)
    expect(await signatureFor('s', 'POST', '/ops/lab/runner/heartbeat', 1_000, 'n'.repeat(32), '{}')).not.toBe(base)
    expect(await signatureFor('s', 'POST', '/ops/lab/runner/claim', 1_001, 'n'.repeat(32), '{}')).not.toBe(base)
    expect(await signatureFor('s', 'POST', '/ops/lab/runner/claim', 1_000, 'm'.repeat(32), '{}')).not.toBe(base)
  })

  test('a different secret gives a different signature', async () => {
    const a = await signatureFor('secret-a', 'POST', '/ops/lab/runner/claim', 1, 'n', '{}')
    const b = await signatureFor('secret-b', 'POST', '/ops/lab/runner/claim', 1, 'n', '{}')
    expect(a).not.toBe(b)
  })
})

describe('randomNonce', () => {
  test('32 lowercase hex chars, different on every call', () => {
    const a = randomNonce()
    const b = randomNonce()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(b).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})
