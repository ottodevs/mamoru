import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// otto/mamoru#417: waits and windows are written in seconds and turned into blocks of the chain (secondsToBlocks), so
// they last as long on Monad (300 ms blocks) as on Base (2 s). A constant written as a block count is allowed only when
// a block count is what it means; each one below says why. A new one fails here until it is converted or listed.

const ROOT = join(import.meta.dir, '../../..')
const SOURCES = ['apps/mamoru-operator/src', 'apps/mamoru-engine/src', 'packages/decide/src', 'packages/policy/src']
/** A constant whose name has BLOCK(S), CONFIRMATIONS or LAG as a word (not REVOKE_FLAG) and a number for a value. */
const BLOCK_CONST = /\bconst ((?:[A-Z0-9]+_)*(?:BLOCK|BLOCKS|CONFIRMATIONS|LAG)(?:_[A-Z0-9]+)*)\s*(?::[^=]+)?=\s*[0-9][0-9_ *]*n?\b/g

const ALLOWED: Record<string, string> = {
  // eth_getLogs ranges: a provider limit in blocks, not a duration.
  OWNER_LOG_PAGE_BLOCKS: 'RPC page size',
  LOG_CHUNK_BLOCKS: 'RPC page size',
  DEPOSIT_PAGE_BLOCKS: 'RPC page size',
  MONAD_HISTORY_STEP_BLOCKS: 'RPC page size (Monad only)',
  // How far back a search reads: RPC budget per look, sized per chain where it matters (#419 cuts RPC volume).
  OWNER_LOG_SEARCH_BLOCKS: 'search budget in blocks; later ops settle by Safe nonce',
  LOG_WINDOW_BLOCKS: 'search budget in blocks',
  DEPOSIT_BACKFILL_BLOCKS: 'the default for a caller without a chain; the operator passes a day of its own blocks',
  INVENTORY_SLACK_BLOCKS: 'search budget in blocks',
  MONAD_HISTORY_LAG_BLOCKS: 'search budget in blocks (Monad only)',
  MONAD_CATCH_UP_BLOCKS: 'search budget in blocks (Monad only)',
  BASE_CATCH_UP_BLOCKS: 'search budget in blocks (Base only)',
  // Reorg depth: a fixed depth on every chain, the same rule whatever tags a node serves (deposits.ts).
  DEPOSIT_CONFIRM_BLOCKS: 'the default for a caller without a chain; the operator uses DEPOSIT_CONFIRM_SECONDS',
  // Ethereum sibling scan: chain 1, not an engine chain.
  SIBLING_SCAN_LAG: 'Ethereum only',
  // Stats sync on the engine: block windows of the pool history, labelled per chain.
  MB_MAX_LAG_BLOCKS: 'indexer lag in blocks',
  WINDOW_BLOCKS: 'default without a chain; syncOnce uses WINDOW_SECONDS',
  SNAPSHOT_RETENTION_BLOCKS: 'default without a chain; syncOnce uses SNAPSHOT_RETENTION_SECONDS',
  VOUCHED_BLOCKS_PER_RUN: 'a count of blocks per run, not a duration',
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []
  })
}

describe('waits and windows are written in seconds (#417)', () => {
  test('every constant written as a block count is one that means blocks', () => {
    const unlisted: string[] = []
    for (const dir of SOURCES) {
      for (const f of files(join(ROOT, dir))) {
        for (const m of readFileSync(f, 'utf8').matchAll(BLOCK_CONST)) if (!(m[1]! in ALLOWED)) unlisted.push(`${relative(ROOT, f)}: ${m[1]}`)
      }
    }
    expect(unlisted).toEqual([])
  })
})

describe('a block-time override (#445)', () => {
  test('a zero, negative or fractional OperatorConfig.blockTimeMs stops the operator at construction', async () => {
    const { Operator } = await import('../src/operator.ts')
    for (const blockTimeMs of [0, -200, 0.5, Number.NaN]) {
      expect(() => new Operator({ blockTimeMs } as never, {} as never, {} as never, { state: { accounts: {} }, save: () => {} } as never)).toThrow('not a positive integer')
    }
    expect(() => new Operator({ blockTimeMs: 1_000 } as never, {} as never, {} as never, { state: { accounts: {} }, save: () => {} } as never)).not.toThrow()
  })
})
