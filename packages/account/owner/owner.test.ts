import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, hexToBigInt, size, slice, toFunctionSelector, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, erc20Abi, multiSendCallOnlyAbi, nonfungiblePositionManagerAbi, smartSessionAbi } from '@mamoru/registry'
import { multiSendCallOnly } from '../safe/index.ts'
import { walkawayCalls, type WalkawayInput } from './index.ts'

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1'
const OWNER_DEST: Address = '0x00000000000000000000000000000000000000b2'
const PIDS: Hex[] = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]
const input: WalkawayInput = {
  account: ACCOUNT,
  permissionIds: PIDS,
  positions: [
    { tokenId: 42n, liquidity: 1_000_000n },
    { tokenId: 43n, liquidity: 7n, amount0Min: 1n, amount1Min: 2n },
  ],
  recipient: OWNER_DEST,
  amounts: { USDC: 5_000_000_000n, cbBTC: 3_000_000n },
  deadline: 1_790_411_347n,
}

type Entry = { operation: number; to: Address; value: bigint; data: Hex }

/** Unpacks MultiSendCallOnly transactions: uint8 op, address to, uint256 value, uint256 len, bytes data. */
function unpack(multiSendData: Hex): Entry[] {
  const { args } = decodeFunctionData({ abi: multiSendCallOnlyAbi, data: multiSendData })
  const packed = args[0]
  const out: Entry[] = []
  let i = 0
  while (i < size(packed)) {
    const len = Number(hexToBigInt(slice(packed, i + 53, i + 85)))
    out.push({
      operation: Number(hexToBigInt(slice(packed, i, i + 1))),
      to: slice(packed, i + 1, i + 21),
      value: hexToBigInt(slice(packed, i + 21, i + 53)),
      data: len === 0 ? '0x' : slice(packed, i + 85, i + 85 + len),
    })
    i += 85 + len
  }
  return out
}

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

describe('owner walkaway batch', () => {
  const calls = walkawayCalls(input)
  const batch = multiSendCallOnly(calls)
  const entries = unpack(batch.data)

  test('packs into one MultiSendCallOnly delegatecall of plain CALLs with no value', () => {
    expect(same(batch.to, address('MultiSendCallOnly_141'))).toBe(true)
    expect(batch.operation).toBe(1)
    expect(entries.length).toBe(calls.length)
    expect(entries.every((e) => e.operation === 0 && e.value === 0n)).toBe(true)
  })

  test('order: revoke every grant, close each position, then transfer', () => {
    const npm = address('NonfungiblePositionManager')
    const expected: [Address, string][] = [
      [address('SmartSession'), 'removeSession(bytes32)'],
      [address('SmartSession'), 'removeSession(bytes32)'],
      [npm, 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))'],
      [npm, 'collect((uint256,address,uint128,uint128))'],
      [npm, 'burn(uint256)'],
      [npm, 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))'],
      [npm, 'collect((uint256,address,uint128,uint128))'],
      [npm, 'burn(uint256)'],
      [address('USDC'), 'transfer(address,uint256)'],
      [address('cbBTC'), 'transfer(address,uint256)'],
    ]
    expect(entries.map((e) => [e.to.toLowerCase(), slice(e.data, 0, 4)])).toEqual(
      expected.map(([to, sig]) => [to.toLowerCase(), toFunctionSelector(sig)]),
    )
  })

  test('revokes exactly the given permission ids', () => {
    const revoked = entries.slice(0, 2).map((e) => decodeFunctionData({ abi: smartSessionAbi, data: e.data }).args[0])
    expect(revoked).toEqual(PIDS)
  })

  test('each position is closed by its own token id and collects to the account', () => {
    const decoded = entries.slice(2, 8).map((e) => decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: e.data }))
    const ids = decoded.map((d) => {
      const a = d.args![0]
      return typeof a === 'bigint' ? a : (a as { tokenId: bigint }).tokenId
    })
    expect(ids).toEqual([42n, 42n, 42n, 43n, 43n, 43n])
    for (const d of decoded.filter((d) => d.functionName === 'collect')) {
      const p = d.args![0] as { recipient: Address }
      expect(same(p.recipient, ACCOUNT)).toBe(true)
    }
    const dec = decoded[3]!.args![0] as { liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint }
    expect([dec.liquidity, dec.amount0Min, dec.amount1Min, dec.deadline]).toEqual([7n, 1n, 2n, input.deadline])
  })

  test('tokens go to the address the owner chose', () => {
    const transfers = entries.slice(8).map((e) => decodeFunctionData({ abi: erc20Abi, data: e.data }).args as readonly [Address, bigint])
    expect(transfers.every(([to]) => same(to, OWNER_DEST))).toBe(true)
    expect(transfers.map(([, amount]) => amount)).toEqual([input.amounts.USDC, input.amounts.cbBTC])
  })

  test('no call targets the account, and no approve', () => {
    expect(entries.some((e) => same(e.to, ACCOUNT))).toBe(false)
    expect(entries.some((e) => slice(e.data, 0, 4) === toFunctionSelector('approve(address,uint256)'))).toBe(false)
  })

  test('an emptied position skips decreaseLiquidity; a zero balance skips its transfer', () => {
    const c = walkawayCalls({ ...input, positions: [{ tokenId: 42n, liquidity: 0n }], amounts: { USDC: 1n, cbBTC: 0n } })
    expect(c.map((x) => slice(x.data, 0, 4))).toEqual([
      toFunctionSelector('removeSession(bytes32)'),
      toFunctionSelector('removeSession(bytes32)'),
      toFunctionSelector('collect((uint256,address,uint128,uint128))'),
      toFunctionSelector('burn(uint256)'),
      toFunctionSelector('transfer(address,uint256)'),
    ])
  })

  test('an account with no grants and no positions only withdraws', () => {
    const c = walkawayCalls({ ...input, permissionIds: [], positions: [], amounts: { USDC: 10n, cbBTC: 0n } })
    expect(c.length).toBe(1)
    expect(same(c[0]!.to, address('USDC'))).toBe(true)
  })

  test('rejects a missing or self recipient and duplicates', () => {
    expect(() => walkawayCalls({ ...input, recipient: '0x0000000000000000000000000000000000000000' })).toThrow()
    expect(() => walkawayCalls({ ...input, recipient: ACCOUNT })).toThrow()
    expect(() => walkawayCalls({ ...input, permissionIds: [PIDS[0]!, PIDS[0]!] })).toThrow()
    expect(() => walkawayCalls({ ...input, positions: [input.positions[0]!, input.positions[0]!] })).toThrow()
  })
})
