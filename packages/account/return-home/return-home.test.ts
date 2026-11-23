import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, pad, type Hex } from 'viem'
import { address, baseRegistry, entry, erc20Abi, monadRegistry, multiSendCallOnlyAbi, smartSessionAbi, swapRouter02Abi, tokenMessengerV2Abi } from '@mamoru/registry'
import { buildMonadSell, buildReturnHome, MONAD_SELL_TWAP_WINDOW_SECONDS, monadSellCalls, monadSellMinOut, monadSellPrice, monadSellTwapValue, returnHomeCalls, RETURN_HOME_DOMAIN, RETURN_HOME_FINALITY, TOKEN_MESSENGER_V2, type MonadSellInput, type ReturnHomeInput } from './index.ts'

const SAFE = '0x1DCE307bc77EFdd434b431DD1698A502c20479c5'
const HOME = '0x8654FA14122595f2960Cf0Bf1cC28a2750AFDA49'
const ids: Hex[] = [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`]
const input = (o: Partial<ReturnHomeInput> = {}): ReturnHomeInput => ({ chainId: 143, safe: SAFE, safeNonce: '3', home: HOME, amountUsdc: '28850000', removeIds: ids, ...o })

describe('buildReturnHome (otto/mamoru#428, spec 014 step 1)', () => {
  test('removes every session, then approves exactly the amount and burns it to the home on Base: open caller, no fee, Standard', () => {
    const calls = returnHomeCalls(input(), monadRegistry)
    expect(calls).toHaveLength(4)
    for (const [i, id] of ids.entries()) {
      expect(calls[i]!.to).toBe(address('SmartSession', monadRegistry))
      expect(decodeFunctionData({ abi: smartSessionAbi, data: calls[i]!.data })).toMatchObject({ functionName: 'removeSession', args: [id] })
    }
    expect(calls[2]!.to).toBe(address('USDC', monadRegistry))
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2]!.data })).toMatchObject({ functionName: 'approve', args: [TOKEN_MESSENGER_V2, 28_850_000n] })
    expect(calls[3]!.to).toBe(TOKEN_MESSENGER_V2)
    const burn = decodeFunctionData({ abi: tokenMessengerV2Abi, data: calls[3]!.data })
    expect(burn.functionName).toBe('depositForBurn')
    expect(burn.args).toEqual([28_850_000n, RETURN_HOME_DOMAIN, pad(HOME, { size: 32 }).toLowerCase() as Hex, address('USDC', monadRegistry), `0x${'00'.repeat(32)}`, 0n, RETURN_HOME_FINALITY])
    expect(calls.every((c) => c.value === 0n)).toBe(true)
  })

  test('TokenMessengerV2 is the address the Base registry pins (same on every CCTP chain); Base is domain 6', () => {
    expect(TOKEN_MESSENGER_V2.toLowerCase()).toBe(address('TokenMessengerV2', baseRegistry).toLowerCase())
    expect(RETURN_HOME_DOMAIN).toBe(6)
  })

  test('no USDC: a revoke only, nothing burned', () => {
    const calls = returnHomeCalls(input({ amountUsdc: '0' }), monadRegistry)
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.to === address('SmartSession', monadRegistry))).toBe(true)
  })

  test('deterministic: same input, same hash; any field changes it', () => {
    const a = buildReturnHome(input(), monadRegistry)
    expect(buildReturnHome(input(), monadRegistry).safeTxHash).toBe(a.safeTxHash)
    for (const o of [{ safeNonce: '4' }, { home: SAFE.replace('1D', '2D') }, { amountUsdc: '28850001' }, { removeIds: ids.slice(1) }]) {
      expect(buildReturnHome(input(o as Partial<ReturnHomeInput>), monadRegistry).safeTxHash).not.toBe(a.safeTxHash)
    }
    expect(a.safeTx).toMatchObject({ value: '0', safeTxGas: '0', baseGas: '0', gasPrice: '0', nonce: '3', operation: 1 })
  })

  test('refuses what the operator never prepares', () => {
    expect(() => returnHomeCalls(input(), baseRegistry)).toThrow('registry of chain')
    expect(() => returnHomeCalls(input({ chainId: 8453 }), baseRegistry)).toThrow('never Base')
    expect(() => returnHomeCalls(input({ home: SAFE }), monadRegistry)).toThrow('home')
    expect(() => returnHomeCalls(input({ home: '0x0000000000000000000000000000000000000000' }), monadRegistry)).toThrow('home')
    expect(() => returnHomeCalls(input({ amountUsdc: '0', removeIds: [] }), monadRegistry)).toThrow('nothing')
    expect(() => returnHomeCalls(input({ amountUsdc: '-1' }), monadRegistry)).toThrow('decimal')
    expect(() => returnHomeCalls(input({ removeIds: [ids[0]!, ids[0]!] }), monadRegistry)).toThrow('duplicate')
  })
})

describe('buildMonadSell (otto/mamoru#428, spec 014 RH-07: step A0)', () => {
  const W = 120n * 10n ** 18n
  const sell = (o: Partial<MonadSellInput> = {}): MonadSellInput => ({ chainId: 143, safe: SAFE, safeNonce: '3', amountIn: W.toString(), amountOutMinimum: '3500000', ...o })
  const WMON = address('WMON', monadRegistry)
  const ROUTER = address('SwapRouter02', monadRegistry)

  test('approve exactly w to SwapRouter02, sell all of it to USDC on the growth pool paid to this Safe, approve back to 0: nothing else', () => {
    const calls = monadSellCalls(sell(), monadRegistry)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.value === 0n)).toBe(true)
    expect(calls[0]!.to).toBe(WMON)
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data })).toMatchObject({ functionName: 'approve', args: [ROUTER, W] })
    expect(calls[1]!.to).toBe(ROUTER)
    const swap = decodeFunctionData({ abi: swapRouter02Abi, data: calls[1]!.data })
    expect(swap.functionName).toBe('exactInputSingle')
    expect(swap.args![0]).toEqual({ tokenIn: WMON, tokenOut: address('USDC', monadRegistry), fee: entry('pool:WMON/USDC/3000', monadRegistry).fee!, recipient: SAFE, amountIn: W, amountOutMinimum: 3_500_000n, sqrtPriceLimitX96: 0n })
    expect(calls[2]!.to).toBe(WMON)
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2]!.data })).toMatchObject({ functionName: 'approve', args: [ROUTER, 0n] })
    // Threats S19: no session, owner, module, guard or fallback handler is touched.
    expect(calls.some((c) => c.to === address('SmartSession', monadRegistry) || c.to === SAFE)).toBe(false)
  })

  test('one Safe tx through MultiSendCallOnly (the only delegatecall), no refund, a hash bound to the Safe, the chain, the nonce and every amount', () => {
    const a = buildMonadSell(sell(), monadRegistry)
    expect(a.safeTx).toMatchObject({ to: address('MultiSendCallOnly_141', monadRegistry), operation: 1, value: '0', gasPrice: '0', safeTxGas: '0', baseGas: '0', nonce: '3' })
    expect(BigInt(a.safeTx.refundReceiver)).toBe(0n)
    expect(decodeFunctionData({ abi: multiSendCallOnlyAbi, data: a.safeTx.data as Hex }).functionName).toBe('multiSend')
    expect(buildMonadSell(sell(), monadRegistry).safeTxHash).toBe(a.safeTxHash)
    for (const o of [{ safeNonce: '4' }, { amountIn: (W - 1n).toString() }, { amountOutMinimum: '3499999' }, { safe: HOME }] as Partial<MonadSellInput>[]) {
      expect(buildMonadSell(sell(o), monadRegistry).safeTxHash, JSON.stringify(o)).not.toBe(a.safeTxHash)
    }
  })

  test('refuses what is not this sale: nothing to sell, no minimum, another chain, a registry of another chain, amounts that are not integers', () => {
    expect(() => buildMonadSell(sell({ amountIn: '0' }), monadRegistry)).toThrow('nothing to sell')
    expect(() => buildMonadSell(sell({ amountOutMinimum: '0' }), monadRegistry)).toThrow('without a minimum')
    expect(() => buildMonadSell(sell({ chainId: 8453 }), baseRegistry)).toThrow('Monad only')
    expect(() => buildMonadSell(sell(), baseRegistry)).toThrow('registry of chain')
    expect(() => buildMonadSell(sell({ amountIn: '1e18' }), monadRegistry)).toThrow('not a decimal integer')
    expect(() => buildMonadSell(sell({ amountOutMinimum: '-1' }), monadRegistry)).toThrow('not a decimal integer')
  })
})

describe('monadSellPrice: the price guard of step A0 (threats S8)', () => {
  // WMON is token0 (18 decimals), USDC token1 (6): at 0.03 USDC per WMON the raw price is 0.03e6 / 1e18.
  const TICK = Math.floor(Math.log(0.03e6 / 1e18) / Math.log(1.0001))
  const W = 120n * 10n ** 18n
  const worth = monadSellTwapValue(W, TICK, monadRegistry)

  test('the TWAP value of the WMON, in USDC base units', () => {
    // 120 WMON at about 0.03 USDC: about 3.6 USDC (the tick rounds the price down by under a basis point).
    expect(Number(worth) / 1e6).toBeCloseTo(3.6, 2)
    expect(MONAD_SELL_TWAP_WINDOW_SECONDS).toBeGreaterThanOrEqual(300)
  })

  test('minimum = the quote less 30 bps', () => {
    expect(monadSellMinOut(3_500_000n)).toBe(3_489_500n)
  })

  test('a quote within 300 bps of the TWAP value and a minimum within 30 bps of the quote: signed', () => {
    const quote = (worth * 9_700n) / 10_000n + 1n
    expect(monadSellPrice({ amountIn: W, amountOutMinimum: monadSellMinOut(quote), quote, twapTick: TICK }, monadRegistry)).toBeNull()
    // A higher minimum than needed is the owner's gain, never a refusal.
    expect(monadSellPrice({ amountIn: W, amountOutMinimum: quote, quote, twapTick: TICK }, monadRegistry)).toBeNull()
  })

  test('a quote more than 300 bps under the TWAP value, or nothing: MONAD_DEPTH_TOO_LOW', () => {
    const quote = (worth * 9_700n) / 10_000n - 1n
    expect(monadSellPrice({ amountIn: W, amountOutMinimum: monadSellMinOut(quote), quote, twapTick: TICK }, monadRegistry)).toBe('MONAD_DEPTH_TOO_LOW')
    expect(monadSellPrice({ amountIn: W, amountOutMinimum: 1n, quote: 0n, twapTick: TICK }, monadRegistry)).toBe('MONAD_DEPTH_TOO_LOW')
  })

  test('a minimum more than 30 bps under the quote, or none: MIN_OUT_TOO_LOW', () => {
    const quote = worth
    expect(monadSellPrice({ amountIn: W, amountOutMinimum: monadSellMinOut(quote) - 1n, quote, twapTick: TICK }, monadRegistry)).toBe('MIN_OUT_TOO_LOW')
    expect(monadSellPrice({ amountIn: W, amountOutMinimum: 0n, quote, twapTick: TICK }, monadRegistry)).toBe('MIN_OUT_TOO_LOW')
  })
})
