import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, getAddress, type Hex } from 'viem'
import type { StopInput } from '@mamoru/domain'
import { address, baseRegistry, erc4626Abi, monadRegistry } from '@mamoru/registry'
import { stopBatch } from '../live/index.ts'
import { buildStop, parseRefundPolicy, refundMismatch, stopCalls, stopSummaryMismatch, swapBackCalls, vaultExitCalls } from './index.ts'

// otto/mamoru#430: the one Stop builder of the operator and the Worker.

const SAFE = getAddress(`0x${'5a'.repeat(20)}`)
const input = (o: Partial<StopInput> = {}): StopInput => ({
  chainId: 8453,
  safe: SAFE,
  safeNonce: '9',
  revokes: [`0x${'01'.repeat(32)}`],
  positions: [{ tokenId: '42', liquidity: '1000', amount0Min: '1', amount1Min: '2' }],
  deadline: '1790000000',
  vaultExits: [{ vault: 'vault:gtUSDCp', mode: 'withdraw', assets: '7000000', shares: '0' }],
  swaps: [{ token: 'cbBTC', pool: 'pool:USDC/cbBTC/500', amountIn: '1500', amountOutMinimum: '1400000' }],
  ...o,
})

describe('buildStop', () => {
  test('the calls are the Stop batch, the vault exits and the swaps back, in that order, all with no value', () => {
    const calls = stopCalls(input(), baseRegistry)
    expect(calls).toEqual([
      ...stopBatch({ account: SAFE, permissionIds: [`0x${'01'.repeat(32)}`], positions: [{ tokenId: 42n, liquidity: 1000n, amount0Min: 1n, amount1Min: 2n }], deadline: 1_790_000_000n, registry: baseRegistry }),
      ...vaultExitCalls(SAFE, [{ vault: 'vault:gtUSDCp', mode: 'withdraw', assets: 7_000_000n, shares: 0n }], baseRegistry),
      ...swapBackCalls(SAFE, [{ token: 'cbBTC', pool: 'pool:USDC/cbBTC/500', amountIn: 1500n, amountOutMinimum: 1_400_000n }], baseRegistry),
    ])
    expect(calls.every((c) => c.value === 0n)).toBe(true)
    const exit = calls.find((c) => c.to === address('vault:gtUSDCp', baseRegistry))!
    expect(decodeFunctionData({ abi: erc4626Abi, data: exit.data }).args).toEqual([7_000_000n, SAFE, SAFE])
  })

  test('the hash moves with the nonce, the Safe, the chain and the refund', () => {
    const h = buildStop(input(), baseRegistry).safeTxHash
    expect(buildStop(input(), baseRegistry).safeTxHash).toBe(h)
    expect(buildStop(input({ safeNonce: '10' }), baseRegistry).safeTxHash).not.toBe(h)
    expect(buildStop(input({ safe: getAddress(`0x${'5b'.repeat(20)}`) }), baseRegistry).safeTxHash).not.toBe(h)
    expect(buildStop(input({ refund: { safeTxGas: '4000000', baseGas: '120000', gasPrice: '1', refundReceiver: `0x${'ab'.repeat(20)}` } }), baseRegistry).safeTxHash).not.toBe(h)
  })

  test.each([
    ['another chain than the registry', input({ chainId: 143 })],
    ['nothing to do', input({ revokes: [], positions: [], vaultExits: [], swaps: [] })],
    ['a revoke that is not a session id', input({ revokes: ['0x01' as Hex] })],
    ['a duplicate revoke', input({ revokes: [`0x${'01'.repeat(32)}`, `0x${'01'.repeat(32)}`] })],
    ['a duplicate position', input({ positions: [input().positions[0]!, input().positions[0]!] })],
    ['a vault exit on a token', input({ vaultExits: [{ vault: 'USDC', mode: 'redeem', assets: '1', shares: '1' }] })],
    ['a vault exit of another kind', input({ vaultExits: [{ vault: 'vault:gtUSDCp', mode: 'transfer' as never, assets: '1', shares: '1' }] })],
    ['one vault exited twice', input({ vaultExits: [input().vaultExits[0]!, input().vaultExits[0]!] })],
    ['a swap on a pool the token is not in', input({ swaps: [{ token: 'cbBTC', pool: 'pool:EURC/USDC/500', amountIn: '1', amountOutMinimum: '1' }] })],
    ['a swap of USDC', input({ swaps: [{ token: 'USDC', pool: 'pool:USDC/cbBTC/500', amountIn: '1', amountOutMinimum: '1' }] })],
    ['an amount that is not a decimal integer', input({ deadline: '-1' })],
    ['a refund at no price', input({ refund: { safeTxGas: '1', baseGas: '1', gasPrice: '0', refundReceiver: `0x${'ab'.repeat(20)}` } })],
    ['a refund to nobody', input({ refund: { safeTxGas: '1', baseGas: '1', gasPrice: '1', refundReceiver: `0x${'00'.repeat(20)}` } })],
    ['a refund over a Stop gas', input({ refund: { safeTxGas: '4000001', baseGas: '1', gasPrice: '1', refundReceiver: `0x${'ab'.repeat(20)}` } })],
    ['a refund over a Stop base gas', input({ refund: { safeTxGas: '1', baseGas: '620001', gasPrice: '1', refundReceiver: `0x${'ab'.repeat(20)}` } })],
  ])('%s: refused', (_why, i) => {
    expect(() => buildStop(i, baseRegistry)).toThrow()
  })

  test('a revoke-only Stop on Monad is the revocations alone', () => {
    const i = input({ chainId: 143, positions: [], deadline: '0', vaultExits: [], swaps: [], revokes: [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`] })
    expect(stopCalls(i, monadRegistry)).toHaveLength(2)
    expect(buildStop(i, monadRegistry).safeTxHash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('what the Worker checks besides the hash', () => {
  const lines = [
    "Revoke the engine's 1 session grant(s)",
    'Close and burn position #42 (USDC/cbBTC 0.05%)',
    'Take 7.00 USDC out of Morpho · Gauntlet USDC Prime',
    'Swap 1500 cbBTC units to at least 1.40 USDC',
    'Everything stays in your Safe as USDC',
  ]
  test('the summary of the operator, line by line', () => {
    expect(stopSummaryMismatch(input(), lines, baseRegistry)).toBeNull()
    expect(stopSummaryMismatch(input(), [...lines.slice(0, 2), lines[2]!.replace('7.00', '70.00'), ...lines.slice(3)], baseRegistry)).toBe('vault vault:gtUSDCp')
    expect(stopSummaryMismatch(input(), [lines[1]!, ...lines.slice(2)], baseRegistry)).toBe('revocations')
    expect(stopSummaryMismatch(input(), [...lines, 'Send 1 USDC to a friend'], baseRegistry)).toBe('unexpected line 6')
    expect(stopSummaryMismatch(input(), 'Stop', baseRegistry)).toBe('summary is not a list of lines')
  })
  test("amounts are cut to the cent, never rounded up, as the operator's fmtUsdc writes them", () => {
    const i = input({ vaultExits: [{ vault: 'vault:gtUSDCp', mode: 'redeem', assets: '12345678', shares: '1' }], swaps: [{ token: 'cbBTC', pool: 'pool:USDC/cbBTC/500', amountIn: '1500', amountOutMinimum: '1409999' }] })
    const at = (vault: string, swap: string) => [lines[0]!, lines[1]!, `Take ${vault} USDC out of Morpho · Gauntlet USDC Prime`, `Swap 1500 cbBTC units to at least ${swap} USDC`, lines[4]!]
    expect(stopSummaryMismatch(i, at('12.34', '1.40'), baseRegistry)).toBeNull()
    expect(stopSummaryMismatch(i, at('12.35', '1.40'), baseRegistry)).toBe('vault vault:gtUSDCp')
    expect(stopSummaryMismatch(i, at('12.34', '1.41'), baseRegistry)).toBe('swap cbBTC')
  })
  test('a Safe-paid Stop on Monad names the most it costs, in MON', () => {
    const i = input({ chainId: 143, positions: [], deadline: '0', vaultExits: [], swaps: [], refund: { safeTxGas: '4000000', baseGas: '120000', gasPrice: '200000000000', refundReceiver: `0x${'ab'.repeat(20)}` } })
    const fee = "Your Safe pays this transaction's network fee to Mamoru's relayer, at most about 0.824 MON (sponsored transactions are used up until 2026-11-23T10:00:00.000Z)"
    expect(stopSummaryMismatch(i, ["Revoke the engine's 1 session grant(s)", 'Your positions and tokens stay in your Safe as they are; Stop again closes them', fee], monadRegistry)).toBeNull()
    expect(stopSummaryMismatch(i, ["Revoke the engine's 1 session grant(s)", 'Your positions and tokens stay in your Safe as they are; Stop again closes them'], monadRegistry)).toBe('fee line')
  })
  test('the refund policy: its relayer, at most its gas price; none for a chain it does not name', () => {
    const policy = parseRefundPolicy(` 8453:0x${'ab'.repeat(20)}:1000000000 , 143:0x${'cd'.repeat(20)}:300000000000, bad, 10:0x${'00'.repeat(20)}:1`)
    expect([...policy.keys()]).toEqual([8453, 143])
    const paid = (r: Partial<NonNullable<StopInput['refund']>>) => input({ refund: { safeTxGas: '1', baseGas: '1', gasPrice: '1000000000', refundReceiver: `0x${'ab'.repeat(20)}`, ...r } })
    expect(refundMismatch(input(), undefined)).toBeNull()
    expect(refundMismatch(paid({}), policy.get(8453))).toBeNull()
    expect(refundMismatch(paid({ gasPrice: '1000000001' }), policy.get(8453))).toBe('refund gas price')
    expect(refundMismatch(paid({ refundReceiver: `0x${'cd'.repeat(20)}` }), policy.get(8453))).toBe('refund receiver')
    expect(refundMismatch(paid({}), policy.get(10))).toBe('a refund on a chain with no refund policy')
  })
})
