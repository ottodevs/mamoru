import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, stringToHex, toFunctionSelector, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import type { AccountContext, OpView, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, erc20Abi, safeAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { LIVE_CAP_USDC, browserOwnerSignature, deployCall, liveAccountFromContext } from '@mamoru/account/live'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { FOLLOW_UP_GRACE, FOLLOW_UP_MAX, FOLLOW_UP_MS, graceLeft, HttpError, sweepsToCover, lastEngineBlock, nextReview, MAX_OWNER_FAILURES_PER_DAY, OWNER_FAILURES_ALERT_PER_DAY, Operator, priorIncludedOf, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { answerAggregate3 } from './fake-multicall.ts'
import type { AccountState, ArmedActivation, StateStore } from '../src/state.ts'

const RELAYER = `0x${'7'.repeat(40)}` as const
const TO = getAddress(`0x${'c'.repeat(40)}`)
const OVER = 101_920_000n
const EXECUTION_SUCCESS = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'))

const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
const owners = [address('SafeWebAuthnSharedSigner')]
const saltNonce = 42n
const ctx: AccountContext = {
  accountKey: 'k',
  chainId: 8453,
  address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))),
  owners,
  saltNonce: saltNonce.toString(),
  passkey: { credentialId: 'unit', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
}
const SAFE = ctx.address

/** A chain with one counterfactual Safe holding `usdc`: no code until the relayer sends the factory call. */
function world(usdc: bigint, policyId: keyof typeof POLICIES = 'conservador-live-v2') {
  const sent: { to: string; data?: Hex; value?: bigint }[] = []
  /** Every eth_simulateV1 the operator ran, as its list of calls. */
  const simulated: { from?: string; to: string; data: Hex }[][] = []
  const chain = { deployed: false, usdc, nonce: 0n }
  /** What the simulation answers ('ok', 'revert' or 'down') and what happens on chain while the relayer sends. */
  const knobs = { sim: 'ok' as 'ok' | 'revert' | 'down', call: 'ok' as 'ok' | 'revert' | 'down', execOk: true, onSend: (_tx: { to: string }) => {}, relayerWei: 10n ** 18n, failBeforeSending: false, relayerPending: 0, grantsEnabled: false as boolean | null, enabled: new Set<string>(), batchGrants: false, head: 100n, batchedGrantReads: 0, multicalls: 0, pending: null as { grants?: { permissionId: string }[]; revokes?: string[] } | null, logs: [] as { stx: Hex; hash: Hex; block: bigint }[], enabledFromBlock: 0n, noHistory: false, usdt: 0n, spotTick: 0, twapTick: 0 as number | null, blockHashes: new Map<bigint, Hex>(),
    /** otto/mamoru#163: the Safe nonce at a past block (default: today's), Safe txs of others run at a block, and a node that cannot serve a block's logs by hash. */
    nonceAt: null as ((block: bigint) => bigint) | null, foreign: [] as { stx: Hex; hash: Hex; block: bigint }[], blockLogsDown: false }
  /** eth_calls of execTransaction the operator made. */
  const called: Hex[] = []
  const TRUE = `0x${'0'.repeat(63)}1` as const
  const factory = deployCall(liveAccountFromContext(ctx))
  const client = {
    getBlockNumber: async () => knobs.head,
    // A block has a hash of its own; `blockHashes` is what a read of that height by number answers instead (another
    // node, behind or on another view, than the one that gave the head).
    getBlock: async (a: { blockNumber?: bigint } = {}) => {
      // The head is the one getBlockNumber answers (a lagging provider lags in both).
      const n = a.blockNumber ?? knobs.head
      return { number: n, hash: (a.blockNumber !== undefined ? knobs.blockHashes.get(n) : undefined) ?? keccak256(stringToHex(`block-${n}`)), timestamp: 1_790_000_000n }
    },
    getTransactionReceipt: async () => {
      throw new Error('no receipt')
    },
    getLogs: async (a: { blockHash?: Hex } = {}) => {
      // EIP-234, a block's logs by its hash: every Safe execution of that block, ours and others', in order.
      if (a.blockHash) {
        if (knobs.blockLogsDown) throw new Error('HTTP request failed. Status: 503')
        return [...knobs.logs, ...knobs.foreign]
          .filter((l) => keccak256(stringToHex(`block-${l.block}`)) === a.blockHash)
          .map((l, i) => ({ address: SAFE, topics: [EXECUTION_SUCCESS, l.stx], transactionHash: l.hash, blockNumber: l.block, logIndex: i }))
      }
      return knobs.logs.map((l) => ({ address: SAFE, topics: [EXECUTION_SUCCESS, l.stx], transactionHash: l.hash, blockNumber: l.block }))
    },
    getCode: async () => (chain.deployed ? '0x01' : undefined),
    getBalance: async ({ address: at }: { address: string }) => (at.toLowerCase() === RELAYER.toLowerCase() ? knobs.relayerWei : 0n),
    getTransactionCount: async ({ blockTag }: { blockTag?: string }) => (blockTag === 'pending' ? 5 + knobs.relayerPending : 5),
    readContract: async ({ address: at, functionName, blockNumber, args }: { address: string; functionName: string; blockNumber?: bigint; args?: readonly unknown[] }) => {
      if (functionName === 'slot0') return [sqrtRatioAtTick(knobs.spotTick), knobs.spotTick, 0, 0, 0, 0, true]
      if (functionName === 'observe') {
        if (knobs.twapTick === null) throw new Error('execution reverted: OLD')
        return [[0n, BigInt(knobs.twapTick) * 1800n], [0n, 0n]]
      }
      if (functionName === 'nonce') return blockNumber !== undefined && knobs.nonceAt ? knobs.nonceAt(blockNumber) : chain.nonce
      if (functionName === 'balanceOf') return at.toLowerCase() === address('USDC').toLowerCase() ? chain.usdc : 0n
      if (functionName === 'isPermissionEnabled') {
        if (blockNumber !== undefined && knobs.noHistory) throw new Error('missing trie node: historical state not available')
        // grantsEnabled null: the chain model, `enabled` (what the owner txs sent through the relayer enabled and revoked).
        if (knobs.grantsEnabled === null) return knobs.enabled.has(String(args?.[0]).toLowerCase())
        return knobs.grantsEnabled && (blockNumber === undefined || blockNumber >= knobs.enabledFromBlock)
      }
      throw new Error(`unexpected read ${functionName}`)
    },
    request: async ({ params }: { params: [{ blockStateCalls: [{ calls: { from?: string; to: string; data: Hex }[] }] }] }) => {
      const calls = params[0].blockStateCalls[0].calls
      simulated.push(calls)
      if (knobs.sim === 'down') throw new Error('the method eth_simulateV1 does not exist')
      const last = calls.length - 1
      return [{ calls: calls.map((_, i) => (knobs.sim === 'revert' && i === last ? { status: '0x0', returnData: '0x', gasUsed: '0x5208', logs: [], error: { message: 'GS026' } } : { status: '0x1', returnData: TRUE, gasUsed: '0x5208', logs: [] })) }]
    },
    call: async ({ to, data }: { to: string; data: Hex }) => {
      // readSafe batches its reads through Multicall3: same answers as readContract above.
      if (to.toLowerCase() === address('Multicall3').toLowerCase()) {
        knobs.multicalls++
        const word = (v: bigint) => toHex(v, { size: 32 })
        return {
          data: answerAggregate3(data, (target, callData) => {
            if (callData.startsWith('0x3850c7bd')) return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'slot0', result: [sqrtRatioAtTick(knobs.spotTick), knobs.spotTick, 0, 0, 0, 0, true] })
            if (callData.startsWith('0x70a08231')) return word(target.toLowerCase() === address('USDC').toLowerCase() ? chain.usdc : target.toLowerCase() === address('USDT').toLowerCase() ? knobs.usdt : 0n)
            if (callData.startsWith('0x4d2301cc')) return word(0n)
            // readSafe (otto/mamoru#135): the block number rides inside this same call.
            if (callData.startsWith(toFunctionSelector('getBlockNumber()'))) return word(100n)
            // isPermissionEnabled(bytes32,address) from the chain model, when a test asks the batch to answer it.
            if (knobs.batchGrants && callData.startsWith(toFunctionSelector('isPermissionEnabled(bytes32,address)'))) {
              knobs.batchedGrantReads++
              return word(knobs.enabled.has(`0x${callData.slice(10, 74)}`.toLowerCase()) ? 1n : 0n)
            }
            throw new Error('execution reverted')
          }),
        }
      }
      called.push(data)
      if (knobs.call === 'revert') throw Object.assign(new Error('execution reverted: GS026'), { code: 3, data: '0x08c379a0' })
      if (knobs.call === 'down') throw new Error('HTTP request failed. Status: 429')
      // otto/mamoru#140 (part2 #5): what a real Safe answers, execTransaction's `true`.
      return { data: TRUE }
    },
  } as unknown as PublicClient
  const relayer = {
    address: RELAYER,
    send: async (tx: { to: string; data?: Hex; value?: bigint }, onSent?: (h: Hex) => void, onSending?: (maxFeeWei: bigint, signed: { hash: Hex; nonce: number }) => void) => {
      sent.push(tx)
      // The signed copy's hash is the hash it is sent under (otto/mamoru#163 keeps it before it leaves).
      if (!knobs.failBeforeSending) onSending?.(0n, { hash: toHex(sent.length, { size: 32 }), nonce: 4 + sent.length })
      knobs.onSend(tx)
      const hash = toHex(sent.length, { size: 32 })
      onSent?.(hash)
      const isDeploy = tx.to.toLowerCase() === factory.to.toLowerCase()
      if (isDeploy) chain.deployed = true
      else if (tx.data) chain.nonce++
      // The owner tx being executed lands: its revocations and grants on the chain model (see track).
      if (!isDeploy && tx.data && knobs.execOk && knobs.pending && tx.to.toLowerCase() === SAFE.toLowerCase()) {
        for (const id of knobs.pending.revokes ?? []) knobs.enabled.delete(id.toLowerCase())
        for (const g of knobs.pending.grants ?? []) knobs.enabled.add(g.permissionId.toLowerCase())
        knobs.pending = null
      }
      const logs = isDeploy || !knobs.execOk ? [] : [{ address: SAFE, topics: [EXECUTION_SUCCESS] }]
      return { hash, receipt: { transactionHash: hash, status: 'success', blockNumber: 99n, logs } as unknown as TransactionReceipt }
    },
  } as unknown as Relayer
  const state = { accounts: {} as Record<string, AccountState> }
  const store = { state, save: () => {} } as unknown as StateStore
  const cfg = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES[policyId]!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 } satisfies OperatorConfig
  const op = new Operator(cfg, client, relayer, store)
  ;(op as unknown as { retryMs: number }).retryMs = 0
  const w = { op, chain, sent, simulated, called, knobs, factory, state }
  // The chain model by default: grants enabled and revoked by the owner txs the relayer sent (see track).
  track(w as never)
  return w
}

/**
 * otto/mamoru#163: Safe txs of others spent the Safe nonces `before`..`after - 1` at block `at`: the Safe nonce read at
 * a block, and that block's logs by hash, show it (the evidence settlement now needs to say "not run").
 */
function spentElsewhere(w: ReturnType<typeof world>, before: bigint, after: bigint, at = 100n): void {
  w.chain.nonce = after
  w.knobs.nonceAt = (b) => (b >= at ? after : before)
  for (let n = before; n < after; n++) w.knobs.foreign.push({ stx: keccak256(stringToHex(`foreign-stx-${n}`)), hash: keccak256(stringToHex(`foreign-tx-${n}`)), block: at })
}

function der(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    let b = Buffer.from(v.toString(16).padStart(64, '0'), 'hex')
    while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1)
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b])
    return Buffer.concat([Buffer.from([0x02, b.length]), b])
  }
  const body = Buffer.concat([int(r), int(s)])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

function sign(t: OwnerTxToSign, key = passkey): OwnerSignature {
  const a = key.assert(t.safeTxHash)
  return {
    prepareId: t.prepareId,
    authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'),
    clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'),
    signature: Buffer.from(der(a.r, a.s)).toString('base64url'),
  }
}

describe('deposit over the cap', () => {
  test('funding reports DEPOSIT_OVER_CAP with the amounts, and nothing at or under the cap', async () => {
    const over = await world(OVER).op.funding(ctx)
    expect(over.capUsdc).toBe('100000000')
    expect(over.overCap).toEqual({ code: 'DEPOSIT_OVER_CAP', usdc: '101920000', capUsdc: '100000000', excessUsdc: '1920000' })
    expect((await world(LIVE_CAP_USDC).op.funding(ctx)).overCap).toBeNull()
    expect((await world(0n).op.funding(ctx)).overCap).toBeNull()
  })

  test('a running account is not reported: the cap only refuses Start', async () => {
    const w = world(OVER)
    w.op.account(ctx).acc.active = true
    expect((await w.op.funding(ctx)).overCap).toBeNull()
  })

  test('an armed approval that meets an over-cap deposit is kept, waiting, with the amounts on its op', async () => {
    const w = world(OVER)
    const { acc } = w.op.account(ctx)
    acc.ops.push({ opId: 'own-1-activate', kind: 'activate', state: 'proposed', code: 'ARMED', updatedAt: '2026-10-01T10:00:00.000Z' })
    acc.armed = { opId: 'own-1-activate', tx: { nonce: 0n } as ArmedActivation['tx'], safeTxHash: '0x', signature: '0x', grants: [], armedAt: '2026-10-01T10:00:00.000Z' }
    await (w.op as unknown as { fireArmed(a: AccountState, usdc: bigint): Promise<void> }).fireArmed(acc, OVER)
    // The owner's signature is not ours to drop: the cap may be raised, and the app shows the excess from funding.
    expect(acc.armed?.opId).toBe('own-1-activate')
    expect(acc.active).toBe(false)
    expect(w.sent).toHaveLength(0)
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ opId: 'own-1-activate', state: 'proposed', code: 'ARMED', amountUsdc: '101920000', capUsdc: '100000000' })
    expect((await w.op.funding(ctx)).overCap).toMatchObject({ code: 'DEPOSIT_OVER_CAP', usdc: '101920000' })
  })

  test('Start is refused before and after the passkey with DEPOSIT_OVER_CAP and readable amounts', async () => {
    const w = world(OVER)
    const err = await w.op.prepareActivate(ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err as HttpError).toMatchObject({ status: 409, code: 'DEPOSIT_OVER_CAP' })
    expect((err as HttpError).message).toBe('this account holds 101.92 USDC, over the 100.00 USDC cap; withdraw at least 1.92 USDC to start')
    // Signed while empty, submitted after an over-cap deposit landed.
    w.chain.usdc = 0n
    const tx = await w.op.prepareActivate(ctx)
    w.chain.usdc = OVER
    expect(await w.op.submit(ctx, 'activate', sign(tx)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'DEPOSIT_OVER_CAP' })
    expect(w.sent).toHaveLength(0)
  })

  test('the excess can leave an undeployed Safe: the relayer deploys it, then the owner transfer runs', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    expect(plan.reduce).toEqual([])
    expect(plan.ownerTx.summary).toEqual([`Create your Safe ${SAFE} on Base`, `Send 1.92 USDC from your Safe to ${TO}`])
    const done = await w.op.submit(ctx, 'transfer', sign(plan.ownerTx))
    expect(done).toMatchObject({ kind: 'transfer', state: 'confirmed', amountUsdc: '1920000', to: TO })
    // Two relayer sends: the factory call, then execTransaction. No ETH top-up: that belongs to activation.
    expect(w.sent).toHaveLength(2)
    expect(w.sent[0]).toEqual(w.factory)
    expect(w.sent[1]!.to).toBe(SAFE)
    expect(w.sent.every((t) => t.value === undefined)).toBe(true)
    // Before either send, the same two calls ran from the relayer in one simulation.
    const sim = w.simulated.at(-1)!
    expect(sim.map((c) => c.to.toLowerCase())).toEqual([w.factory.to.toLowerCase(), SAFE.toLowerCase()])
    expect(sim.map((c) => c.from)).toEqual([RELAYER, RELAYER])
    expect(sim[1]!.data).toBe(w.sent[1]!.data!)
    const exec = decodeFunctionData({ abi: safeAbi, data: w.sent[1]!.data! })
    expect(exec.functionName).toBe('execTransaction')
    expect((exec.args[0] as string).toLowerCase()).toBe(address('USDC').toLowerCase())
    expect(decodeFunctionData({ abi: erc20Abi, data: exec.args[2] as Hex })).toMatchObject({ functionName: 'transfer', args: [TO, 1_920_000n] })
    // The engine did not start and no session exists.
    expect(w.state.accounts.k).toMatchObject({ active: false, trusted: false, grants: [] })
  })

  test('once the excess left, Start prepares on the deployed Safe', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    await w.op.submit(ctx, 'transfer', sign(plan.ownerTx))
    w.chain.usdc = OVER - 1_920_000n
    expect((await w.op.funding(ctx)).overCap).toBeNull()
    const tx = await w.op.prepareActivate(ctx)
    expect(tx.summary[0]).toBe(`Use your Safe ${SAFE} on Base`)
  })

  test('an undeployed Safe cannot send more than it holds', async () => {
    const w = world(1_000_000n)
    expect(await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '2000000' }).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'INSUFFICIENT_FUNDS' })
  })
})

