import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, getAddress, keccak256, stringToHex, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import type { AccountContext, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, erc20Abi, safeAbi } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { LIVE_CAP_USDC, browserOwnerSignature, deployCall, liveAccountFromContext } from '@mamoru/account/live'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { HttpError, MAX_OWNER_FAILURES_PER_DAY, OWNER_FAILURES_ALERT_PER_DAY, Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, ArmedActivation, StateStore } from '../src/state.ts'

const RELAYER = `0x${'7'.repeat(40)}` as const
const TO = getAddress(`0x${'c'.repeat(40)}`)
const OVER = 26_920_000n
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
  const knobs = { sim: 'ok' as 'ok' | 'revert' | 'down', call: 'ok' as 'ok' | 'revert' | 'down', execOk: true, onSend: (_tx: { to: string }) => {} }
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
    getBalance: async () => 0n,
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
    call: async ({ data }: { data: Hex }) => {
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
    expect(over.capUsdc).toBe('25000000')
    expect(over.overCap).toEqual({ code: 'DEPOSIT_OVER_CAP', usdc: '26920000', capUsdc: '25000000', excessUsdc: '1920000' })
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
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ opId: 'own-1-activate', state: 'failed', code: 'DEPOSIT_OVER_CAP', amountUsdc: '26920000', capUsdc: '25000000' })
  })

  test('Start is refused before and after the passkey with DEPOSIT_OVER_CAP and readable amounts', async () => {
    const w = world(OVER)
    const err = await w.op.prepareActivate(ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err as HttpError).toMatchObject({ status: 409, code: 'DEPOSIT_OVER_CAP' })
    expect((err as HttpError).message).toBe('this account holds 26.92 USDC, over the 25.00 USDC cap; withdraw at least 1.92 USDC to start')
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
    // A forged signature still costs nothing, simulation or not.
    const v = world(OVER)
    v.knobs.sim = 'down'
    const forged = await v.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1920000' })
    expect(await v.op.submit(ctx, 'transfer', sign(forged.ownerTx, thief)).catch((e: unknown) => e)).toMatchObject({ code: 'BAD_SIGNATURE' })
    expect(v.sent).toHaveLength(0)
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
    expect(await w.op.submit(ctx, 'stop', sign(tx, thief)).catch((e: unknown) => e)).toMatchObject({ code: 'BAD_SIGNATURE' })
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
    expect(op).toMatchObject({ kind: 'activate', state: 'failed', code: 'DEPOSIT_OVER_CAP', amountUsdc: '26920000', capUsdc: '25000000' })
    expect(w.sent.some((t) => t.to === SAFE && t.data !== undefined)).toBe(false)
    expect(w.state.accounts.k).toMatchObject({ active: false, grants: [] })
    expect((await w.op.funding(ctx)).overCap?.excessUsdc).toBe('1920000')
  })

  test('a deposit that lands before the preflight is refused before any relayer transaction', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    await w.op.submit(ctx, 'activate', sign(tx))
    const acc = w.state.accounts.k!
    // The watcher saw 20 USDC; by the time it executes, the account holds 26.92.
    w.chain.usdc = OVER
    await (w.op as unknown as { fireArmed(a: AccountState, usdc: bigint): Promise<void> }).fireArmed(acc, 20_000_000n)
    expect(w.sent).toHaveLength(0)
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ state: 'failed', code: 'DEPOSIT_OVER_CAP', amountUsdc: '26920000' })
  })
})

// Review P2: the owner can withdraw while an activation is still armed, and that activation is invalidated cleanly.
describe('withdrawing with an armed activation', () => {
  test('the transfer runs at nonce 0 and the armed activation is superseded, so the app asks for a fresh Start', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    const armed = await w.op.submit(ctx, 'activate', sign(tx))
    expect(armed.code).toBe('ARMED')
    // 26.92 USDC lands; the owner withdraws the excess before the watcher has looked.
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

