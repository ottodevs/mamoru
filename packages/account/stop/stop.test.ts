import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, getAddress, type Hex } from 'viem'
import type { StopInput } from '@mamoru/domain'
import { address, baseRegistry, erc4626Abi, monadRegistry } from '@mamoru/registry'
import { stopBatch } from '../live/index.ts'
import { buildStop, stopCalls, swapBackCalls, vaultExitCalls } from './index.ts'

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