// otto/mamoru#137: the activation summary must say what the engine key may do without asking again, its limits,
// and that every recipient is the Safe, never a blanket "funds never leave" promise (grants.ts pins every
// collect/mint/swap recipient to ACCOUNT). manage-any/convert-any act on any Safe-owned position, in any pool,
// not only the policy's pools (grants.ts: decreaseLiquidity/collect/burn take any tokenId > 0); the disclosure
// is gated on what this activation's `stored` grants actually hold, not on the policy in the abstract, since a
// gas-capped activation (fitActivation) can leave manage-any/convert-any out. The baseline line never claims
// decrease/collect/burn on its own: the per-position 'manage' grant is excluded from the activation batch
// (perPosition) and the live engine keeps it revoked (revokeManage), so only enter-swap/enter-mint are
// unconditional, and only manage-any/convert-any — when present in `stored` — grant anything beyond that.
describe('what the activation summary says the engine key may do', () => {
  test('multi-pool: swap and mint unconditionally, act on any other position only when manage-any/convert-any are granted, every recipient is the Safe', async () => {
    const w = world(20_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    const text = tx.summary.join(' ')
    expect(text).toContain("may swap USDC into those pools' tokens and mint positions there")
    expect(text).not.toContain('manage them')
    expect(text).toContain('It may also act on any Uniswap v3 position your Safe owns, in any pool: take liquidity out, collect fees, burn it once empty, and convert')
    expect(text).toContain('It does this without asking you again, within these limits, and whatever it collects, mints or swaps is paid to your Safe, never to anyone else. For 365 days; cap 100.00 USDC')
    expect(text).not.toContain('Funds never leave')
    expect(text).not.toContain('without your passkey')
  })

  test('single pool: the same disclosure, gated on manage-any', async () => {
    const w = world(20_000_000n, 'conservador-live-v1')
    const tx = await w.op.prepareActivate(ctx)
    const text = tx.summary.join(' ')
    expect(text).toContain('may swap USDC->cbBTC')
    expect(text).toContain('and mint that pool')
    expect(text).not.toContain('manage the position')
    expect(text).toContain('It may also act on any Uniswap v3 position your Safe owns, in any pool: take liquidity out, collect fees, burn it once empty, and convert cbBTC back to USDC')
    expect(text).toContain('It does this without asking you again, within these limits, and whatever it collects, mints or swaps is paid to your Safe, never to anyone else. For 365 days; cap 100.00 USDC')
    expect(text).not.toContain('Funds never leave')
    expect(text).not.toContain('without your passkey')
  })

  test('single pool without manage-any: no "act on any position" claim, same recipient disclosure', async () => {
    const w = world(20_000_000n, 'conservador-v1')
    const tx = await w.op.prepareActivate(ctx)
    const text = tx.summary.join(' ')
    expect(text).not.toContain('any Uniswap v3 position')
    expect(text).toContain('It does this without asking you again, within these limits, and whatever it collects, mints or swaps is paid to your Safe, never to anyone else. For 365 days; cap 100.00 USDC')
  })

  test('a gas-capped activation that leaves manage-any/convert-any out of this transaction makes no "any other position" claim', async () => {
    const w = world(20_000_000n)
    // conservador-live-v2 has 3 pairs' manage-any/convert-any (12 non-perPosition grants); at 2M gas per session
    // all 3 pairs are dropped (12 -> 10 -> 8 -> 6), leaving only enter-swap/enter-mint, same as `stored` would hold.
    ;(w.op as unknown as { activationGas(...a: unknown[]): Promise<bigint> }).activationGas = async (_l, _c, sessions) => BigInt(sessions as number) * 2_000_000n
    const tx = await w.op.prepareActivate(ctx)
    const text = tx.summary.join(' ')
    expect(text).not.toContain('any Uniswap v3 position')
    expect(text).toContain('It does this without asking you again, within these limits, and whatever it collects, mints or swaps is paid to your Safe, never to anyone else.')
  })
})

// Review P1: a forged or useless owner signature must cost the relayer nothing, on every path it pays for.
// In these tests the mocked chain answers what the real one would for a forged signature: the simulation reverts.
describe('the relayer spends nothing before the owner signature is proven', () => {
  const thief = new SoftwarePasskey(PASSKEY_SCALARS.a2)
  type Privates = { fireArmed(a: AccountState, usdc: bigint): Promise<void>; watchArmed(): Promise<void>; armStopped: boolean }
  const priv = (op: Operator) => op as unknown as Privates
  const arm = async (w: ReturnType<typeof world>, key = passkey) => {
    w.chain.usdc = 0n
    const tx = await w.op.prepareActivate(ctx)
    return { tx, op: await w.op.submit(ctx, 'activate', sign(tx, key)).catch((e: unknown) => e as HttpError) }
  }

  test('transfer: a signature from another key is refused before the Safe is deployed', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    w.knobs.sim = 'revert'
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx, thief)).catch((e: unknown) => e)).toMatchObject({ status: 400, code: 'BAD_SIGNATURE' })
    expect(w.sent).toHaveLength(0)
    expect(w.chain.deployed).toBe(false)
    expect(w.op.ops(ctx, null).ops).toEqual([])
    // It cost the relayer nothing, so it counts against nothing; and an unproven caller leaves no account behind (#140 part2 #7).
    expect(w.state.accounts.k?.ownerFailures ?? []).toHaveLength(0)
    // The prepared transaction is spent: the same body cannot be tried again.
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx)).catch((e: unknown) => e)).toMatchObject({ code: 'PREPARE_UNKNOWN' })
  })

  test('activate and armed activate: a forged signature is neither executed nor armed', async () => {
    const w = world(10_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    w.knobs.sim = 'revert'
    expect(await w.op.submit(ctx, 'activate', sign(tx, thief)).catch((e: unknown) => e)).toMatchObject({ code: 'BAD_SIGNATURE' })
    const armed = await arm(w, thief)
    expect(armed.op).toMatchObject({ code: 'BAD_SIGNATURE' })
    expect(w.state.accounts.k?.armed).toBeUndefined()
    expect(w.sent).toHaveLength(0)
  })

  test('armed executor: a stored signature that does not verify fails the op without a deploy', async () => {
    const w = world(0n)
    const armed = await arm(w)
    expect(armed.op).toMatchObject({ state: 'proposed', code: 'ARMED' })
    const acc = w.state.accounts.k!
    // As if the state file held a signature the passkey never made (older operator, tampering).
    acc.armed = { ...acc.armed!, signature: browserOwnerSignature(sign(armed.tx, thief), armed.tx.safeTxHash) }
    w.chain.usdc = 10_000_000n
    w.knobs.sim = 'revert'
    await priv(w.op).fireArmed(acc, 10_000_000n)
    expect(w.sent).toHaveLength(0)
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ state: 'failed', code: 'BAD_SIGNATURE' })
    expect(acc.armed).toBeUndefined()
  })

  test('a signature over another transaction (other nonce, same Safe) is refused', async () => {
    const w = world(OVER)
    const first = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    const second = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '2920000' })
    const swapped = { ...sign(first.ownerTx), prepareId: second.ownerTx.prepareId }
    expect(await w.op.submit(ctx, 'transfer', swapped).catch((e: unknown) => e)).toMatchObject({ status: 400, code: 'BAD_SIGNATURE' })
    expect(w.sent).toHaveLength(0)
  })

  test('a valid signature whose sequence would revert is not sent: no deploy, no exec', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    w.knobs.sim = 'revert'
    const before = w.simulated.length
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx))).toMatchObject({ state: 'failed', code: 'OWNER_TX_REVERTS' })
    expect(w.simulated.length - before).toBe(3)
    expect(w.sent).toHaveLength(0)
    expect(w.chain.deployed).toBe(false)
    // No gas was spent: the refusal is not held against the account.
    expect(w.state.accounts.k!.ownerFailures ?? []).toHaveLength(0)
  })

  test('simulation unavailable never stops a proven owner: an undeployed Safe goes ahead on the signature and the minimum balance', async () => {
    const w = world(OVER)
    w.knobs.sim = 'down'
    // Preparing a plain USDC transfer does not need the simulation either.
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    const before = w.simulated.length
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx))).toMatchObject({ state: 'confirmed' })
    expect(w.simulated.length - before).toBe(3)
    expect(w.sent.map((t) => t.to)).toEqual([w.factory.to, SAFE])
  })

  test('simulation unavailable on a deployed Safe: eth_call stands in; ok sends, revert does not, and no answer at all still sends', async () => {
    const deployedWorld = () => {
      const w = world(5_000_000n)
      w.chain.deployed = true
      w.knobs.sim = 'down'
      return w
    }
    const ok = deployedWorld()
    const p1 = await ok.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    expect(await ok.op.submit(ctx, 'transfer', sign(p1.ownerTx))).toMatchObject({ state: 'confirmed' })
    expect(ok.called.length).toBeGreaterThan(0)
    expect(ok.sent).toHaveLength(1)

    const reverting = deployedWorld()
    const p2 = await reverting.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    reverting.knobs.call = 'revert'
    expect(await reverting.op.submit(ctx, 'transfer', sign(p2.ownerTx))).toMatchObject({ state: 'failed', code: 'OWNER_TX_REVERTS' })
    expect(reverting.sent).toHaveLength(0)
    expect(reverting.state.accounts.k!.ownerFailures ?? []).toHaveLength(0)

    const blind = deployedWorld()
    const p3 = await blind.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    blind.knobs.call = 'down'
    expect(await blind.op.submit(ctx, 'transfer', sign(p3.ownerTx))).toMatchObject({ state: 'confirmed' })
    expect(blind.sent).toHaveLength(1)

    // Stop, the other exit path, behaves the same.
    const stop = deployedWorld()
    stop.op.account(ctx).acc.grants = [{ name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}`, grant: {} as never }]
    stop.knobs.call = 'down'
    const tx = await stop.op.prepareStop(ctx)
    expect(await stop.op.submit(ctx, 'stop', sign(tx))).toMatchObject({ kind: 'exit', state: 'confirmed' })
    expect(stop.sent).toHaveLength(1)
  })

  test('stop goes through the same checks', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    const { acc } = w.op.account(ctx)
    acc.grants = [{ name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}`, grant: {} as never }]
    const tx = await w.op.prepareStop(ctx)
    w.knobs.sim = 'revert'
    expect(await w.op.submit(ctx, 'stop', sign(tx, thief)).catch((e: unknown) => e)).toMatchObject({ code: 'BAD_SIGNATURE' })
    w.knobs.sim = 'ok'
    const again = await w.op.prepareStop(ctx)
    w.knobs.sim = 'revert'
    expect(await w.op.submit(ctx, 'stop', sign(again))).toMatchObject({ state: 'failed', code: 'OWNER_TX_REVERTS' })
    expect(w.sent).toHaveLength(0)
  })

  test('no deploy for an account under 1 USDC: transfer and Start are refused, an armed activation waits', async () => {
    const w = world(500_000n)
    expect(await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '500000' }).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'BELOW_DEPLOY_MINIMUM' })
    expect(await w.op.prepareActivate(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'BELOW_DEPLOY_MINIMUM' })
    expect((await w.op.funding(ctx)).deployMinUsdc).toBe('1000000')
    await arm(w)
    const acc = w.state.accounts.k!
    await priv(w.op).fireArmed(acc, 500_000n)
    expect(acc.armed).toBeDefined()
    expect(w.sent).toHaveLength(0)
    // Signed while the balance was enough, executed after it dropped: refused by the preflight, still nothing sent.
    const v = world(2_000_000n)
    const plan = await v.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    v.chain.usdc = 900_000n
    expect(await v.op.submit(ctx, 'transfer', sign(plan.ownerTx))).toMatchObject({ state: 'failed', code: 'BELOW_DEPLOY_MINIMUM' })
    expect(v.sent).toHaveLength(0)
  })

  test('the budget counts only failures the relayer paid for', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    w.knobs.execOk = false
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx))).toMatchObject({ state: 'failed', code: 'OWNER_TX_FAILED' })
    expect(w.sent).toHaveLength(2)
    expect(w.state.accounts.k!.ownerFailures).toHaveLength(1)
  })

  test('a proven owner always withdraws and stops, whatever the failure counters say; only a new activation waits', async () => {
    const w = world(OVER)
    const { acc } = w.op.account(ctx)
    const recent = new Date().toISOString()
    acc.ownerFailures = Array.from({ length: MAX_OWNER_FAILURES_PER_DAY + 3 }, () => recent)
    // Other accounts failing a lot is an alert, not a gate.
    for (let i = 0; i < OWNER_FAILURES_ALERT_PER_DAY; i++) w.state.accounts[`other-${i}`] = { ownerFailures: [recent, recent] } as unknown as AccountState

    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx))).toMatchObject({ kind: 'transfer', state: 'confirmed' })
    acc.grants = [{ name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}`, grant: {} as never }]
    const stop = await w.op.prepareStop(ctx)
    expect(await w.op.submit(ctx, 'stop', sign(stop))).toMatchObject({ kind: 'exit', state: 'confirmed' })

    // A new activation of this account is what the budget holds back, with a message that says withdrawals work.
    w.chain.usdc = 20_000_000n
    const start = await w.op.prepareActivate(ctx)
    const refused = await w.op.submit(ctx, 'activate', sign(start)).catch((e: unknown) => e as HttpError)
    expect(refused).toMatchObject({ status: 429, code: 'OWNER_FAILURE_BUDGET' })
    expect((refused as HttpError).message).toContain('withdrawals still work')
    // Failures older than 24 hours no longer count.
    acc.ownerFailures = acc.ownerFailures!.map(() => new Date(Date.now() - 25 * 3_600_000).toISOString())
    w.chain.usdc = 0n
    const again = await w.op.prepareActivate(ctx)
    expect(await w.op.submit(ctx, 'activate', sign(again))).toMatchObject({ code: 'ARMED' })
  })

  test('failures of other accounts never gate this one, not even its activation', async () => {
    const w = world(0n)
    w.op.account(ctx)
    const recent = new Date().toISOString()
    for (let i = 0; i < OWNER_FAILURES_ALERT_PER_DAY; i++) w.state.accounts[`other-${i}`] = { ownerFailures: [recent, recent] } as unknown as AccountState
    expect((await arm(w)).op).toMatchObject({ state: 'proposed', code: 'ARMED' })
  })

  test('an armed approval of an account over its budget waits without a send, and runs once the budget frees', async () => {
    const v = world(0n)
    await arm(v)
    const armedAcc = v.state.accounts.k!
    armedAcc.ownerFailures = Array.from({ length: MAX_OWNER_FAILURES_PER_DAY }, () => new Date().toISOString())
    v.chain.usdc = 10_000_000n
    await priv(v.op).fireArmed(armedAcc, 10_000_000n)
    expect(armedAcc.armed).toBeDefined()
    expect(v.op.ops(ctx, null).ops[0]).toMatchObject({ state: 'proposed', code: 'ARMED' })
    expect(v.sent).toHaveLength(0)
    // A day later the failures are out of the window: the same signature runs.
    armedAcc.ownerFailures = []
    await priv(v.op).fireArmed(armedAcc, 10_000_000n)
    expect(armedAcc.armed).toBeUndefined()
    expect(armedAcc.active).toBe(true)
  })
})

// The off-chain signature check is a mirror of the on-chain verifier. otto/mamoru#140 (part2 #5): when the mirror says
// no, the operator's one provider is not proof (a dishonest one says yes to anything): its revert refuses, its yes alone
// refuses too (OWNER_SIG_UNVERIFIED). The MAMORU_RPC_TRUSTED quorum that can prove it is tested in owner-hardening.test.ts.
// Here "odd" signatures stand for a real authenticator the mirror gets wrong (mirror says no).
describe('the off-chain signature check is overruled only by independent providers', () => {
  const odd = new SoftwarePasskey(PASSKEY_SCALARS.a2)
  const errors = async <T>(run: () => Promise<T>): Promise<{ out: T; logged: string[] }> => {
    const logged: string[] = []
    const error = console.error
    console.error = (...args: unknown[]) => void logged.push(String(args[0]))
    try {
      return { out: await run(), logged }
    } finally {
      console.error = error
    }
  }

  test('mirror says no, the one provider says yes: not sent, refused as unverified, alert logged with the assertion shape', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    const { out, logged } = await errors(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx, odd)).catch((e: unknown) => e))
    expect(out).toMatchObject({ status: 400, code: 'OWNER_SIG_UNVERIFIED' })
    expect(w.sent).toHaveLength(0)
    const line = logged.find((l) => l.includes('OWNER_SIG_UNVERIFIED'))!
    expect(line).toContain('k transfer')
    const shape = JSON.parse(line.slice(line.indexOf('shape ') + 6)) as Record<string, unknown>
    expect(shape).toMatchObject({ authenticatorDataLength: 37, flags: '0x05', clientDataKeys: ['type', 'challenge', 'origin', 'crossOrigin'], clientDataPrefixOk: true, signatureDer: 'ok', highS: false })
    // Nothing secret or identifying: no key, no signature bytes, no challenge, no origin value.
    expect(line).not.toContain(plan.ownerTx.safeTxHash.slice(2, 20))
    expect(line).not.toContain('mamoru.lol')
    expect(w.state.accounts.k?.ownerFailures ?? []).toHaveLength(0)
  })

  test('mirror says no, simulation reverts: nothing is sent', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    w.knobs.sim = 'revert'
    const { out, logged } = await errors(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx, odd)).catch((e: unknown) => e))
    expect(out).toMatchObject({ status: 400, code: 'BAD_SIGNATURE' })
    expect(w.sent).toHaveLength(0)
    expect(w.op.mirrorMismatches).toBe(0)
    expect(logged.some((l) => l.includes('OWNER_SIG_MIRROR_MISMATCH'))).toBe(false)
  })

  test('mirror says no, nothing can answer for an undeployed Safe: 503, retryable with the same body, nothing sent, no budget hit', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    const body = sign(plan.ownerTx, odd)
    w.knobs.sim = 'down'
    const { out } = await errors(() => w.op.submit(ctx, 'transfer', body).catch((e: unknown) => e))
    expect(out).toMatchObject({ status: 503, code: 'OWNER_CHECK_UNAVAILABLE' })
    expect(w.sent).toHaveLength(0)
    expect(w.op.ops(ctx, null).ops).toEqual([])
    expect(w.state.accounts.k?.ownerFailures ?? []).toHaveLength(0)
    // Once the one provider answers yes it is still not proof: refused, never sent.
    w.knobs.sim = 'ok'
    expect((await errors(() => w.op.submit(ctx, 'transfer', body).catch((e: unknown) => e))).out).toMatchObject({ code: 'OWNER_SIG_UNVERIFIED' })
    expect(w.sent).toHaveLength(0)
  })

  test('mirror says no on a deployed Safe without simulation: an eth_call revert refuses, a yes or no answer sends nothing', async () => {
    const make = async (call: 'ok' | 'revert' | 'down') => {
      const w = world(5_000_000n)
      w.chain.deployed = true
      const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
      w.knobs.sim = 'down'
      w.knobs.call = call
      return { w, ...(await errors(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx, odd)).catch((e: unknown) => e))) }
    }
    const ok = await make('ok')
    expect(ok.out).toMatchObject({ status: 400, code: 'OWNER_SIG_UNVERIFIED' })
    expect(ok.w.sent).toHaveLength(0)
    const reverting = await make('revert')
    expect(reverting.out).toMatchObject({ status: 400, code: 'BAD_SIGNATURE' })
    expect(reverting.w.sent).toHaveLength(0)
    const blind = await make('down')
    expect(blind.out).toMatchObject({ status: 503, code: 'OWNER_CHECK_UNAVAILABLE' })
    expect(blind.w.sent).toHaveLength(0)
    expect(blind.w.state.accounts.k?.ownerFailures ?? []).toHaveLength(0)
  })

  test('stop follows the same rule', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [{ name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}`, grant: {} as never }]
    const tx = await w.op.prepareStop(ctx)
    const { out, logged } = await errors(() => w.op.submit(ctx, 'stop', sign(tx, odd)).catch((e: unknown) => e))
    expect(out).toMatchObject({ code: 'OWNER_SIG_UNVERIFIED' })
    expect(w.sent).toHaveLength(0)
    expect(logged.some((l) => l.includes('OWNER_SIG_UNVERIFIED') && l.includes('k stop'))).toBe(true)
  })

  test('armed executor: a stored signature the mirror refuses is neither dropped nor sent while the chain cannot be asked', async () => {
    const w = world(0n)
    w.chain.usdc = 0n
    const tx = await w.op.prepareActivate(ctx)
    expect(await w.op.submit(ctx, 'activate', sign(tx))).toMatchObject({ code: 'ARMED' })
    const acc = w.state.accounts.k!
    acc.armed = { ...acc.armed!, signature: browserOwnerSignature(sign(tx, odd), tx.safeTxHash) }
    w.chain.usdc = 10_000_000n
    w.knobs.sim = 'down'
    await errors(() => (w.op as unknown as { fireArmed(a: AccountState, usdc: bigint): Promise<void> }).fireArmed(acc, 10_000_000n))
    expect(w.sent).toHaveLength(0)
    expect(acc.armed?.tries).toBe(1)
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ state: 'proposed', code: 'ARMED' })
    expect(acc.ownerFailures ?? []).toHaveLength(0)
  })

  test('a body no Safe signature can be built from is refused and its shape logged', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    const good = sign(plan.ownerTx)
    const { out, logged } = await errors(() => w.op.submit(ctx, 'transfer', { ...good, signature: Buffer.from('3006020101020101ff', 'hex').toString('base64url') }).catch((e: unknown) => e))
    expect(out).toMatchObject({ status: 400, code: 'BAD_SIGNATURE' })
    expect(logged.find((l) => l.includes('OWNER_SIG_UNPARSEABLE'))).toContain('"signatureDer":"DER signature: bad length"')
    expect(w.sent).toHaveLength(0)
  })

  test('mirror says yes: nothing changes and nothing is logged as a mismatch', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    const { out, logged } = await errors(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))
    expect(out).toMatchObject({ state: 'confirmed' })
    expect(w.op.mirrorMismatches).toBe(0)
    expect(logged.some((l) => l.includes('MISMATCH'))).toBe(false)
  })
})

// Review P1: the cap is read again right before the activation is sent.
describe('cap re-check at send time', () => {
  test('a deposit that lands while the Safe is being deployed stops the activation with DEPOSIT_OVER_CAP', async () => {
    const w = world(20_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    // The deposit lands with the first relayer transaction: after the preflight, before the activation.
    w.knobs.onSend = () => {
      w.chain.usdc = OVER
    }
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    expect(op).toMatchObject({ kind: 'activate', state: 'failed', code: 'DEPOSIT_OVER_CAP', amountUsdc: '101920000', capUsdc: '100000000' })
    expect(w.sent.some((t) => t.to === SAFE && t.data !== undefined)).toBe(false)
    expect(w.state.accounts.k).toMatchObject({ active: false, grants: [] })
    expect((await w.op.funding(ctx)).overCap?.excessUsdc).toBe('1920000')
  })

  test('a deposit that lands before the preflight is refused before any relayer transaction', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    await w.op.submit(ctx, 'activate', sign(tx))
    const acc = w.state.accounts.k!
    // The watcher saw 20 USDC; by the time it executes, the account holds 101.92.
    w.chain.usdc = OVER
    await (w.op as unknown as { fireArmed(a: AccountState, usdc: bigint): Promise<void> }).fireArmed(acc, 20_000_000n)
    expect(w.sent).toHaveLength(0)
    // Refused for now, and the approval is kept for when the account is back within the cap.
    expect(acc.armed).toBeDefined()
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ state: 'proposed', code: 'ARMED', amountUsdc: '101920000' })
    w.chain.usdc = 20_000_000n
    await (w.op as unknown as { fireArmed(a: AccountState, usdc: bigint): Promise<void> }).fireArmed(acc, 20_000_000n)
    expect(acc.active).toBe(true)
  })
})

// Review P2: the owner can withdraw while an activation is still armed, and that activation is invalidated cleanly.
describe('withdrawing with an armed activation', () => {
  test('the transfer runs at nonce 0 and the armed activation is superseded, so the app asks for a fresh Start', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    expect(armed.code).toBe('ARMED')
    // 101.92 USDC lands; the owner withdraws the excess before the watcher has looked.
    w.chain.usdc = OVER
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx))).toMatchObject({ state: 'confirmed' })
    const acc = w.state.accounts.k!
    expect(acc.armed).toBeUndefined()
    expect(w.op.ops(ctx, null).ops.find((o) => o.opId === armed.opId)).toMatchObject({ state: 'failed', code: 'ARMED_SUPERSEDED' })
    // The stale activation can never run: the Safe is at nonce 1. A new Start prepares at that nonce.
    w.chain.usdc = OVER - 1_920_000n
    const fresh = await w.op.prepareActivate(ctx)
    expect(fresh.safeTxHash).not.toBe(tx.safeTxHash)
    expect(fresh.summary[0]).toBe(`Use your Safe ${SAFE} on Base`)
  })
})


