import { describe, expect, test } from 'bun:test'
import { concat, numberToHex, pad, type Hex } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'
import type { Address } from '@mamoru/domain'
import { admitPrepare, gasCapUsdc, L1_USDC, stubOwnerSignature } from '../src/bridge-out.ts'
import { cctpMaxFee, cctpMessageKey, decodeCctpMessage, mintIsFor, TOKEN_MESSENGER_V2 } from '../src/cctp.ts'
import { CANDIDE_TOKEN_PAYMASTER_V07, checkCandide, decodeCandide, paymasterFromEnv, checkPimlicoErc20, decodePimlicoErc20, L1Bundler, MAX_CONSTANT_FEE, PIMLICO_ERC20_PAYMASTER_V07, PimlicoErc20Paymaster, RpcRefused, RpcUnavailable, type GasPrice } from '../src/paymaster.ts'

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

describe('Candide token paymaster data (#180)', () => {
  const cq: GasPrice = { paymaster: CANDIDE_TOKEN_PAYMASTER_V07, token: L1_USDC, exchangeRate: RATE, postOpGas: 0n }
  const cdata = (mode = 0, markupMode = 0, rate = RATE) =>
    concat([numberToHex(mode, { size: 1 }), numberToHex(markupMode, { size: 1 }), numberToHex(3, { size: 1 }), numberToHex(1_800_000_000, { size: 6 }), numberToHex(rate, { size: 32 }), ...(markupMode === 2 ? [numberToHex(1_050_000n, { size: 32 })] : []), `0x${'22'.repeat(65)}`])
  const cwhy = (d: Hex, paymaster: Address = CANDIDE_TOKEN_PAYMASTER_V07) => {
    try {
      checkCandide(f(d, paymaster), cq)
      return 'accepted'
    } catch (e) {
      return (e as Error).message
    }
  }
  test('decodes the leading fields and refuses another paymaster, another mode, a dearer rate', () => {
    expect(decodeCandide(cdata(0, 2))).toMatchObject({ mode: 0, markupMode: 2, gasTokenSlot: 3, validUntil: 1_800_000_000, exchangeRate: RATE, priceMarkup: 1_050_000n })
    expect(cwhy(cdata())).toBe('accepted')
    expect(cwhy(cdata(), PIMLICO_ERC20_PAYMASTER_V07)).toContain('unexpected paymaster')
    expect(cwhy(cdata(1))).toContain('token mode')
    expect(cwhy(cdata(0, 0, (RATE * 103n) / 100n))).toContain('rate above the quote')
    expect(() => decodeCandide('0x0000')).toThrow('too short')
  })
  test('provider from env: by name or by host; none without a URL', () => {
    expect(paymasterFromEnv(undefined, undefined, 1, L1_USDC)).toBeNull()
    expect(paymasterFromEnv(undefined, 'https://api.pimlico.io/v2/1/rpc?apikey=x', 1, L1_USDC)?.name).toBe('pimlico')
    expect(paymasterFromEnv(undefined, 'https://api.candide.dev/api/v3/1/x', 1, L1_USDC)?.name).toBe('candide')
    expect(paymasterFromEnv('candide', 'https://proxy.example/x', 1, L1_USDC)?.name).toBe('candide')
    expect(() => paymasterFromEnv(undefined, 'https://proxy.example/x', 1, L1_USDC)).toThrow('pimlico or candide')
  })
  test('Pimlico data limited to its own bundlers is refused (the operator bundles)', () => {
    const own = `0x02${data().slice(4)}` as Hex
    expect(why(own)).toContain('its own bundlers')
  })
})

