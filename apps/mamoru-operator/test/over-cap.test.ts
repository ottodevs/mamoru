import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, getAddress, keccak256, stringToHex, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import type { AccountContext, OpView, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, erc20Abi, safeAbi, swapRouter02Abi, uniswapV3PoolAbi } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { LIVE_CAP_USDC, browserOwnerSignature, deployCall, liveAccountFromContext } from '@mamoru/account/live'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { FOLLOW_UP_GRACE, FOLLOW_UP_MAX, FOLLOW_UP_MS, graceLeft, HttpError, lastEngineBlock, nextReview, MAX_OWNER_FAILURES_PER_DAY, OWNER_FAILURES_ALERT_PER_DAY, Operator, type OperatorConfig } from '../src/operator.ts'
import { SendExpired, type Relayer } from '../src/relayer.ts'
import { answerAggregate3 } from './fake-multicall.ts'
import { quoterV2Abi } from '@mamoru/uniswap-v3/quote'
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
function world(usdc: bigint) {
  const sent: { to: string; data?: Hex; value?: bigint }[] = []
  /** Every eth_simulateV1 the operator ran, as its list of calls. */
  const simulated: { from?: string; to: string; data: Hex }[][] = []
  const chain = { deployed: false, usdc, nonce: 0n, eth: 0n }
  /** What the simulation answers ('ok', 'revert' or 'down') and what happens on chain while the relayer sends. */
  const knobs = { sim: 'ok' as 'ok' | 'revert' | 'down', call: 'ok' as 'ok' | 'revert' | 'down', execOk: true, onSend: (_tx: { to: string }) => {}, relayerWei: 10n ** 18n, failBeforeSending: false, relayerPending: 0, grantsEnabled: false, enabledFromBlock: 0n, noHistory: false, usdt: 0n, weiPerUsdc: 0n, twapTick: null as number | null, blockTime: 1_790_000_000n, notAfterSeen: [] as bigint[], expireInQueue: false }
  /** eth_calls of execTransaction the operator made. */
  const called: Hex[] = []
  const TRUE = `0x${'0'.repeat(63)}1` as const
  const factory = deployCall(liveAccountFromContext(ctx))
  const client = {
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ number: 100n, timestamp: knobs.blockTime }),
    getTransactionReceipt: async () => {
      throw new Error('no receipt')
    },
    getLogs: async () => [],
    getCode: async () => (chain.deployed ? '0x01' : undefined),
    getBalance: async ({ address: at }: { address: string }) => (at.toLowerCase() === RELAYER.toLowerCase() ? knobs.relayerWei : at.toLowerCase() === SAFE.toLowerCase() ? chain.eth : 0n),
    getTransactionCount: async ({ blockTag }: { blockTag?: string }) => (blockTag === 'pending' ? 5 + knobs.relayerPending : 5),
    readContract: async ({ address: at, functionName, blockNumber }: { address: string; functionName: string; blockNumber?: bigint }) => {
      if (functionName === 'slot0') return [1n << 96n, 0, 0, 0, 0, 0, true]
      if (functionName === 'nonce') return chain.nonce
      // A pool's observe([1800, 0]) at `twapTick` when set; otherwise the window is not covered.
      if (functionName === 'observe') {
        if (knobs.twapTick === null) throw new Error('execution reverted: OLD')
        return [[0n, BigInt(knobs.twapTick) * 1800n], [0n, 0n]]
      }
      if (functionName === 'balanceOf') return at.toLowerCase() === address('USDC').toLowerCase() ? chain.usdc : 0n
      if (functionName === 'isPermissionEnabled') {
        if (blockNumber !== undefined && knobs.noHistory) throw new Error('missing trie node: historical state not available')
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
        const word = (v: bigint) => toHex(v, { size: 32 })
        return {
          data: answerAggregate3(data, (target, callData) => {
            if (callData.startsWith('0x3850c7bd')) return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'slot0', result: [1n << 96n, 0, 0, 0, 0, 0, true] })
            if (callData.startsWith('0x70a08231')) return word(target.toLowerCase() === address('USDC').toLowerCase() ? chain.usdc : target.toLowerCase() === address('USDT').toLowerCase() ? knobs.usdt : 0n)
            if (callData.startsWith('0x4d2301cc')) return word(chain.eth)
            throw new Error('execution reverted')
          }),
        }
      }
      // QuoterV2 (USDC -> WETH) answers at `weiPerUsdc` when set; otherwise it has no answer and nothing is quoted.
      if (to.toLowerCase() === address('QuoterV2').toLowerCase() && knobs.weiPerUsdc > 0n) {
        const { args } = decodeFunctionData({ abi: quoterV2Abi, data })
        return { data: encodeFunctionResult({ abi: quoterV2Abi, functionName: 'quoteExactInputSingle', result: [(args[0].amountIn * knobs.weiPerUsdc) / 1_000_000n, 0n, 0, 0n] }) }
      }
      called.push(data)
      if (knobs.call === 'revert') throw Object.assign(new Error('execution reverted: GS026'), { code: 3, data: '0x08c379a0' })
      if (knobs.call === 'down') throw new Error('HTTP request failed. Status: 429')
      return { data: '0x' }
    },
  } as unknown as PublicClient
  const relayer = {
    address: RELAYER,
    send: async (tx: { to: string; data?: Hex; value?: bigint; notAfter?: { at: bigint; code: string } }, onSent?: (h: Hex) => void, onSending?: () => void) => {
      // The real relayer checks a job's time limit right before the broadcast (relayer-nonce.test.ts); here a knob says it ran out in the queue.
      if (tx.notAfter) {
        knobs.notAfterSeen.push(tx.notAfter.at)
        if (knobs.expireInQueue) throw new SendExpired(tx.notAfter.code, tx.notAfter.at, tx.notAfter.at)
      }
      sent.push(tx)
      if (!knobs.failBeforeSending) onSending?.()
      knobs.onSend(tx)
      const hash = toHex(sent.length, { size: 32 })
      onSent?.(hash)
      const isDeploy = tx.to.toLowerCase() === factory.to.toLowerCase()
      if (isDeploy) chain.deployed = true
      else if (tx.data) chain.nonce++
      else if (tx.to.toLowerCase() === SAFE.toLowerCase()) chain.eth += tx.value ?? 0n
      const logs = isDeploy || !knobs.execOk ? [] : [{ address: SAFE, topics: [EXECUTION_SUCCESS] }]
      return { hash, receipt: { transactionHash: hash, status: 'success', blockNumber: 101n, logs } as unknown as TransactionReceipt }
    },
  } as unknown as Relayer
  const state = { accounts: {} as Record<string, AccountState> }
  const store = { state, save: () => {} } as unknown as StateStore
  const cfg = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 } satisfies OperatorConfig
  const op = new Operator(cfg, client, relayer, store)
  ;(op as unknown as { retryMs: number }).retryMs = 0
  return { op, chain, sent, simulated, called, knobs, factory, state }
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
    // It cost the relayer nothing, so it counts against nothing.
    expect(w.state.accounts.k!.ownerFailures ?? []).toHaveLength(0)
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
    expect(w.state.accounts.k!.armed).toBeUndefined()
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