// otto/mamoru#85: the watcher cost one eth_call per armed account per tick; it is one request for all of them.
describe('the armed watcher reads every armed Safe in one request', () => {
  type Reads = { call(a: { to: string; data: Hex }): Promise<unknown>; readContract(a: { address: string; functionName: string; args?: readonly unknown[] }): Promise<unknown> }
  type Watcher = { checkArmed(): Promise<void>; fireArmed(a: AccountState, usdc: bigint): Promise<void>; armRead: Map<string, number>; armSeen: Map<string, number> }
  const priv = (op: Operator) => op as unknown as Watcher
  const pass = (op: Operator) => priv(op).checkArmed()
  const clientOf = (op: Operator) => (op as unknown as { client: Reads }).client
  const isMulticall = (to: string) => to.toLowerCase() === address('Multicall3').toLowerCase()
  const word = (v: bigint) => toHex(v, { size: 32 })
  /** The holder a balanceOf(address) calldata asks about. */
  const holderOf = (callData: Hex) => getAddress(`0x${callData.slice(34)}`)
  /** Counts the Multicall3 requests and the single balance reads the operator makes from here on. */
  const count = (op: Operator) => {
    const client = clientOf(op)
    const seen = { multicall: 0, balanceOf: 0 }
    const { call, readContract } = client
    client.call = (a) => (isMulticall(a.to) && seen.multicall++, call(a))
    client.readContract = (a) => (a.functionName === 'balanceOf' && seen.balanceOf++, readContract(a))
    return seen
  }
  /** The USDC balance of each Safe, in the batch and in single reads; `fail` makes that way of reading throw. */
  const balances = (op: Operator, usdc: Record<string, bigint>, fail: { batch?: boolean; slot?: boolean; single?: boolean } = {}) => {
    const client = clientOf(op)
    const { readContract } = client
    client.call = async (a) => {
      if (!isMulticall(a.to)) throw new Error('unexpected call')
      if (fail.batch) throw new Error('HTTP request failed. Status: 429')
      return { data: answerAggregate3(a.data, (_target, callData) => { if (fail.slot) throw new Error('execution reverted'); return word(usdc[holderOf(callData)] ?? 0n) }) }
    }
    client.readContract = async (a) => {
      if (a.functionName !== 'balanceOf') return readContract(a)
      if (fail.single) throw new Error('HTTP request failed. Status: 429')
      return usdc[getAddress(a.args![0] as string)] ?? 0n
    }
    return fail
  }
  /** Every fireArmed the watcher started, without executing it. */
  const fired = (op: Operator) => {
    const out: { key: string; usdc: bigint }[] = []
    priv(op).fireArmed = async (a, usdc) => void out.push({ key: a.accountKey, usdc })
    return out
  }
  /** One armed account `k` plus two copies of it on other Safes. */
  const three = async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    expect((await w.op.submit(ctx, 'activate', sign(tx))).code).toBe('ARMED')
    const acc = w.state.accounts.k!
    for (const [key, safe] of [['k2', TO], ['k3', getAddress(RELAYER)]] as const) w.state.accounts[key] = { ...acc, accountKey: key, ctx: { ...acc.ctx, accountKey: key, address: safe } }
    return w
  }

  test('three armed accounts with nothing deposited: one Multicall3 request, no single read, nothing sent', async () => {
    const w = await three()
    const seen = count(w.op)
    await pass(w.op)
    expect(seen).toEqual({ multicall: 1, balanceOf: 0 })
    expect(w.sent).toHaveLength(0)
    expect(Object.values(w.state.accounts).every((a) => a.armed)).toBe(true)
  })

  test('only the Safe that received the deposit is executed, with its own balance', async () => {
    const w = await three()
    balances(w.op, { [TO]: 7_000_000n })
    const out = fired(w.op)
    await pass(w.op)
    expect(out).toEqual([{ key: 'k2', usdc: 7_000_000n }])
  })

  test('the amount executed is the one read on its own after the batch, not the one the batch saw', async () => {
    const w = await three()
    const usdc: Record<string, bigint> = { [TO]: 7_000_000n }
    balances(w.op, usdc)
    const client = clientOf(w.op)
    const { call } = client
    // More USDC lands between the batch and the single read.
    client.call = async (a) => { const r = await call(a); usdc[TO] = 9_000_000n; return r }
    const out = fired(w.op)
    await pass(w.op)
    expect(out).toEqual([{ key: 'k2', usdc: 9_000_000n }])
  })

  test('an activation armed days ago with no owner around is read every five minutes, and at once when the app opens', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    const stored = w.state.accounts.k!.ops.find((o) => o.opId === armed.opId)!
    stored.updatedAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const seen = count(w.op)
    await pass(w.op)
    await pass(w.op)
    expect(seen.multicall).toBe(1)
    // Four minutes after the last read: not yet. Five: read again.
    priv(w.op).armRead.set('k', Date.now() - 240_000)
    await pass(w.op)
    expect(seen.multicall).toBe(1)
    priv(w.op).armRead.set('k', Date.now() - 301_000)
    await pass(w.op)
    expect(seen.multicall).toBe(2)
    // The owner opens the app: funding marks the account, every pass reads it again.
    await w.op.funding(ctx)
    // funding reads the Safe through Multicall3 too: count the watcher's passes from here.
    const before = seen.multicall
    await pass(w.op)
    await pass(w.op)
    expect(seen.multicall - before).toBe(2)
  })

  test('armed between a day and an hour ago: read once a minute', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    w.state.accounts.k!.ops.find((o) => o.opId === armed.opId)!.updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
    const seen = count(w.op)
    await pass(w.op)
    priv(w.op).armRead.set('k', Date.now() - 30_000)
    await pass(w.op)
    expect(seen.multicall).toBe(1)
    priv(w.op).armRead.set('k', Date.now() - 61_000)
    await pass(w.op)
    expect(seen.multicall).toBe(2)
  })

  test('a clock set back does not hide an armed account: a last read in the future is read at once', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    w.state.accounts.k!.ops.find((o) => o.opId === armed.opId)!.updatedAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
    priv(w.op).armRead.set('k', Date.now() + 3_600_000)
    const seen = count(w.op)
    await pass(w.op)
    expect(seen.multicall).toBe(1)
  })

  test('a failed read does not count as a read: the idle account is tried again on the next pass', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    w.state.accounts.k!.ops.find((o) => o.opId === armed.opId)!.updatedAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const out = fired(w.op)
    // The whole batch fails, then its slot and the single read fail: neither marks the account as read.
    const fail = balances(w.op, { [SAFE]: 5_000_000n }, { batch: true })
    await pass(w.op)
    expect(priv(w.op).armRead.has('k')).toBe(false)
    fail.batch = false
    fail.slot = fail.single = true
    await pass(w.op)
    expect(priv(w.op).armRead.has('k')).toBe(false)
    expect(out).toEqual([])
    // The provider is back: the very next pass sees the deposit.
    fail.slot = fail.single = false
    await pass(w.op)
    expect(out).toEqual([{ key: 'k', usdc: 5_000_000n }])
  })

  test('more armed accounts than one request carries: a failed request loses only its own accounts', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    await w.op.submit(ctx, 'activate', sign(tx))
    const acc = w.state.accounts.k!
    delete w.state.accounts.k
    const safeOf = (i: number) => getAddress(toHex(0x1000 + i, { size: 20 }))
    for (let i = 0; i < 150; i++) w.state.accounts[`a${i}`] = { ...acc, accountKey: `a${i}`, ctx: { ...acc.ctx, accountKey: `a${i}`, address: safeOf(i) } }
    // A deposit in the first request's accounts and one in the second's.
    balances(w.op, { [safeOf(3)]: 4_000_000n, [safeOf(120)]: 6_000_000n })
    const client = clientOf(w.op)
    const { call } = client
    let requests = 0
    client.call = async (a) => {
      if (++requests === 2) throw new Error('HTTP request failed. Status: 429')
      return call(a)
    }
    const out = fired(w.op)
    await pass(w.op)
    expect(requests).toBe(2)
    expect(out).toEqual([{ key: 'a3', usdc: 4_000_000n }])
    expect(priv(w.op).armRead.size).toBe(100)
    // Next pass: the 50 accounts of the failed request are due at once, and their deposit is seen.
    await pass(w.op)
    expect(out).toContainEqual({ key: 'a120', usdc: 6_000_000n })
    expect(priv(w.op).armRead.size).toBe(150)
  })

  test('the batch sees a deposit but the single read fails: nothing is executed and the next pass tries again', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    w.state.accounts.k!.ops.find((o) => o.opId === armed.opId)!.updatedAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const fail = balances(w.op, { [SAFE]: 5_000_000n }, { single: true })
    const out = fired(w.op)
    await pass(w.op)
    expect(out).toEqual([])
    expect(w.state.accounts.k!.armed).toBeDefined()
    fail.single = false
    await pass(w.op)
    expect(out).toEqual([{ key: 'k', usdc: 5_000_000n }])
  })

  test('no armed account: no request at all', async () => {
    const w = world(0n)
    const seen = count(w.op)
    await pass(w.op)
    expect(seen).toEqual({ multicall: 0, balanceOf: 0 })
  })

  test('a deposit is executed by the relayer and the op leaves the armed state', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    w.chain.usdc = 10_000_000n
    await pass(w.op)
    expect(w.state.accounts.k!.armed).toBeUndefined()
    expect(w.sent.length).toBeGreaterThan(0)
    expect(w.op.ops(ctx, null).ops.find((o) => o.opId === armed.opId)?.code).toBeUndefined()
  })
})

// The keyed RPC provider has an hourly budget: over it the loops that can wait do less, and nothing is read elsewhere.
describe('over the RPC budget the background loops slow down', () => {
  type Run = { engine: { journal: { ops: { state: string }[] } }; reviewedAt?: number; includedAt?: number }
  type Braked = { reviewBraked(r: Run, now?: number): boolean; checkArmed(): Promise<void>; armRead: Map<string, number>; cfg: { rpcBudget?: { over(): boolean; cuPerHour: number } } }
  const priv = (op: Operator) => op as unknown as Braked
  const budget = (op: Operator, over: boolean) => {
    const b = { cuPerHour: 40_000, over: () => over }
    priv(op).cfg.rpcBudget = b
    return b
  }
  const idle = { journal: { ops: [{ state: 'confirmed' }, { state: 'failed' }] } }
  const NOW = Date.now()

  test('under the budget no review is skipped', () => {
    const w = world(0n)
    budget(w.op, false)
    expect(priv(w.op).reviewBraked({ engine: idle, reviewedAt: NOW - 1_000 }, NOW)).toBe(false)
  })

  test('over the budget an idle account whose last decision started under 15 minutes ago is skipped, and reviewed again after that', () => {
    const w = world(0n)
    budget(w.op, true)
    expect(priv(w.op).reviewBraked({ engine: idle, reviewedAt: NOW - 5 * 60_000 }, NOW)).toBe(true)
    expect(priv(w.op).reviewBraked({ engine: idle, reviewedAt: NOW - 14 * 60_000 }, NOW)).toBe(true)
    expect(priv(w.op).reviewBraked({ engine: idle, reviewedAt: NOW - 15 * 60_000 }, NOW)).toBe(false)
  })

  test('over the budget an account with no decision yet in this run is not skipped', () => {
    const w = world(0n)
    budget(w.op, true)
    expect(priv(w.op).reviewBraked({ engine: idle }, NOW)).toBe(false)
    expect(priv(w.op).reviewBraked({ engine: { journal: { ops: [] } } }, NOW)).toBe(false)
  })

  test('over the budget an operation left included is picked up at the normal pace for 30 minutes, then at the braked pace', () => {
    const w = world(0n)
    budget(w.op, true)
    const run: Run = { engine: { journal: { ops: [{ state: 'confirmed' }, { state: 'included' }] } }, reviewedAt: NOW - 1_000 }
    expect(priv(w.op).reviewBraked(run, NOW)).toBe(false)
    expect(run.includedAt).toBe(NOW)
    run.reviewedAt = NOW + 29 * 60_000 - 1_000
    expect(priv(w.op).reviewBraked(run, NOW + 29 * 60_000)).toBe(false)
    // Still included after 30 minutes (a safe head that does not move): the brake applies again, it is not off for good.
    run.reviewedAt = NOW + 31 * 60_000 - 1_000
    expect(priv(w.op).reviewBraked(run, NOW + 31 * 60_000)).toBe(true)
    // And it is still reviewed, at the braked pace.
    expect(priv(w.op).reviewBraked(run, NOW + 31 * 60_000 - 1_000 + 15 * 60_000)).toBe(false)
  })

  test('the 30 minutes are per operation: once it ends, the next one left included starts its own', () => {
    const w = world(0n)
    const b = budget(w.op, true)
    const ops = [{ state: 'included' }]
    const run: Run = { engine: { journal: { ops } }, reviewedAt: NOW - 1_000 }
    expect(priv(w.op).reviewBraked(run, NOW)).toBe(false)
    // It confirms while the budget is not over: the mark is cleared even though the brake was not asked.
    ops[0]!.state = 'confirmed'
    b.over = () => false
    expect(priv(w.op).reviewBraked(run, NOW + 60_000)).toBe(false)
    expect(run.includedAt).toBeUndefined()
    // Two hours later another operation is left included, over the budget: it gets its own 30 minutes.
    b.over = () => true
    ops.push({ state: 'included' })
    run.reviewedAt = NOW + 2 * 3_600_000 - 1_000
    expect(priv(w.op).reviewBraked(run, NOW + 2 * 3_600_000)).toBe(false)
    expect(run.includedAt).toBe(NOW + 2 * 3_600_000)
  })

  test('a clock set back does not stretch the 30 minutes of an included operation', () => {
    const w = world(0n)
    budget(w.op, true)
    const run: Run = { engine: { journal: { ops: [{ state: 'included' }] } }, reviewedAt: NOW - 1_000, includedAt: NOW + 6 * 3_600_000 }
    expect(priv(w.op).reviewBraked(run, NOW)).toBe(false)
    expect(run.includedAt).toBe(NOW)
  })

  test('an operation no review picks up again does not switch the brake off: it would stay off for good', () => {
    const w = world(0n)
    budget(w.op, true)
    for (const state of ['pending_reconciliation', 'confirmed', 'failed', 'discarded']) {
      expect(priv(w.op).reviewBraked({ engine: { journal: { ops: [{ state }] } }, reviewedAt: NOW - 1_000 }, NOW)).toBe(true)
    }
  })

  test('a clock set back does not keep an account unreviewed', () => {
    const w = world(0n)
    budget(w.op, true)
    expect(priv(w.op).reviewBraked({ engine: idle, reviewedAt: NOW + 3_600_000 }, NOW)).toBe(false)
  })

  test('armed Safes are read at most once a minute over the budget, every pass under it, and a funding read is never held', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    await w.op.submit(ctx, 'activate', sign(tx))
    const client = (w.op as unknown as { client: { call(a: { to: string; data: Hex }): Promise<unknown> } }).client
    const { call } = client
    let multicalls = 0
    client.call = (a) => (a.to.toLowerCase() === address('Multicall3').toLowerCase() && multicalls++, call(a))
    // Under the budget a freshly armed Safe is read on every pass.
    const b = budget(w.op, false)
    await priv(w.op).checkArmed()
    await priv(w.op).checkArmed()
    expect(multicalls).toBe(2)
    // The budget trips: the Safe just read waits a minute from its own last read, not from the last pass.
    b.over = () => true
    await priv(w.op).checkArmed()
    expect(multicalls).toBe(2)
    priv(w.op).armRead.set('k', Date.now() - 59_000)
    await priv(w.op).checkArmed()
    expect(multicalls).toBe(2)
    priv(w.op).armRead.set('k', Date.now() - 61_000)
    await priv(w.op).checkArmed()
    expect(multicalls).toBe(3)
    // Over the budget the owner still reads the account: funding does not ask the budget.
    const before = multicalls
    expect((await w.op.funding(ctx)).usdc).toBe('0')
    expect(multicalls).toBeGreaterThan(before)
  })
})