describe('CCTP (#180)', () => {
  const safe = '0x00000000000000000000000000000000000000aA' as Address
  const w = (a: Address) => pad(a, { size: 32 })
  const message = (o: { dest?: number; recipient?: Address; amount?: bigint } = {}) =>
    concat([
      numberToHex(1, { size: 4 }), numberToHex(0, { size: 4 }), numberToHex(o.dest ?? 6, { size: 4 }), `0x${'aa'.repeat(32)}`,
      w(TOKEN_MESSENGER_V2), w(TOKEN_MESSENGER_V2), `0x${'00'.repeat(32)}`, numberToHex(2000, { size: 4 }), numberToHex(2000, { size: 4 }),
      numberToHex(1, { size: 4 }), w(L1_USDC), w(o.recipient ?? safe), numberToHex(o.amount ?? 5_000_000n, { size: 32 }), w(safe), numberToHex(0, { size: 32 }), numberToHex(0, { size: 32 }), numberToHex(0, { size: 32 }),
    ])
  test('the operator pays a mint only for this account\'s burn', () => {
    expect(mintIsFor(decodeCctpMessage(message()), L1_USDC, safe, 5_000_000n)).toBe(true)
    expect(mintIsFor(decodeCctpMessage(message({ dest: 3 })), L1_USDC, safe, 5_000_000n)).toBe(false)
    expect(mintIsFor(decodeCctpMessage(message({ recipient: '0x00000000000000000000000000000000000000bB' })), L1_USDC, safe, 5_000_000n)).toBe(false)
    expect(mintIsFor(decodeCctpMessage(message({ amount: 5_000_001n })), L1_USDC, safe, 5_000_000n)).toBe(false)
    expect(() => decodeCctpMessage('0x00')).toThrow('too short')
  })
  test('maxFee in bps rounds up; Standard is free', () => {
    expect(cctpMaxFee(146_928_900n, 0)).toBe(0n)
    expect(cctpMaxFee(146_928_900n, 1)).toBe(14_693n)
    expect(cctpMaxFee(100n, 1)).toBe(1n)
  })
})

describe('shared limits (#180)', () => {
  test('one approval per account, a cap across accounts, expired ones make room', () => {
    const m = new Map<string, { prepareId: string; accountKey: string; expires: number }>()
    expect(admitPrepare(m, { prepareId: 'a1', accountKey: 'a', expires: 100 }, 2, 0)).toBe(true)
    expect(admitPrepare(m, { prepareId: 'a2', accountKey: 'a', expires: 100 }, 2, 0)).toBe(true)
    expect([...m.keys()]).toEqual(['a2'])
    expect(admitPrepare(m, { prepareId: 'b1', accountKey: 'b', expires: 100 }, 2, 0)).toBe(true)
    expect(admitPrepare(m, { prepareId: 'c1', accountKey: 'c', expires: 100 }, 2, 0)).toBe(false)
    expect(admitPrepare(m, { prepareId: 'c1', accountKey: 'c', expires: 300 }, 2, 200)).toBe(true)
  })
})

describe('CCTP message key (#180)', () => {
  test('the emitted message and its attested form share a key; another burn does not', () => {
    const body = (amount: bigint, fee = 0n) => concat([numberToHex(1, { size: 4 }), `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, numberToHex(amount, { size: 32 }), `0x${'22'.repeat(32)}`, numberToHex(0, { size: 32 }), numberToHex(fee, { size: 32 }), numberToHex(fee, { size: 32 })])
    const msg = (nonce: string, fin: number, amount: bigint, fee = 0n) => concat([numberToHex(1, { size: 4 }), numberToHex(0, { size: 4 }), numberToHex(6, { size: 4 }), `0x${nonce.repeat(32)}`, `0x${'33'.repeat(96)}`, numberToHex(2000, { size: 4 }), numberToHex(fin, { size: 4 }), body(amount, fee)])
    expect(cctpMessageKey(msg('00', 0, 5n))).toBe(cctpMessageKey(msg('ab', 2000, 5n, 0n)))
    expect(cctpMessageKey(msg('00', 0, 5n))).toBe(cctpMessageKey(msg('ab', 2000, 5n, 3n)))
    expect(cctpMessageKey(msg('00', 0, 5n))).not.toBe(cctpMessageKey(msg('ab', 2000, 6n)))
  })
})
