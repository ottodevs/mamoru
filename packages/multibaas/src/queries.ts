// Typed builders of the MBQ catalogue (dashboard.md §6.4, plan §23.4). Every range is closed [from, to].

export type Select =
  | { type: 'block_number' | 'block_hash' | 'tx_hash' | 'triggered_at' | 'event_signature' | 'contract_address'; alias: string }
  | { type: 'input'; inputIndex: number; alias: string; aggregator?: 'min' | 'max' | 'add' }

type Operator = 'equal' | 'greaterthan' | 'greaterthanorequal' | 'lessthan' | 'lessthanorequal'

export type FilterLeaf =
  | { fieldType: 'contract_address' | 'block_number'; operator: Operator; value: string }
  | { fieldType: 'input'; inputIndex: number; operator: Operator; value: string }

export type Filter = { rule: 'and' | 'or'; children: (Filter | FilterLeaf)[] }

export type EventSpec = { eventName: string; select: Select[]; filter: Filter }

export type EventQuery = { events: EventSpec[]; orderBy?: string; order?: 'ASC' | 'DESC'; groupBy?: string }

export const SIG = {
  Swap: 'Swap(address,address,int256,int256,uint160,uint128,int24)',
  Mint: 'Mint(address,address,int24,int24,uint128,uint256,uint256)',
  Burn: 'Burn(address,int24,int24,uint128,uint256,uint256)',
  IncreaseLiquidity: 'IncreaseLiquidity(uint256,uint128,uint256,uint256)',
  DecreaseLiquidity: 'DecreaseLiquidity(uint256,uint128,uint256,uint256)',
  Collect: 'Collect(uint256,address,uint256,uint256)',
  Transfer: 'Transfer(address,address,uint256)',
  UserOperationEvent: 'UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)',
  UserOperationRevertReason: 'UserOperationRevertReason(bytes32,address,uint256,bytes)',
} as const

const COMMON: Select[] = [
  { type: 'block_number', alias: 'block' },
  { type: 'block_hash', alias: 'blockHash' },
  { type: 'tx_hash', alias: 'txHash' },
  { type: 'triggered_at', alias: 'at' },
]

// MultiBaas rejects inputs selected by name (MB-02, 2026-09-26); inputs are selected by index and aliased by name.
export const INPUTS = {
  Swap: ['sender', 'recipient', 'amount0', 'amount1', 'sqrtPriceX96', 'liquidity', 'tick'],
  Mint: ['sender', 'owner', 'tickLower', 'tickUpper', 'amount', 'amount0', 'amount1'],
  Burn: ['owner', 'tickLower', 'tickUpper', 'amount', 'amount0', 'amount1'],
  Transfer: ['from', 'to', 'tokenId'],
  UserOperationEvent: ['userOpHash', 'sender', 'paymaster', 'nonce', 'success', 'actualGasCost', 'actualGasUsed'],
  UserOperationRevertReason: ['userOpHash', 'sender', 'nonce', 'revertReason'],
} as const

function named<E extends keyof typeof INPUTS>(event: E, ...names: (typeof INPUTS)[E][number][]): Select[] {
  const all: readonly string[] = INPUTS[event]
  return names.map((name) => ({ type: 'input' as const, inputIndex: all.indexOf(name), alias: name }))
}

function range(contract: string, from: number, to: number, extra: (Filter | FilterLeaf)[] = []): Filter {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw new RangeError(`bad range ${from}-${to}`)
  return {
    rule: 'and',
    children: [
      { fieldType: 'contract_address', operator: 'equal', value: contract.toLowerCase() },
      ...extra,
      { fieldType: 'block_number', operator: 'greaterthanorequal', value: String(from) },
      { fieldType: 'block_number', operator: 'lessthanorequal', value: String(to) },
    ],
  }
}

const ordered = (events: EventSpec[]): EventQuery => ({ events, orderBy: 'block', order: 'ASC' })

const byInput = (inputIndex: number, value: string): FilterLeaf => ({ fieldType: 'input', inputIndex, operator: 'equal', value: value.toLowerCase() })

/** MBQ-01: Swap rows of a pool. */
export function mbq01Swaps(pool: string, from: number, to: number): EventQuery {
  return ordered([{ eventName: SIG.Swap, select: [...COMMON, ...named('Swap', ...INPUTS.Swap)], filter: range(pool, from, to) }])
}

