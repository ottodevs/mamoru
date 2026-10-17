import { describe, expect, test } from 'bun:test'
import { decodeFunctionData } from 'viem'
import { address, erc20Abi, swapRouter02Abi } from '@mamoru/registry'
import { webAuthnSigner } from '@mamoru/account/safe'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { activationBatch, gasReserveCalls } from '@mamoru/account/live'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import {
  SELF_RESERVE_DEADLINE_MARGIN_SECONDS,
  SELF_RESERVE_MAX_USDC,
  SELF_RESERVE_MIN_USDC,
  SELF_RESERVE_TWAP_TOLERANCE_BPS,
  meanTick,
  reserveExpired,
  selfReserveConfirmed,
  selfReservePlan,
  usdcForWeiAtTick,
} from '../src/self-reserve.ts'

/** Policy reserve 0.0003 ETH + operator margin 0.0002 ETH. */
const T = 500_000_000_000_000n
/** Spot at 2,700 USD/ETH: wei for one USDC. */
const RATE = 370_370_370_370_370n
/** pool:WETH/USDC/500 (WETH is token0) at ~2,699.73 USD/ETH. */
const TICK = -197_311
const rateAt = (usdPerEth: number) => 10n ** 18n / BigInt(usdPerEth)

describe('the reserve priced at the pool TWAP', () => {
  test('mean tick of observe([1800, 0]) rounds towards negative infinity', () => {
    expect(meanTick([0n, BigInt(TICK) * 1800n], 1800)).toBe(TICK)
    expect(meanTick([0n, BigInt(TICK) * 1800n + 1n], 1800)).toBe(TICK)
    expect(meanTick([0n, BigInt(TICK) * 1800n - 1n], 1800)).toBe(TICK - 1)
    expect(meanTick([1800n, 3600n], 1800)).toBe(1)
  })

  test('USDC worth the reserve at a tick, either token order, rounded up', () => {
    const fair = usdcForWeiAtTick(T, TICK, true)
    // 0.0005 ETH at 2,699.73 = 1.349866 USDC.
    expect(fair).toBe(1_349_866n)
    // The same pool with the tokens the other way round: the tick is negated.
    const flipped = usdcForWeiAtTick(T, -TICK, false)
    expect(flipped >= fair - 1n && flipped <= fair + 1n).toBe(true)
  })
})

describe('self-funded reserve or the relayer subsidy', () => {
  const FAIR = usdcForWeiAtTick(T, TICK, true)
  const plan = (over: Partial<{ usdc: bigint; eth: bigint; probeOut: bigint | null; fairCost: bigint | null; feeBps: bigint }> = {}) =>
    selfReservePlan({
      usdc: over.usdc ?? 20_000_000n,
      eth: over.eth ?? 0n,
      target: T,
      probeOut: over.probeOut === undefined ? RATE : over.probeOut,
      fairCost: over.fairCost === undefined ? FAIR : over.fairCost,
      feeBps: over.feeBps ?? 5n,
    })

  test('normal: the USDC spent is the TWAP cost plus 1% and the pool fee, never more; the minimum is the reserve', () => {
    expect(SELF_RESERVE_TWAP_TOLERANCE_BPS).toBe(100n)
    expect(plan()).toEqual({ amountIn: (FAIR * 10_105n) / 10_000n, minOut: T })
    expect((FAIR * 10_105n) / 10_000n).toBe(1_364_039n)
    // The 0.30% pool pays its own fee on top, and nothing else.
    expect(plan({ feeBps: 30n })).toEqual({ amountIn: (FAIR * 10_130n) / 10_000n, minOut: T })
    // A partial reserve: priced on what is missing.
    const half = usdcForWeiAtTick(T / 2n, TICK, true)
    expect(plan({ eth: T / 2n, fairCost: half })).toEqual({ amountIn: (half * 10_105n) / 10_000n, minOut: T / 2n })
  })

  test('a spot that makes the reserve dearer than the TWAP by more than 1% buys nothing; a cheaper spot is fine', () => {
    expect(plan({ probeOut: rateAt(2725) })).toMatchObject({ minOut: T })
    expect(plan({ probeOut: rateAt(2730) })).toEqual({ skip: 'TWAP_DIVERGENCE' })
    // The review's case: the spot asks ~3 USDC for what the TWAP prices at ~1.35.
    expect(plan({ probeOut: rateAt(6000) })).toEqual({ skip: 'TWAP_DIVERGENCE' })
    expect(plan({ probeOut: rateAt(2000) })).toEqual({ amountIn: 1_364_039n, minOut: T })
  })

  test('no TWAP (observe failed) or no quote: no swap', () => {
    expect(plan({ fairCost: null })).toEqual({ skip: 'NO_TWAP' })
    expect(plan({ fairCost: 0n })).toEqual({ skip: 'NO_TWAP' })
    expect(plan({ probeOut: null })).toEqual({ skip: 'NO_QUOTE' })
    expect(plan({ probeOut: 0n })).toEqual({ skip: 'NO_QUOTE' })
  })

  test('the minimum USDC is the subsidy minimum: one unit under it keeps the relayer path', () => {
    expect(SELF_RESERVE_MIN_USDC).toBe(10_000_000n)
    expect(plan({ usdc: SELF_RESERVE_MIN_USDC })).toMatchObject({ minOut: T })
    expect(plan({ usdc: SELF_RESERVE_MIN_USDC - 1n })).toEqual({ skip: 'BELOW_MINIMUM' })
  })

  test('nothing to buy, nothing deposited yet, or too dear: no swap in the batch', () => {
    expect(plan({ eth: T })).toEqual({ skip: 'FUNDED' })
    expect(plan({ usdc: 0n })).toEqual({ skip: 'NO_DEPOSIT' })
    // At 6,000 USD/ETH on both clocks the reserve would cost 3.03 USDC, over the 3 USDC cap.
    expect(SELF_RESERVE_MAX_USDC).toBe(3_000_000n)
    expect(plan({ probeOut: rateAt(6000), fairCost: 3_000_000n })).toEqual({ skip: 'OVER_MAX' })
  })

  test('the exact quote must give at least the minimum', () => {
    expect(selfReserveConfirmed(T, T)).toBe(true)
    expect(selfReserveConfirmed(T, T - 1n)).toBe(false)
  })

  test('a swap is never sent within ten minutes of its deadline, or after it', () => {
    const d = 1_790_604_800n
    expect(SELF_RESERVE_DEADLINE_MARGIN_SECONDS).toBe(600n)
    expect(reserveExpired(d, d - 601n)).toBe(false)
    expect(reserveExpired(d, d - 600n)).toBe(true)
    expect(reserveExpired(d, d + 1n)).toBe(true)
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
