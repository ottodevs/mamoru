// otto/mamoru#287 and #286: owner-side simulations on Monad, whose eth_simulateV1 refuses a sender with code ("sender
// not eoa") and reports the whole gas a call is given as its gasUsed (probed on rpc.monad.xyz, 1 Nov). Before: a Stop
// with positions or a withdrawal with a payout probe on the Monad Safe answered 503 SIMULATION_UNAVAILABLE, and the
// Safe-context gas figure was 30M (RENEWAL_TOO_LARGE).
import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import type { Operator } from '../src/operator.ts'
import { SAFE, TO, ctx, quiet, sign, world } from './owner-world.ts'

const GRANT = { name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}` as Hex, grant: {} as never }
type Calls = { to: Address; data: Hex; value?: bigint }[]
type Privates = {
  ownerTxGasLimit(live: { safe: Address }, calls: Calls, block: bigint): Promise<bigint | null>
  activationGasOf(live: { safe: Address }, calls: Calls, sessions: number, block: bigint): Promise<{ gas: bigint; simulated: boolean }>
}
const priv = (op: Operator) => op as unknown as Privates
const simulate = (op: Operator, calls: Calls) => (op as unknown as { simulateFromSafe(safe: Address, calls: Calls, block: bigint): Promise<unknown[]> }).simulateFromSafe(SAFE, calls, 100n)
const CALLS: Calls = [{ to: `0x${'12'.repeat(20)}`, data: '0x095ea7b3' }]

function monad(usdc = 5_000_000n) {
  const w = world(usdc)
  w.chain.deployed = true
  w.knobs.monad = true
  return w
}

describe('Stop and withdrawals from the Monad Safe (otto/mamoru#287)', () => {
  test('a Stop with a position prepares and lands: its collect amounts come from the run without the Safe code, checked in the Safe context', async () => {
    const w = monad()
    w.op.account(ctx).acc.grants = [GRANT]
    w.chain.positions = [{ tokenId: 2n, liquidity: 1_000_000_000n }]
    const tx = await w.op.prepareStop(ctx)
    expect(tx.summary.some((l) => l.startsWith('Close and burn position #2'))).toBe(true)
    const { out } = await quiet(() => w.op.submit(ctx, 'stop', sign(tx)))
    expect(out).toMatchObject({ kind: 'exit', state: 'confirmed' })
  })

  test('a withdrawal with a payout probe prepares on Monad', async () => {
    const w = monad()
    w.knobs.payoutGain = 10n ** 12n
    const { out: plan } = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '3000000', asset: 'EURC' }))
    expect(plan.receive).toMatchObject({ asset: 'EURC' })
  })

  test('a batch that reverts in both runs is a revert (409, the call named); disagreeing or unreadable runs are unavailable (503)', async () => {
    for (const [sim, sarOk, want] of [['revert', false, { status: 409, code: 'SIMULATION_FAILED' }], ['revert', true, { status: 503, code: 'SIMULATION_UNAVAILABLE' }], ['ok', false, { status: 503, code: 'SIMULATION_UNAVAILABLE' }], ['ok', null, { status: 503, code: 'SIMULATION_UNAVAILABLE' }]] as const) {
      const w = monad()
      w.knobs.sim = sim
      w.knobs.sarOk = sarOk
      const { out } = await quiet(() => simulate(w.op, CALLS).catch((e: unknown) => e))
      expect(out).toMatchObject(want)
    }
  })

  test('a call to the Safe itself cannot run without its code: unavailable, not simulated', async () => {
    const w = monad()
    const { out } = await quiet(() => simulate(w.op, [{ to: SAFE, data: '0x610b5925' }]).catch((e: unknown) => e))
    expect(out).toMatchObject({ status: 503, code: 'SIMULATION_UNAVAILABLE' })
  })

  test('Base is unchanged: no override, no Safe-context run', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    let inSafe = 0
    ;(w.op as unknown as { batchInSafe: () => Promise<null> }).batchInSafe = async () => (inSafe++, null)
    expect(await simulate(w.op, CALLS)).toHaveLength(1)
    expect(inSafe).toBe(0)
  })
})

describe('owner gas on Monad (otto/mamoru#287) and a measured revert (otto/mamoru#286)', () => {
  test('a Safe-context gasUsed of the whole gas given is no measurement: null, so the static estimate sizes the tx', async () => {
    const w = monad()
    expect(await priv(w.op).ownerTxGasLimit({ safe: SAFE }, CALLS, 100n)).toBeNull()
    expect(await priv(w.op).activationGasOf({ safe: SAFE }, CALLS, 1, 100n)).toMatchObject({ simulated: false })
  })

  test('Monad (per-call run refused): a batch that reverts in the Safe context is 409; one that succeeds keeps the static estimate (gate r1, Argon P1)', async () => {
    const w = monad()
    w.knobs.sarOk = false
    expect(await priv(w.op).activationGasOf({ safe: SAFE }, CALLS, 1, 100n).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'SIMULATION_FAILED' })
    w.knobs.sarOk = null
    expect(await priv(w.op).activationGasOf({ safe: SAFE }, CALLS, 1, 100n)).toMatchObject({ simulated: false })
  })

  test('Base: a real gasUsed is still a measurement', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    expect(await priv(w.op).activationGasOf({ safe: SAFE }, CALLS, 1, 100n)).toMatchObject({ simulated: true })
  })

  test('a call that reverts, and the batch reverts in the Safe context too: 409 SIMULATION_FAILED, no static estimate to sign', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.knobs.sim = 'revert'
    const op = priv(w.op)
    ;(w.op as unknown as { batchInSafe: () => Promise<{ success: boolean; gasUsed: bigint }> }).batchInSafe = async () => ({ success: false, gasUsed: 50_000n })
    expect(await op.activationGasOf({ safe: SAFE }, CALLS, 1, 100n).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'SIMULATION_FAILED' })
    ;(w.op as unknown as { batchInSafe: () => Promise<{ success: boolean; gasUsed: bigint } | null> }).batchInSafe = async () => ({ success: true, gasUsed: 50_000n })
    expect(await op.activationGasOf({ safe: SAFE }, CALLS, 1, 100n)).toMatchObject({ simulated: false })
    ;(w.op as unknown as { batchInSafe: () => Promise<null> }).batchInSafe = async () => null
    expect(await op.activationGasOf({ safe: SAFE }, CALLS, 1, 100n)).toMatchObject({ simulated: false })
  })
})