// A relayer short of ETH is ours to fix: the owner's signed Start waits armed and runs once the relayer is funded.
describe('an activation waits for the relayer instead of failing', () => {
  type Privates = { fireArmed(a: AccountState, usdc: bigint): Promise<void>; relayerBalanceCache: unknown }
  const priv = (op: Operator) => op as unknown as Privates
  /** Funds the relayer and drops the 60 s balance cache, as the minute passing would. */
  const fund = (w: ReturnType<typeof world>, wei: bigint) => {
    w.knobs.relayerWei = wei
    priv(w.op).relayerBalanceCache = null
  }
  const SHORT = 100_000_000_000_000n

  test('Start with the deposit already there and the relayer short: armed, nothing sent, nothing counted', async () => {
    const w = world(20_000_000n)
    w.knobs.relayerWei = SHORT
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    expect(op).toMatchObject({ kind: 'activate', state: 'proposed', code: 'ARMED' })
    expect(w.sent).toHaveLength(0)
    const acc = w.state.accounts.k!
    expect(acc.armed?.opId).toBe(op.opId)
    expect(acc.ownerFailures ?? []).toHaveLength(0)
    // Still short: the watcher leaves it armed and does not use up a try.
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.armed?.tries ?? 0).toBe(0)
    expect(w.sent).toHaveLength(0)
    // Funded: the same signature runs without the owner.
    fund(w, 10n ** 18n)
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.armed).toBeUndefined()
    expect(acc.active).toBe(true)
    expect(w.sent.map((t) => t.to)).toEqual([w.factory.to, SAFE, SAFE])
  })

  test('the relayer runs out mid-way (insufficient funds): the same op goes back to armed, at no cost to the owner', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase()) throw new Error('insufficient funds for gas * price + value: have 1 want 2')
    }
    // The relayer reads as funded (a stale minute of cache): the node is what refuses.
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    expect(acc.armed?.opId).toBe(op.opId)
    expect(w.op.ops(ctx, null).ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'proposed', code: 'ARMED' })
    expect(acc.ownerFailures ?? []).toHaveLength(0)
    // The armed retry that hits the same refusal does not use up a try either.
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.armed?.tries ?? 0).toBe(0)
    w.knobs.onSend = () => {}
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.active).toBe(true)
  })

  test('rearm never brings back an op whose execTransaction went out, nor overrides a newer armed activation', async () => {
    type Rearm = { rearm(a: AccountState, op: OpView, p: unknown, sig: Hex): void }
    const w = world(20_000_000n)
    w.knobs.relayerWei = SHORT
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    const acc = w.state.accounts.k!
    const p = { tx: acc.armed!.tx, safeTxHash: acc.armed!.safeTxHash, grants: [] }
    const sent: OpView = { opId: 'own-9-activate', kind: 'activate', state: 'submitted', txHash: '0x01', updatedAt: '2026-10-04T00:00:00Z' }
    const later: OpView = { opId: 'own-10-activate', kind: 'activate', state: 'submitted', updatedAt: '2026-10-04T00:00:00Z' }
    acc.ops.push(sent as never, later as never)
    ;(w.op as unknown as Rearm).rearm(acc, sent, p, '0x')
    ;(w.op as unknown as Rearm).rearm(acc, later, p, '0x')
    expect(acc.ops.find((o) => o.opId === 'own-9-activate')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.ops.find((o) => o.opId === 'own-10-activate')).toMatchObject({ state: 'failed', code: 'ARMED_SUPERSEDED' })
    expect(acc.armed?.opId).toBe(armed.opId)
  })

  test('an armed activation whose execTransaction went out is never sent again, whatever the error after it', async () => {
    type Send = (tx: { to: string; data?: Hex; value?: bigint }, onSent?: (h: Hex) => void) => Promise<unknown>
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    const relayer = (w.op as unknown as { relayer: { send: Send } }).relayer
    const send = relayer.send.bind(relayer)
    relayer.send = async (t, onSent) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && t.data) {
        onSent?.(`0x${'ab'.repeat(32)}`)
        throw new Error('insufficient funds for gas * price + value (receipt poll)')
      }
      return send(t, onSent)
    }
    w.chain.usdc = 20_000_000n
    const acc = w.state.accounts.k!
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.armed).toBeUndefined()
    expect(acc.ops.find((o) => o.opId === armed.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR', txHash: `0x${'ab'.repeat(32)}` })
  })

  test('the provider refuses the execTransaction (JSON-RPC error, nothing broadcast): the op waits armed and the next pass sends it', async () => {
    const w = world(20_000_000n)
    let refuse = true
    w.knobs.onSend = (t) => {
      if (refuse && t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { name: 'InvalidInputRpcError', code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    expect(acc.armed).toMatchObject({ opId: op.opId, tries: 1 })
    expect(acc.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'proposed', code: 'ARMED' })
    expect(acc.ownerFailures ?? []).toHaveLength(0)
    refuse = false
    // Not at once: the transaction was handed to the provider, so the retry waits the full three minutes.
    expect(acc.armed!.retryAt! - Date.now()).toBeGreaterThan(170_000)
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.armed).toBeDefined()
    expect(w.sent.filter((t) => t.data && t.to.toLowerCase() === SAFE.toLowerCase())).toHaveLength(1)
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.armed).toBeUndefined()
    expect(acc.active).toBe(true)
  })

  test('the Safe nonce moved after an attempt of ours: the op goes to reconciliation, not to ARMED_NONCE_MOVED', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    expect(acc.armed?.tries).toBe(1)
    // The refused attempt landed after all: the Safe executed it. The relayer is left short of ETH by it, and the
    // moved nonce is still seen.
    w.chain.nonce = 1n
    w.chain.deployed = true
    fund(w, SHORT)
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.armed).toBeUndefined()
    expect(acc.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('the nonce moved and the signed grants are enabled on the Safe: the attempt landed, the account is started, whenever it was', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    const signed = acc.armed!.grants.map((g) => g.permissionId)
    // Hours later (the operator was down): the copy had landed, and the engine's grants are on the Safe.
    w.chain.nonce = 1n
    w.knobs.grantsEnabled = true
    // The fake chain's head is block 100; the activation executed in block 63.
    w.knobs.enabledFromBlock = 63n
    // otto/mamoru#140 (I2): what proves it is the Safe's ExecutionSuccess of its own Safe tx hash in that block.
    w.knobs.logs.push({ stx: acc.armed!.safeTxHash, hash: `0x${'63'.repeat(32)}`, block: 63n })
    acc.armed!.sentAt = Date.now() - 60_000
    acc.ops.find((o) => o.opId === op.opId)!.updatedAt = '2026-10-01T00:00:00.000Z'
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n).catch(() => undefined)
    expect(acc.active).toBe(true)
    expect(acc.armed).toBeUndefined()
    expect(acc.grants.map((g) => g.permissionId)).toEqual(signed)
    expect(acc.ownerFailures ?? []).toHaveLength(0)
    // Deposits and history are read from the block it executed in, not from the one it was noticed in.
    expect(acc.depositsAfter).toBe('63')
    expect(acc.historyFromBlock).toBe('63')
  })

  test('a head behind the node that saw the grant enabled settles nothing: the approval stays armed for the next pass', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    w.chain.nonce = 1n
    w.knobs.grantsEnabled = true
    // Enabled from block 105, and the head this provider reports is still 100.
    w.knobs.enabledFromBlock = 105n
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n).catch(() => undefined)
    expect(acc.active).toBe(false)
    expect(acc.armed?.opId).toBe(op.opId)
    // A head that answers "not yet" is waited for, however many passes: an engine started on it would see no grant.
    for (let i = 0; i < 5; i++) await priv(w.op).fireArmed(acc, 20_000_000n).catch(() => undefined)
    expect(acc.active).toBe(false)
    expect(acc.armed?.opId).toBe(op.opId)
    // The head catches up: the account starts from the block it executed in (its own ExecutionSuccess there).
    w.knobs.enabledFromBlock = 97n
    w.knobs.logs.push({ stx: acc.armed!.safeTxHash, hash: `0x${'97'.repeat(32)}`, block: 97n })
    await priv(w.op).fireArmed(acc, 20_000_000n).catch(() => undefined)
    expect(acc.active).toBe(true)
    expect(acc.depositsAfter).toBe('97')
  })

  test('otto/mamoru#140: the signed grants enabled without the ExecutionSuccess of its Safe tx hash do not start the account', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const op = await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    // The owner enabled the same sessions in a transaction of their own (another Safe tx hash), spending the nonce.
    w.chain.nonce = 1n
    w.knobs.grantsEnabled = true
    w.knobs.enabledFromBlock = 63n
    w.knobs.logs.push({ stx: `0x${'77'.repeat(32)}`, hash: `0x${'63'.repeat(32)}`, block: 63n })
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n).catch(() => undefined)
    expect(acc.active).toBe(false)
    expect(acc.armed).toBeUndefined()
    expect(acc.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('no provider serves the state of past blocks: after three passes it is left to reconciliation, never started from grant state', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    w.chain.nonce = 1n
    w.knobs.grantsEnabled = true
    w.knobs.noHistory = true
    for (let i = 0; i < 2; i++) {
      acc.armed!.retryAt = Date.now() - 1
      await priv(w.op).fireArmed(acc, 20_000_000n).catch(() => undefined)
      expect(acc.active).toBe(false)
    }
    await priv(w.op).fireArmed(acc, 20_000_000n).catch(() => undefined)
    // otto/mamoru#140 (I2): without the block of its execution there is no ExecutionSuccess to check: not started.
    expect(acc.active).toBe(false)
    expect(acc.armed).toBeUndefined()
    expect(acc.ops.find((o) => o.kind === 'activate')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('a retry whose execTransaction fails on chain is left to reconciliation: the first copy may have executed', async () => {
    const w = world(20_000_000n)
    let refuse = true
    w.knobs.onSend = (t) => {
      if (refuse && t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    refuse = false
    w.knobs.execOk = false
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n)
    const after = acc.ops.find((o) => o.opId === op.opId)!
    expect(after).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(after.txHash).toBeUndefined()
    expect(acc.armed).toBeUndefined()
  })

  test('a retry whose preflight finds the transaction reverting (its nonce spent) is left to reconciliation', async () => {
    const w = world(20_000_000n)
    let refuse = true
    w.knobs.onSend = (t) => {
      if (refuse && t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    refuse = false
    const sentBefore = w.sent.length
    w.knobs.sim = 'revert'
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(w.sent.length).toBe(sentBefore)
  })

  test('a refusal while the relayer still reads (gas, nonce) is not a send: a later moved nonce drops the op, no budget charged', async () => {
    const w = world(20_000_000n)
    w.knobs.failBeforeSending = true
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    expect(acc.armed).toMatchObject({ opId: op.opId, tries: 1 })
    expect(acc.armed!.execSent).toBeUndefined()
    w.chain.nonce = 1n
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'ARMED_NONCE_MOVED' })
    expect(acc.ownerFailures ?? []).toHaveLength(0)
  })

  test('past the maximum of tries the approval is parked, not dropped, and still runs when the send goes through', async () => {
    const w = world(20_000_000n)
    let refuse = true
    w.knobs.failBeforeSending = true
    w.knobs.onSend = (t) => {
      if (refuse && t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    for (let i = 0; i < 25; i++) {
      acc.armed!.retryAt = Date.now() - 1
      await priv(w.op).fireArmed(acc, 20_000_000n)
    }
    expect(acc.armed).toMatchObject({ opId: op.opId, tries: 26 })
    // Parked: the next try is half an hour away, not minutes.
    expect(acc.armed!.retryAt! - Date.now()).toBeGreaterThan(25 * 60_000)
    expect(acc.ownerFailures ?? []).toHaveLength(0)
    refuse = false
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.active).toBe(true)
  })

  test('the approval stays in the state through an attempt, and a restart arms it again', async () => {
    type Boot = { resume(): void; stop?: () => void; armStopped: boolean; armTimer?: ReturnType<typeof setTimeout> }
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    const acc = w.state.accounts.k!
    let during: unknown
    w.knobs.onSend = () => {
      during ??= acc.armed?.opId
    }
    w.chain.usdc = 20_000_000n
    // A restart caught it before anything was sent: the op had left the armed code, the signature is still stored.
    acc.ops.find((o) => o.opId === op.opId)!.code = undefined
    const boot = w.op as unknown as Boot
    boot.resume()
    boot.armStopped = true
    clearTimeout(boot.armTimer)
    expect(acc.armed?.opId).toBe(op.opId)
    expect(acc.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'proposed', code: 'ARMED' })
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(during).toBe(op.opId)
    expect(acc.active).toBe(true)
    expect(acc.armed).toBeUndefined()
  })

  test('a restart after the execTransaction was handed over, before its hash was kept, waits before sending again', async () => {
    type Boot = { resume(): void; armStopped: boolean; armTimer?: ReturnType<typeof setTimeout> }
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    const acc = w.state.accounts.k!
    acc.armed!.execSent = true
    acc.ops.find((o) => o.opId === op.opId)!.code = undefined
    const boot = w.op as unknown as Boot
    boot.resume()
    boot.armStopped = true
    clearTimeout(boot.armTimer)
    expect(acc.armed!.retryAt! - Date.now()).toBeGreaterThan(170_000)
    w.chain.usdc = 20_000_000n
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(w.sent).toHaveLength(0)
  })

  test('an approval sent once is not sent again while the relayer still has a transaction pending', async () => {
    const w = world(20_000_000n)
    let refuse = true
    w.knobs.onSend = (t) => {
      if (refuse && t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    refuse = false
    const before = w.sent.length
    w.knobs.relayerPending = 1
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(w.sent.length).toBe(before)
    expect(acc.armed).toBeDefined()
    w.knobs.relayerPending = 0
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.active).toBe(true)
  })

  test('the owner approves again while an attempt is out: the old attempt does not touch the new approval', async () => {
    const w = world(0n)
    const first = await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    let second: { opId: string } | undefined
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) {
        // While the first attempt is at the provider, a newer approval takes its place.
        acc.armed = { ...acc.armed!, opId: 'own-9-activate' }
        second = { opId: 'own-9-activate' }
        throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
      }
    }
    w.chain.usdc = 20_000_000n
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(second).toBeDefined()
    expect(acc.armed?.opId).toBe('own-9-activate')
    expect(acc.armed?.tries ?? 0).toBe(0)
    expect(first.opId).not.toBe('own-9-activate')
  })

  test('a restart that finds the execTransaction already out leaves it to its receipt, and does not send it again', async () => {
    type Boot = { resume(): void; armStopped: boolean; armTimer?: ReturnType<typeof setTimeout> }
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    const acc = w.state.accounts.k!
    Object.assign(acc.ops.find((o) => o.opId === op.opId)!, { state: 'submitted', code: undefined, txHash: `0x${'cd'.repeat(32)}` })
    const boot = w.op as unknown as Boot
    boot.resume()
    boot.armStopped = true
    clearTimeout(boot.armTimer)
    expect(acc.armed).toBeUndefined()
    expect(acc.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR', txHash: `0x${'cd'.repeat(32)}` })
    expect(w.sent).toHaveLength(0)
  })

  test('a parked approval is not read again until its hold ends; one already sent once is read within a minute', async () => {
    type Watch = { armDue(a: AccountState, at: number): boolean; armRead: Map<string, number>; park(a: AccountState, ms: number): void }
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    await w.op.submit(ctx, 'activate', sign(tx))
    const acc = w.state.accounts.k!
    const watch = w.op as unknown as Watch
    const t = Date.now()
    watch.armRead.set(acc.accountKey, t)
    watch.park(acc, 10 * 60_000)
    expect(watch.armDue(acc, t + 9 * 60_000)).toBe(false)
    expect(watch.armDue(acc, t + 10 * 60_000 + 1)).toBe(true)
    acc.armed!.execSent = true
    watch.park(acc, 10 * 60_000)
    expect(watch.armDue(acc, t + 59_000)).toBe(false)
    expect(watch.armDue(acc, t + 61_000)).toBe(true)
  })

  test('money gone, but an approval sent once still looks at its Safe nonce and reaches reconciliation', async () => {
    type Watch = { checkArmed(): Promise<void> }
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Missing or invalid parameters.'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    const acc = w.state.accounts.k!
    expect(acc.armed?.execSent).toBe(true)
    // The copy landed after all, and the engine has since placed every USDC.
    w.chain.nonce = 1n
    w.chain.usdc = 0n
    await (w.op as unknown as Watch).checkArmed()
    expect(acc.armed).toBeUndefined()
    expect(acc.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('already known on the deploy or the top-up is not about the owner transaction: the op waits armed', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && !('data' in t && t.data)) throw Object.assign(new Error('already known'), { code: -32000 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    expect(w.state.accounts.k!.armed).toMatchObject({ opId: op.opId, tries: 1 })
  })

  test('a refusal that may be about a copy already in a node (already known, nonce too low) is never sent again', async () => {
    for (const message of ['already known', 'nonce too low: next nonce 43, tx nonce 42', 'replacement transaction underpriced']) {
      const w = world(20_000_000n)
      w.knobs.onSend = (t) => {
        if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error(message), { code: -32000 })
      }
      const tx = await w.op.prepareActivate(ctx)
      const op = await w.op.submit(ctx, 'activate', sign(tx))
      await Bun.sleep(5)
      expect(w.state.accounts.k!.armed).toBeUndefined()
      expect(w.state.accounts.k!.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    }
  })

  test('an internal error (-32603) is what the proxy answers for a lost reply: the op fails as before, it is not sent again', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Internal error'), { code: -32603 })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    expect(w.state.accounts.k!.armed).toBeUndefined()
    expect(w.state.accounts.k!.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('a send that times out says nothing about the chain: the op fails as before and reconciliation settles it', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' })
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(5)
    expect(w.state.accounts.k!.armed).toBeUndefined()
    expect(w.state.accounts.k!.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('any other send failure still fails the op and counts against the owner budget', async () => {
    const w = world(20_000_000n)
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw new Error('nonce too low')
    }
    const tx = await w.op.prepareActivate(ctx)
    const op = await w.op.submit(ctx, 'activate', sign(tx))
    await Bun.sleep(0)
    expect(w.op.ops(ctx, null).ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(w.state.accounts.k!.armed).toBeUndefined()
    expect(w.state.accounts.k!.ownerFailures).toHaveLength(1)
  })
})

// One approval lasts a year and is renewed with one tap: the same grants with a fresh validity, nothing moved.
/**
 * The chain model for grants: what an owner transaction executed through the relayer enables and revokes is applied
 * to `knobs.enabled` when the relayer sends it (the op being executed, see executeOwner). Settlements from chain
 * proofs do not change it: they only read what is there.
 */
function track(w: ReturnType<typeof world>): void {
  type P = { kind: string; tx?: unknown; grants?: { permissionId: string }[]; revokes?: string[] }
  const o = w.op as unknown as { executeOwner(a: AccountState, l: unknown, p: P, s: unknown, op: unknown): Promise<void> }
  const exec = o.executeOwner.bind(w.op)
  w.knobs.grantsEnabled = null
  o.executeOwner = (a, l, p, s, op) => {
    w.knobs.pending = p
    return exec(a, l, p, s, op).finally(() => {
      w.knobs.pending = null
    })
  }
}

/**
 * An owner op of unknown outcome that did run: its grants enabled, its revocations applied on the chain model, and
 * the Safe's ExecutionSuccess of its own Safe tx hash in the logs (I2: the only proof besides its receipt).
 */
function landed(w: ReturnType<typeof world>, op: { opId: string; safeTxHash?: Hex; ownerGrants?: { permissionId: string }[]; revokes?: string[] }): void {
  op.safeTxHash ??= keccak256(stringToHex(op.opId))
  for (const id of op.revokes ?? []) w.knobs.enabled.delete(id.toLowerCase())
  for (const g of op.ownerGrants ?? []) w.knobs.enabled.add(g.permissionId.toLowerCase())
  w.knobs.logs.push({ stx: op.safeTxHash, hash: keccak256(stringToHex(`tx-${op.opId}`)), block: 99n })
}

describe('renewing the approval of a running account', () => {
  type Loop = { startLoop(a: AccountState): void }
  /** A running account: activated through the real path, with the engine loop stubbed (the fake chain has no engine RPC). */
  const running = async () => {
    const w = world(20_000_000n)
    ;(w.op as unknown as Loop).startLoop = () => {}
    track(w)
    const op = await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    expect(acc.active).toBe(true)
    return { w, acc, started: op }
  }
  /** Grants whose end is inside the renewal window: what the renewal (not an extension) is built for. */
  const due = <G extends { grant: { userOp: { validUntil: number } } }>(gs: G[]): G[] =>
    gs.map((g) => ({ ...g, grant: { ...g.grant, userOp: { ...g.grant.userOp, validUntil: Math.floor(Date.now() / 1000) + 15 * 86_400 } } }))

  test('#149: a single-pair (conservador-live-v1) renewal lists the signed limits of its bare-named grants', async () => {
    const w = world(20_000_000n, 'conservador-live-v1')
    ;(w.op as unknown as Loop).startLoop = () => {}
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    expect(acc.grants.map((g) => g.name)).toContain('enter-swap')
    const tx = await w.op.prepareRenew(ctx)
    expect(tx.summary).toContain('In USDC/cbBTC 0.05%: USDC swapped in at most 25.00 per swap and 50.00 in total, so at most 50.00 in one transaction, which can hold several swaps; at most 8 transactions to swap USDC in, 8 to open a position, 256 to take liquidity out, burn or re-open a position, 64 to collect fees and swap them to USDC (one transaction can hold several of these steps)')
  })

  test('an account that is not running cannot renew: it starts instead', async () => {
    const w = world(20_000_000n)
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'NOT_ACTIVE' })
  })

  test('funding tells until when the approval is valid and when its renewal is due', async () => {
    const { w, acc } = await running()
    const now = Math.floor(Date.now() / 1000)
    const fresh = (await w.op.funding(ctx)).approval!
    // Signed for a year from the block time of the fake chain; only the shape of the answer matters here.
    expect(fresh.validUntil).toBe(acc.grants[0]!.grant.userOp.validUntil)
    const until = (validUntil: number) => {
      acc.grants = acc.grants.map((g) => ({ ...g, grant: { ...g.grant, userOp: { ...g.grant.userOp, validUntil } } }))
    }
    until(now + 200 * 86_400)
    // otto/mamoru#151: the approval names the account's own policy (what a renewal that moves nothing renews).
    expect((await w.op.funding(ctx)).approval).toEqual({ validUntil: now + 200 * 86_400, renewDue: false, expired: false, policyId: w.op.policyOf(acc).policyId })
    until(now + 15 * 86_400)
    expect((await w.op.funding(ctx)).approval).toMatchObject({ renewDue: true, expired: false })
    until(now - 60)
    expect((await w.op.funding(ctx)).approval).toMatchObject({ renewDue: true, expired: true })
    acc.active = false
    expect((await w.op.funding(ctx)).approval).toBeNull()
  })

  test('one signature replaces the grants with fresh ones; positions, deposits and history are left as they are', async () => {
    const { w, acc } = await running()
    const before = acc.grants.map((g) => g.permissionId)
    acc.managedTokenIds = ['7']
    acc.depositsAfter = '90'
    acc.historyFromBlock = '80'
    const epoch = acc.epoch
    const sentBefore = w.sent.length
    const tx = await w.op.prepareRenew(ctx)
    expect(tx.summary.join(' ')).toContain('Nothing is moved')
    // otto/mamoru#137: no blanket "funds never leave" claim; the renewal says exactly what the engine keeps
    // doing without asking again (this account's grants include manage-any/convert-any), and every recipient
    // stays the Safe.
    expect(tx.summary.join(' ')).toContain('It also keeps acting, without asking again, on any Uniswap v3 position your Safe owns, in any pool')
    expect(tx.summary.join(' ')).toContain('take liquidity out, collect fees, burn it once empty, and convert')
    expect(tx.summary).toContain('Whatever it collects, mints or swaps is paid to your Safe, never to anyone else')
    expect(tx.summary.join(' ')).not.toContain('Funds never leave')
    expect(tx.summary.join(' ')).not.toContain('without your passkey')
    const op = await w.op.submit(ctx, 'renew', sign(tx))
    expect(op).toMatchObject({ kind: 'renew', state: 'confirmed', code: 'EXEC_OK' })
    // One transaction, to the Safe: no deploy, no top-up.
    expect(w.sent.slice(sentBefore).map((t) => t.to)).toEqual([SAFE])
    const after = acc.grants.map((g) => g.permissionId)
    expect(after).toHaveLength(before.length)
    expect(after.some((id) => before.includes(id))).toBe(false)
    // The grants it replaced were revoked in the same transaction: nothing is left enabled beside the new ones.
    expect(tx.summary.join(' ')).toContain('revoked in the same transaction')
    expect(before.every((id) => acc.revoked.includes(id))).toBe(true)
    expect(acc.superseded ?? []).toEqual([])
    expect(acc.grants.map((g) => g.name)).toEqual((await running()).acc.grants.map((g) => g.name))
    expect(acc.active).toBe(true)
    expect(acc.epoch).toBe(epoch + 1)
    expect(acc.managedTokenIds).toEqual(['7'])
    expect(acc.depositsAfter).toBe('90')
    expect(acc.historyFromBlock).toBe('80')
  })

  test('otto/mamoru#137: a renewal without manage-any/convert-any makes no re-ranging claim', async () => {
    const w = world(20_000_000n, 'conservador-v1')
    ;(w.op as unknown as Loop).startLoop = () => {}
    track(w)
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const tx = await w.op.prepareRenew(ctx)
    const text = tx.summary.join(' ')
    expect(text).not.toContain('any Uniswap v3 position')
    expect(tx.summary).toContain('Whatever it collects, mints or swaps is paid to your Safe, never to anyone else')
    expect(text).not.toContain('Funds never leave')
  })

  test('a renewal that does not fit one transaction with its revocations is refused: never done without them', async () => {
    type Gas = { activationGas(...a: unknown[]): Promise<bigint> }
    const { w, acc } = await running()
    const before = acc.grants.map((g) => g.permissionId)
    ;(w.op as unknown as Gas).activationGas = async () => 99_000_000n
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'RENEWAL_TOO_LARGE' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(before)
    expect(acc.active).toBe(true)
  })

  test('the renewed grants are the ones the account had, by name: none lost, none added', async () => {
    const { w, acc } = await running()
    // An account that holds fewer grants than the policy offers keeps exactly those when its renewal is due.
    acc.grants = due(acc.grants.slice(0, 3))
    const names = acc.grants.map((g) => g.name)
    await w.op.submit(ctx, 'renew', sign(await w.op.prepareRenew(ctx)))
    expect(acc.grants.map((g) => g.name)).toEqual(names)
  })

  test('a stop revokes the grants of a renewal whose outcome is unknown, without asking the chain first', async () => {
    for (const state of [{ state: 'failed', code: 'OWNER_TX_ERROR' }, { state: 'submitted' }]) {
      const { w, acc } = await running()
      const fresh = [{ name: 'enter-swap:x', grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }]
      acc.ops.push({ opId: 'own-7-renew', kind: 'renew', updatedAt: new Date().toISOString(), ownerGrants: fresh, ...state } as never)
      // Whatever the chain would say: the removal of a session that is not there is taken.
      // (the chain model: the engine's grants enabled, the other op's not)
      await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
      expect(acc.revoked).toContain(`0x${'ee'.repeat(32)}`)
    }
  })

  test('no renewal while a stop is on its way, or while the engine has an operation that is not settled', async () => {
    const { w, acc } = await running()
    // The engine's grants are enabled on the Safe throughout: no stop has run.
    // (the chain model: the engine's grants enabled, the other op's not)
    acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'submitted', updatedAt: new Date().toISOString() } as never)
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'STOP_IN_FLIGHT' })
    // A stop whose receipt was not read is still on its way as far as anyone knows.
    Object.assign(acc.ops.at(-1)!, { state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ code: 'STOP_IN_FLIGHT' })
    // It stops counting once it cannot land any more: a later owner transaction confirmed, or an hour gone.
    acc.ops.push({ opId: 'own-8-transfer', kind: 'transfer', state: 'confirmed', updatedAt: new Date().toISOString() } as never)
    await w.op.prepareRenew(ctx)
    acc.ops.pop()
    Object.assign(acc.ops.at(-1)!, { updatedAt: new Date(Date.now() - 3_700_000).toISOString() })
    await w.op.prepareRenew(ctx)
    Object.assign(acc.ops.at(-1)!, { state: 'failed', code: 'OWNER_TX_FAILED' })
    const tx = await w.op.prepareRenew(ctx)
    // Prepared while idle; by the time it is signed the engine has an operation out.
    type Runners = { runners: Map<string, { engine: { journal: { ops: { state: string }[] }; carried(): unknown[] } }> }
    ;(w.op as unknown as Runners).runners.set(acc.accountKey, { engine: { journal: { ops: [{ state: 'included' }] }, carried: () => [] } })
    const sentBefore = w.sent.length
    expect(await w.op.submit(ctx, 'renew', sign(tx)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ENGINE_BUSY' })
    expect(w.sent.length).toBe(sentBefore)
  })

  test('a userOp the bundler rejected, still pending, is carried and does not hold the renewal; one not carried does (Sol review round 2 of #64)', async () => {
    const { w, acc } = await running()
    w.knobs.grantsEnabled = true
    const op = { state: 'pending_reconciliation', stateCode: 'BUNDLER_REJECTED' }
    type Runners = { runners: Map<string, { engine: { journal: { ops: object[] }; carried(): object[] } }> }
    const runners = (w.op as unknown as Runners).runners
    // Signed bytes the next engine will watch (Engine.carried): the renewal goes ahead.
    runners.set(acc.accountKey, { engine: { journal: { ops: [op] }, carried: () => [op] } })
    expect((await w.op.prepareRenew(ctx)).summary.join(' ')).toContain('Renew')
    // Nothing the next engine could watch: it holds the renewal as before.
    runners.set(acc.accountKey, { engine: { journal: { ops: [op] }, carried: () => [] } })
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ENGINE_BUSY' })
  })

  test('a stop on its way pauses the engine (US6)', async () => {
    const { w, acc } = await running()
    const paused = () => (w.op as unknown as { stopInFlight(a: AccountState): boolean }).stopInFlight(acc)
    expect(paused()).toBe(false)
    acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'submitted', updatedAt: new Date().toISOString() } as never)
    expect(paused()).toBe(true)
    // startLoop hands this to the engine as its intents (the engine side is in review-requests.test.ts).
    acc.ops.pop()
    expect(paused()).toBe(false)
  })

  test('a renewal whose receipt was never read is applied from the chain before another one is built', async () => {
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const fresh = due([{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }])
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: old } as never)
    // The chain says it ran (its own ExecutionSuccess): its grants are the engine's now, and the next renewal revokes those, not the old ones.
    landed(w, acc.ops.at(-1) as never)
    const tx = await w.op.prepareRenew(ctx)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'confirmed', code: 'EXEC_OK' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual([`0x${'ee'.repeat(32)}`])
    expect(old.every((id) => acc.revoked.includes(id))).toBe(true)
    await w.op.submit(ctx, 'renew', sign(tx))
    expect(acc.revoked).toContain(`0x${'ee'.repeat(32)}`)
    expect(acc.superseded ?? []).toEqual([])
  })

  // Base caps a transaction at 2^24 gas: an activation of the full v2 set does not fit, so it leaves out the
  // manage-any/convert-any pairs of the lowest-preference pools (otto/mamoru#5). One more approval adds them.
  describe('grants left out to fit the gas cap', () => {
    type Gas = { activationGas(live: unknown, calls: unknown[], sessions: number): Promise<bigint> }
    /** About what Base charges per session enabled: more than eight do not fit the activation budget. */
    const perSession = (w: ReturnType<typeof world>) => {
      ;(w.op as unknown as Gas).activationGas = async (_l, _c, sessions) => BigInt(sessions) * 1_700_000n
    }
    const pairs = (names: string[]) => names.filter((n) => n.startsWith('manage-any') || n.startsWith('convert-any'))
    /** A running account activated under the real gas cap: its WETH and cbBTC pairs were left out. */
    const capped = async () => {
      const w = world(20_000_000n)
      ;(w.op as unknown as Loop).startLoop = () => {}
      track(w)
      perSession(w)
      await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
      const acc = w.state.accounts.k!
      expect(acc.active).toBe(true)
      return { w, acc }
    }
    const full = POLICIES['conservador-live-v2']!.session.grants.filter((g) => !g.perPosition).length

    test('the activation leaves out the lowest-preference pairs, and funding says how many grants are missing', async () => {
      const { w, acc } = await capped()
      expect(acc.grants.length).toBeLessThan(full)
      expect(pairs(acc.grants.map((g) => g.name)).every((n) => n.endsWith('pool:USDC/USDT/100'))).toBe(true)
      expect((await w.op.funding(ctx)).approval).toMatchObject({ renewDue: false, missing: full - acc.grants.length })
    })

    test('one more approval adds only the missing grants: the engine keeps the ones it has, nothing is moved', async () => {
      const { w, acc } = await capped()
      const before = acc.grants.map((g) => g.permissionId)
      const epoch = acc.epoch
      acc.managedTokenIds = ['7']
      const tx = await w.op.prepareRenew(ctx)
      expect(tx.summary.join(' ')).toContain('re-range and collect fees in')
      expect(tx.summary.join(' ')).toContain('swap cbBTC and WETH to USDC')
      expect(tx.summary.join(' ')).toContain('without asking you again, only within these limits')
      expect(tx.summary.join(' ')).toContain('Nothing is moved now')
      const sentBefore = w.sent.length
      const op = await w.op.submit(ctx, 'renew', sign(tx))
      expect(op).toMatchObject({ kind: 'renew', state: 'confirmed', code: 'EXEC_OK', extend: true })
      expect(w.sent.slice(sentBefore).map((t) => t.to)).toEqual([SAFE])
      // Every grant of the policy, the old ones untouched and none revoked.
      expect(acc.grants).toHaveLength(full)
      expect(new Set(acc.grants.map((g) => g.name)).size).toBe(full)
      expect(before.every((id) => acc.grants.some((g) => g.permissionId === id))).toBe(true)
      expect(before.some((id) => acc.revoked.includes(id))).toBe(false)
      expect(acc.superseded ?? []).toEqual([])
      expect(acc.grantsFromBlock).toBe('99')
      expect(acc.epoch).toBe(epoch + 1)
      expect(acc.managedTokenIds).toEqual(['7'])
      expect((await w.op.funding(ctx)).approval?.missing).toBeUndefined()
      // Nothing left to add: the next one is a renewal again.
      expect((await w.op.prepareRenew(ctx)).summary.join(' ')).toContain('revoked in the same transaction')
    })

    test('#149: a grant at 80% of its usage gets the renewal row, and the renewal (not an extension) starts its counts again', async () => {
      const { w, acc } = await capped()
      const convert = acc.grants.find((g) => g.name === 'convert-any:pool:USDC/USDT/100')!
      // Sized at the account cap (the 100 USDC live cap): the first tier.
      expect(convert.grant.userOp.usageLimit).toBe(1_000)
      expect(acc.grants.find((g) => g.name.startsWith('manage-any'))!.grant.userOp.usageLimit).toBe(2_500)
      const harvests = (n: number) => Array.from({ length: n }, (_, i) => ({ opId: `eng-${acc.epoch}-9-op-${i}-harvest`, kind: 'enter', state: 'confirmed', updatedAt: new Date().toISOString(), permissionId: convert.permissionId }) as never)
      acc.ops.push(...harvests(799))
      expect((await w.op.funding(ctx)).approval?.usage).toBeUndefined()
      acc.ops.push(...harvests(1))
      expect((await w.op.funding(ctx)).approval?.usage).toEqual({ action: 'collect', pool: 'pool:USDC/USDT/100', usedBps: 8_000, spent: false })
      acc.ops.push(...harvests(200))
      expect((await w.op.funding(ctx)).approval?.usage).toMatchObject({ usedBps: 10_000, spent: true })
      // Grants are missing too, but fresh counts need a renewal: it goes first, and says what the counts become.
      const old = acc.grants.map((g) => g.permissionId)
      const tx = await w.op.prepareRenew(ctx)
      expect(tx.summary.join(' ')).toContain('revoked in the same transaction')
      expect(tx.summary.join(' ')).toContain('within new limits counted from zero')
      expect(tx.summary).toContain('In USDC/USDT 0.01%: USDC swapped in at most 50.00 per swap and 300.00 in total, so at most 300.00 in one transaction, which can hold several swaps; at most 3,000 transactions to swap USDC in, 1,000 to open a position, 2,500 to take liquidity out, burn or re-open a position, 1,000 to collect fees and swap them to USDC (one transaction can hold several of these steps)')
      await w.op.submit(ctx, 'renew', sign(tx))
      expect(old.every((id) => acc.revoked.includes(id))).toBe(true)
      expect((await w.op.funding(ctx)).approval?.usage).toBeUndefined()
    })

    test('#149: uses the chain counts and the operator did not make (the key used elsewhere) bring the row too', async () => {
      const { w, acc } = await capped()
      const swap = acc.grants.find((g) => g.name === 'enter-swap:pool:USDC/cbBTC/500')!
      expect((await w.op.funding(ctx)).approval?.usage).toBeUndefined()
      type Usage = { chainUsage: Map<string, { at: number; grants: string; byGrant: Map<string, { used: number; spentBps: number | null }> }> }
      const ids = acc.grants.map((g) => g.permissionId.toLowerCase()).join(',')
      ;(w.op as unknown as Usage).chainUsage.set(acc.accountKey, { at: Date.now(), grants: ids, byGrant: new Map([[swap.permissionId.toLowerCase(), { used: 3, spentBps: 8_500 }]]) })
      expect((await w.op.funding(ctx)).approval?.usage).toEqual({ action: 'enter', pool: 'pool:USDC/cbBTC/500', usedBps: 8_500, spent: false })
    })

    test('a renewal that is due goes first, with what fits; the missing grants are added after it', async () => {
      const { w, acc } = await capped()
      acc.grants = due(acc.grants)
      const had = acc.grants.map((g) => g.name)
      const tx = await w.op.prepareRenew(ctx)
      expect(tx.summary.join(' ')).toContain('revoked in the same transaction')
      await w.op.submit(ctx, 'renew', sign(tx))
      expect(acc.grants.map((g) => g.name)).toEqual(had)
      const op = await w.op.submit(ctx, 'renew', sign(await w.op.prepareRenew(ctx)))
      expect(op).toMatchObject({ state: 'confirmed', extend: true })
      expect(acc.grants).toHaveLength(full)
    })

    test('a renewal of the full set that does not fit leaves out pairs instead of failing; their revokes stay', async () => {
      const { w, acc } = await capped()
      await w.op.submit(ctx, 'renew', sign(await w.op.prepareRenew(ctx)))
      expect(acc.grants).toHaveLength(full)
      acc.grants = due(acc.grants)
      const old = acc.grants.map((g) => g.permissionId)
      const tx = await w.op.prepareRenew(ctx)
      expect(tx.summary.join(' ')).toContain('needs one more approval after this one')
      await w.op.submit(ctx, 'renew', sign(tx))
      expect(old.every((id) => acc.revoked.includes(id))).toBe(true)
      expect(acc.grants.length).toBeLessThan(full)
      expect((await w.op.funding(ctx)).approval?.missing).toBe(full - acc.grants.length)
    })

    test('an extension prepared on grants that changed since, or with a renewal of unknown outcome, is prepared again', async () => {
      const { w, acc } = await capped()
      const tx = await w.op.prepareRenew(ctx)
      acc.grants = acc.grants.map((g, i) => (i === 0 ? { ...g, permissionId: `0x${'dd'.repeat(32)}` as Hex } : g))
      w.knobs.enabled.add(`0x${'dd'.repeat(32)}`)
      expect(await w.op.submit(ctx, 'renew', sign(tx)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'RENEWAL_STALE' })
      const again = await w.op.prepareRenew(ctx)
      acc.ops.push({ opId: 'own-9-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: [{ ...acc.grants[0]!, permissionId: `0x${'ee'.repeat(32)}` as Hex }], revokes: [] } as never)
      // (the chain model: the engine's grants enabled, the other op's not)
      expect(await w.op.submit(ctx, 'renew', sign(again)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'RENEWAL_STALE' })
    })

    test('while a renewal\'s outcome is unknown no extension is built: the full renewal revokes it all', async () => {
      const { w, acc } = await capped()
      const old = acc.grants.map((g) => g.permissionId)
      acc.ops.push({ opId: 'own-9-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: [{ ...acc.grants[0]!, permissionId: `0x${'ee'.repeat(32)}` as Hex }], revokes: old } as never)
      // The chain says it did not run.
      // (the chain model: the engine's grants enabled, the other op's not)
      const tx = await w.op.prepareRenew(ctx)
      expect(tx.summary.join(' ')).toContain('revoked in the same transaction')
      const op = await w.op.submit(ctx, 'renew', sign(tx))
      expect(op.extend).toBeUndefined()
      expect([...old, `0x${'ee'.repeat(32)}`].every((id) => acc.revoked.includes(id as Hex))).toBe(true)
    })

    test('an extension whose receipt was never read is applied from the chain by adding its grants', async () => {
      const { w, acc } = await capped()
      const had = acc.grants.map((g) => g.permissionId)
      const extra = { name: 'manage-any:pool:USDC/cbBTC/500', grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }
      acc.ops.push({ opId: 'own-9-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: [extra], revokes: [], extend: true } as never)
      landed(w, acc.ops.at(-1) as never)
      await w.op.prepareRenew(ctx)
      expect(acc.ops.find((o) => o.opId === 'own-9-renew')).toMatchObject({ state: 'confirmed' })
      expect(acc.grants.map((g) => g.permissionId)).toEqual([...had, `0x${'ee'.repeat(32)}`])
      expect(had.some((id) => acc.revoked.includes(id))).toBe(false)
    })
  })

  test('one renewal at a time, and one prepared on grants that changed since is prepared again', async () => {
    const { w, acc } = await running()
    const tx = await w.op.prepareRenew(ctx)
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'submitted', updatedAt: new Date().toISOString() } as never)
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'RENEWAL_IN_FLIGHT' })
    expect(await w.op.submit(ctx, 'renew', sign(tx)).catch((e: unknown) => e)).toMatchObject({ code: 'RENEWAL_IN_FLIGHT' })
    acc.ops.pop()
    // The account's grants are no longer the ones this renewal was built to revoke.
    const again = await w.op.prepareRenew(ctx)
    acc.grants = acc.grants.map((g, i) => (i === 0 ? { ...g, permissionId: `0x${'dd'.repeat(32)}` as Hex } : g))
    w.knobs.enabled.add(`0x${'dd'.repeat(32)}`)
    expect(await w.op.submit(ctx, 'renew', sign(again)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'RENEWAL_STALE' })
  })

  test('a stop whose receipt was never read and that did run is applied from its own receipt: nothing is renewed after it', async () => {
    const { w, acc } = await running()
    const had = acc.grants.map((g) => g.permissionId)
    const stx = `0x${'5a'.repeat(32)}` as Hex
    const hash = `0x${'ab'.repeat(32)}` as Hex
    acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', txHash: hash, safeTxHash: stx, updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } as never)
    w.knobs.enabled.clear()
    // Its receipt is read now: the Safe executed this stop's own Safe tx hash.
    type Rc = { getTransactionReceipt(a: { hash: Hex }): Promise<unknown> }
    ;(w.op as unknown as { client: Rc }).client.getTransactionReceipt = async () => ({ transactionHash: hash, status: 'success', blockNumber: 99n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, stx] }] })
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'NOT_ACTIVE' })
    expect(acc.active).toBe(false)
    expect(acc.ops.find((o) => o.opId === 'own-7-exit')).toMatchObject({ state: 'confirmed', txHash: hash, block: 99 })
    expect(had.every((id) => acc.revoked.includes(id))).toBe(true)
    expect(acc.deactivated).toBeUndefined()
  })

  test('otto/mamoru#140: grants revoked by another transaction do not confirm an unread stop: the account stops, the stop stays unconfirmed', async () => {
    for (const proof of ['none', 'other-safe-tx'] as const) {
      const { w, acc } = await running()
      const had = acc.grants.map((g) => g.permissionId)
      const stx = `0x${'5a'.repeat(32)}` as Hex
      const hash = `0x${'ab'.repeat(32)}` as Hex
      acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', safeTxHash: stx, ...(proof === 'other-safe-tx' ? { txHash: hash } : {}), updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } as never)
      // The owner revoked the grants elsewhere (spending the nonce): the stop's own transaction never landed, or the
      // receipt read carries another Safe tx hash.
      w.knobs.enabled.clear()
      type Rc = { getTransactionReceipt(a: { hash: Hex }): Promise<unknown> }
      if (proof === 'other-safe-tx') (w.op as unknown as { client: Rc }).client.getTransactionReceipt = async () => ({ transactionHash: hash, status: 'success', blockNumber: 99n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, `0x${'77'.repeat(32)}`] }] })
      expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'NOT_ACTIVE' })
      // The engine cannot act any more: the account is not running, its grants are recorded as revoked.
      expect(acc.active).toBe(false)
      expect(had.every((id) => acc.revoked.includes(id))).toBe(true)
      // But the stop (its position close and swaps) is not reported as done: it stays an unread receipt.
      expect(acc.ops.find((o) => o.opId === 'own-7-exit')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
      expect(acc.deactivated).toMatchObject({ code: 'GRANTS_REVOKED_ELSEWHERE', opId: 'own-7-exit', block: '100' })
    }
  })

  test('otto/mamoru#140: an unread stop with only some engine grants revoked elsewhere stops the engine, keeps the stop unconfirmed and the rest tracked', async () => {
    for (const which of ['first', 'last'] as const) {
    const { w, acc } = await running()
    const had = acc.grants.map((g) => g.permissionId)
    const off = which === 'first' ? had[0]! : had.at(-1)!
    let stopped = 0
    ;(w.op as unknown as { stopLoop(k: string): void }).stopLoop = () => void stopped++
    acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', safeTxHash: `0x${'5a'.repeat(32)}`, revokes: had, updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } as never)
    // Another Safe transaction revoked the engine's first grant; the others are still enabled.
    type Read = { readContract(a: { functionName: string; args?: readonly unknown[] }): Promise<unknown> }
    const client = (w.op as unknown as { client: Read }).client
    const read = client.readContract.bind(client)
    client.readContract = async (a) => (a.functionName === 'isPermissionEnabled' ? a.args![0] !== off : read(a))
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'NOT_ACTIVE' })
    expect(stopped).toBeGreaterThan(0)
    expect(acc.active).toBe(false)
    expect(acc.ops.find((o) => o.opId === 'own-7-exit')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.deactivated).toMatchObject({ code: 'GRANTS_PARTLY_REVOKED', opId: 'own-7-exit' })
    expect(acc.revoked).toContain(off)
    expect([...(acc.superseded ?? [])].sort()).toEqual(had.filter((id) => id !== off).sort())
    // Start waits for a stop; the next stop revokes the grants still enabled.
    expect(await w.op.prepareActivate(ctx).catch((e: unknown) => e)).toMatchObject({ code: 'STOP_FIRST' })
    await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
    expect(had.every((id) => acc.revoked.includes(id))).toBe(true)
    expect(acc.superseded ?? []).toEqual([])
    }
  })

  test('otto/mamoru#140: mixed engine grants stop the engine even with an unread renewal pending, with or without an unread stop', async () => {
    for (const withStop of [true, false]) {
      const { w, acc } = await running()
      const had = acc.grants.map((g) => g.permissionId)
      const ee = `0x${'ee'.repeat(32)}` as Hex
      const ff = `0x${'ff'.repeat(32)}` as Hex
      const fresh = [ee, ff].map((permissionId) => ({ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId }))
      // A renewal with its receipt unread that has not run (its grants disabled, its Safe nonce not spent).
      acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: had, safeTxHash: keccak256(stringToHex('stx-' + Math.random())), safeNonce: '5' } as never)
      if (withStop) acc.ops.push({ opId: 'own-8-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', safeTxHash: `0x${'5a'.repeat(32)}`, revokes: had, updatedAt: new Date().toISOString() } as never)
      // Another transaction revoked the engine's last grant; the others stay enabled.
      const off = had.at(-1)!
      type Read = { readContract(a: { functionName: string; args?: readonly unknown[] }): Promise<unknown> }
      const client = (w.op as unknown as { client: Read }).client
      const read = client.readContract.bind(client)
      client.readContract = async (a) => (a.functionName === 'isPermissionEnabled' ? a.args![0] !== off && a.args![0] !== ee && a.args![0] !== ff : read(a))
      await w.op.prepareRenew(ctx).catch(() => undefined)
      expect(acc.active).toBe(false)
      expect(acc.deactivated).toMatchObject({ code: 'GRANTS_PARTLY_REVOKED', opId: withStop ? 'own-8-exit' : 'own-7-renew' })
      expect([...(acc.superseded ?? [])].sort()).toEqual(had.filter((id) => id !== off).sort())
      // Neither pending op is settled by this: the renewal is still for its all-grants check, the stop unconfirmed.
      expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
      if (withStop) expect(acc.ops.find((o) => o.opId === 'own-8-exit')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
      // The next stop revokes everything still tracked, the renewal's grants too.
      await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
      expect([...had, ee, ff].every((id) => acc.revoked.includes(id))).toBe(true)
    }
  })

  test('otto/mamoru#140: an unread stop left `submitted` by a restart is not confirmed by grant state either', async () => {
    const { w, acc } = await running()
    acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'submitted', safeTxHash: `0x${'5a'.repeat(32)}`, updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } as never)
    w.knobs.enabled.clear()
    await w.op.prepareRenew(ctx).catch(() => undefined)
    expect(acc.active).toBe(false)
    expect(acc.ops.find((o) => o.opId === 'own-7-exit')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.deactivated?.code).toBe('GRANTS_REVOKED_ELSEWHERE')
  })

  test('otto/mamoru#140: an unread renewal with only some of its grants revoked since keeps the enabled ones tracked for the next stop', async () => {
    for (const [disabled, extend] of [['first', false], ['last', false], ['first', true]] as const) {
      const { w, acc } = await running()
      const old = acc.grants.map((g) => g.permissionId)
      const ee = `0x${'ee'.repeat(32)}` as Hex
      const ff = `0x${'ff'.repeat(32)}` as Hex
      const fresh = [ee, ff].map((permissionId) => ({ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId }))
      acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: extend ? [] : old, extend, safeTxHash: keccak256(stringToHex('stx-' + Math.random())), safeNonce: '1' } as never)
      // It ran (its own ExecutionSuccess is in the logs) and spent nonce 1; the owner then removed one of its grants elsewhere.
      landed(w, acc.ops.at(-1) as never)
      w.chain.nonce = 3n
      const on = disabled === 'first' ? ff : ee
      w.knobs.enabled.delete(on === ff ? ee : ff)
      await w.op.prepareRenew(ctx).catch(() => undefined)
      // Not applied as the engine's approval (part of it is gone), not forgotten either.
      expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'RENEWAL_PARTLY_REVOKED' })
      expect(acc.superseded).toContain(on)
      if (extend) {
        // An extension revoked none of the engine's grants: it keeps running on them.
        expect(acc.active).toBe(true)
        expect(acc.grants.map((g) => g.permissionId)).toEqual(old)
      } else {
        // A renewal that ran revoked the engine's grants: the engine has nothing left to act with, so it is not left
        // running on revoked grants. The account stops, recorded as such.
        expect(acc.active).toBe(false)
        expect(old.every((id) => acc.revoked.includes(id))).toBe(true)
        expect(acc.deactivated).toMatchObject({ code: 'GRANTS_REVOKED_ELSEWHERE', opId: 'own-7-renew' })
      }
      // The next stop revokes the grant still enabled.
      await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
      expect(acc.revoked).toContain(on)
    }
  })

  test('otto/mamoru#140: reconciliation confirms a stop by its receipt only when the receipt carries its own Safe tx hash', async () => {
    const { w, acc } = await running()
    const stx = `0x${'5a'.repeat(32)}` as Hex
    const hash = `0x${'ab'.repeat(32)}` as Hex
    acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', txHash: hash, safeTxHash: stx, updatedAt: new Date().toISOString() } as never)
    type Rc = { getTransactionReceipt(a: { hash: Hex }): Promise<unknown> }
    const client = (w.op as unknown as { client: Rc }).client
    client.getTransactionReceipt = async () => ({ transactionHash: hash, status: 'success', blockNumber: 99n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, `0x${'77'.repeat(32)}`] }] })
    await w.op.reconcileOwner(acc)
    expect(acc.ops.find((o) => o.opId === 'own-7-exit')?.state).toBe('failed')
    expect(acc.active).toBe(true)
    client.getTransactionReceipt = async () => ({ transactionHash: hash, status: 'success', blockNumber: 99n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, stx] }] })
    Object.assign(acc.ops.find((o) => o.opId === 'own-7-exit')!, { code: 'OWNER_TX_ERROR' })
    await w.op.reconcileOwner(acc)
    expect(acc.ops.find((o) => o.opId === 'own-7-exit')).toMatchObject({ state: 'confirmed', txHash: hash })
    expect(acc.active).toBe(false)
  })

  test('otto/mamoru#140: a renewal proven by its receipt is applied only when every one of its grants is still enabled', async () => {
    for (const whole of [false, true]) {
      const { w, acc } = await running()
      const old = acc.grants.map((g) => g.permissionId)
      const ee = `0x${'ee'.repeat(32)}` as Hex
      const ff = `0x${'ff'.repeat(32)}` as Hex
      const stx = `0x${'5a'.repeat(32)}` as Hex
      const hash = `0x${'ab'.repeat(32)}` as Hex
      const fresh = [ee, ff].map((permissionId) => ({ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId }))
      acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', txHash: hash, safeTxHash: stx, updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: old } as never)
      type C = { getTransactionReceipt(a: { hash: Hex }): Promise<unknown>; readContract(a: { functionName: string; args?: readonly unknown[] }): Promise<unknown> }
      const client = (w.op as unknown as { client: C }).client
      client.getTransactionReceipt = async () => ({ transactionHash: hash, status: 'success', blockNumber: 90n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, stx] }] })
      const read = client.readContract.bind(client)
      // It ran (its receipt says so); since then the owner removed ff elsewhere, unless `whole`.
      client.readContract = async (a) => (a.functionName === 'isPermissionEnabled' ? a.args![0] === ee || (whole && a.args![0] === ff) : read(a))
      await w.op.reconcileOwner(acc)
      if (whole) {
        expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'confirmed', txHash: hash })
        expect(acc.grants.map((g) => g.permissionId)).toEqual([ee, ff])
        expect(acc.active).toBe(true)
      } else {
        // Not restarted on a disabled grant, not confirmed: the survivor is tracked, the engine stops.
        expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'RENEWAL_PARTLY_REVOKED', txHash: hash })
        expect(acc.grants.map((g) => g.permissionId)).not.toContain(ff)
        expect(acc.active).toBe(false)
        expect(acc.superseded).toContain(ee)
        expect(acc.deactivated).toMatchObject({ code: 'GRANTS_REVOKED_ELSEWHERE', opId: 'own-7-renew' })
      }
    }
  })

  test('otto/mamoru#140: a renewal whose grants cannot be read now is not applied from its receipt: left for later', async () => {
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const ee = `0x${'ee'.repeat(32)}` as Hex
    const stx = `0x${'5a'.repeat(32)}` as Hex
    const hash = `0x${'ab'.repeat(32)}` as Hex
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', txHash: hash, safeTxHash: stx, updatedAt: new Date().toISOString(), ownerGrants: [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: ee }], revokes: old } as never)
    type C = { getTransactionReceipt(a: { hash: Hex }): Promise<unknown>; readContract(a: { functionName: string }): Promise<unknown> }
    const client = (w.op as unknown as { client: C }).client
    client.getTransactionReceipt = async () => ({ transactionHash: hash, status: 'success', blockNumber: 90n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, stx] }] })
    const read = client.readContract.bind(client)
    client.readContract = async (a) => {
      if (a.functionName === 'isPermissionEnabled') throw new Error('HTTP request failed. Status: 429')
      return read(a)
    }
    await w.op.reconcileOwner(acc)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(old)
  })

  test('otto/mamoru#140: a renewal whose grants cannot be read right after its receipt is left to reconciliation, not applied', async () => {
    const { w, acc } = await running()
    const before = acc.grants.map((g) => g.permissionId)
    type C = { getBlockNumber(): Promise<bigint>; readContract(a: { functionName: string }): Promise<unknown> }
    const client = (w.op as unknown as { client: C }).client
    const read = client.readContract.bind(client)
    let sent = false
    w.knobs.onSend = () => void (sent = true)
    client.getBlockNumber = async () => (sent ? 120n : 100n)
    client.readContract = async (a) => {
      if (sent && a.functionName === 'isPermissionEnabled') throw new Error('HTTP request failed. Status: 429')
      return read(a)
    }
    const op = await w.op.submit(ctx, 'renew', sign(await w.op.prepareRenew(ctx)))
    expect(op).toMatchObject({ kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.ops.find((o) => o.opId === op.opId)?.txHash).toBeDefined()
    expect(acc.grants.map((g) => g.permissionId)).toEqual(before)
  })

  test('otto/mamoru#140: a renewal found late after a Start is never applied over it; its grants stay tracked', async () => {
    const { w, acc } = await running()
    const mine = acc.grants.map((g) => g.permissionId)
    const ee = `0x${'ee'.repeat(32)}` as Hex
    const stx = `0x${'5a'.repeat(32)}` as Hex
    const hash = `0x${'ab'.repeat(32)}` as Hex
    // An unread renewal from before, then a Start that confirmed (the account's grants now are that Start's).
    const i = acc.ops.findIndex((o) => o.kind === 'activate')
    acc.ops.splice(i, 0, { opId: 'own-0-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', txHash: hash, safeTxHash: stx, updatedAt: new Date().toISOString(), ownerGrants: [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: ee }], revokes: [] } as never)
    type C = { getTransactionReceipt(a: { hash: Hex }): Promise<unknown>; readContract(a: { functionName: string; args?: readonly unknown[] }): Promise<unknown> }
    const client = (w.op as unknown as { client: C }).client
    client.getTransactionReceipt = async () => ({ transactionHash: hash, status: 'success', blockNumber: 90n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, stx] }] })
    w.knobs.enabled.add(ee)
    await w.op.reconcileOwner(acc)
    expect(acc.active).toBe(true)
    expect(acc.grants.map((g) => g.permissionId)).toEqual(mine)
    expect(acc.superseded).toContain(ee)
  })

  test('otto/mamoru#140: a Stop sweeps the chain first, so a revoked grant the owner enabled again is revoked too', async () => {
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
    expect(acc.active).toBe(false)
    expect(old.every((id) => !w.knobs.enabled.has(id.toLowerCase()))).toBe(true)
    // The owner enables one of them again; no engine loop runs on a stopped account, so only the Stop can see it.
    w.knobs.enabled.add(old[0]!.toLowerCase())
    const tx = await w.op.prepareStop(ctx)
    expect(tx.summary).toContain("Revoke the engine's 1 session grant(s)")
    await w.op.submit(ctx, 'stop', sign(tx))
    expect(w.knobs.enabled.has(old[0]!.toLowerCase())).toBe(false)
  })

  test('otto/mamoru#140: a Stop whose grant sweep cannot read the chain is refused, nothing prepared', async () => {
    const { w } = await running()
    type C = { readContract(a: { functionName: string }): Promise<unknown> }
    const client = (w.op as unknown as { client: C }).client
    const read = client.readContract.bind(client)
    client.readContract = async (a) => {
      if (a.functionName === 'isPermissionEnabled') throw new Error('HTTP request failed. Status: 429')
      return read(a)
    }
    expect(await w.op.prepareStop(ctx).catch((e: unknown) => e)).toMatchObject({ status: 503, code: 'GRANT_CHECK_UNAVAILABLE' })
  })

  test('otto/mamoru#140: a first Start, nothing tracked yet, still needs the chain readable', async () => {
    const w = world(20_000_000n)
    ;(w.op as unknown as Loop).startLoop = () => {}
    const tx = await w.op.prepareActivate(ctx)
    type C = { getBlockNumber(): Promise<bigint> }
    ;(w.op as unknown as { client: C }).client.getBlockNumber = async () => {
      throw new Error('HTTP request failed. Status: 429')
    }
    expect(await w.op.submit(ctx, 'activate', sign(tx)).catch((e: unknown) => e)).toMatchObject({ status: 503, code: 'GRANT_CHECK_UNAVAILABLE' })
    expect(w.state.accounts.k?.active ?? false).toBe(false)
  })

  test('otto/mamoru#140: an account stopped by the grant check is never saved inactive without its reason', async () => {
    const { w, acc } = await running()
    const saves: { active: boolean; code?: string }[] = []
    const store = (w.op as unknown as { store: { save(): void } }).store
    store.save = () => void saves.push({ active: acc.active, code: acc.deactivated?.code })
    // The owner revokes one engine grant elsewhere; the next full sweep stops the engine.
    w.knobs.enabled.delete(acc.grants[0]!.permissionId.toLowerCase())
    expect(await (w.op as unknown as { enforceGrants(a: AccountState): Promise<boolean> }).enforceGrants(acc)).toBe(true)
    expect(acc.active).toBe(false)
    expect(saves.length).toBeGreaterThan(0)
    expect(saves.filter((s) => !s.active).every((s) => s.code === 'GRANTS_PARTLY_REVOKED')).toBe(true)
  })

  test('otto/mamoru#140: Start is refused while earlier grants are still enabled on the Safe; a Stop revokes them, then Start works', async () => {
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const ee = `0x${'ee'.repeat(32)}` as Hex
    const ff = `0x${'ff'.repeat(32)}` as Hex
    const fresh = [ee, ff].map((permissionId) => ({ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId }))
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: old, safeTxHash: keccak256(stringToHex('stx-' + Math.random())), safeNonce: '1' } as never)
    // Its nonce spent by other Safe txs (the chain shows which: otto/mamoru#163), its old grants revoked, ff enabled.
    for (const id of old) w.knobs.enabled.delete(id.toLowerCase())
    w.knobs.enabled.add(ff)
    spentElsewhere(w, 1n, 3n)
    await w.op.prepareRenew(ctx).catch(() => undefined)
    expect(acc.active).toBe(false)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'RENEWAL_UNPROVEN' })
    expect(acc.superseded).toContain(ff)
    // Start before Stop: refused at prepare, and at submit for one prepared before.
    expect(await w.op.prepareActivate(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'STOP_FIRST' })
    const sup = acc.superseded
    w.knobs.enabled.delete(ff)
    const early = await w.op.prepareActivate(ctx)
    w.knobs.enabled.add(ff)
    acc.superseded = sup
    expect(await w.op.submit(ctx, 'activate', sign(early)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'STOP_FIRST' })
    expect(acc.active).toBe(false)
    // The Stop revokes ff; Start is then allowed again.
    await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
    expect(acc.revoked).toContain(ff)
    expect(acc.superseded ?? []).toEqual([])
    const again = await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    expect(again).toMatchObject({ kind: 'activate', state: 'confirmed' })
    expect(acc.active).toBe(true)
    expect(acc.deactivated).toBeUndefined()
  })

  test('otto/mamoru#140: a grant sweep is one Multicall3 batch per 100 ids; a past id read disabled is read again and tracked once re-enabled', async () => {
    const { w, acc } = await running()
    const old = Array.from({ length: 30 }, (_, i) => toHex(i + 1, { size: 32 }))
    acc.revoked.push(...old)
    w.knobs.batchGrants = true
    type Sweep = { enforceGrants(a: AccountState, o?: { full?: boolean }): Promise<boolean> }
    const sweep = (o?: { full?: boolean }) => (w.op as unknown as Sweep).enforceGrants(acc, o)
    const before = w.knobs.multicalls
    expect(await sweep()).toBe(true)
    expect(w.knobs.multicalls - before).toBe(1)
    expect(w.knobs.batchedGrantReads).toBe(acc.grants.length + old.length)
    expect(acc.active).toBe(true)
    // No retirement (I3): the owner enables one of those old ids again; the next sweep reads it and tracks it.
    w.knobs.enabled.add(old[3]!.toLowerCase())
    w.knobs.batchedGrantReads = 0
    await sweep()
    expect(w.knobs.batchedGrantReads).toBe(acc.grants.length + old.length)
    expect(acc.superseded).toContain(old[3])
  })

  test('otto/mamoru#140: the engine loop sweep reads the engine grants every time and every other id within sweepsToCover sweeps', async () => {
    const { w, acc } = await running()
    const E = acc.grants.length
    const old = Array.from({ length: 250 }, (_, i) => toHex(i + 1, { size: 32 }))
    acc.revoked.push(...old)
    w.knobs.batchGrants = true
    type Sweep = { enforceGrants(a: AccountState, o?: { full?: boolean }): Promise<boolean> }
    const n = sweepsToCover(old.length, E)
    expect(n).toBe(Math.ceil(250 / (100 - E)))
    // The oldest id is enabled again by the owner: some sweep within n finds it.
    w.knobs.enabled.add(old[0]!.toLowerCase())
    w.knobs.enabled.add(old[249]!.toLowerCase())
    const reads: number[] = []
    for (let i = 0; i < n; i++) {
      w.knobs.batchedGrantReads = 0
      const calls = w.knobs.multicalls
      expect(await (w.op as unknown as Sweep).enforceGrants(acc, { full: false })).toBe(true)
      expect(w.knobs.multicalls - calls).toBe(1)
      reads.push(w.knobs.batchedGrantReads)
      // The engine's grants are read every sweep: the account is still running on enabled grants.
      expect(acc.active).toBe(true)
    }
    expect(Math.max(...reads)).toBeLessThanOrEqual(100)
    expect(acc.superseded).toEqual(expect.arrayContaining([old[0], old[249]]))
    // An engine grant revoked elsewhere is seen at the very next loop sweep, whatever the rotation.
    w.knobs.enabled.delete(acc.grants[0]!.permissionId.toLowerCase())
    await (w.op as unknown as Sweep).enforceGrants(acc, { full: false })
    expect(acc.active).toBe(false)
    expect(acc.deactivated?.code).toBe('GRANTS_PARTLY_REVOKED')
  })

  test('otto/mamoru#140: Start is refused (GRANT_CHECK_UNAVAILABLE) while the grant sweep cannot read the chain at the account floor', async () => {
    const { w, acc } = await running()
    // Stopped through the real path, so Start is otherwise allowed.
    await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
    expect(acc.active).toBe(false)
    type Read = { readContract(a: { functionName: string }): Promise<unknown> }
    const client = (w.op as unknown as { client: Read }).client
    const read = client.readContract.bind(client)
    client.readContract = async (a) => {
      if (a.functionName === 'isPermissionEnabled') throw new Error('HTTP request failed. Status: 429')
      return read(a)
    }
    expect(await w.op.prepareActivate(ctx).catch((e: unknown) => e)).toMatchObject({ status: 503, code: 'GRANT_CHECK_UNAVAILABLE' })
    client.readContract = read
    // One prepared while reads worked is refused at submit when they fail again.
    const t = await w.op.prepareActivate(ctx)
    w.knobs.head = 10n
    expect(await w.op.submit(ctx, 'activate', sign(t)).catch((e: unknown) => e)).toMatchObject({ status: 503, code: 'GRANT_CHECK_UNAVAILABLE' })
    expect(acc.active).toBe(false)
    w.knobs.head = 100n
    expect(await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))).toMatchObject({ kind: 'activate', state: 'confirmed' })
  })

  test('otto/mamoru#140: the engine review is held while its grant check fails; it runs again once a check reads the chain', async () => {
    const { w, acc } = await running()
    type Gate = { grantGate(a: AccountState, at: number): Promise<boolean>; grantsChecked: Map<string, number> }
    const g = w.op as unknown as Gate
    type Read = { readContract(a: { functionName: string }): Promise<unknown> }
    const client = (w.op as unknown as { client: Read }).client
    const read = client.readContract.bind(client)
    client.readContract = async (a) => {
      if (a.functionName === 'isPermissionEnabled') throw new Error('HTTP request failed. Status: 429')
      return read(a)
    }
    const t0 = Date.now()
    expect(await g.grantGate(acc, t0)).toBe(false)
    // Not counted as checked: the very next tick asks again, and holds again.
    expect(g.grantsChecked.has(acc.accountKey)).toBe(false)
    expect(await g.grantGate(acc, t0 + 1)).toBe(false)
    // A provider behind the account holds it too.
    client.readContract = read
    w.knobs.head = 10n
    expect(await g.grantGate(acc, t0 + 2)).toBe(false)
    w.knobs.head = 100n
    expect(await g.grantGate(acc, t0 + 3)).toBe(true)
    expect(acc.active).toBe(true)
    // Verified: the next reviews within GRANTS_CHECK_MS go ahead without a read.
    expect(await g.grantGate(acc, t0 + 4)).toBe(true)
  })

  test('otto/mamoru#140: a full sweep reads every tracked id at one pinned block, in batches sent one at a time', async () => {
    const { w, acc } = await running()
    await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
    const old = Array.from({ length: 1200 }, (_, i) => toHex(i + 1, { size: 32 }))
    acc.revoked.push(...old)
    w.knobs.batchGrants = true
    type C = { call(a: { blockNumber?: bigint }): Promise<unknown> }
    const client = (w.op as unknown as { client: C }).client
    const call = client.call.bind(client)
    let inflight = 0
    let peak = 0
    const blocks = new Set<string>()
    client.call = async (a) => {
      inflight++
      peak = Math.max(peak, inflight)
      blocks.add(String(a.blockNumber))
      await Bun.sleep(1)
      try {
        return await call(a)
      } finally {
        inflight--
      }
    }
    const before = w.knobs.multicalls
    expect((await w.op.prepareActivate(ctx)).summary.length).toBeGreaterThan(0)
    const known = new Set(acc.revoked.map((id) => id.toLowerCase())).size
    expect(w.knobs.batchedGrantReads).toBe(known)
    // Batches of 100 at most, one at a time, all at the same block.
    expect(w.knobs.multicalls - before).toBeGreaterThanOrEqual(Math.ceil(known / 100))
    expect(peak).toBe(1)
    expect([...blocks].filter((b) => b !== 'undefined')).toEqual(['100'])
  })

  test('otto/mamoru#140 property: Start passes only on a snapshot of one block in which every tracked id was read; later re-enables are caught by the loop sweep', async () => {
    for (const size of [50, 600, 1000])
      for (const reenabled of [0, 1, 300])
        for (const change of ['none', 'add-enabled', 'superseded-shrinks', 're-enable-read-id'] as const) {
          const label = JSON.stringify({ size, reenabled, change })
          const { w, acc } = await running()
          await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
          w.knobs.batchGrants = true
          const half = Math.floor(size / 2)
          const ids = Array.from({ length: size }, (_, i) => toHex(i + 1, { size: 32 }))
          acc.superseded = ids.slice(0, half)
          acc.revoked.push(...ids.slice(half))
          for (const id of ids.slice(half, half + reenabled)) w.knobs.enabled.add(id.toLowerCase())
          const A = ids[0]!
          const extra = toHex(99_999, { size: 32 })
          // A first Start: one snapshot. Then the chain or the list changes, and Start is asked again.
          const first = await w.op.prepareActivate(ctx).catch((e: unknown) => e)
          if (change === 'add-enabled') {
            acc.revoked.push(extra)
            w.knobs.enabled.add(extra.toLowerCase())
          }
          if (change === 'superseded-shrinks') acc.superseded = (acc.superseded ?? []).slice(0, 3)
          // The review's case: an id read disabled in the first snapshot, enabled again by the owner before the second.
          if (change === 're-enable-read-id') w.knobs.enabled.add(A.toLowerCase())
          const second = await w.op.prepareActivate(ctx).catch((e: unknown) => e)
          const enabledNow = [...w.knobs.enabled]
          const tracked = new Set([...acc.grants.map((g) => g.permissionId), ...(acc.superseded ?? [])].map((id) => id.toLowerCase()))
          // I3 at Start: after each snapshot every enabled id is tracked, and Start passes only when none is left.
          expect(enabledNow.filter((id) => !tracked.has(id)), label).toEqual([])
          const expectFirst = reenabled === 0
          expect(first instanceof HttpError ? first.code : 'ok', label).toBe(expectFirst ? 'ok' : 'STOP_FIRST')
          const expectSecond = reenabled === 0 && change !== 'add-enabled' && change !== 're-enable-read-id'
          expect(second instanceof HttpError ? second.code : 'ok', label).toBe(expectSecond ? 'ok' : 'STOP_FIRST')
        }
  }, 240_000)

  test('otto/mamoru#140: a grant re-enabled after a Start snapshot is tracked by the engine loop sweep within sweepsToCover sweeps', async () => {
    const { w, acc } = await running()
    const old = Array.from({ length: 400 }, (_, i) => toHex(i + 1, { size: 32 }))
    acc.revoked.push(...old)
    w.knobs.batchGrants = true
    type Sweep = { enforceGrants(a: AccountState, o?: { full?: boolean }): Promise<boolean> }
    expect(await (w.op as unknown as Sweep).enforceGrants(acc)).toBe(true)
    expect(acc.superseded ?? []).toEqual([])
    // After the snapshot, the owner enables an old id.
    w.knobs.enabled.add(old[123]!.toLowerCase())
    const others = new Set(acc.revoked.map((id) => id.toLowerCase())).size + (acc.superseded?.length ?? 0)
    const n = sweepsToCover(others, acc.grants.length)
    for (let i = 0; i < n; i++) await (w.op as unknown as Sweep).enforceGrants(acc, { full: false })
    expect(acc.superseded).toContain(old[123])
  })

  test('otto/mamoru#140 property: a read error never finalises an owner op; an unproven renewal is retried until its receipt or log answers', async () => {
    for (const failure of ['receipt-error', 'logs-error', 'none'] as const)
      for (const ran of [false, true]) {
        const label = JSON.stringify({ failure, ran })
        const { w, acc } = await running()
        const had = acc.grants.map((g) => g.permissionId)
        const ee = `0x${'ee'.repeat(32)}` as Hex
        const stx = keccak256(stringToHex(`stx-${failure}-${ran}`))
        const hash = keccak256(stringToHex(`tx-${failure}-${ran}`))
        const R = { opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: ee }], revokes: had, safeTxHash: stx, safeNonce: '1', ...(failure === 'receipt-error' ? { txHash: hash } : {}) }
        acc.ops.push(R as never)
        if (ran) {
          for (const id of had) w.knobs.enabled.delete(id.toLowerCase())
          w.knobs.enabled.add(ee)
        }
        // otto/mamoru#163: what spent nonce 1 is in that block's own logs: R itself when it ran, another Safe tx if not.
        spentElsewhere(w, 1n, 3n)
        if (ran) w.knobs.foreign[0] = { stx, hash, block: 100n }
        type C = { getTransactionReceipt(a: unknown): Promise<unknown>; getLogs(a: unknown): Promise<unknown> }
        const client = (w.op as unknown as { client: C }).client
        const getReceipt = client.getTransactionReceipt.bind(client)
        const getLogs = client.getLogs.bind(client)
        ;(w.op as unknown as { receiptOf(h: Hex): Promise<unknown> }).receiptOf = async () => null
        if (failure === 'receipt-error') client.getTransactionReceipt = async () => {
          throw new Error('HTTP request failed. Status: 503')
        }
        if (failure === 'logs-error') client.getLogs = async () => {
          throw new Error('HTTP request failed. Status: 429')
        }
        await w.op.prepareRenew(ctx).catch(() => undefined)
        const st = () => acc.ops.find((o) => o.opId === R.opId)!
        // A read error: undecided, still an unread receipt. Reads that answer: the block that spent the nonce says which
        // Safe tx did (otto/mamoru#163): R itself (applied at once, every grant enabled), or another one (superseded).
        if (failure === 'none' && ran) {
          expect(st(), label).toMatchObject({ state: 'confirmed', txHash: hash })
          expect(acc.grants.map((g) => g.permissionId), label).toEqual([ee])
          continue
        }
        if (failure === 'none') expect(st().code, label).toBe('RENEWAL_SUPERSEDED')
        else expect(st(), label).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
        expect(st().state, label).toBe('failed')
        // The provider recovers and its log (or receipt) is found: a renewal that ran is applied, every grant enabled.
        client.getTransactionReceipt = getReceipt
        client.getLogs = getLogs
        if (ran) {
          w.knobs.logs.push({ stx, hash, block: 99n })
          ;(w.op as unknown as { receiptOf(h: Hex): Promise<unknown> }).receiptOf = async () => ({ transactionHash: hash, status: 'success', blockNumber: 99n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, stx] }] })
          await w.op.prepareRenew(ctx).catch(() => undefined)
          await w.op.reconcileOwner(acc)
          expect(st(), label).toMatchObject({ state: 'confirmed' })
          // While it was unproven the engine was stopped (I1: its old grants read revoked); proven now, its grant is
          // tracked (superseded, for the next stop, since the account no longer runs), never lost.
          expect(acc.active, label).toBe(false)
          expect(acc.superseded, label).toContain(ee)
        }
      }
  }, 120_000)

  test('otto/mamoru#140: reconciliation retries on its own, with backoff, while an owner op is unresolved, and stops once it resolves', async () => {
    const { w, acc } = await running()
    const stx = `0x${'5a'.repeat(32)}` as Hex
    const hash = `0x${'ab'.repeat(32)}` as Hex
    acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', txHash: hash, safeTxHash: stx, updatedAt: new Date().toISOString() } as never)
    type R = { reconcileRetryMs: number; reconcileRetryMaxMs: number; reconcileSoon(a: AccountState): void; reconcileTimers: Map<string, { delay: number }>; receiptOf(h: Hex): Promise<unknown> }
    const o = w.op as unknown as R
    o.reconcileRetryMs = 5
    o.reconcileRetryMaxMs = 20
    // An RPC outage: the first passes cannot read anything; then the receipt is served.
    let tries = 0
    const delays: number[] = []
    o.receiptOf = async () => {
      tries++
      const t = o.reconcileTimers.get(acc.accountKey)
      if (t) delays.push(t.delay)
      return tries < 5 ? null : { transactionHash: hash, status: 'success', blockNumber: 99n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, stx] }] }
    }
    o.reconcileSoon(acc)
    for (let i = 0; i < 100 && acc.ops.find((x) => x.opId === 'own-7-exit')!.state !== 'confirmed'; i++) await Bun.sleep(5)
    expect(acc.ops.find((x) => x.opId === 'own-7-exit')).toMatchObject({ state: 'confirmed', txHash: hash })
    expect(tries).toBeGreaterThanOrEqual(5)
    // The wait doubled up to its maximum, and nothing is scheduled once resolved.
    expect(delays.slice(0, 3)).toEqual([5, 10, 20])
    await Bun.sleep(30)
    expect(o.reconcileTimers.has(acc.accountKey)).toBe(false)
    w.op.shutdown()
  })

  test('otto/mamoru#140: a Start whose grant state changes between submit and execution is checked again under the lock', async () => {
    for (const change of ['superseded', 'unreadable'] as const) {
      const { w, acc } = await running()
      await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
      const t = await w.op.prepareActivate(ctx)
      type Sweep = { enforceGrants(a: AccountState): Promise<boolean> }
      const o = w.op as unknown as Sweep
      const real = o.enforceGrants.bind(w.op)
      let calls = 0
      // The submit check passes; by the time the locked execution runs, an earlier grant is enabled again (or the
      // chain cannot be read).
      o.enforceGrants = async (a) => {
        calls++
        if (calls === 1) return real(a)
        if (change === 'unreadable') return false
        acc.superseded = [`0x${'ee'.repeat(32)}` as Hex]
        return true
      }
      const sent = w.sent.length
      const op = await w.op.submit(ctx, 'activate', sign(t))
      expect(op, change).toMatchObject({ kind: 'activate', state: 'failed', code: change === 'superseded' ? 'STOP_FIRST' : 'GRANT_CHECK_UNAVAILABLE' })
      expect(w.sent.length, change).toBe(sent)
      expect(acc.active, change).toBe(false)
    }
  })

  test('otto/mamoru#140: the engine grants are read on every tick (one Multicall3 call): a revocation stops the engine within one tick', async () => {
    const { w, acc } = await running()
    acc.revoked.push(...Array.from({ length: 300 }, (_, i) => toHex(i + 1, { size: 32 })))
    w.knobs.batchGrants = true
    type Gate = { grantGate(a: AccountState, at: number): Promise<boolean> }
    const g = w.op as unknown as Gate
    const t0 = Date.now()
    expect(await g.grantGate(acc, t0)).toBe(true)
    // Within GRANTS_CHECK_MS: only the engine's grants are read, in one call.
    w.knobs.batchedGrantReads = 0
    const calls = w.knobs.multicalls
    expect(await g.grantGate(acc, t0 + 1_000)).toBe(true)
    expect(w.knobs.multicalls - calls).toBe(1)
    expect(w.knobs.batchedGrantReads).toBe(acc.grants.length)
    // The owner revokes one engine grant right after: the very next tick sees it and stops the engine.
    w.knobs.enabled.delete(acc.grants[0]!.permissionId.toLowerCase())
    await g.grantGate(acc, t0 + 2_000)
    expect(acc.active).toBe(false)
    expect(acc.deactivated?.code).toBe('GRANTS_PARTLY_REVOKED')
  })

  test('otto/mamoru#140: past 2000 tracked ids a full grant check alerts, and still reads every id (no retirement)', async () => {
    const { w, acc } = await running()
    const old = Array.from({ length: 2100 }, (_, i) => toHex(i + 1, { size: 32 }))
    acc.revoked.push(...old)
    w.knobs.batchGrants = true
    const lines: string[] = []
    const err = console.error
    console.error = (...a: unknown[]) => void lines.push(a.join(' '))
    try {
      type Sweep = { enforceGrants(a: AccountState): Promise<boolean> }
      expect(await (w.op as unknown as Sweep).enforceGrants(acc)).toBe(true)
    } finally {
      console.error = err
    }
    expect(lines.some((l) => l.startsWith('[alert]') && l.includes('permission ids'))).toBe(true)
    expect(w.knobs.batchedGrantReads).toBe(acc.grants.length + new Set(acc.revoked.map((id) => id.toLowerCase())).size)
  })

  test('otto/mamoru#140: reconciliation does not apply an older renewal on a head below the account floor', async () => {
    const { w, acc } = await running()
    const had = acc.grants.map((g) => g.permissionId)
    const ee = `0x${'ee'.repeat(32)}` as Hex
    const stx = `0x${'5a'.repeat(32)}` as Hex
    const hash = `0x${'ab'.repeat(32)}` as Hex
    // A renewal whose receipt is readable at block 90; a later owner op of the account is recorded at block 200.
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', txHash: hash, safeTxHash: stx, updatedAt: new Date().toISOString(), ownerGrants: [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: ee }], revokes: [] } as never)
    acc.ops.push({ opId: 'own-8-transfer', kind: 'transfer', state: 'confirmed', code: 'EXEC_OK', block: 200, updatedAt: new Date().toISOString() } as never)
    w.knobs.enabled.add(ee)
    ;(w.op as unknown as { receiptOf(h: Hex): Promise<unknown> }).receiptOf = async () => ({ transactionHash: hash, status: 'success', blockNumber: 90n, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, stx] }] })
    w.knobs.head = 150n
    await w.op.reconcileOwner(acc)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(had)
    expect(acc.active).toBe(true)
    // The head reaches the floor: it is applied from its receipt, every grant enabled.
    w.knobs.head = 210n
    await w.op.reconcileOwner(acc)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'confirmed' })
  })

  test('otto/mamoru#140: a provider whose head is behind the account defers every grant decision, never stops the engine', async () => {
    const { w, acc } = await running()
    const had = acc.grants.map((g) => g.permissionId)
    const ee = `0x${'ee'.repeat(32)}` as Hex
    // A renewal that ran, its receipt unread but its log readable at block 99; the provider answering is at 50.
    const R = { opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: ee }], revokes: had, safeNonce: '1' }
    acc.ops.push(R as never)
    landed(w, R as never)
    w.chain.nonce = 2n
    w.knobs.head = 50n
    await w.op.prepareRenew(ctx).catch(() => undefined)
    await w.op.reconcileOwner(acc)
    expect(acc.active).toBe(true)
    expect(acc.deactivated).toBeUndefined()
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(had)
    // The head catches up: the renewal is applied from its proof, every grant enabled.
    w.knobs.head = 100n
    await w.op.prepareRenew(ctx).catch(() => undefined)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'confirmed' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual([ee])
    expect(acc.active).toBe(true)
  })

  test('otto/mamoru#140 invariants I1-I3 hold after every settle pass, over every combination of owner ops and chain events', async () => {
    type Owner = 'none' | 'some' | 'all'
    const cases: { renewalRan: boolean; stopRan: boolean; read: boolean; owner: Owner; reenable: boolean; start: 'before' | 'after'; lag: boolean; flaky: boolean }[] = []
    for (const renewalRan of [false, true])
      for (const stopRan of [false, true])
        for (const read of [false, true])
          for (const owner of ['none', 'some', 'all'] as const)
            for (const reenable of renewalRan ? [false] : [false, true])
              for (const start of ['before', 'after'] as const)
                for (const lag of [false, true])
                  for (const flaky of [false, true]) cases.push({ renewalRan, stopRan, read, owner, reenable, start, lag, flaky })
    expect(cases.length).toBe(288)
    for (const c of cases) {
      const label = JSON.stringify(c)
      const { w, acc } = await running()
      const E = acc.grants.map((g) => g.permissionId)
      const N = [`0x${'e1'.repeat(32)}`, `0x${'e2'.repeat(32)}`] as Hex[]
      const k = w.chain.nonce
      const sR = `0x${'a1'.repeat(32)}` as Hex
      const sS = `0x${'a2'.repeat(32)}` as Hex
      const hR = `0x${'b1'.repeat(32)}` as Hex
      const hS = `0x${'b2'.repeat(32)}` as Hex
      const R = { opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: N.map((permissionId) => ({ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId })), revokes: E, safeTxHash: sR, safeNonce: k.toString(), ...(c.read ? { txHash: hR } : {}) }
      const S = { opId: 'own-8-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), revokes: [...E, ...N], safeTxHash: sS, ...(c.read ? { txHash: hS } : {}) }
      acc.ops.push(R as never, S as never)
      // The chain: what ran, what the owner did with transactions of their own, and which receipts and logs can be read.
      const on = w.knobs.enabled
      const receipts = new Map<string, unknown>()
      const ran = new Set<string>()
      const execute = (stx: Hex, hash: Hex, block: bigint) => {
        if (c.read) {
          w.knobs.logs.push({ stx, hash, block })
          receipts.set(hash, { transactionHash: hash, status: 'success', blockNumber: block, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, stx] }] })
        }
      }
      if (c.renewalRan) {
        for (const id of E) on.delete(id.toLowerCase())
        for (const id of N) on.add(id.toLowerCase())
        w.chain.nonce = k + 1n
        ran.add(R.opId)
        execute(sR, hR, 95n)
      }
      if (c.reenable) {
        for (const id of N) on.add(id.toLowerCase())
        w.chain.nonce++
      }
      if (c.stopRan) {
        for (const id of [...E, ...N]) on.delete(id.toLowerCase())
        w.chain.nonce++
        ran.add(S.opId)
        execute(sS, hS, 97n)
      }
      const mine = [...E, ...N].map((id) => id.toLowerCase()).filter((id) => on.has(id)).sort()
      if (c.owner !== 'none' && mine.length) {
        for (const id of c.owner === 'some' ? mine.slice(0, 1) : mine) on.delete(id)
        w.chain.nonce++
      }
      ;(w.op as unknown as { receiptOf(h: Hex): Promise<unknown> }).receiptOf = async (h) => receipts.get(h.toLowerCase()) ?? receipts.get(h) ?? null

      const check = (when: string) => {
        const at = `${label} ${when}`
        // I1: the engine runs only on grants that are all enabled.
        if (acc.active) expect(acc.grants.filter((g) => !on.has(g.permissionId.toLowerCase())).map((g) => g.permissionId), at).toEqual([])
        // I2: an owner op is confirmed (or taken as run and partly revoked) only when it ran and its own receipt or log is readable.
        for (const o of [R, S]) {
          const st = acc.ops.find((x) => x.opId === o.opId)!
          if (st.state === 'confirmed' || st.code === 'RENEWAL_PARTLY_REVOKED') expect({ op: o.opId, ran: ran.has(o.opId), read: c.read }, at).toEqual({ op: o.opId, ran: true, read: true })
        }
        // I3: every grant enabled on the chain is tracked: the engine's, or in superseded.
        const tracked = new Set([...acc.grants.map((g) => g.permissionId), ...(acc.superseded ?? [])].map((id) => id.toLowerCase()))
        expect([...on].filter((id) => !tracked.has(id)), at).toEqual([])
      }
      const settle = async () => {
        await w.op.prepareRenew(ctx).catch(() => undefined)
        await w.op.reconcileOwner(acc)
        await w.op.prepareRenew(ctx).catch(() => undefined)
      }
      const tryStart = async (when: string) => {
        // flaky: the grant reads fail while Start is asked (a 429 storm): it must never start blind.
        type Read = { readContract(a: { functionName: string }): Promise<unknown> }
        const client = (w.op as unknown as { client: Read }).client
        const read = client.readContract.bind(client)
        if (c.flaky)
          client.readContract = async (a) => {
            if (a.functionName === 'isPermissionEnabled') throw new Error('HTTP request failed. Status: 429')
            return read(a)
          }
        const res = await w.op.prepareActivate(ctx).then((t) => w.op.submit(ctx, 'activate', sign(t))).catch((e: unknown) => e)
        client.readContract = read
        if (res instanceof HttpError) expect(c.flaky ? ['ALREADY_ACTIVE', 'GRANT_CHECK_UNAVAILABLE'] : ['ALREADY_ACTIVE', 'STOP_FIRST'], `${label} ${when}`).toContain(res.code)
        else {
          expect(c.flaky, `${label} ${when}: started on unread grants`).toBe(false)
          expect(res, `${label} ${when}`).toMatchObject({ kind: 'activate', state: 'confirmed' })
        }
        // Invariants are established by a pass that read the chain: with the reads failing none could, so only
        // "nothing started" is asserted above; the settle pass after it checks them all.
        if (!c.flaky) check(`after Start ${when}`)
      }
      if (c.lag) {
        // A provider behind the account first: nothing may be decided on that view. No engine whose grants are all
        // enabled is stopped, no renewal is taken as partly revoked or unproven, and I2 holds.
        const was = acc.active
        const g0 = acc.grants.map((g) => g.permissionId.toLowerCase())
        w.knobs.head = 50n
        await settle()
        // (A stop proven by its own receipt may still settle: that is proof, not a grant read.)
        if (was && g0.every((id) => on.has(id))) expect(acc.active, `${label} lagging`).toBe(true)
        expect(acc.deactivated, `${label} lagging`).toBeUndefined()
        expect(['RENEWAL_PARTLY_REVOKED', 'RENEWAL_UNPROVEN'], `${label} lagging`).not.toContain(acc.ops.find((x) => x.opId === R.opId)!.code)
        w.knobs.head = 100n
      }
      if (c.start === 'before') await tryStart('before settle')
      await settle()
      check('after settle')
      if (c.start === 'after') {
        await tryStart('after settle')
        await settle()
        check('after Start and settle')
      }
    }
  }, 240_000)

  test('otto/mamoru#140: an unread renewal is forgotten only when every one of its grants reads disabled', async () => {
    const { w, acc } = await running()
    const ee = `0x${'ee'.repeat(32)}` as Hex
    const ff = `0x${'ff'.repeat(32)}` as Hex
    const fresh = [ee, ff].map((permissionId) => ({ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId }))
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: [], safeTxHash: keccak256(stringToHex('stx-' + Math.random())), safeNonce: '1' } as never)
    spentElsewhere(w, 1n, 3n)
    type Read = { readContract(a: { functionName: string; args?: readonly unknown[] }): Promise<unknown> }
    const client = (w.op as unknown as { client: Read }).client
    const read = client.readContract.bind(client)
    // One of its grants cannot be read: nothing is decided.
    client.readContract = async (a) => {
      if (a.functionName !== 'isPermissionEnabled') return read(a)
      if (a.args![0] === ff) throw new Error('HTTP request failed. Status: 429')
      return false
    }
    await w.op.prepareRenew(ctx).catch(() => undefined)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    // Both read disabled with the nonce spent: it can never run and nothing of it is left.
    client.readContract = async (a) => (a.functionName === 'isPermissionEnabled' ? false : read(a))
    await w.op.prepareRenew(ctx).catch(() => undefined)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'RENEWAL_SUPERSEDED' })
  })

  test('a renewal that ran unread is settled before a stop is judged: its revoked old grants are not taken for a stop that ran', async () => {
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const fresh = [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }]
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: old } as never)
    acc.ops.push({ opId: 'own-8-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString() } as never)
    // The renewal ran (its own ExecutionSuccess): its grant enabled, the old ones revoked. The stop has not run.
    landed(w, acc.ops.find((o) => o.opId === 'own-7-renew') as never)
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ code: 'STOP_IN_FLIGHT' })
    expect(acc.active).toBe(true)
    expect(acc.grants.map((g) => g.permissionId)).toEqual([`0x${'ee'.repeat(32)}`])
    expect(acc.ops.find((o) => o.opId === 'own-8-exit')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('a renewal that ran unread, still behind on the block read for it, is not taken for a stop that ran', async () => {
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const ee = `0x${'ee'.repeat(32)}` as Hex
    const fresh = [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: ee }]
    // A stop that never ran (its receipt unread), then a renewal that did run, its receipt unread too.
    acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), revokes: old } as never)
    acc.ops.push({ opId: 'own-8-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: old } as never)
    // `latest` shows the renewal (its grant enabled, the old ones revoked); a block read by number comes from a node behind it.
    type Read = { readContract(a: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> }
    const client = (w.op as unknown as { client: Read }).client
    const read = client.readContract.bind(client)
    client.readContract = async (a) => (a.functionName === 'isPermissionEnabled' ? (a.blockNumber === undefined ? a.args![0] === ee : a.args![0] !== ee) : read(a))
    await w.op.prepareRenew(ctx).catch(() => undefined)
    expect(acc.active).toBe(true)
    expect(acc.ops.find((o) => o.opId === 'own-7-exit')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(old)
  })

  test('a renewal of unknown outcome whose Safe nonce another transaction spent is no longer revoked by every later one', async () => {
    const { w, acc } = await running()
    const ee = `0x${'ee'.repeat(32)}` as Hex
    const ghost = [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: ee }]
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: ghost, revokes: [], safeTxHash: keccak256(stringToHex('stx-' + Math.random())), safeNonce: '1' } as never)
    // (the chain model: the engine's grants enabled, the other op's not)
    // Its nonce not spent yet: it can still land, so the next renewal revokes its grants.
    expect(w.chain.nonce).toBe(1n)
    await w.op.prepareRenew(ctx)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    // A withdrawal spent nonce 1 (its block's log shows it): the renewal can never run, nothing of it is enabled.
    spentElsewhere(w, 1n, 2n)
    await w.op.submit(ctx, 'renew', sign(await w.op.prepareRenew(ctx)))
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'RENEWAL_SUPERSEDED' })
    expect(acc.revoked).not.toContain(ee)
  })

  test('a stop leaves remembered whatever it did not revoke', async () => {
    type After = { afterOwner(a: AccountState, p: unknown, r: unknown): void }
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const dd = `0x${'dd'.repeat(32)}` as Hex
    acc.superseded = [old[0]!, dd]
    ;(w.op as unknown as After).afterOwner(acc, { prepareId: 'own-9-stop', accountKey: acc.accountKey, kind: 'stop', revokes: old }, { blockNumber: 5n })
    expect(acc.active).toBe(false)
    expect(acc.grants).toEqual([])
    expect(acc.superseded).toEqual([dd])
  })

  test('a new renewal revokes the grants of one whose outcome is unknown, and that one is never applied after it', async () => {
    const { w, acc } = await running()
    const ghost = [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }]
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: ghost, revokes: [] } as never)
    // The read says it did not run (a node behind): the next renewal revokes its grants all the same.
    // (the chain model: the engine's grants enabled, the other op's not)
    await w.op.submit(ctx, 'renew', sign(await w.op.prepareRenew(ctx)))
    expect(acc.revoked).toContain(`0x${'ee'.repeat(32)}`)
    const mine = acc.grants.map((g) => g.permissionId)
    // Later the chain shows the first one's grants enabled (they are not: the second revoked them; a stale read).
    w.knobs.enabled.add(`0x${'ee'.repeat(32)}`)
    await w.op.prepareRenew(ctx).catch(() => undefined)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'RENEWAL_SUPERSEDED' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(mine)
  })

  test('an engine operation sent before a restart (stored, not in the new journal) holds the renewal for ten minutes, not for ever', async () => {
    const { w, acc } = await running()
    // (the chain model: the engine's grants enabled, the other op's not)
    acc.ops.push({ opId: 'eng-1-1-op-9-enter_mint', kind: 'enter', state: 'submitted', updatedAt: new Date().toISOString() } as never)
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ENGINE_BUSY' })
    Object.assign(acc.ops.at(-1)!, { updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() })
    expect((await w.op.prepareRenew(ctx)).summary.join(' ')).toContain('Renew')
  })

  test('a carried engine op (signed bytes waiting, stored for the next engine) does not hold the renewal (Sol review round 2 of #64)', async () => {
    const { w, acc } = await running()
    w.knobs.grantsEnabled = true
    const storedId = 'eng-1-1-op-9-enter_swap'
    acc.ops.push({ opId: storedId, kind: 'enter', state: 'submitted', updatedAt: new Date().toISOString() } as never)
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ENGINE_BUSY' })
    acc.carried = [{ opId: 'op-9', storedId, state: 'pending_reconciliation', nonce: 5n } as never]
    expect((await w.op.prepareRenew(ctx)).summary.join(' ')).toContain('Renew')
  })

  test('a carried op that lands late marks its stored row, and its session uses replay on the next start (Sol review round 2 of #64)', async () => {
    const { w, acc } = await running()
    const storedId = `eng-${acc.epoch}-1-op-9-harvest`
    acc.ops.push({ opId: storedId, kind: 'harvest', state: 'failed', code: 'RECON_UNINCLUDABLE', updatedAt: new Date().toISOString() } as never)
    type Sync = { syncEngineOps(a: AccountState, r: unknown, moved?: unknown): void }
    const runner = { engine: { journal: { ops: [] }, carried: () => [] }, epoch: acc.epoch, run: 2, seen: new Map(), alias: new Map() }
    const calls = [{ target: SAFE, value: 0n, callData: '0x' }]
    const moved = { opId: 'op-9', storedId, lateIncluded: true, included: { txHash: `0x${'44'.repeat(32)}`, blockNumber: 160n }, permissionId: `0x${'dd'.repeat(32)}`, calls }
    acc.carried = [moved as never]
    ;(w.op as unknown as Sync).syncEngineOps(acc, runner, moved)
    expect(acc.ops.find((o) => o.opId === storedId)).toMatchObject({ lateIncluded: true, block: 160, permissionId: `0x${'dd'.repeat(32)}` })
    // Nothing left to carry once it landed.
    expect(acc.carried).toBeUndefined()
  })

  test('a carried op that was still in flight settles its stored row when it lands (rebase review of #64)', async () => {
    const { w, acc } = await running()
    const storedId = `eng-${acc.epoch}-1-op-9-enter_mint`
    acc.ops.push({ opId: storedId, kind: 'enter', state: 'submitted', updatedAt: new Date().toISOString() } as never)
    type Sync = { syncEngineOps(a: AccountState, r: unknown, moved?: unknown): void }
    const runner = { engine: { journal: { ops: [] }, carried: () => [] }, epoch: acc.epoch, run: 2, seen: new Map(), alias: new Map() }
    const moved = { opId: 'op-9', storedId, lateIncluded: true, included: { txHash: `0x${'44'.repeat(32)}`, blockNumber: 160n, success: true }, permissionId: `0x${'dd'.repeat(32)}`, calls: [] }
    ;(w.op as unknown as Sync).syncEngineOps(acc, runner, moved)
    expect(acc.ops.find((o) => o.opId === storedId)).toMatchObject({ state: 'confirmed', code: 'EXEC_OK', lateIncluded: true, block: 160 })
  })

  test('session uses replay for every permission the new engine signs with, from any epoch (Sol review round 3 of #64)', () => {
    const kept = `0x${'aa'.repeat(32)}` as Hex
    const gone = `0x${'bb'.repeat(32)}` as Hex
    const calls = [{ target: SAFE, value: 0n, callData: '0x' as Hex }]
    const ops = [
      { opId: 'eng-1-1-op-1-enter_swap', state: 'confirmed', permissionId: kept, calls },
      { opId: 'eng-1-2-op-4-harvest', state: 'failed', lateIncluded: true, permissionId: kept, calls },
      { opId: 'eng-1-1-op-2-enter_swap', state: 'confirmed', permissionId: gone, calls },
      { opId: 'eng-2-1-op-3-enter_swap', state: 'failed', permissionId: kept, calls },
      { opId: 'own-3-renew', state: 'confirmed', permissionId: kept, calls },
    ] as never[]
    // Epoch 2 after an extension that kept `kept`: its epoch-1 uses still count; `gone`'s and a failed op's do not.
    expect(priorIncludedOf(ops, [{ permissionId: kept }]).length).toBe(2)
  })

  test('a renewal that was out when the operator stopped is settled after the restart, and does not hold later ones for ever', async () => {
    type Boot = { resume(): void; armStopped: boolean; armTimer?: ReturnType<typeof setTimeout> }
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const fresh = [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }]
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'submitted', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: old } as never)
    // One that was only queued when the process stopped is recovered the same way.
    acc.ops.push({ opId: 'own-8-transfer', kind: 'transfer', state: 'proposed', updatedAt: new Date().toISOString() } as never)
    const boot = w.op as unknown as Boot
    boot.resume()
    boot.armStopped = true
    clearTimeout(boot.armTimer)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.ops.find((o) => o.opId === 'own-8-transfer')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.ownerFailures ?? []).toHaveLength(0)
    // It had run: the chain shows its grants, and the next renewal is built on them.
    landed(w, acc.ops.find((o) => o.opId === 'own-7-renew') as never)
    await w.op.prepareRenew(ctx)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'confirmed' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual([`0x${'ee'.repeat(32)}`])
  })

  test('a renewal counts against the same failure budget as an activation', async () => {
    const { w, acc } = await running()
    const tx = await w.op.prepareRenew(ctx)
    acc.ownerFailures = Array.from({ length: MAX_OWNER_FAILURES_PER_DAY }, () => new Date().toISOString())
    expect(await w.op.submit(ctx, 'renew', sign(tx)).catch((e: unknown) => e)).toMatchObject({ status: 429, code: 'OWNER_FAILURE_BUDGET' })
  })

  test('a renewal that lands on an account stopped meanwhile leaves its grants remembered, for the next stop to revoke', async () => {
    type After = { afterOwner(a: AccountState, p: unknown, r: unknown): void }
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const tx = await w.op.prepareRenew(ctx)
    void tx
    acc.active = false
    const fresh = [{ name: 'enter-swap:x', grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }]
    ;(w.op as unknown as After).afterOwner(acc, { prepareId: 'own-9-renew', accountKey: acc.accountKey, kind: 'renew', grants: fresh, revokes: old }, { blockNumber: 5n })
    expect(acc.superseded).toEqual([`0x${'ee'.repeat(32)}`])
    expect(acc.grants.map((g) => g.permissionId)).toEqual(old)
  })

  test('otto/mamoru#163: a reverted renewal relayed later by anyone and run is applied: the engine runs on its grants', async () => {
    const { w, acc } = await running()
    const tx = await w.op.prepareRenew(ctx)
    w.knobs.execOk = false
    const r = await w.op.submit(ctx, 'renew', sign(tx))
    // GS013: a reverted execTransaction leaves the Safe nonce where it was.
    w.chain.nonce--
    expect(r).toMatchObject({ kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR' })
    const stored = acc.ops.find((o) => o.opId === r.opId)!
    // Our copy's receipt reads reverted.
    type Rc = { client: { getTransactionReceipt(a: { hash: Hex }): Promise<unknown> } }
    ;(w.op as unknown as Rc).client.getTransactionReceipt = async ({ hash }) => {
      if (hash.toLowerCase() === stored.txHash!.toLowerCase()) return { transactionHash: hash, status: 'reverted', blockNumber: 99n, logs: [] }
      throw Object.assign(new Error('not found'), { name: 'TransactionReceiptNotFoundError' })
    }
    // A third party relays the same signature in another transaction: its grants enabled, the nonce moves, the Safe logs
    // ExecutionSuccess(safeTxHash).
    for (const id of stored.revokes ?? []) w.knobs.enabled.delete(id.toLowerCase())
    for (const g of stored.ownerGrants ?? []) w.knobs.enabled.add(g.permissionId.toLowerCase())
    w.chain.nonce++
    w.knobs.logs.push({ stx: stored.safeTxHash!, hash: `0x${'ab'.repeat(32)}`, block: 100n })
    await (w.op as unknown as { settleRenewals(a: AccountState): Promise<void> }).settleRenewals(acc)
    expect(stored).toMatchObject({ state: 'confirmed', code: 'EXEC_OK', txHash: `0x${'ab'.repeat(32)}` })
    expect(acc.active).toBe(true)
    expect(acc.grants.map((g) => g.permissionId)).toEqual(expect.arrayContaining((stored.ownerGrants ?? []).map((g) => g.permissionId)))
  })

  test('otto/mamoru#163: a relayed renewal whose execution the search cannot see yet (a lagging view) is not taken as unproven; applied once seen', async () => {
    const { w, acc } = await running()
    const tx = await w.op.prepareRenew(ctx)
    w.knobs.execOk = false
    const r = await w.op.submit(ctx, 'renew', sign(tx))
    w.chain.nonce--
    const stored = acc.ops.find((o) => o.opId === r.opId)!
    type Rc = { client: { getTransactionReceipt(a: { hash: Hex }): Promise<unknown> } }
    ;(w.op as unknown as Rc).client.getTransactionReceipt = async ({ hash }) => {
      if (hash.toLowerCase() === stored.txHash!.toLowerCase()) return { transactionHash: hash, status: 'reverted', blockNumber: 99n, logs: [] }
      throw Object.assign(new Error('not found'), { name: 'TransactionReceiptNotFoundError' })
    }
    // Relayed and run at block 150: grants enabled, nonce moved. The search is answered by a node behind 150 (no log,
    // another hash for 150).
    for (const id of stored.revokes ?? []) w.knobs.enabled.delete(id.toLowerCase())
    for (const g of stored.ownerGrants ?? []) w.knobs.enabled.add(g.permissionId.toLowerCase())
    w.chain.nonce++
    w.knobs.head = 150n
    w.knobs.blockHashes.set(150n, `0x${'cd'.repeat(32)}`)
    const settle = (w.op as unknown as { settleRenewals(a: AccountState): Promise<void> }).settleRenewals.bind(w.op)
    await settle(acc)
    expect(stored).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    // Consistent: the log is there and block 150 is the same everywhere.
    w.knobs.blockHashes.clear()
    w.knobs.logs.push({ stx: stored.safeTxHash!, hash: `0x${'ab'.repeat(32)}`, block: 150n })
    await settle(acc)
    expect(stored).toMatchObject({ state: 'confirmed', code: 'EXEC_OK', txHash: `0x${'ab'.repeat(32)}` })
    // Meanwhile the engine was stopped for running on grants that read revoked (I1, the renewal not proven yet): its
    // grants, applied on a stopped account, are tracked for the next stop, none left unrecorded.
    const tracked = new Set([...acc.grants.map((g) => g.permissionId), ...(acc.superseded ?? [])].map((id) => id.toLowerCase()))
    expect((stored.ownerGrants ?? []).every((g) => tracked.has(g.permissionId.toLowerCase()))).toBe(true)
  })

  test('otto/mamoru#163: a renewal recorded RENEWAL_UNPROVEN is still applied by reconciliation once its relayed execution is seen', async () => {
    const { w, acc } = await running()
    const tx = await w.op.prepareRenew(ctx)
    w.knobs.execOk = false
    const r = await w.op.submit(ctx, 'renew', sign(tx))
    const stored = acc.ops.find((o) => o.opId === r.opId)!
    // An earlier pass (before this change, or on a view without the log) left it unproven.
    Object.assign(stored, { code: 'RENEWAL_UNPROVEN' })
    for (const id of stored.revokes ?? []) w.knobs.enabled.delete(id.toLowerCase())
    for (const g of stored.ownerGrants ?? []) w.knobs.enabled.add(g.permissionId.toLowerCase())
    w.knobs.logs.push({ stx: stored.safeTxHash!, hash: `0x${'ab'.repeat(32)}`, block: 100n })
    await w.op.reconcileOwner(acc)
    expect(stored).toMatchObject({ state: 'confirmed', code: 'EXEC_OK', txHash: `0x${'ab'.repeat(32)}` })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(expect.arrayContaining((stored.ownerGrants ?? []).map((g) => g.permissionId)))
  })

  test('a renewal that fails on chain changes nothing: the engine keeps the grants it had', async () => {
    const { w, acc } = await running()
    const before = acc.grants.map((g) => g.permissionId)
    const tx = await w.op.prepareRenew(ctx)
    w.knobs.execOk = false
    // otto/mamoru#163: a reverted renewal is not final (its Safe nonce unspent, anyone may relay it): an unread receipt,
    // never applied until proven, its grants revoked by the next renewal or stop meanwhile.
    const r = await w.op.submit(ctx, 'renew', sign(tx))
    expect(r).toMatchObject({ kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(before)
    expect(acc.active).toBe(true)
    const stored = acc.ops.find((o) => o.opId === r.opId)!
    expect(stored.signedTxs).toEqual([{ hash: expect.any(String), nonce: expect.any(Number), reverted: true }])
    // A stop meanwhile revokes the reverted renewal's grants too: relayed later, they would otherwise stay on.
    const stop = await w.op.prepareStop(ctx, { revokeOnly: true })
    const revokes = (w.op as unknown as { prepared: Map<string, { revokes?: string[] }> }).prepared.get(stop.prepareId)!.revokes
    expect(revokes).toEqual(expect.arrayContaining((stored.ownerGrants ?? []).map((g) => g.permissionId)))
  })

  test('a renewal signed by another key is refused before the relayer sends anything', async () => {
    const { w, acc } = await running()
    const before = acc.grants.map((g) => g.permissionId)
    const sentBefore = w.sent.length
    const tx = await w.op.prepareRenew(ctx)
    w.knobs.sim = 'revert'
    expect(await w.op.submit(ctx, 'renew', sign(tx, new SoftwarePasskey(PASSKEY_SCALARS.a2))).catch((e: unknown) => e)).toMatchObject({ code: 'BAD_SIGNATURE' })
    expect(w.sent.length).toBe(sentBefore)
    expect(acc.grants.map((g) => g.permissionId)).toEqual(before)
  })
})

// otto/mamoru#120: a 5 USDC deposit took half an hour to be placed, one step per 5-minute review.
describe('reviews follow each other quickly while an entry is in progress', () => {
  const REVIEW = 300_000

  test('a review with nothing to do is followed by the next one a whole period later', () => {
    expect(nextReview(false, 0, false, REVIEW)).toEqual({ ms: REVIEW, followUps: 0 })
    expect(nextReview(false, 7, false, REVIEW)).toEqual({ ms: REVIEW, followUps: 0 })
  })

  test('a review that waited for the head, or whose operation confirmed, is followed in seconds', () => {
    expect(nextReview(true, 0, false, REVIEW)).toEqual({ ms: FOLLOW_UP_MS, followUps: 1 })
    expect(nextReview(true, 5, false, REVIEW)).toEqual({ ms: FOLLOW_UP_MS, followUps: 6 })
  })

  test('twelve in a row at most, then a whole period: an engine that keeps producing operations cannot spin', () => {
    expect(nextReview(true, FOLLOW_UP_MAX - 1, false, REVIEW)).toEqual({ ms: FOLLOW_UP_MS, followUps: FOLLOW_UP_MAX })
    expect(nextReview(true, FOLLOW_UP_MAX, false, REVIEW)).toEqual({ ms: REVIEW, followUps: 0 })
  })

  test('over the RPC budget nothing is hurried', () => {
    expect(nextReview(true, 0, true, REVIEW)).toEqual({ ms: REVIEW, followUps: 0 })
  })

  test('after a quick review, two that do nothing are still quick: the provider may not show the last step yet', () => {
    expect(graceLeft(true, 3, 1)).toEqual({ more: true, grace: 0 })
    expect(graceLeft(false, 3, 0)).toEqual({ more: true, grace: 1 })
    expect(graceLeft(false, 4, FOLLOW_UP_GRACE - 1)).toEqual({ more: true, grace: FOLLOW_UP_GRACE })
    expect(graceLeft(false, 5, FOLLOW_UP_GRACE)).toEqual({ more: false, grace: 0 })
    // An account that was not in an entry gets none.
    expect(graceLeft(false, 0, 0)).toEqual({ more: false, grace: 0 })
  })

  test('a review period shorter than the follow-up (tests, the lab) is never stretched', () => {
    expect(nextReview(true, 0, false, 1)).toEqual({ ms: 1, followUps: 1 })
  })
})

// otto/mamoru#122: 5 USDC in, a swap to USDT waiting for its mint, and the app showed 3.74.
describe('funding reports every token the account holds, not only USDC', () => {
  test('USDT left by a swap is listed with its value, and the deposit adds up', async () => {
    const w = world(3_748_000n)
    w.knobs.usdt = 1_253_694n
    const f = await w.op.funding(ctx)
    expect(f.idle).toEqual([
      { token: 'USDC', amount: '3748000', decimals: 6, valueUsdc: '3748000' },
      // The fake pool trades one for one.
      { token: 'USDT', amount: '1253694', decimals: 6, valueUsdc: '1253694' },
    ])
    expect(f.idle!.reduce((a, t) => a + BigInt(t.valueUsdc), 0n)).toBe(5_001_694n)
    // The old fields stay for app versions that read them.
    expect(f.usdc).toBe('3748000')
  })

  test('an empty account lists nothing, and an account that is not running has no engine status', async () => {
    const f = await world(0n).op.funding(ctx)
    expect(f.idle).toEqual([])
    expect(f.engine).toBeNull()
  })
})

// otto/mamoru#135: a home tab polling GET /funding every few seconds no longer costs its own readSafe each time.
describe('funding caches its readSafe for a few seconds, shared across polls', () => {
  test('a chain balance change with no owner op is not seen until an owner op changes the account', async () => {
    const w = world(OVER)
    const before = await w.op.funding(ctx)
    expect(before.usdc).toBe('101920000')
    // The chain changes with nothing owner-signed happening: the next poll still answers from the cache.
    w.chain.usdc = 50_000_000n
    expect((await w.op.funding(ctx)).usdc).toBe('101920000')
    // A transfer runs end to end; the readSafe reads it makes along the way are never served from this cache.
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx))).toMatchObject({ state: 'confirmed' })
    w.chain.usdc = 40_000_000n
    // The op's state just moved (patchOp): funding reads again instead of answering from before it.
    expect((await w.op.funding(ctx)).usdc).toBe('40000000')
  })
})

