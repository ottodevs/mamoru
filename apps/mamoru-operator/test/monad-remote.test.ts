// otto/mamoru#251, Monad side: the operator that runs the Base accounts' own Safes on Monad. `remoteKey` gives the session key
// the Base approval commits to; `provision` deploys the Safe with the relayer when it has no code, checks on chain that it
// is the one the approval committed to (owners, threshold 1, SmartSession, every session enabled), and only then stores the
// account active with the remote grants and starts its engine. Fake Monad RPC and relayer; no network.
import { describe, expect, test } from 'bun:test'
import { toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address, RemoteSpec } from '@mamoru/domain'
import { monadRegistry } from '@mamoru/registry'
import { liveWmonUsdcMonadV6 } from '@mamoru/policy'
import { baseKeyOf, monadV6Deployed, remoteAccountKey, remoteInput, remoteSafe } from '@mamoru/account/remote'
import { createProxyCall } from '@mamoru/account/safe'
import { HttpError, Operator } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'
import { withPinnedV3 } from '../../../packages/account/remote/fixture.ts'
import { ctx, quiet } from './owner-world.ts'

const registry = withPinnedV3(monadRegistry)

/** A Monad operator over a fake chain: what the Safe at `address` looks like on chain is set per test. */
function monadWorld(opts: { writes?: boolean } = {}) {
  const chain = {
    deployed: false,
    owners: null as string[] | null,
    threshold: 1n,
    smartSession: true,
    /** Permission ids that are not enabled on the Safe. */
    notEnabled: new Set<string>(),
    eth: 0n,
  }
  const sent: { to: string; data?: Hex; value?: bigint }[] = []
  const started: string[] = []
  let saves = 0
  let safe = '' as Address
  const read = (functionName: string, args: readonly unknown[] = []) => {
    if (functionName === 'getOwners') return chain.owners ?? ctx.owners
    if (functionName === 'getThreshold') return chain.threshold
    if (functionName === 'isModuleInstalled') return chain.smartSession
    if (functionName === 'isPermissionEnabled') return !chain.notEnabled.has(String(args[0]).toLowerCase())
    if (functionName === 'nonce') return 0n
    throw new Error(`unexpected read ${functionName}`)
  }
  const client = {
    getBlockNumber: async () => 500n,
    getGasPrice: async () => 100_000_000_000n,
    getCode: async () => (chain.deployed ? '0x01' : undefined),
    getBalance: async () => chain.eth,
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => read(functionName, args),
  } as unknown as PublicClient
  const relayer = {
    address: `0x${'7'.repeat(40)}`,
    send: async (tx: { to: string; data?: Hex; value?: bigint }) => {
      sent.push(tx)
      if (tx.to.toLowerCase() === safe.toLowerCase()) chain.eth += tx.value ?? 0n
      else chain.deployed = true
      const hash = toHex(sent.length, { size: 32 })
      return { hash, receipt: { transactionHash: hash, status: 'success', blockNumber: 499n, logs: [], gasUsed: 200_000n, effectiveGasPrice: 1n } as unknown as TransactionReceipt }
    },
  } as unknown as Relayer
  const state = { accounts: {} as Record<string, AccountState> } as { accounts: Record<string, AccountState>; remoteKeys?: Record<string, Hex> }
  const store = { state, save: () => void saves++ } as unknown as StateStore
  const op = new Operator(
    { chainId: 143, registry, ...(opts.writes === false ? {} : { chainWrites: [143] }), live: true, rpcUrl: '', bundlerUrl: '', policy: monadV6Deployed(registry), reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 },
    client,
    relayer,
    store,
  )
  // The engine is the Operator's own and is covered elsewhere: here only that provisioning starts it, for whom.
  ;(op as unknown as { startLoop(a: AccountState): void }).startLoop = (a) => void started.push(a.accountKey)
  /** The remote Safe's context for `spec` (the Base account's keys, its own address and account key). */
  const remoteCtx = (spec: RemoteSpec): AccountContext => {
    const r = remoteSafe(remoteInput(ctx, spec, registry))
    safe = r.address
    return { accountKey: remoteAccountKey(ctx.accountKey, 143), chainId: 143, address: r.address, owners: ctx.owners, saltNonce: ctx.saltNonce, passkey: ctx.passkey, remote: spec }
  }
  const specFor = (sessionKey: Address): RemoteSpec => ({ chainId: 143, policyId: liveWmonUsdcMonadV6.policyId, sessionKey, validAfter: 1_790_000_000, validUntil: 1_821_536_000, capUsdc: '50000000' })
  return { op, chain, sent, started, state, saves: () => saves, remoteCtx, specFor }
}