/** MBQ-02: Mint and Burn rows of a pool in one query (several events per query are accepted). */
export function mbq02Liquidity(pool: string, from: number, to: number): EventQuery {
  const kind: Select = { type: 'event_signature', alias: 'kind' }
  return ordered([
    { eventName: SIG.Mint, select: [kind, ...COMMON, ...named('Mint', ...INPUTS.Mint)], filter: range(pool, from, to) },
    { eventName: SIG.Burn, select: [kind, ...COMMON, ...named('Burn', ...INPUTS.Burn)], filter: range(pool, from, to) },
  ])
}

/** MBQ-01 and MBQ-02 in one body: every Swap, Mint and Burn of a pool, with `kind`. One call per page instead of two. */
export function poolActivity(pool: string, from: number, to: number): EventQuery {
  const swaps = mbq01Swaps(pool, from, to).events[0]!
  return ordered([{ ...swaps, select: [{ type: 'event_signature', alias: 'kind' }, ...swaps.select] }, ...mbq02Liquidity(pool, from, to).events])
}

/** MBQ-03: position events of the account's tokenIds on the NonfungiblePositionManager. */
export function mbq03PositionEvents(npm: string, tokenIds: readonly bigint[], from: number, to: number): EventQuery {
  if (tokenIds.length === 0) throw new RangeError('no tokenIds')
  const ids: Filter = { rule: 'or', children: tokenIds.map((id) => byInput(0, id.toString())) }
  const select: Select[] = [
    { type: 'event_signature', alias: 'kind' },
    ...COMMON,
    { type: 'input', inputIndex: 0, alias: 'tokenId' },
    { type: 'input', inputIndex: 1, alias: 'arg1' },
    { type: 'input', inputIndex: 2, alias: 'amount0' },
    { type: 'input', inputIndex: 3, alias: 'amount1' },
  ]
  return ordered([SIG.IncreaseLiquidity, SIG.DecreaseLiquidity, SIG.Collect].map((eventName) => ({ eventName, select, filter: range(npm, from, to, [ids]) })))
}

/** MBQ-04: position NFT transfers from or to the account. */
export function mbq04PositionTransfers(npm: string, account: string, from: number, to: number): EventQuery {
  const side: Filter = { rule: 'or', children: [byInput(0, account), byInput(1, account)] }
  return ordered([{ eventName: SIG.Transfer, select: [...COMMON, ...named('Transfer', ...INPUTS.Transfer)], filter: range(npm, from, to, [side]) }])
}

/** MBQ-05: UserOperation outcomes of the account on EntryPoint v0.7. */
export function mbq05UserOps(entryPoint: string, account: string, from: number, to: number): EventQuery {
  const filter = range(entryPoint, from, to, [byInput(1, account)])
  return ordered([
    { eventName: SIG.UserOperationEvent, select: [{ type: 'event_signature', alias: 'kind' }, ...COMMON, ...named('UserOperationEvent', 'userOpHash', 'sender', 'nonce', 'success', 'actualGasCost')], filter },
    { eventName: SIG.UserOperationRevertReason, select: [{ type: 'event_signature', alias: 'kind' }, ...COMMON, ...named('UserOperationRevertReason', ...INPUTS.UserOperationRevertReason)], filter },
  ])
}

/** MBQ-07: Swap aggregates of a pool over the stats window; a contrast only, never the source. */
export function mbq07SwapAggregates(pool: string, from: number, to: number): EventQuery[] {
  const group: Select = { type: 'contract_address', alias: 'pool' }
  const positive = (inputIndex: number): FilterLeaf => ({ fieldType: 'input', inputIndex, operator: 'greaterthan', value: '0' })
  return [
    { events: [{ eventName: SIG.Swap, select: [group, { type: 'input', inputIndex: 6, alias: 'tickMin', aggregator: 'min' }, { type: 'input', inputIndex: 6, alias: 'tickMax', aggregator: 'max' }], filter: range(pool, from, to) }], groupBy: 'pool' },
    { events: [{ eventName: SIG.Swap, select: [group, { type: 'input', inputIndex: 2, alias: 'volume0', aggregator: 'add' }], filter: range(pool, from, to, [positive(2)]) }], groupBy: 'pool' },
    { events: [{ eventName: SIG.Swap, select: [group, { type: 'input', inputIndex: 3, alias: 'volume1', aggregator: 'add' }], filter: range(pool, from, to, [positive(3)]) }], groupBy: 'pool' },
  ]
}

/** MBQ-08: swaps of a pool whose recipient is the account. */
export function mbq08AccountSwaps(pool: string, account: string, from: number, to: number): EventQuery {
  return ordered([{ eventName: SIG.Swap, select: [...COMMON, ...named('Swap', ...INPUTS.Swap)], filter: range(pool, from, to, [byInput(1, account)]) }])
}