// otto/mamoru#135: fresh=1 on GET funding (the add-money screen, a dialog opening) asks for a read at most 2 s
// old. A deposit moves nothing of the account, so only this, never an invalidation, shows it before 15 s.
describe('fresh funding: a read at most 2 s old, never held back by an earlier one', () => {
  const isMulticall = (to: string) => to.toLowerCase() === address('Multicall3').toLowerCase()
  /** How many Multicall3 reads (one per readSafe) have run since this was called. */
  const reads = (op: Operator) => {
    const client = (op as unknown as { client: { call: (a: { to: string }) => Promise<unknown> } }).client
    let n = 0
    const { call } = client
    client.call = (a) => (isMulticall(a.to) && n++, call(a))
    return () => n
  }
  const at = (ms: number) => setSystemTime(new Date(1_790_000_000_000 + ms))
  afterEach(() => setSystemTime())

  test('sees a deposit the plain poll would still answer from before it', async () => {
    at(0)
    const w = world(OVER)
    expect((await w.op.funding(ctx)).usdc).toBe('101920000')
    w.chain.usdc = 50_000_000n
    at(3_000)
    expect((await w.op.funding(ctx)).usdc).toBe('101920000')
    expect((await w.op.funding(ctx, true)).usdc).toBe('50000000')
  })

  // Review finding 1: the add-money screen polls fresh=1 every 4 s; every one of those polls must reach the chain.
  test('fresh=1 every 4 s: each one is a read of its own, none served from the one before', async () => {
    at(0)
    const w = world(5_000_000n)
    const count = reads(w.op)
    for (let i = 0; i < 4; i++) {
      at(i * 4_000)
      await w.op.funding(ctx, true)
    }
    expect(count()).toBe(4)
  })

  test('fresh=1 in a tight loop costs at most one read per 2 s', async () => {
    at(0)
    const w = world(5_000_000n)
    const count = reads(w.op)
    await w.op.funding(ctx, true)
    at(1_999)
    await w.op.funding(ctx, true)
    expect(count()).toBe(1)
    at(4_000)
    await w.op.funding(ctx, true)
    expect(count()).toBe(2)
  })

  // Review finding 1 (second half): an Add dialog's fresh read right before a Withdraw dialog's must not hand the
  // Withdraw a balance from before a deposit that landed in between, beyond the 2 s bound.
  test('a fresh read of one dialog does not hold back the next dialog\'s past 2 s', async () => {
    at(0)
    const w = world(5_000_000n)
    await w.op.funding(ctx, true)
    w.chain.usdc = 9_000_000n
    at(2_000)
    expect((await w.op.funding(ctx, true)).usdc).toBe('9000000')
  })

  // Review finding 4: a failed fresh read leaves no window behind it.
  test('a failed fresh read is retried at once, not held back for a gap', async () => {
    at(0)
    const w = world(5_000_000n)
    const client = (w.op as unknown as { client: { call: (a: { to: string }) => Promise<unknown> } }).client
    const { call } = client
    let fail = true
    client.call = (a) => (isMulticall(a.to) && fail ? Promise.reject(new Error('rpc down')) : call(a))
    await expect(w.op.funding(ctx, true)).rejects.toThrow()
    fail = false
    w.chain.usdc = 7_000_000n
    expect((await w.op.funding(ctx, true)).usdc).toBe('7000000')
  })
})

