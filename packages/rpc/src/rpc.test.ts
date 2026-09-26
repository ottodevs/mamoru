import { describe, expect, test } from 'bun:test'
import { toEventSelector, type Hex, type Log } from 'viem'
import { address } from '@mamoru/registry'
import { userOpLogs } from './index.ts'

const EP = address('EntryPointV07')
const POOL = address('pool:USDC/cbBTC/500')
const BEFORE = toEventSelector('BeforeExecution()')
const UOE = toEventSelector('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')
const OTHER = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)')

function log(addr: Hex, topic: Hex, logIndex: number): Log {
  return { address: addr, topics: [topic] as never, data: '0x', logIndex, blockNumber: 1n, blockHash: `0x${'aa'.repeat(32)}`, transactionHash: `0x${'bb'.repeat(32)}`, transactionIndex: 0, removed: false }
}

// One handleOps with two userOps: [deposit] BeforeExecution, op A logs, UserOperationEvent(A), op B logs, UserOperationEvent(B).
const bundle = [log(EP, OTHER, 0), log(EP, BEFORE, 1), log(POOL, OTHER, 2), log(EP, UOE, 3), log(POOL, OTHER, 4), log(POOL, OTHER, 5), log(EP, UOE, 6)]

describe('userOpLogs', () => {
  test('the first op gets only the logs between BeforeExecution and its event', () => {
    expect(userOpLogs(bundle, 3).map((l) => l.logIndex)).toEqual([2])
  })

  test('the second op gets only the logs after the first op event', () => {
    expect(userOpLogs(bundle, 6).map((l) => l.logIndex)).toEqual([4, 5])
  })

  test('the order of the receipt logs does not matter', () => {
    expect(userOpLogs([...bundle].reverse(), 6).map((l) => l.logIndex)).toEqual([4, 5])
  })

  test('refuses an index that is not a UserOperationEvent, and a transaction without BeforeExecution', () => {
    expect(() => userOpLogs(bundle, 4)).toThrow(/no UserOperationEvent/)
    expect(() => userOpLogs(bundle.filter((l) => l.logIndex !== 1), 3)).toThrow(/BeforeExecution/)
  })
})
