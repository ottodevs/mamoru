import { describe, expect, test } from 'bun:test'
import { concat, encodeFunctionData, encodePacked, hashTypedData, size, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, erc20Abi, erc4626Abi, monadRegistry, multiSendCallOnlyAbi, nonfungiblePositionManagerAbi, swapRouter02Abi, type Registry } from '@mamoru/registry'
import { uniswapV3 } from '@mamoru/uniswap-v3'
import { ownerSafeTx, stopBatch } from '../live/index.ts'
import { safeTxTypedData, type MultiSendCall, type SafeTx } from '../safe/index.ts'
import { readStop, STOP_MAX_BASE_GAS, STOP_SAFE_TX_GAS, STOP_MIN_OUT_BPS, whyNotStop, whyNotStopBounds, type StopNeeds } from './index.ts'

// otto/mamoru#430: the Worker reads a Stop's Safe tx and passes it only when every call is one a Stop makes, paying the Safe.

const SAFE: Address = '0x1DCE307bc77EFdd434b431DD1698A502c20479c5'
const THIEF: Address = '0x9999999999999999999999999999999999999999'
const RELAYER: Address = '0x7777777777777777777777777777777777777777'
const ids: Hex[] = [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`]
const strip = (c: { to: Address; value: bigint; data: Hex }): MultiSendCall => ({ to: c.to, value: c.value, data: c.data })

/** What planFullStop builds: revokes, close and burn, a vault redeem, a swap back to USDC (approve, swap, approve 0). */
function stopCalls(reg: Registry, token = 'cbBTC', fee = 500): MultiSendCall[] {
  const { approve, exactInputSingle } = uniswapV3(reg)
  const vault = reg.entries.find((e) => e.kind === 'vault')
  return [
    ...stopBatch({ account: SAFE, permissionIds: ids, positions: [{ tokenId: 7n, liquidity: 1_000n, amount0Min: 1n, amount1Min: 1n }], deadline: 1_800_000_000n, registry: reg }),
    ...(vault ? [{ to: vault.address, value: 0n, data: encodeFunctionData({ abi: erc4626Abi, functionName: 'redeem', args: [5n, SAFE, SAFE] }) }] : []),
    ...[approve(token, 'SwapRouter02', 50_000n), exactInputSingle({ account: SAFE, tokenIn: token, tokenOut: 'USDC', fee, amountIn: 50_000n, amountOutMinimum: 1n }), approve(token, 'SwapRouter02', 0n)].map(strip),
  ]
}

const wire = (tx: SafeTx) => ({
  to: tx.to,
  value: tx.value.toString(),
  data: tx.data,
  operation: tx.operation,
  safeTxGas: (tx.refund?.safeTxGas ?? 0n).toString(),
  baseGas: (tx.refund?.baseGas ?? 0n).toString(),
  gasPrice: (tx.refund?.gasPrice ?? 0n).toString(),
  gasToken: '0x0000000000000000000000000000000000000000' as Address,
  refundReceiver: tx.refund?.refundReceiver ?? ('0x0000000000000000000000000000000000000000' as Address),
  nonce: tx.nonce.toString(),
})
/** A prepare body for `tx`, hashed as the owner would sign it. */
const offer = (tx: SafeTx, chainId = 8453) => ({ safe: SAFE, chainId, safeTxHash: hashTypedData(safeTxTypedData(SAFE, chainId, tx)), safeTx: wire(tx) })
const batch = (calls: MultiSendCall[], reg: Registry = baseRegistry) => offer(ownerSafeTx(calls, 4n, reg), reg.chainId)
/** A MultiSendCallOnly payload built by hand: `op` per entry, so a DELEGATECALL entry can be tried. */
const packed = (entries: { op: number; c: MultiSendCall }[]): Hex =>
  encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName: 'multiSend', args: [concat(entries.map(({ op, c }) => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [op, c.to, c.value, BigInt(size(c.data)), c.data])))] })
const usdc = address('USDC', baseRegistry)
const npm = address('NonfungiblePositionManager', baseRegistry)
const router = address('SwapRouter02', baseRegistry)

describe('whyNotStop (otto/mamoru#430)', () => {
  test("planFullStop's calls on Base (revoke, close and burn, vault redeem, swap back): admitted", () => {
    expect(whyNotStop(SAFE, 8453, batch(stopCalls(baseRegistry)), baseRegistry)).toBeNull()
  })

  test('the same on Monad (WMON back to USDC, no vault in its registry): admitted', () => {
    expect(whyNotStop(SAFE, 143, batch(stopCalls(monadRegistry, 'WMON', 3000), monadRegistry), monadRegistry)).toBeNull()
  })

  test('a revoke-only Stop (one plain CALL): admitted', () => {
    const one = stopBatch({ account: SAFE, permissionIds: [ids[0]!], positions: [], deadline: 0n, registry: baseRegistry })
    expect(whyNotStop(SAFE, 8453, batch(one), baseRegistry)).toBeNull()
  })

  test('a Stop the Safe pays for itself, within the base gas the operator charges: admitted', () => {
    const tx = { ...ownerSafeTx(stopCalls(baseRegistry), 4n, baseRegistry), refund: { safeTxGas: STOP_SAFE_TX_GAS, baseGas: STOP_MAX_BASE_GAS, gasPrice: 20_000_000n, refundReceiver: RELAYER } }
    expect(whyNotStop(SAFE, 8453, offer(tx), baseRegistry)).toBeNull()
  })

  const extra: [string, MultiSendCall, string][] = [
    ['a USDC transfer out', { to: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [THIEF, 1_000_000n] }) }, 'token call'],
    ['an approval to someone else', { to: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [THIEF, 1_000_000n] }) }, 'token call'],
    ['a collect to someone else', { to: npm, value: 0n, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', args: [{ tokenId: 7n, recipient: THIEF, amount0Max: 1n, amount1Max: 1n }] }) }, 'collect recipient'],
    ['the position NFT sent away', { to: npm, value: 0n, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'safeTransferFrom', args: [SAFE, THIEF, 7n] }) }, 'position call'],
    ['a swap paid to someone else', { to: router, value: 0n, data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('cbBTC', baseRegistry), tokenOut: usdc, fee: 500, recipient: THIEF, amountIn: 1n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) }, 'swap recipient'],
    ['a swap into another token', { to: router, value: 0n, data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: usdc, tokenOut: address('cbBTC', baseRegistry), fee: 500, recipient: SAFE, amountIn: 1n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) }, 'swap tokens'],
    ['a vault redeem paid to someone else', { to: address('vault:gtUSDCp', baseRegistry), value: 0n, data: encodeFunctionData({ abi: erc4626Abi, functionName: 'redeem', args: [5n, THIEF, SAFE] }) }, 'vault receiver'],
    ['ETH sent out', { to: THIEF, value: 1n, data: '0x' }, 'value'],
    ['a call to an unknown contract', { to: THIEF, value: 0n, data: '0x12345678' }, 'target'],
  ]
  test.each(extra)('%s added to a Stop: refused', (_what, call, why) => {
    expect(whyNotStop(SAFE, 8453, batch([...stopCalls(baseRegistry), call]), baseRegistry)).toContain(why)
  })

  test('an approval to the router left open at the end: refused', () => {
    const { approve } = uniswapV3(baseRegistry)
    expect(whyNotStop(SAFE, 8453, batch([...stopCalls(baseRegistry), strip(approve('USDC', 'SwapRouter02', 10n ** 12n))]), baseRegistry)).toContain('left open')
  })

  test('calldata with bytes after the call: refused', () => {
    const calls = stopCalls(baseRegistry)
    calls[0] = { ...calls[0]!, data: `${calls[0]!.data}00` as Hex }
    expect(whyNotStop(SAFE, 8453, batch(calls), baseRegistry)).toContain('session call')
  })

  test('a DELEGATECALL entry inside the batch: refused', () => {
    const calls = stopCalls(baseRegistry)
    const tx: SafeTx = { to: address('MultiSendCallOnly_141', baseRegistry), value: 0n, data: packed([{ op: 0, c: calls[0]! }, { op: 1, c: calls[1]! }]), operation: 1, nonce: 4n }
    expect(whyNotStop(SAFE, 8453, offer(tx), baseRegistry)).toContain('not a CALL')
  })

  test('a batch through MultiSend (which allows delegatecall) instead of MultiSendCallOnly: refused', () => {
    const tx = { ...ownerSafeTx(stopCalls(baseRegistry), 4n, baseRegistry), to: address('MultiSend_141', baseRegistry) }
    expect(whyNotStop(SAFE, 8453, offer(tx), baseRegistry)).toBe('batch')
  })

  test('a single call made as a DELEGATECALL: refused', () => {
    const one = stopBatch({ account: SAFE, permissionIds: [ids[0]!], positions: [], deadline: 0n, registry: baseRegistry })[0]!
    expect(whyNotStop(SAFE, 8453, offer({ to: one.to, value: 0n, data: one.data, operation: 1, nonce: 4n }), baseRegistry)).toBe('batch')
  })

  test('a refund over the base gas the operator charges: refused', () => {
    const tx = { ...ownerSafeTx(stopCalls(baseRegistry), 4n, baseRegistry), refund: { safeTxGas: STOP_SAFE_TX_GAS, baseGas: STOP_MAX_BASE_GAS + 1n, gasPrice: 20_000_000n, refundReceiver: RELAYER } }
    expect(whyNotStop(SAFE, 8453, offer(tx), baseRegistry)).toBe('refund')
  })

  test('a refund paid in a token: refused', () => {
    const body = batch(stopCalls(baseRegistry))
    expect(whyNotStop(SAFE, 8453, { ...body, safeTx: { ...body.safeTx, gasToken: usdc } }, baseRegistry)).toBe('gas token')
  })

  test('a hash the tx does not give, another Safe, another chain, no safeTx: refused', () => {
    const body = batch(stopCalls(baseRegistry))
    expect(whyNotStop(SAFE, 8453, { ...body, safeTxHash: `0x${'12'.repeat(32)}` }, baseRegistry)).toBe('hash')
    expect(whyNotStop(SAFE, 8453, { ...body, safe: THIEF }, baseRegistry)).toBe('safe')
    expect(whyNotStop(SAFE, 8453, { ...body, chainId: 143 }, baseRegistry)).toBe('chain')
    expect(whyNotStop(SAFE, 8453, { ...body, safeTx: undefined }, baseRegistry)).toBe('no safeTx')
  })

  test('a swap on a fee tier with no pool in the registry (one anyone could create thin): refused', () => {
    const swap = { to: router, value: 0n, data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('cbBTC', baseRegistry), tokenOut: usdc, fee: 10_000, recipient: SAFE, amountIn: 1n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) }
    expect(whyNotStop(SAFE, 8453, batch([...stopCalls(baseRegistry), swap]), baseRegistry)).toContain('swap pool')
  })

  test.each([0n, 1n, STOP_SAFE_TX_GAS - 1n])('a refund that forwards %p gas to the calls (they run out, the refund is paid): refused', (safeTxGas) => {
    const tx = { ...ownerSafeTx(stopCalls(baseRegistry), 4n, baseRegistry), refund: { safeTxGas, baseGas: 100_000n, gasPrice: 20_000_000n, refundReceiver: RELAYER } }
    expect(whyNotStop(SAFE, 8453, offer(tx), baseRegistry)).toBe('refund')
  })

  test('readStop names what the Worker must read: every swap and a refund gas price', () => {
    const tx = { ...ownerSafeTx(stopCalls(baseRegistry), 4n, baseRegistry), refund: { safeTxGas: STOP_SAFE_TX_GAS, baseGas: 100_000n, gasPrice: 20_000_000n, refundReceiver: RELAYER } }
    const r = readStop(SAFE, 8453, offer(tx), baseRegistry) as StopNeeds
    expect(r.swaps).toEqual([{ tokenIn: address('cbBTC', baseRegistry), tokenOut: usdc, fee: 500, amountIn: 50_000n, amountOutMinimum: 1n }])
    expect(r.refundGasPrice).toBe(20_000_000n)
  })
})

describe('whyNotStopBounds (otto/mamoru#430)', () => {
  const needs = (min: bigint, gas: bigint | null = null): StopNeeds => ({ swaps: [{ tokenIn: THIEF, tokenOut: THIEF, fee: 500, amountIn: 1n, amountOutMinimum: min }], refundGasPrice: gas })
  test('a minimum out within the room of the Worker quote: admitted; under it (a sandwich): refused', () => {
    const quote = 1_000_000n
    expect(whyNotStopBounds(needs((quote * STOP_MIN_OUT_BPS) / 10_000n), { quotes: [quote], gasPrice: null })).toBeNull()
    expect(whyNotStopBounds(needs((quote * STOP_MIN_OUT_BPS) / 10_000n - 1n), { quotes: [quote], gasPrice: null })).toBe('swap 0 minimum out')
    expect(whyNotStopBounds(needs(0n), { quotes: [quote], gasPrice: null })).toBe('swap 0 minimum out')
  })
  test('a refund gas price up to three times the chain\'s: admitted; above, or unread: refused', () => {
    expect(whyNotStopBounds({ swaps: [], refundGasPrice: 30n }, { quotes: [], gasPrice: 10n })).toBeNull()
    expect(whyNotStopBounds({ swaps: [], refundGasPrice: 31n }, { quotes: [], gasPrice: 10n })).toBe('refund gas price')
    expect(whyNotStopBounds({ swaps: [], refundGasPrice: 30n }, { quotes: [], gasPrice: null })).toBe('refund gas price')
  })
  test('a quote missing for a swap: refused', () => {
    expect(whyNotStopBounds(needs(1n), { quotes: [], gasPrice: null })).toBe('quotes')
  })
})