// Review finding 3: funding pairs the engine and op state it reports with the balance; anything of the account
// moving (owner or engine) must drop the cached balance, or post-entry engine state shows pre-entry balances.
describe('funding reads the chain again whenever anything of the account moves', () => {
  type Hooks = {
    setBusy(acc: AccountState, step: string): void
    watchJournal(acc: AccountState, runner: unknown): void
    setFollowUps(acc: AccountState, runner: { followUps?: number }, n: number): void
    syncEngineOps(acc: AccountState, runner: unknown): void
  }
  const acc = (w: ReturnType<typeof world>) => w.op.account(ctx).acc
  const settle = async (w: ReturnType<typeof world>) => {
    expect((await w.op.funding(ctx)).usdc).toBe('5000000')
    w.chain.usdc = 6_000_000n
    expect((await w.op.funding(ctx)).usdc).toBe('5000000')
  }

  test('an owner transaction starting or ending (the progress line)', async () => {
    const w = world(5_000_000n)
    await settle(w)
    ;(w.op as unknown as Hooks).setBusy(acc(w), 'withdrawing')
    expect((await w.op.funding(ctx)).usdc).toBe('6000000')
  })

  test('an engine journal move', async () => {
    const w = world(5_000_000n)
    await settle(w)
    const hooks = w.op as unknown as Hooks
    hooks.syncEngineOps = () => {}
    const runner = { engine: { journal: { onMove: undefined as undefined | (() => void) } } }
    hooks.watchJournal(acc(w), runner)
    runner.engine.journal.onMove!()
    expect((await w.op.funding(ctx)).usdc).toBe('6000000')
  })

  test('the engine starting or ending an entry (engine.placing flips), and nothing when it does not', async () => {
    const w = world(5_000_000n)
    await settle(w)
    const hooks = w.op as unknown as Hooks
    const runner: { followUps?: number } = { followUps: 0 }
    hooks.setFollowUps(acc(w), runner, 0)
    expect((await w.op.funding(ctx)).usdc).toBe('5000000')
    hooks.setFollowUps(acc(w), runner, 2)
    expect((await w.op.funding(ctx)).usdc).toBe('6000000')
    w.chain.usdc = 7_000_000n
    hooks.setFollowUps(acc(w), runner, 3)
    expect((await w.op.funding(ctx)).usdc).toBe('6000000')
    hooks.setFollowUps(acc(w), runner, 0)
    expect((await w.op.funding(ctx)).usdc).toBe('7000000')
  })
})