const code = async (p: Promise<unknown>) => {
  const e = (await quiet(() => p.catch((x: unknown) => x))).out
  return e instanceof HttpError ? { status: e.status, code: e.code } : e
}

describe('remote-key (Monad side)', () => {
  test('gives the same session key on repeated calls, a key it holds, and writes it down once', () => {
    const m = monadWorld()
    const a = m.op.remoteKey(ctx)
    const saved = m.saves()
    expect(m.op.remoteKey(ctx)).toEqual(a)
    expect(m.saves()).toBe(saved)
    expect(m.state.remoteKeys![ctx.accountKey]).toBeDefined()
    expect(privateKeyToAccount(m.state.remoteKeys![ctx.accountKey]!).address).toBe(a.sessionKey)
    // Another Base account key gets a key of its own.
    const other = m.op.remoteKey({ ...ctx, accountKey: 'other' })
    expect(other.sessionKey).not.toBe(a.sessionKey)
    expect(m.op.remoteKey(ctx)).toEqual(a)
  })

  test('refuses a context that is not a Base account', () => {
    const m = monadWorld()
    const refused = (c: AccountContext) => {
      try {
        m.op.remoteKey(c)
      } catch (e) {
        return e instanceof HttpError ? e.status : e
      }
      return null
    }
    expect(refused({ ...ctx, chainId: 143 })).toBe(400)
    expect(refused({ ...ctx, accountKey: 'k@143' })).toBe(400)
    expect(refused({ ...ctx, remote: m.specFor(`0x${'11'.repeat(20)}`) })).toBe(400)
    // A Base account whose Safe is not what its keys give: refused too, and no key is made for it.
    expect(refused({ ...ctx, address: `0x${'ab'.repeat(20)}` })).toBe(400)
    expect(m.state.remoteKeys).toBeUndefined()
  })
})

