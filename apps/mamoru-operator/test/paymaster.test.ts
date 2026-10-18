import { describe, expect, test } from 'bun:test'
import { concat, numberToHex, type Hex } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'
import type { Address } from '@mamoru/domain'
import { gasCapUsdc, L1_USDC, stubOwnerSignature } from '../src/bridge-out.ts'
import { checkPimlicoErc20, decodePimlicoErc20, L1Bundler, MAX_CONSTANT_FEE, PIMLICO_ERC20_PAYMASTER_V07, PimlicoErc20Paymaster, RpcRefused, RpcUnavailable, type GasPrice } from '../src/paymaster.ts'

const TREASURY = '0x000000000000000000000000000000000000bEEF' as Address
const RATE = 2_415_300_294n
const quote: GasPrice = { paymaster: PIMLICO_ERC20_PAYMASTER_V07, token: L1_USDC, exchangeRate: RATE, postOpGas: 60_000n }

function data(o: { mode?: number; flags?: number; token?: Address; rate?: bigint; postOpGas?: bigint; preFund?: bigint; constantFee?: bigint; recipient?: Address; sigLen?: number } = {}): Hex {
  const flags = o.flags ?? (o.constantFee !== undefined ? 1 : 0) | (o.recipient ? 2 : 0) | (o.preFund !== undefined ? 4 : 0)
  return concat([
    numberToHex(((o.mode ?? 1) << 1) | 1, { size: 1 }),
    numberToHex(flags, { size: 1 }),
    numberToHex(1_800_000_000, { size: 6 }),
    numberToHex(0, { size: 6 }),
    o.token ?? L1_USDC,
    numberToHex(o.postOpGas ?? 60_000n, { size: 16 }),
    numberToHex(o.rate ?? RATE, { size: 32 }),
    numberToHex(40_000n, { size: 16 }),
    TREASURY,
    ...(o.preFund !== undefined ? [numberToHex(o.preFund, { size: 16 })] : []),
    ...(o.constantFee !== undefined ? [numberToHex(o.constantFee, { size: 16 })] : []),
    ...(o.recipient ? [o.recipient] : []),
    `0x${'11'.repeat(o.sigLen ?? 65)}`,
  ])
}
const f = (d: Hex, paymaster: Address = PIMLICO_ERC20_PAYMASTER_V07) => ({ paymaster, paymasterVerificationGasLimit: 60_000n, paymasterPostOpGasLimit: 70_000n, paymasterData: d })
const why = (d: Hex, paymaster?: Address) => {
  try {
    checkPimlicoErc20(f(d, paymaster), quote, L1_USDC)
    return 'accepted'
  } catch (e) {
    return (e as Error).message
  }
}

describe('Pimlico ERC-20 paymaster data (#180)', () => {
  test('decodes the singleton paymaster ERC-20 layout', () => {
    const c = decodePimlicoErc20(data({ constantFee: 10_000n }))
    expect(c).toMatchObject({ mode: 1, allowAllBundlers: true, validUntil: 1_800_000_000, token: L1_USDC, postOpGas: 60_000n, exchangeRate: RATE, paymasterValidationGasLimit: 40_000n, treasury: TREASURY, preFund: 0n, constantFee: 10_000n, recipient: null })
    expect(decodePimlicoErc20(data({ sigLen: 64 })).signature.length).toBe(2 + 128)
    expect(() => decodePimlicoErc20(data({ sigLen: 10 }))).toThrow('signature length')
    expect(() => decodePimlicoErc20(data({ flags: 8 }))).toThrow('unknown paymaster flags')
    expect(() => decodePimlicoErc20('0x0300')).toThrow('too short')
  })

  test('accepts what was quoted, refuses anything that could cost the account more', () => {
    expect(why(data())).toBe('accepted')
    expect(why(data({ rate: (RATE * 101n) / 100n }))).toBe('accepted')
    expect(why(data({ rate: (RATE * 103n) / 100n }))).toContain('rate above the quote')
    expect(why(data(), '0x000000000000000000000000000000000000dEaD')).toContain('unexpected paymaster')
    expect(why(data({ mode: 0 }))).toContain('ERC-20 mode')
    expect(why(data({ token: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }))).toContain('another token')
    expect(why(data({ postOpGas: 60_001n }))).toContain('postOp gas')
    expect(why(data({ preFund: 1n }))).toContain('prefund')
    expect(why(data({ recipient: '0x000000000000000000000000000000000000dEaD' }))).toContain('recipient')
    expect(why(data({ constantFee: MAX_CONSTANT_FEE }))).toBe('accepted')
    expect(why(data({ constantFee: MAX_CONSTANT_FEE + 1n }))).toContain('constant fee')
  })

  test('the gas cap covers every gas unit, the postOp gas, the penalty and the constant fee, rounded up', () => {
    const op = { callGasLimit: 200_000n, verificationGasLimit: 700_000n, preVerificationGas: 80_000n, maxFeePerGas: 1_000_000_000n, paymasterVerificationGasLimit: 60_000n, paymasterPostOpGasLimit: 70_000n } as UserOperation<'0.7'>
    const gas = 700_000n + 200_000n + 80_000n + 60_000n + 70_000n + 60_000n + (270_000n * 10n) / 100n
    const wei = gas * 1_000_000_000n
    expect(gasCapUsdc(op, quote, 0n)).toBe((wei * RATE + 10n ** 18n - 1n) / 10n ** 18n)
    expect(gasCapUsdc(op, quote, 7n)).toBe(gasCapUsdc(op, quote, 0n) + 7n)
  })

  test('the estimation signature has the owner signature shape', () => {
    const s = stubOwnerSignature(1_800_000_000)
    expect(s.slice(0, 26)).toBe('0x00000000000000006b49d200')
    expect(s.length).toBeGreaterThan(2 + 2 * (12 + 65 + 32 + 128))
  })
})

describe('provider RPC (#180)', () => {
  const answer = (body: unknown, ok = true): typeof fetch => (async () => (ok ? Response.json(body) : Promise.reject(new Error('down')))) as unknown as typeof fetch
  const op = { sender: L1_USDC, nonce: 0n, callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x' } as UserOperation<'0.7'>

  test('a quote from another paymaster is refused; errors never carry the URL', async () => {
    const url = 'https://api.example/v2/1/rpc?apikey=SECRET'
    const other = new PimlicoErc20Paymaster(url, 1, L1_USDC, answer({ jsonrpc: '2.0', id: 1, result: { quotes: [{ paymaster: '0x000000000000000000000000000000000000dEaD', token: L1_USDC, exchangeRate: '0x1', postOpGas: '0x1' }] } }))
    await expect(other.quote()).rejects.toThrow('unexpected paymaster')
    const down = new PimlicoErc20Paymaster(url, 1, L1_USDC, answer(null, false))
    const e = await down.quote().catch((x) => x as Error)
    expect(e).toBeInstanceOf(RpcUnavailable)
    expect(String((e as Error).message)).not.toContain('SECRET')
  })

  test('the bundler: a refusal is RpcRefused, a missing estimate method is null', async () => {
    const refusing = new L1Bundler('http://127.0.0.1:1/', answer({ jsonrpc: '2.0', id: 1, error: { code: -32500, message: 'AA23 reverted' } }))
    await expect(refusing.send(op)).rejects.toBeInstanceOf(RpcRefused)
    const lab = new L1Bundler('http://127.0.0.1:1/', answer({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not served' } }))
    expect(await lab.estimate(op)).toBeNull()
  })
})