describe('a restarted engine does not look at the chain from before its last operation', () => {
  test('the floor it is given is the block of the latest stored engine operation that reached the chain', () => {
    expect(lastEngineBlock([])).toBe(0n)
    expect(lastEngineBlock([{ opId: 'own-1-activate', block: 900 }, { opId: 'eng-1-1-op-1-enter_swap', block: 120 }, { opId: 'eng-1-1-op-2-enter_mint', block: 131 }, { opId: 'eng-1-1-op-3-enter_swap' }])).toBe(131n)
  })
})

describe('spec 006: one cap per prepare, and renewals keep the signed cap', () => {
  const settingsWith = (caps: number[]) => {
    let i = 0
    const s = (capUsdc: number) => ({ depth: { impactBps: 30, shareBps: 500 }, capUsdc, guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } })
    return { forAccount: () => ({ settings: s(caps[Math.min(i++, caps.length - 1)]!), versionId: 1, source: 'd1', override: [] }), status: () => ({}) }
  }
  type Internals = { prepared: Map<string, { capUsdc?: string; kind: string }>; startLoop(a: AccountState): void }

  test('a settings pull in the middle of an activation prepare cannot make the summary and the grants disagree', async () => {
    const w = world(20_000_000n)
    // The first read of the cap says 100; every later read (a pull landed mid-prepare) says 1000.
    ;(w.op.cfg as { settings?: unknown }).settings = settingsWith([100, 1000])
    const tx = await w.op.prepareActivate(ctx)
    const p = [...(w.op as unknown as Internals).prepared.values()].find((x) => x.kind === 'activate')!
    expect(p.capUsdc).toBe('100000000')
    expect(tx.summary.join(' ')).toContain('cap 100.00 USDC')
    expect(tx.summary.join(' ')).not.toContain('1,000.00 USDC')
    // The usage limits (#149) are sized from the same captured cap: equal to an activation prepared at a steady 100.
    const steady = world(20_000_000n)
    ;(steady.op.cfg as { settings?: unknown }).settings = settingsWith([100])
    const lines = (t: { summary: string[] }) => t.summary.filter((l) => l.includes('at most')).map((l) => l.replace(/0x[0-9a-fA-F]{40}/g, ''))
    expect(lines(tx)).toEqual(lines(await steady.op.prepareActivate(ctx)))
  })

  test('a renewal after a cap raise keeps the limits the account signed, names them, and says the plan changed', async () => {
    const w = world(20_000_000n)
    ;(w.op as unknown as Internals).startLoop = () => {}
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    expect(acc.signedCapUsdc).toBe('100000000')
    acc.grants = acc.grants.map((g) => ({ ...g, grant: { ...g.grant, userOp: { ...g.grant.userOp, validUntil: Math.floor(Date.now() / 1000) + 15 * 86_400 } } }))
    ;(w.op.cfg as { settings?: unknown }).settings = settingsWith([1000])
    const tx = await w.op.prepareRenew(ctx)
    const text = tx.summary.join(' ')
    expect(text).toContain('sized for deposits up to 100.00 USDC (the cap you signed)')
    expect(text).toContain('this approval keeps the 100.00 USDC limits you signed')
    const p = [...(w.op as unknown as Internals).prepared.values()].find((x) => x.kind === 'renew')!
    expect(p.capUsdc).toBe('100000000')
  })
})

