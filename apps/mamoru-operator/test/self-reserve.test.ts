import { describe, expect, test } from 'bun:test'
import { decodeFunctionData } from 'viem'
import { address, erc20Abi, swapRouter02Abi } from '@mamoru/registry'
import { webAuthnSigner } from '@mamoru/account/safe'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { activationBatch, gasReserveCalls } from '@mamoru/account/live'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import {
  SELF_RESERVE_MAX_USDC,
  SELF_RESERVE_MIN_USDC,
  SELF_RESERVE_PROBE_USDC,
  selfReserveAmountIn,
  selfReserveConfirmed,
  selfReservePlan,
} from '../src/self-reserve.ts'

/** Policy reserve 0.0003 ETH + operator margin 0.0002 ETH. */
const T = 500_000_000_000_000n
/** 2,700 USD/ETH: wei for one USDC. */
const RATE = 370_370_370_370_370n

describe('the USDC a self-funded reserve converts', () => {
  test('the reserve at the quoted rate plus 10%, rounded up to a cent', () => {
    // 0.0005 ETH at 2,700 = 1.35 USDC; +10% = 1.485; up to the cent: 1.49.
    expect(selfReserveAmountIn(T, SELF_RESERVE_PROBE_USDC, RATE)).toBe(1_490_000n)
    // Never under the headroom: what it buys at the probed rate covers the reserve by at least 10%.
    const a = selfReserveAmountIn(T, SELF_RESERVE_PROBE_USDC, RATE)!
    expect((a * RATE) / SELF_RESERVE_PROBE_USDC).toBeGreaterThanOrEqual((T * 11n) / 10n)
    expect(selfReserveAmountIn(1n, SELF_RESERVE_PROBE_USDC, RATE)).toBe(10_000n)
  })

  test('no rate, no amount', () => {
    expect(selfReserveAmountIn(T, SELF_RESERVE_PROBE_USDC, 0n)).toBeNull()
    expect(selfReserveAmountIn(0n, SELF_RESERVE_PROBE_USDC, RATE)).toBeNull()
  })
})

describe('self-funded reserve or the relayer subsidy', () => {
  const plan = (over: Partial<{ usdc: bigint; eth: bigint; probeOut: bigint | null }> = {}) =>
    selfReservePlan({ usdc: over.usdc ?? 20_000_000n, eth: over.eth ?? 0n, target: T, probeOut: over.probeOut === undefined ? RATE : over.probeOut })

  test('a Safe with enough USDC buys exactly the reserve it lacks as its minimum', () => {
    expect(plan()).toEqual({ amountIn: 1_490_000n, minOut: T })
    // A partial reserve: only what is missing, for less USDC.
    expect(plan({ eth: T / 2n })).toEqual({ amountIn: 750_000n, minOut: T / 2n })
  })

  test('the minimum USDC is the subsidy minimum: one unit under it keeps the relayer path', () => {
    expect(SELF_RESERVE_MIN_USDC).toBe(10_000_000n)
    expect(plan({ usdc: SELF_RESERVE_MIN_USDC })).toMatchObject({ minOut: T })
    expect(plan({ usdc: SELF_RESERVE_MIN_USDC - 1n })).toEqual({ skip: 'BELOW_MINIMUM' })
  })

  test('nothing to buy, nothing deposited yet, no quote, or too dear: no swap in the batch', () => {
    expect(plan({ eth: T })).toEqual({ skip: 'FUNDED' })
    expect(plan({ usdc: 0n })).toEqual({ skip: 'NO_DEPOSIT' })
    expect(plan({ probeOut: null })).toEqual({ skip: 'NO_QUOTE' })
    expect(plan({ probeOut: 0n })).toEqual({ skip: 'NO_QUOTE' })
    // At 6,000 USD/ETH the reserve would cost 3.30 USDC, over the 3 USDC cap.
    expect(SELF_RESERVE_MAX_USDC).toBe(3_000_000n)
    expect(plan({ probeOut: 166_666_666_666_666n })).toEqual({ skip: 'OVER_MAX' })
  })

  test('the exact quote must clear the minimum by half the headroom', () => {
    expect(selfReserveConfirmed(T, (T * 105n) / 100n)).toBe(true)
    expect(selfReserveConfirmed(T, (T * 105n) / 100n - 1n)).toBe(false)
    expect(selfReserveConfirmed(T, T)).toBe(false)
  })
})

describe('the activation batch with the reserve swap', () => {
  const p = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner')]
  const webauthn = webAuthnSigner(p.x, p.y)
  const safe = counterfactualAddress(accountSetup(owners, 42n, webauthn))
  const live = { safe, chainId: 8453, owners, saltNonce: 42n, webauthn }
  const reserve = { fee: 500, amountIn: 1_490_000n, amountOutMinimum: T, deadline: 1_790_604_800n }

  test('the grants first, then approve exactly the USDC in, swap to ETH paid to the Safe itself, approve 0', () => {
    const plain = activationBatch(live, [], [], { trust: false })
    const withReserve = activationBatch(live, [], [], { trust: false, reserve })
    expect(withReserve.permissionIds).toEqual(plain.permissionIds)
    expect(withReserve.calls.slice(0, plain.calls.length)).toEqual(plain.calls)
    const [approveIn, swap, approveZero] = withReserve.calls.slice(plain.calls.length)
    expect(withReserve.calls).toHaveLength(plain.calls.length + 3)
    for (const c of [approveIn!, approveZero!]) expect(c.to).toBe(address('USDC'))
    expect(decodeFunctionData({ abi: erc20Abi, data: approveIn!.data }).args).toEqual([address('SwapRouter02'), reserve.amountIn])
    expect(decodeFunctionData({ abi: erc20Abi, data: approveZero!.data }).args).toEqual([address('SwapRouter02'), 0n])
    expect(swap!.to).toBe(address('SwapRouter02'))
    expect(swap!.value).toBe(0n)
    const multicall = decodeFunctionData({ abi: swapRouter02Abi, data: swap!.data })
    expect(multicall.functionName).toBe('multicall')
    const [deadline, inner] = multicall.args as [bigint, `0x${string}`[]]
    expect(deadline).toBe(reserve.deadline)
    const exact = decodeFunctionData({ abi: swapRouter02Abi, data: inner[0]! })
    expect(exact.functionName).toBe('exactInputSingle')
    expect(exact.args[0]).toMatchObject({ tokenIn: address('USDC'), tokenOut: address('WETH'), fee: 500, amountIn: reserve.amountIn, amountOutMinimum: T })
    const unwrap = decodeFunctionData({ abi: swapRouter02Abi, data: inner[1]! })
    expect(unwrap.functionName).toBe('unwrapWETH9')
    // The ETH goes to the Safe and nowhere else, at no less than the reserve it lacks.
    expect(unwrap.args).toEqual([T, safe])
  })

  test('no reserve, no swap; a zero amount is refused', () => {
    expect(activationBatch(live, [], [], { trust: false }).calls.some((c) => c.to === address('SwapRouter02'))).toBe(false)
    expect(() => gasReserveCalls(safe, { ...reserve, amountIn: 0n })).toThrow()
    expect(() => gasReserveCalls(safe, { ...reserve, amountOutMinimum: 0n })).toThrow()
  })
})
