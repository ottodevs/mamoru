import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, getAddress, keccak256, stringToHex, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import type { AccountContext, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, erc20Abi, safeAbi } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { LIVE_CAP_USDC, deployCall, liveAccountFromContext } from '@mamoru/account/live'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { HttpError, Operator, type OperatorConfig } from '../src/operator.ts'
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
  const chain = { deployed: false, usdc, nonce: 0n }
  const factory = deployCall(liveAccountFromContext(ctx))
  const client = {
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ number: 100n, timestamp: 1_790_000_000n }),
    getCode: async () => (chain.deployed ? '0x01' : undefined),
    getBalance: async () => 0n,
    readContract: async ({ address: at, functionName }: { address: string; functionName: string }) => {
      if (functionName === 'slot0') return [1n << 96n, 0, 0, 0, 0, 0, true]
      if (functionName === 'nonce') return chain.nonce
      if (functionName === 'balanceOf') return at.toLowerCase() === address('USDC').toLowerCase() ? chain.usdc : 0n
      throw new Error(`unexpected read ${functionName}`)
    },
    request: async ({ params }: { params: [{ blockStateCalls: [{ calls: unknown[] }] }] }) => [{ calls: params[0].blockStateCalls[0].calls.map(() => ({ status: '0x1', returnData: '0x', gasUsed: '0x5208', logs: [] })) }],
    call: async () => ({ data: '0x' }),
  } as unknown as PublicClient
  const relayer = {
    address: RELAYER,
    send: async (tx: { to: string; data?: Hex; value?: bigint }, onSent?: (h: Hex) => void) => {
      sent.push(tx)
      const hash = toHex(sent.length, { size: 32 })
      onSent?.(hash)
      const isDeploy = tx.to.toLowerCase() === factory.to.toLowerCase()
      if (isDeploy) chain.deployed = true
      else if (tx.data) chain.nonce++
      const logs = isDeploy ? [] : [{ address: SAFE, topics: [EXECUTION_SUCCESS] }]
      return { hash, receipt: { transactionHash: hash, status: 'success', blockNumber: 101n, logs } as unknown as TransactionReceipt }
    },
  } as unknown as Relayer
  const state = { accounts: {} as Record<string, AccountState> }
  const store = { state, save: () => {} } as unknown as StateStore
  const cfg = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 } satisfies OperatorConfig
  const op = new Operator(cfg, client, relayer, store)
  return { op, chain, sent, factory, state }
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

function sign(t: OwnerTxToSign): OwnerSignature {
  const a = passkey.assert(t.safeTxHash)
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