describe('provision (Monad side)', () => {
  /** A Monad operator that has given its key for `ctx`, and the remote context built on it. */
  function keyed() {
    const m = monadWorld()
    const { sessionKey } = m.op.remoteKey(ctx)
    const spec = m.specFor(sessionKey)
    const rctx = m.remoteCtx(spec)
    const r = remoteSafe(remoteInput(ctx, spec, registry))
    return { ...m, spec, rctx, r }
  }

  test('refuses a spec whose session key is not the one this operator gave: 409 REMOTE_KEY_UNKNOWN, nothing sent', async () => {
    const m = keyed()
    const other = m.specFor(`0x${'11'.repeat(20)}`)
    expect(await code(m.op.provision(m.remoteCtx(other)))).toEqual({ status: 409, code: 'REMOTE_KEY_UNKNOWN' })
    // A Base account this operator never keyed.
    const fresh = monadWorld()
    expect(await code(fresh.op.provision(fresh.remoteCtx(fresh.specFor(m.spec.sessionKey as Address))))).toEqual({ status: 409, code: 'REMOTE_KEY_UNKNOWN' })
    expect(m.sent).toEqual([])
    expect(fresh.sent).toEqual([])
    expect(m.started).toEqual([])
  })

  test('refuses a context without a spec, for another chain, or whose address is not what the spec gives', async () => {
    const m = keyed()
    const { remote: _, ...bare } = m.rctx
    expect(await code(m.op.provision(bare as AccountContext))).toEqual({ status: 400, code: 'BAD_REQUEST' })
    expect(await code(m.op.provision({ ...m.rctx, remote: { ...m.spec, chainId: 8453 } }))).toEqual({ status: 400, code: 'BAD_REQUEST' })
    expect((await code(m.op.provision({ ...m.rctx, address: `0x${'ab'.repeat(20)}` }))) as { status: number }).toMatchObject({ status: 400 })
    expect(m.sent).toEqual([])
  })

  test('a read-only Monad operator (no MAMORU_CHAIN_WRITES) provisions nothing', async () => {
    const m = monadWorld({ writes: false })
    const spec = m.specFor(m.op.remoteKey(ctx).sessionKey)
    expect(await code(m.op.provision(m.remoteCtx(spec)))).toMatchObject({ status: 503 })
    expect(m.sent).toEqual([])
    expect(m.started).toEqual([])
  })

  test('no code on chain: the relayer deploys the committed initializer first, then the checks run', async () => {
    const m = keyed()
    expect(m.chain.deployed).toBe(false)
    const res = await m.op.provision(m.rctx)
    expect(res).toEqual({ state: 'active', address: m.r.address })
    const deploy = createProxyCall(m.r.setup, registry)
    expect(m.sent[0]).toMatchObject({ to: deploy.to, data: deploy.data })
    expect(m.chain.deployed).toBe(true)
  })

  test('code already there: nothing is deployed', async () => {
    const m = keyed()
    m.chain.deployed = true
    await m.op.provision(m.rctx)
    const deploy = createProxyCall(m.r.setup, registry)
    expect(m.sent.some((t) => t.to === deploy.to)).toBe(false)
  })

  for (const [why, break_] of [
    ['an owner that is not the account\'s', (c: ReturnType<typeof monadWorld>['chain']) => void (c.owners = [...ctx.owners.slice(1), `0x${'ab'.repeat(20)}`])],
    ['a threshold above 1', (c: ReturnType<typeof monadWorld>['chain']) => void (c.threshold = 2n)],
    ['SmartSession not installed', (c: ReturnType<typeof monadWorld>['chain']) => void (c.smartSession = false)],
  ] as const) {
    test(`on-chain checks fail (${why}): 409 REMOTE_SAFE_UNVERIFIED, nothing runs on it`, async () => {
      const m = keyed()
      m.chain.deployed = true
      break_(m.chain)
      expect(await code(m.op.provision(m.rctx))).toEqual({ status: 409, code: 'REMOTE_SAFE_UNVERIFIED' })
      expect(m.sent).toEqual([]) // no gas top-up either
      expect(m.started).toEqual([])
      expect(m.state.accounts[m.rctx.accountKey]?.active).not.toBe(true)
    })
  }

  test('a session of the spec that is not enabled on the Safe: 409 REMOTE_SAFE_UNVERIFIED, nothing runs', async () => {
    const m = keyed()
    m.chain.deployed = true
    m.chain.notEnabled.add(m.r.permissionIds[0]!.toLowerCase())
    expect(await code(m.op.provision(m.rctx))).toEqual({ status: 409, code: 'REMOTE_SAFE_UNVERIFIED' })
    expect(m.sent).toEqual([])
    expect(m.started).toEqual([])
    expect(m.state.accounts[m.rctx.accountKey]?.active).not.toBe(true)
  })

  test('checks pass: the account is stored active with the remote grants, funded for gas, and its engine starts', async () => {
    const m = keyed()
    await m.op.provision(m.rctx)
    const acc = m.state.accounts[m.rctx.accountKey]!
    expect(acc).toMatchObject({ active: true, trusted: true, policyId: liveWmonUsdcMonadV6.policyId, signedCapUsdc: m.spec.capUsdc })
    expect(acc.ctx.address).toBe(m.r.address)
    expect(acc.grants.map((g) => g.name)).toEqual(m.r.keys)
    expect(acc.grants.map((g) => g.permissionId)).toEqual(m.r.permissionIds)
    expect(acc.grants.map((g) => g.grant.account)).toEqual(m.r.grants.map(() => m.r.address))
    // The engine signs with the key this operator generated (the one the Base approval committed to), never one from the request.
    expect(privateKeyToAccount(acc.sessionKey!).address).toBe(m.spec.sessionKey)
    expect(m.started).toEqual([m.rctx.accountKey])
    // The gas reserve is topped up from the relayer to the Safe, after the deploy.
    const topUp = m.sent.find((t) => t.to === m.r.address)!
    expect(topUp.value).toBeGreaterThan(liveWmonUsdcMonadV6.gasReserveWei - 1n)
    expect(m.sent.indexOf(topUp)).toBeGreaterThan(0)
    expect(baseKeyOf(m.rctx.accountKey, 143)).toBe(ctx.accountKey)
  })

  test('idempotent: already active answers active again, sends nothing and starts nothing more', async () => {
    const m = keyed()
    await m.op.provision(m.rctx)
    const sent = m.sent.length
    const again = await m.op.provision(m.rctx)
    expect(again).toEqual({ state: 'active', address: m.r.address })
    expect(m.sent).toHaveLength(sent)
    expect(m.started).toHaveLength(1)
    expect(Object.keys(m.state.accounts)).toEqual([m.rctx.accountKey])
  })
})