// The off-chain signature check is a mirror of the on-chain verifier. The chain is the ground truth: when the mirror
// says no, a simulation of the exact sequence decides. Here "thief" signatures stand for a real authenticator the
// mirror gets wrong (mirror says no) and the mocked chain says whatever the knob says.
describe('the chain overrules the off-chain signature check', () => {
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

  test('mirror says no, simulation succeeds: the transfer is sent and the mismatch is logged with the assertion shape', async () => {
    const w = world(OVER)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    const { out, logged } = await errors(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx, odd)))
    expect(out).toMatchObject({ kind: 'transfer', state: 'confirmed' })
    expect(w.sent.map((t) => t.to)).toEqual([w.factory.to, SAFE])
    expect(w.op.mirrorMismatches).toBeGreaterThanOrEqual(1)
    const line = logged.find((l) => l.includes('OWNER_SIG_MIRROR_MISMATCH'))!
    expect(line).toContain('k transfer')
    const shape = JSON.parse(line.slice(line.indexOf('shape ') + 6)) as Record<string, unknown>
    expect(shape).toMatchObject({ authenticatorDataLength: 37, flags: '0x05', clientDataKeys: ['type', 'challenge', 'origin', 'crossOrigin'], clientDataPrefixOk: true, signatureDer: 'ok', highS: false })
    // Nothing secret or identifying: no key, no signature bytes, no challenge, no origin value.
    expect(line).not.toContain(plan.ownerTx.safeTxHash.slice(2, 20))
    expect(line).not.toContain('mamoru.lol')
    expect(w.state.accounts.k!.ownerFailures ?? []).toHaveLength(0)
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
    expect(w.state.accounts.k!.ownerFailures ?? []).toHaveLength(0)
    // Not a permanent failure: the same prepared transaction and body go through once the chain can be asked.
    w.knobs.sim = 'ok'
    expect((await errors(() => w.op.submit(ctx, 'transfer', body))).out).toMatchObject({ state: 'confirmed' })
  })

  test('mirror says no on a deployed Safe without simulation: eth_call decides, and no answer at all is a retryable 503', async () => {
    const make = async (call: 'ok' | 'revert' | 'down') => {
      const w = world(5_000_000n)
      w.chain.deployed = true
      const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
      w.knobs.sim = 'down'
      w.knobs.call = call
      return { w, ...(await errors(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx, odd)).catch((e: unknown) => e))) }
    }
    const ok = await make('ok')
    expect(ok.out).toMatchObject({ state: 'confirmed' })
    expect(ok.w.sent).toHaveLength(1)
    expect(ok.logged.some((l) => l.includes('OWNER_SIG_MIRROR_MISMATCH'))).toBe(true)
    const reverting = await make('revert')
    expect(reverting.out).toMatchObject({ status: 400, code: 'BAD_SIGNATURE' })
    expect(reverting.w.sent).toHaveLength(0)
    const blind = await make('down')
    expect(blind.out).toMatchObject({ status: 503, code: 'OWNER_CHECK_UNAVAILABLE' })
    expect(blind.w.sent).toHaveLength(0)
    expect(blind.w.state.accounts.k!.ownerFailures ?? []).toHaveLength(0)
  })

  test('stop follows the same rule', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [{ name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}`, grant: {} as never }]
    const tx = await w.op.prepareStop(ctx)
    const { out, logged } = await errors(() => w.op.submit(ctx, 'stop', sign(tx, odd)))
    expect(out).toMatchObject({ kind: 'exit', state: 'confirmed' })
    expect(logged.some((l) => l.includes('OWNER_SIG_MIRROR_MISMATCH') && l.includes('k stop'))).toBe(true)
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
    // The head catches up: the account starts from the block it executed in.
    w.knobs.enabledFromBlock = 97n
    await priv(w.op).fireArmed(acc, 20_000_000n).catch(() => undefined)
    expect(acc.active).toBe(true)
    expect(acc.depositsAfter).toBe('97')
  })

  test('no provider serves the state of past blocks: after three passes the account starts, engine from the head, deposits from the floor', async () => {
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
    expect(acc.active).toBe(true)
    // The engine starts 150 blocks past the unproven head, so no node still before the execution is ever reviewed;
    // deposits are read from before the execution.
    expect(acc.historyFromBlock).toBe('250')
    expect(BigInt(acc.depositsAfter)).toBeLessThan(100n)
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
describe('renewing the approval of a running account', () => {
  type Loop = { startLoop(a: AccountState): void }
  /** A running account: activated through the real path, with the engine loop stubbed (the fake chain has no engine RPC). */
  const running = async () => {
    const w = world(20_000_000n)
    ;(w.op as unknown as Loop).startLoop = () => {}
    const op = await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    expect(acc.active).toBe(true)
    return { w, acc, started: op }
  }
  /** Grants whose end is inside the renewal window: what the renewal (not an extension) is built for. */
  const due = <G extends { grant: { userOp: { validUntil: number } } }>(gs: G[]): G[] =>
    gs.map((g) => ({ ...g, grant: { ...g.grant, userOp: { ...g.grant.userOp, validUntil: Math.floor(Date.now() / 1000) + 15 * 86_400 } } }))

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
    expect((await w.op.funding(ctx)).approval).toEqual({ validUntil: now + 200 * 86_400, renewDue: false, expired: false })
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
      w.knobs.grantsEnabled = false
      await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))
      expect(acc.revoked).toContain(`0x${'ee'.repeat(32)}`)
    }
  })

  test('no renewal while a stop is on its way, or while the engine has an operation that is not settled', async () => {
    const { w, acc } = await running()
    // The engine's grants are enabled on the Safe throughout: no stop has run.
    w.knobs.grantsEnabled = true
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
    type Runners = { runners: Map<string, { engine: { journal: { ops: { state: string }[] } } }> }
    ;(w.op as unknown as Runners).runners.set(acc.accountKey, { engine: { journal: { ops: [{ state: 'included' }] } } })
    const sentBefore = w.sent.length
    expect(await w.op.submit(ctx, 'renew', sign(tx)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ENGINE_BUSY' })
    expect(w.sent.length).toBe(sentBefore)
  })

  test('a renewal whose receipt was never read is applied from the chain before another one is built', async () => {
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const fresh = due([{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }])
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: old } as never)
    // The chain says it ran: its grants are the engine's now, and the next renewal revokes those, not the old ones.
    w.knobs.grantsEnabled = true
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
      expect(acc.grantsFromBlock).toBe('101')
      expect(acc.epoch).toBe(epoch + 1)
      expect(acc.managedTokenIds).toEqual(['7'])
      expect((await w.op.funding(ctx)).approval?.missing).toBeUndefined()
      // Nothing left to add: the next one is a renewal again.
      expect((await w.op.prepareRenew(ctx)).summary.join(' ')).toContain('revoked in the same transaction')
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
      expect(await w.op.submit(ctx, 'renew', sign(tx)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'RENEWAL_STALE' })
      const again = await w.op.prepareRenew(ctx)
      acc.ops.push({ opId: 'own-9-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: [{ ...acc.grants[0]!, permissionId: `0x${'ee'.repeat(32)}` as Hex }], revokes: [] } as never)
      w.knobs.grantsEnabled = false
      expect(await w.op.submit(ctx, 'renew', sign(again)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'RENEWAL_STALE' })
    })

    test('while a renewal\'s outcome is unknown no extension is built: the full renewal revokes it all', async () => {
      const { w, acc } = await capped()
      const old = acc.grants.map((g) => g.permissionId)
      acc.ops.push({ opId: 'own-9-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: [{ ...acc.grants[0]!, permissionId: `0x${'ee'.repeat(32)}` as Hex }], revokes: old } as never)
      // The chain says it did not run.
      w.knobs.grantsEnabled = false
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
      w.knobs.grantsEnabled = true
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
    expect(await w.op.submit(ctx, 'renew', sign(again)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'RENEWAL_STALE' })
  })

  test('a stop whose receipt was never read and that did run is applied from the chain: nothing is renewed after it', async () => {
    const { w, acc } = await running()
    const had = acc.grants.map((g) => g.permissionId)
    acc.ops.push({ opId: 'own-7-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } as never)
    // The engine's grants are no longer enabled on the Safe: the stop executed.
    w.knobs.grantsEnabled = false
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'NOT_ACTIVE' })
    expect(acc.active).toBe(false)
    expect(acc.ops.find((o) => o.opId === 'own-7-exit')).toMatchObject({ state: 'confirmed' })
    expect(had.every((id) => acc.revoked.includes(id))).toBe(true)
  })

  test('a renewal that ran unread is settled before a stop is judged: its revoked old grants are not taken for a stop that ran', async () => {
    const { w, acc } = await running()
    const old = acc.grants.map((g) => g.permissionId)
    const fresh = [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }]
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: fresh, revokes: old } as never)
    acc.ops.push({ opId: 'own-8-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString() } as never)
    // The renewed grant is enabled; the old ones are not (the renewal revoked them). The stop has not run.
    type Read = { readContract(a: { functionName: string; args?: readonly unknown[] }): Promise<unknown> }
    const client = (w.op as unknown as { client: Read }).client
    const read = client.readContract.bind(client)
    client.readContract = async (a) => (a.functionName === 'isPermissionEnabled' ? a.args![0] === `0x${'ee'.repeat(32)}` : read(a))
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ code: 'STOP_IN_FLIGHT' })
    expect(acc.active).toBe(true)
    expect(acc.grants.map((g) => g.permissionId)).toEqual([`0x${'ee'.repeat(32)}`])
    expect(acc.ops.find((o) => o.opId === 'own-8-exit')).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('a new renewal revokes the grants of one whose outcome is unknown, and that one is never applied after it', async () => {
    const { w, acc } = await running()
    const ghost = [{ name: acc.grants[0]!.name, grant: acc.grants[0]!.grant, permissionId: `0x${'ee'.repeat(32)}` as Hex }]
    acc.ops.push({ opId: 'own-7-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: new Date().toISOString(), ownerGrants: ghost, revokes: [] } as never)
    // The read says it did not run (a node behind): the next renewal revokes its grants all the same.
    w.knobs.grantsEnabled = false
    await w.op.submit(ctx, 'renew', sign(await w.op.prepareRenew(ctx)))
    expect(acc.revoked).toContain(`0x${'ee'.repeat(32)}`)
    const mine = acc.grants.map((g) => g.permissionId)
    // Later the chain shows the first one's grants enabled (they are not: the second revoked them; a stale read).
    w.knobs.grantsEnabled = true
    await w.op.prepareRenew(ctx).catch(() => undefined)
    expect(acc.ops.find((o) => o.opId === 'own-7-renew')).toMatchObject({ state: 'failed', code: 'RENEWAL_SUPERSEDED' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(mine)
  })

  test('an engine operation sent before a restart (stored, not in the new journal) holds the renewal for ten minutes, not for ever', async () => {
    const { w, acc } = await running()
    w.knobs.grantsEnabled = true
    acc.ops.push({ opId: 'eng-1-1-op-9-enter_mint', kind: 'enter', state: 'submitted', updatedAt: new Date().toISOString() } as never)
    expect(await w.op.prepareRenew(ctx).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ENGINE_BUSY' })
    Object.assign(acc.ops.at(-1)!, { updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() })
    expect((await w.op.prepareRenew(ctx)).summary.join(' ')).toContain('Renew')
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
    w.knobs.grantsEnabled = true
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

  test('a renewal that fails on chain changes nothing: the engine keeps the grants it had', async () => {
    const { w, acc } = await running()
    const before = acc.grants.map((g) => g.permissionId)
    const tx = await w.op.prepareRenew(ctx)
    w.knobs.execOk = false
    expect(await w.op.submit(ctx, 'renew', sign(tx))).toMatchObject({ kind: 'renew', state: 'failed', code: 'OWNER_TX_FAILED' })
    expect(acc.grants.map((g) => g.permissionId)).toEqual(before)
    expect(acc.active).toBe(true)
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

describe('a restarted engine does not look at the chain from before its last operation', () => {
  test('the floor it is given is the block of the latest stored engine operation that reached the chain', () => {
    expect(lastEngineBlock([])).toBe(0n)
    expect(lastEngineBlock([{ opId: 'own-1-activate', block: 900 }, { opId: 'eng-1-1-op-1-enter_swap', block: 120 }, { opId: 'eng-1-1-op-2-enter_mint', block: 131 }, { opId: 'eng-1-1-op-3-enter_swap' }])).toBe(131n)
  })
})

// otto/mamoru#82: the gas reserve the relayer sends into a Safe at activation is the only part of a start the owner
// can take away, so it is what the subsidy limits guard. A Safe that holds its own reserve always starts.
describe('the relayer pays the gas reserve within limits', () => {
  type Armed = { fireArmed(acc: AccountState, usdc: bigint): Promise<void> }
  const priv = (op: Operator) => op as unknown as Armed
  /** The engine loop is not under test here: an activation only has to land. */
  const quiet = (u: bigint) => {
    const w = world(u)
    ;(w.op as unknown as { startLoop(a: AccountState): void }).startLoop = () => {}
    return w
  }
  const TARGET = POLICIES['conservador-live-v2']!.gasReserveWei + 200_000_000_000_000n
  const topUps = (w: ReturnType<typeof world>) => w.sent.filter((t) => t.to.toLowerCase() === SAFE.toLowerCase() && !t.data)
  const refusal = (e: unknown) => e as HttpError
  const spentToday = (w: ReturnType<typeof world>, n: number) => {
    for (let i = 0; i < n; i++) w.state.accounts[`paid-${i}`] = { accountKey: `paid-${i}`, subsidies: [{ at: new Date().toISOString(), wei: TARGET.toString() }] } as unknown as AccountState
  }

  test('a first start from 10 USDC gets its reserve, and the reserve is recorded', async () => {
    const w = quiet(10_000_000n)
    expect(await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))).toMatchObject({ state: 'confirmed' })
    expect(topUps(w)).toMatchObject([{ to: SAFE, value: TARGET }])
    expect(w.state.accounts.k!.subsidies).toEqual([{ at: expect.any(String), wei: TARGET.toString() }])
  })

  test('under 10 USDC the start is refused with a typed code and the ETH to send; with that ETH in the Safe it starts and the relayer sends no reserve', async () => {
    const w = quiet(5_000_000n)
    const e = refusal(await w.op.prepareActivate(ctx).catch((x: unknown) => x))
    expect(e).toMatchObject({ status: 409, code: 'SUBSIDY_BELOW_MINIMUM' })
    expect(e.message).toContain('send 0.0005 ETH on Base to your account')
    expect(w.sent).toHaveLength(0)
    w.chain.eth = TARGET
    expect(await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))).toMatchObject({ state: 'confirmed' })
    expect(topUps(w)).toHaveLength(0)
    expect(w.state.accounts.k!.subsidies).toBeUndefined()
  })

  test('a stop soon after a paid reserve is never gated, and ends the subsidy of the account', async () => {
    const w = quiet(20_000_000n)
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    acc.grants = [{ name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}`, grant: {} as never }]
    expect(await w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx)))).toMatchObject({ kind: 'exit', state: 'confirmed' })
    expect(acc.subsidyForfeitAt).toBeString()
    // The owner moved the reserve out: starting again needs their own.
    w.chain.eth = 0n
    expect(await w.op.prepareActivate(ctx).catch((x: unknown) => x)).toMatchObject({ status: 409, code: 'SUBSIDY_EARLY_EXIT' })
    w.chain.eth = TARGET
    expect(await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))).toMatchObject({ state: 'confirmed' })
  })

  test('a withdrawal after the window keeps the subsidy; an account past its reserves is refused', async () => {
    const w = quiet(20_000_000n)
    const { acc } = w.op.account(ctx)
    acc.subsidies = [{ at: new Date(Date.now() - 73 * 3_600_000).toISOString(), wei: TARGET.toString() }]
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    expect(await w.op.submit(ctx, 'transfer', sign(plan.ownerTx))).toMatchObject({ state: 'confirmed' })
    expect(acc.subsidyForfeitAt).toBeUndefined()
    acc.subsidies.push({ at: acc.subsidies[0]!.at, wei: TARGET.toString() })
    expect(await w.op.prepareActivate(ctx).catch((x: unknown) => x)).toMatchObject({ status: 409, code: 'SUBSIDY_ACCOUNT_LIMIT' })
  })

  test('the reserve is on the record before its send, and comes off it only when nothing can have been paid', async () => {
    const w = quiet(20_000_000n)
    let atSend: unknown
    w.knobs.onSend = (t) => {
      if (t.to.toLowerCase() === SAFE.toLowerCase() && !('data' in t && (t as { data?: Hex }).data)) atSend = structuredClone(w.state.accounts.k!.subsidies)
    }
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    expect(atSend).toEqual([{ at: expect.any(String), wei: TARGET.toString() }])

    // Refused before it reached a provider: off the record. Lost after it was handed over: kept, it may have landed.
    for (const [handed, kept] of [[false, 0], [true, 1]] as const) {
      const v = quiet(20_000_000n)
      v.knobs.failBeforeSending = !handed
      v.knobs.onSend = (t) => {
        if (t.to.toLowerCase() === SAFE.toLowerCase() && !(t as { data?: Hex }).data) throw handed ? new Error('Timed out while waiting for transaction') : new Error('insufficient funds for gas * price + value')
      }
      await v.op.submit(ctx, 'activate', sign(await v.op.prepareActivate(ctx)))
      await Bun.sleep(5)
      expect(v.state.accounts.k!.subsidies ?? []).toHaveLength(kept)
    }
  })

  test('an armed approval that loses the last of the budget inside its attempt stays armed', async () => {
    const w = quiet(20_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    w.chain.usdc = 0n
    expect(await w.op.submit(ctx, 'activate', sign(tx))).toMatchObject({ code: 'ARMED' })
    w.chain.usdc = 20_000_000n
    const acc = w.state.accounts.k!
    // The watcher's look passes; the budget is gone by the time the attempt decides (another account's start).
    const real = (w.op as unknown as { subsidy: (...a: unknown[]) => unknown }).subsidy.bind(w.op)
    let calls = 0
    ;(w.op as unknown as { subsidy: (...a: unknown[]) => unknown }).subsidy = (...a: unknown[]) => (calls++ === 0 ? real(...a) : { need: TARGET, code: 'SUBSIDY_DAILY_BUDGET' })
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.armed).toBeDefined()
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ state: 'proposed', code: 'ARMED' })
    expect(w.sent).toHaveLength(0)
  })

  test('the daily budget: prepare is refused, an approval signed before waits armed with nothing sent and runs once the budget frees', async () => {
    const w = quiet(20_000_000n)
    const logged: string[] = []
    const error = console.error
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    try {
      const tx = await w.op.prepareActivate(ctx)
      spentToday(w, 10)
      expect(await w.op.prepareActivate(ctx).catch((x: unknown) => x)).toMatchObject({ status: 409, code: 'SUBSIDY_DAILY_BUDGET' })
      expect(await w.op.submit(ctx, 'activate', sign(tx))).toMatchObject({ state: 'proposed', code: 'ARMED' })
      const acc = w.state.accounts.k!
      await priv(w.op).fireArmed(acc, 20_000_000n)
      expect(acc.armed).toBeDefined()
      expect(w.sent).toHaveLength(0)
      expect(logged.filter((l) => l.includes('[alert]') && l.includes('relayer subsidy'))).toHaveLength(1)
      for (let i = 0; i < 10; i++) w.state.accounts[`paid-${i}`]!.subsidies![0]!.at = new Date(Date.now() - 25 * 3_600_000).toISOString()
      await priv(w.op).fireArmed(acc, 20_000_000n)
      expect(acc.active).toBe(true)
      expect(w.op.subsidySummary()).toEqual({ paid24hWei: TARGET.toString(), budgetWei: (10n * TARGET).toString() })
    } finally {
      console.error = error
    }
  })
})

