import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, pad, type Hex } from 'viem'
import { address, baseRegistry, erc20Abi, monadRegistry, smartSessionAbi, tokenMessengerV2Abi } from '@mamoru/registry'
import { buildReturnHome, returnHomeCalls, RETURN_HOME_DOMAIN, RETURN_HOME_FINALITY, TOKEN_MESSENGER_V2, type ReturnHomeInput } from './index.ts'

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
