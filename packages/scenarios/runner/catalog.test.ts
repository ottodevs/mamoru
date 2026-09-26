import { describe, expect, test } from 'bun:test'
import { ReasonError } from '@mamoru/domain'
import { gateScenario } from './catalog.ts'
import { loadManifest } from './manifest.ts'

const manifest = await loadManifest()
const ok = {
  id: 'T',
  requirements: [],
  fork: { source: 'base', block: 51811000, blockHash: manifest.fork.blockHash, chainId: 31337 },
  policy: 'conservador-lab-v1',
  world: 'none',
  fixtures: [],
  steps: [],
  expect: {},
  invariants: [],
}

function code(raw: unknown): string {
  try {
    gateScenario(raw, manifest, 'test.yaml')
  } catch (e) {
    if (e instanceof ReasonError) return e.code
    throw e
  }
  return 'NONE'
}

describe('scenario gate', () => {
  test('the catalog scenario passes', () => expect(code(ok)).toBe('NONE'))
  test('missing block', () => expect(code({ ...ok, fork: { ...ok.fork, block: undefined } })).toBe('LAB_BLOCK_REQUIRED'))
  test('Base chain ids', () => {
    expect(code({ ...ok, fork: { ...ok.fork, chainId: 8453 } })).toBe('LAB_CHAIN_ID_FORBIDDEN')
    expect(code({ ...ok, fork: { ...ok.fork, chainId: 84532 } })).toBe('LAB_CHAIN_ID_FORBIDDEN')
  })
  test('another block or hash', () => {
    expect(code({ ...ok, fork: { ...ok.fork, block: 51811001 } })).toBe('LAB_BLOCK_HASH_MISMATCH')
    expect(code({ ...ok, fork: { ...ok.fork, blockHash: `0x${'00'.repeat(32)}` } })).toBe('LAB_BLOCK_HASH_MISMATCH')
  })
})
