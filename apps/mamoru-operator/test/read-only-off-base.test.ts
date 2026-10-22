// otto/mamoru#63 (review of PR #110, P1-2): on any registry other than Base the operator signs and sends nothing,
// even if it were configured live. Fail closed at every write path: relayer, owner prepare/submit, engine and armed
// loops. Reading a Safe stays open (the Monad fork E2E reads and values one).
import { describe, expect, test } from 'bun:test'
import { generatePrivateKey } from 'viem/accounts'
import { baseRegistry, monadRegistry } from '@mamoru/registry'
import type { PublicClient } from 'viem'
import { writeRefusal } from '../src/chain.ts'
import { Relayer } from '../src/relayer.ts'
import type { AccountState } from '../src/state.ts'
import { ctx, quiet, sign, world } from './owner-world.ts'

const lab314143 = { ...monadRegistry } // a lab fork of Monad reads the Monad registry: same refusal
const monadTestnet = { ...monadRegistry, chain: 'monad-testnet', chainId: 10143 }

describe('writeRefusal', () => {
  test('Base is written to; Monad mainnet, its testnet and a Monad fork are not', () => {
    expect(writeRefusal(baseRegistry)).toBeNull()
    for (const r of [monadRegistry, lab314143, monadTestnet]) expect(writeRefusal(r)).toMatch(/read only on monad.*signs and sends nothing off Base/)
  })
})

describe('Relayer with a refusal', () => {
  test('every send is refused before any read, with CHAIN_UNSUPPORTED', async () => {
    let reads = 0
    const client = new Proxy({}, { get: () => () => (reads++, Promise.reject(new Error('no read expected'))) }) as unknown as PublicClient
    const relayer = new Relayer(generatePrivateKey(), client, 'http://127.0.0.1:1/', 143, writeRefusal(monadRegistry))
    const e = (await relayer.send({ to: relayer.address, value: 1n }).catch((x: unknown) => x)) as { code?: string }
    expect(e.code).toBe('CHAIN_UNSUPPORTED')
    expect(reads).toBe(0)
  })

  test('without a refusal (Base) the relayer is unchanged: it goes on to read', async () => {
    let reads = 0
    const client = new Proxy({}, { get: () => () => (reads++, Promise.reject(new Error('stop here'))) }) as unknown as PublicClient
    const relayer = new Relayer(generatePrivateKey(), client, 'http://127.0.0.1:1/', 8453)
    await relayer.send({ to: relayer.address, value: 1n }).catch(() => {})
    expect(reads).toBeGreaterThan(0)
  })
})

describe('Operator on the Monad registry, even misconfigured live', () => {
  test('every owner prepare and submit answers CHAIN_READ_ONLY and nothing is sent', async () => {
    const w = world(5_000_000n, { registry: monadRegistry, live: true })
    const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as { code?: string }).code
    expect(await code(w.op.prepareActivate(ctx))).toBe('CHAIN_READ_ONLY')
    expect(await code(w.op.prepareRenew(ctx))).toBe('CHAIN_READ_ONLY')
    expect(await code(w.op.prepareStop(ctx))).toBe('CHAIN_READ_ONLY')
    expect(await code(w.op.prepareTransfer(ctx, { to: ctx.address, amountUsdc: '1000000', asset: 'USDC' } as never))).toBe('CHAIN_READ_ONLY')
    expect(await code(w.op.submit(ctx, 'activate', sign({ prepareId: 'x', safeTxHash: `0x${'1'.repeat(64)}` } as never)))).toBe('CHAIN_READ_ONLY')
    expect(w.sent).toEqual([])
  })

  test('resume starts no engine loop, armed watcher or reconciliation for an active or armed account', async () => {
    const w = world(5_000_000n, { registry: monadRegistry, live: true })
    const acc = { accountKey: 'k', ctx, trusted: true, active: true, sessionKey: generatePrivateKey(), grants: [], revoked: [], managedTokenIds: [], depositsAfter: '0', historyFromBlock: '0', epoch: 0, ops: [], seq: 0 } as unknown as AccountState
    w.state.accounts.k = acc
    await quiet(async () => w.op.resume())
    await Bun.sleep(20)
    expect(w.op.engineHealthSnapshot()).toEqual([])
    expect(w.sent).toEqual([])
    w.op.shutdown()
  })

  test('on Base the same world prepares as before (the guard is the registry, nothing else)', async () => {
    const w = world(5_000_000n)
    const r = (await w.op.prepareActivate(ctx).catch((e: unknown) => e)) as { code?: string }
    expect(r.code).not.toBe('CHAIN_READ_ONLY')
  })
})