// otto/mamoru#15: a Safe with enough USDC buys its own gas reserve inside the activation the owner signs; the relayer
// pays only the deploy and execTransaction gas, and its subsidy (#82) is left for the starts that cannot.
describe('the activation buys its own gas reserve', () => {
  type Armed = { fireArmed(acc: AccountState, usdc: bigint): Promise<void> }
  const quiet = (u: bigint) => {
    const w = world(u)
    ;(w.op as unknown as { startLoop(a: AccountState): void }).startLoop = () => {}
    // Spot 2,700 USD/ETH; TWAP ~2,699.73 (pool:WETH/USDC/500, WETH token0); the chain's clock is now.
    w.knobs.weiPerUsdc = 370_370_370_370_370n
    w.knobs.twapTick = -197_311
    w.knobs.blockTime = BigInt(Math.floor(Date.now() / 1000))
    return w
  }
  const TARGET = POLICIES['conservador-live-v2']!.gasReserveWei + 200_000_000_000_000n
  const topUps = (w: ReturnType<typeof world>) => w.sent.filter((t) => t.to.toLowerCase() === SAFE.toLowerCase() && !t.data)
  const execs = (w: ReturnType<typeof world>) => w.sent.filter((t) => t.to.toLowerCase() === SAFE.toLowerCase() && t.data)
  /** The Safe's execTransaction carries SwapRouter02.unwrapWETH9(reserve, Safe): the ETH of the swap is paid to the Safe. */
  const unwrapToSafe = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'unwrapWETH9', args: [TARGET, SAFE] }).slice(2).toLowerCase()
  const swaps = (data?: Hex) => !!data && data.toLowerCase().includes(unwrapToSafe)

  test('20 USDC: the summary names the USDC converted, the signed batch swaps it, the relayer sends no reserve', async () => {
    const w = quiet(20_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    // 1.349866 USDC at the TWAP, +1% tolerance and the 0.05% fee: 1.364039, shown to the unit.
    expect(tx.summary).toContain('Convert 1.364039 USDC to at least 0.0005 ETH on Uniswap v3 USDC/WETH 0.05% + unwrap, kept in your Safe as its gas reserve')
    expect(tx.summary.some((l) => l.includes('your 18.63 USDC'))).toBe(true)
    expect(await w.op.submit(ctx, 'activate', sign(tx))).toMatchObject({ state: 'confirmed' })
    expect(topUps(w)).toHaveLength(0)
    expect(execs(w)).toHaveLength(1)
    expect(swaps(execs(w)[0]!.data)).toBe(true)
    expect(w.state.accounts.k!.subsidies).toBeUndefined()
  })

  test('with the daily subsidy budget spent, a self-funded start still runs', async () => {
    const w = quiet(20_000_000n)
    for (let i = 0; i < 10; i++) w.state.accounts[`paid-${i}`] = { accountKey: `paid-${i}`, subsidies: [{ at: new Date().toISOString(), wei: TARGET.toString() }] } as unknown as AccountState
    expect(await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))).toMatchObject({ state: 'confirmed' })
    expect(topUps(w)).toHaveLength(0)
  })

  test('a relayer holding only the activation gas starts a self-funded account instead of arming it', async () => {
    const w = quiet(20_000_000n)
    w.knobs.relayerWei = 200_000_000_000_000n
    expect(await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))).toMatchObject({ state: 'confirmed' })
    // The same relayer cannot pay a reserve: a start that needs one waits armed.
    const v = quiet(20_000_000n)
    v.knobs.weiPerUsdc = 0n
    v.knobs.relayerWei = 200_000_000_000_000n
    expect(await v.op.submit(ctx, 'activate', sign(await v.op.prepareActivate(ctx)))).toMatchObject({ code: 'ARMED' })
  })

  test('a self-funded approval that waits armed keeps its reserve, and runs with no top-up', async () => {
    const w = quiet(20_000_000n)
    w.knobs.relayerWei = 0n
    expect(await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))).toMatchObject({ code: 'ARMED' })
    const acc = w.state.accounts.k!
    expect(acc.armed?.reserveWei).toBe(TARGET.toString())
    w.knobs.relayerWei = 10n ** 18n
    ;(w.op as unknown as { relayerBalanceCache: null }).relayerBalanceCache = null
    await (w.op as unknown as Armed).fireArmed(acc, 20_000_000n)
    expect(acc.active).toBe(true)
    expect(topUps(w)).toHaveLength(0)
    expect(swaps(execs(w)[0]!.data)).toBe(true)
  })

  test('kept on the relayer path: under 10 USDC, no quote, a Safe that holds its reserve, an approval signed before the deposit', async () => {
    const small = quiet(5_000_000n)
    expect(await small.op.prepareActivate(ctx).catch((x: unknown) => x)).toMatchObject({ status: 409, code: 'SUBSIDY_BELOW_MINIMUM' })

    const noQuote = quiet(20_000_000n)
    noQuote.knobs.weiPerUsdc = 0n
    const t1 = await noQuote.op.prepareActivate(ctx)
    expect(t1.summary.some((l) => l.startsWith('Convert'))).toBe(false)
    await noQuote.op.submit(ctx, 'activate', sign(t1))
    expect(topUps(noQuote)).toMatchObject([{ value: TARGET }])

    const funded = quiet(20_000_000n)
    funded.chain.eth = TARGET
    const t2 = await funded.op.prepareActivate(ctx)
    expect(t2.summary.some((l) => l.startsWith('Convert'))).toBe(false)
    await funded.op.submit(ctx, 'activate', sign(t2))
    expect(topUps(funded)).toHaveLength(0)
    expect(swaps(execs(funded)[0]!.data)).toBe(false)

    const early = quiet(0n)
    const t3 = await early.op.prepareActivate(ctx)
    expect(t3.summary.some((l) => l.startsWith('Convert'))).toBe(false)
    expect(await early.op.submit(ctx, 'activate', sign(t3))).toMatchObject({ code: 'ARMED' })
    early.chain.usdc = 20_000_000n
    await (early.op as unknown as Armed).fireArmed(early.state.accounts.k!, 20_000_000n)
    expect(topUps(early)).toMatchObject([{ value: TARGET }])
    expect(early.state.accounts.k!.subsidies).toHaveLength(1)
  })

  test('a spot away from the TWAP, or a pool that cannot answer observe: no swap, the relayer path', async () => {
    for (const set of [(w: ReturnType<typeof world>) => (w.knobs.weiPerUsdc = 10n ** 18n / 2730n), (w: ReturnType<typeof world>) => (w.knobs.twapTick = null)]) {
      const w = quiet(20_000_000n)
      set(w)
      const t = await w.op.prepareActivate(ctx)
      expect(t.summary.some((l) => l.startsWith('Convert'))).toBe(false)
      await w.op.submit(ctx, 'activate', sign(t))
      expect(topUps(w)).toMatchObject([{ value: TARGET }])
      expect(swaps(execs(w)[0]!.data)).toBe(false)
    }
  })

  test('an armed self-funded approval near its swap deadline is never broadcast: dropped, the owner approves again', async () => {
    const w = quiet(20_000_000n)
    w.knobs.relayerWei = 0n
    expect(await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))).toMatchObject({ code: 'ARMED' })
    const acc = w.state.accounts.k!
    expect(BigInt(acc.armed!.reserveDeadline!)).toBe(w.knobs.blockTime + 7n * 86_400n)
    // Funded again a week later, five minutes before the deadline.
    acc.armed!.reserveDeadline = String(Math.floor(Date.now() / 1000) + 300)
    const sims = w.simulated.length
    w.knobs.relayerWei = 10n ** 18n
    ;(w.op as unknown as { relayerBalanceCache: null }).relayerBalanceCache = null
    await (w.op as unknown as Armed).fireArmed(acc, 20_000_000n)
    expect(w.sent).toHaveLength(0)
    expect(w.simulated).toHaveLength(sims)
    expect(acc.armed).toBeUndefined()
    expect(acc.active).toBe(false)
    expect(w.op.ops(ctx, null).ops.at(-1)).toMatchObject({ kind: 'activate', state: 'failed', code: 'RESERVE_SWAP_EXPIRED' })
  })

  test('one already handed to a provider is not sent again past its deadline: reconciliation reads whether it landed', async () => {
    const w = quiet(20_000_000n)
    w.knobs.relayerWei = 0n
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    acc.armed = { ...acc.armed!, execSent: true, sentAt: Date.now() - 8 * 86_400_000, reserveDeadline: String(Math.floor(Date.now() / 1000) - 60) }
    w.knobs.relayerWei = 10n ** 18n
    ;(w.op as unknown as { relayerBalanceCache: null }).relayerBalanceCache = null
    await (w.op as unknown as Armed).fireArmed(acc, 20_000_000n)
    expect(w.sent).toHaveLength(0)
    expect(w.op.ops(ctx, null).ops.at(-1)).toMatchObject({ kind: 'activate', state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('a direct start whose deadline is already near is refused before anything is simulated or sent', async () => {
    const w = quiet(20_000_000n)
    const t = await w.op.prepareActivate(ctx)
    // The provider's head runs ahead of the clock by a week: the later of the two counts.
    w.knobs.blockTime += 7n * 86_400n
    expect(await w.op.submit(ctx, 'activate', sign(t))).toMatchObject({ state: 'failed', code: 'RESERVE_SWAP_EXPIRED' })
    expect(w.sent).toHaveLength(0)
  })
  test('the execTransaction carries the swap deadline into the relayer; dropped there, it fails as expired and nothing goes out', async () => {
    const w = quiet(20_000_000n)
    w.knobs.expireInQueue = true
    const t = await w.op.prepareActivate(ctx)
    expect(await w.op.submit(ctx, 'activate', sign(t))).toMatchObject({ state: 'failed', code: 'RESERVE_SWAP_EXPIRED' })
    expect(w.knobs.notAfterSeen).toEqual([w.knobs.blockTime + 7n * 86_400n - 600n])
    expect(execs(w)).toHaveLength(0)
    expect(w.state.accounts.k!.ownerFailures ?? []).toHaveLength(0)
  })
})