test('spec 006: an armed activation that runs later records the cap its signature named as the account signed cap', async () => {
  const w = world(20_000_000n)
  ;(w.op as unknown as { startLoop(a: AccountState): void }).startLoop = () => {}
  const settings = (capUsdc: number) => ({ forAccount: () => ({ settings: { depth: { impactBps: 30, shareBps: 500 }, capUsdc, guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } }, versionId: 1, source: 'd1', override: [] }), status: () => ({}) })
  ;(w.op.cfg as { settings?: unknown }).settings = settings(500)
  w.knobs.relayerWei = 100_000_000_000_000n
  const op = await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
  expect(op).toMatchObject({ code: 'ARMED' })
  const acc = w.state.accounts.k!
  expect(acc.armed?.capUsdc).toBe('500000000')
  // The cap is raised while it waits; the relayer is funded; the watcher runs it.
  ;(w.op.cfg as { settings?: unknown }).settings = settings(1000)
  w.knobs.relayerWei = 10n ** 18n
  ;(w.op as unknown as { relayerBalanceCache: unknown }).relayerBalanceCache = null
  await (w.op as unknown as { fireArmed(a: AccountState, usdc: bigint): Promise<void> }).fireArmed(acc, 20_000_000n)
  expect(acc.active).toBe(true)
  expect(acc.signedCapUsdc).toBe('500000000')
})

describe('prices the owner signs are read at the TWAP, not at slot0 (otto/mamoru#140)', () => {
  /** The cap of every rule of the grants a prepared activation would enable, by grant and field. */
  const capsOf = (w: ReturnType<typeof world>, prepareId: string) => {
    const p = (w.op as unknown as { prepared: Map<string, { grants?: { name: string; grant: { actions: { signature: string; params: { field: string; ref: bigint; cumulativeLimit?: bigint }[] }[] } }[] }> }).prepared.get(prepareId)!
    return p.grants!.flatMap((g) => g.grant.actions.flatMap((a) => a.params.filter((r) => r.field.startsWith('amount')).map((r) => `${g.name} ${a.signature.split('(')[0]} ${r.field} ${r.ref} ${r.cumulativeLimit ?? ''}`)))
  }

  test('a slot0 moved inside the read block does not change the volatile caps of the approval', async () => {
    const calm = world(0n)
    const moved = world(0n)
    moved.knobs.spotTick = 5_000
    const a = await calm.op.prepareActivate(ctx)
    const b = await moved.op.prepareActivate(ctx)
    expect(capsOf(moved, b.prepareId)).toEqual(capsOf(calm, a.prepareId))
    // And the TWAP does move them: the caps follow the average price, as before they followed the spot.
    const later = world(0n)
    later.knobs.twapTick = 5_000
    const c = await later.op.prepareActivate(ctx)
    expect(capsOf(later, c.prepareId)).not.toEqual(capsOf(calm, a.prepareId))
  })

  test('no TWAP, no approval: the caps are not sized from slot0 alone', async () => {
    const w = world(0n)
    w.knobs.twapTick = null
    expect(await w.op.prepareActivate(ctx).catch((e: unknown) => e)).toMatchObject({ status: 503, code: 'PRICE_UNAVAILABLE' })
  })
})
