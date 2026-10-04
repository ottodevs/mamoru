import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, stringToHex, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import type { AccountContext, OpView, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, erc20Abi, safeAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { LIVE_CAP_USDC, browserOwnerSignature, deployCall, liveAccountFromContext } from '@mamoru/account/live'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { HttpError, MAX_OWNER_FAILURES_PER_DAY, OWNER_FAILURES_ALERT_PER_DAY, Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
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
function world(usdc: bigint) {
  const sent: { to: string; data?: Hex; value?: bigint }[] = []
  /** Every eth_simulateV1 the operator ran, as its list of calls. */
  const simulated: { from?: string; to: string; data: Hex }[][] = []
  const chain = { deployed: false, usdc, nonce: 0n }
  /** What the simulation answers ('ok', 'revert' or 'down') and what happens on chain while the relayer sends. */
  const knobs = { sim: 'ok' as 'ok' | 'revert' | 'down', call: 'ok' as 'ok' | 'revert' | 'down', execOk: true, onSend: (_tx: { to: string }) => {}, relayerWei: 10n ** 18n }
  /** eth_calls of execTransaction the operator made. */
  const called: Hex[] = []
  const TRUE = `0x${'0'.repeat(63)}1` as const
  const factory = deployCall(liveAccountFromContext(ctx))
  const client = {
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ number: 100n, timestamp: 1_790_000_000n }),
    getTransactionReceipt: async () => {
      throw new Error('no receipt')
    },
    getLogs: async () => [],
    getCode: async () => (chain.deployed ? '0x01' : undefined),
    getBalance: async ({ address: at }: { address: string }) => (at.toLowerCase() === RELAYER.toLowerCase() ? knobs.relayerWei : 0n),
    readContract: async ({ address: at, functionName }: { address: string; functionName: string }) => {
      if (functionName === 'slot0') return [1n << 96n, 0, 0, 0, 0, 0, true]
      if (functionName === 'nonce') return chain.nonce
      if (functionName === 'balanceOf') return at.toLowerCase() === address('USDC').toLowerCase() ? chain.usdc : 0n
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
            if (callData.startsWith('0x70a08231')) return word(target.toLowerCase() === address('USDC').toLowerCase() ? chain.usdc : 0n)
            if (callData.startsWith('0x4d2301cc')) return word(0n)
            throw new Error('execution reverted')
          }),
        }
      }
      called.push(data)
      if (knobs.call === 'revert') throw Object.assign(new Error('execution reverted: GS026'), { code: 3, data: '0x08c379a0' })
      if (knobs.call === 'down') throw new Error('HTTP request failed. Status: 429')
      return { data: '0x' }
    },
  } as unknown as PublicClient
  const relayer = {
    address: RELAYER,
    send: async (tx: { to: string; data?: Hex; value?: bigint }, onSent?: (h: Hex) => void) => {
      sent.push(tx)
      knobs.onSend(tx)
      const hash = toHex(sent.length, { size: 32 })
      onSent?.(hash)
      const isDeploy = tx.to.toLowerCase() === factory.to.toLowerCase()
      if (isDeploy) chain.deployed = true
      else if (tx.data) chain.nonce++
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

  test('an armed activation that meets an over-cap deposit fails on the op with the code and the amounts', async () => {
    const w = world(OVER)
    const { acc } = w.op.account(ctx)
    acc.ops.push({ opId: 'own-1-activate', kind: 'activate', state: 'proposed', code: 'ARMED', updatedAt: '2026-10-01T10:00:00.000Z' })
    acc.armed = { opId: 'own-1-activate', tx: { nonce: 0n } as ArmedActivation['tx'], safeTxHash: '0x', signature: '0x', grants: [], armedAt: '2026-10-01T10:00:00.000Z' }
    await (w.op as unknown as { fireArmed(a: AccountState, usdc: bigint): Promise<void> }).fireArmed(acc, OVER)
    expect(acc.armed).toBeUndefined()
    expect(acc.active).toBe(false)
    expect(w.sent).toHaveLength(0)
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ opId: 'own-1-activate', state: 'failed', code: 'DEPOSIT_OVER_CAP', amountUsdc: '101920000', capUsdc: '100000000' })
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

  test('an armed activation of an account over its budget is dropped without a send', async () => {
    const v = world(0n)
    await arm(v)
    const armedAcc = v.state.accounts.k!
    armedAcc.ownerFailures = Array.from({ length: MAX_OWNER_FAILURES_PER_DAY }, () => new Date().toISOString())
    v.chain.usdc = 10_000_000n
    await priv(v.op).fireArmed(armedAcc, 10_000_000n)
    expect(armedAcc.armed).toBeUndefined()
    expect(v.op.ops(ctx, null).ops[0]).toMatchObject({ state: 'failed', code: 'OWNER_FAILURE_BUDGET' })
    expect(v.sent).toHaveLength(0)
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
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ state: 'failed', code: 'DEPOSIT_OVER_CAP', amountUsdc: '101920000' })
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
    // Not at once: the first retry waits 30 s.
    expect(acc.armed!.retryAt! - Date.now()).toBeGreaterThan(25_000)
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
    // The refused attempt landed after all: the Safe executed it.
    w.chain.nonce = 1n
    acc.armed!.retryAt = Date.now() - 1
    await priv(w.op).fireArmed(acc, 20_000_000n)
    expect(acc.armed).toBeUndefined()
    expect(acc.ops.find((o) => o.opId === op.opId)).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('a retry whose execTransaction fails on chain is left to reconciliation: the first copy may have executed', async () => {
    const w = world(20_000_000n)
    let refuse = true
    w.knobs.onSend = (t) => {
      if (refuse && t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Internal error'), { code: -32603 })
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
      if (refuse && t.to.toLowerCase() === SAFE.toLowerCase() && 'data' in t) throw Object.assign(new Error('Internal error'), { code: -32603 })
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
