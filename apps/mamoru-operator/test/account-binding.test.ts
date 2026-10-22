// otto/mamoru#140 (part1 #6.2, #6.3): account() only checked that an accountKey keeps the same Safe address; it
// never checked the reverse, so a compromised app Worker could alias a fresh accountKey onto a Safe already
// tracked under another one — a second AccountState for the same live Safe, with its own lock and its own
// owner-failure budget. Separately, a GET (funding/ops) for any unseen accountKey created and disk-saved a new
// AccountState just by being asked, with no owner action behind it.
import { describe, expect, test } from 'bun:test'
import { toHex, type PublicClient } from 'viem'
import type { AccountContext } from '@mamoru/domain'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { baseRegistry, address } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { HttpError, Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'

const owners = [address('SafeWebAuthnSharedSigner', baseRegistry)]
const saltNonce = 7n
const passkey = { x: 11n, y: 22n }
const SAFE = counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y)))

function ctxOf(accountKey: string): AccountContext {
  return {
    accountKey,
    chainId: 8453,
    address: SAFE,
    owners,
    saltNonce: saltNonce.toString(),
    passkey: { credentialId: accountKey, x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
  }
}

function world() {
  const client = {} as unknown as PublicClient
  const relayer = { address: `0x${'7'.repeat(40)}` } as unknown as Relayer
  const state = { accounts: {} as Record<string, AccountState> }
  let saves = 0
  const store = { state, save: () => void saves++ } as unknown as StateStore
  const cfg = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 } satisfies OperatorConfig
  const op = new Operator(cfg, client, relayer, store)
  return { op, state, saves: () => saves }
}

describe('account(): a Safe address binds to exactly one accountKey, in both directions', () => {
  test('the first accountKey seen for a Safe is accepted and persisted', () => {
    const w = world()
    const { acc } = w.op.account(ctxOf('key-a'))
    expect(acc.accountKey).toBe('key-a')
    expect(w.state.accounts['key-a']).toBeDefined()
  })

  test('a second, different accountKey for the SAME Safe is refused, not silently given its own account', () => {
    const w = world()
    w.op.account(ctxOf('key-a'))
    const err = (() => {
      try {
        w.op.account(ctxOf('key-b'))
        return undefined
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(409)
    expect((err as HttpError).code).toBe('ACCOUNT_MISMATCH')
    // No second AccountState was created for the same Safe.
    expect(w.state.accounts['key-b']).toBeUndefined()
    expect(Object.keys(w.state.accounts)).toEqual(['key-a'])
  })

  test('the known accountKey for its own Safe keeps working after the collision attempt was refused', () => {
    const w = world()
    w.op.account(ctxOf('key-a'))
    expect(() => w.op.account(ctxOf('key-b'))).toThrow()
    expect(w.op.account(ctxOf('key-a')).acc.accountKey).toBe('key-a')
  })
})

describe('account({ readOnly: true }): a GET for an unseen accountKey never grows or saves state', () => {
  test('an unseen accountKey gets the same empty view, with nothing written to the store', () => {
    const w = world()
    const { acc } = w.op.account(ctxOf('key-a'), { readOnly: true })
    expect(acc.accountKey).toBe('key-a')
    expect(acc.ops).toEqual([])
    expect(w.state.accounts['key-a']).toBeUndefined()
    expect(w.saves()).toBe(0)
  })

  test('repeated read-only calls for the same unseen accountKey never accumulate state either', () => {
    const w = world()
    w.op.account(ctxOf('key-a'), { readOnly: true })
    w.op.account(ctxOf('key-a'), { readOnly: true })
    w.op.account(ctxOf('key-a'), { readOnly: true })
    expect(Object.keys(w.state.accounts)).toEqual([])
    expect(w.saves()).toBe(0)
  })

  test('a read-only call still enforces the reverse Safe->accountKey binding', () => {
    const w = world()
    w.op.account(ctxOf('key-a')) // persisted normally (e.g. the account already prepared something)
    expect(() => w.op.account(ctxOf('key-b'), { readOnly: true })).toThrow(HttpError)
  })

  test('a non-read-only call after read-only ones for the same accountKey persists normally', () => {
    const w = world()
    w.op.account(ctxOf('key-a'), { readOnly: true })
    const { acc } = w.op.account(ctxOf('key-a'))
    expect(acc.accountKey).toBe('key-a')
    expect(w.state.accounts['key-a']).toBeDefined()
    expect(w.saves()).toBe(1)
  })
})
