import { describe, expect, test } from 'bun:test'
import { concat, encodeAbiParameters, encodeEventTopics, pad, parseAbiItem, toHex, zeroHash, type Hex, type Log } from 'viem'
import type { AccountContext } from '@mamoru/domain'
import { address, baseRegistry, messageTransmitterV2Abi, tokenMessengerV2Abi } from '@mamoru/registry'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import { MESSAGE_TRANSMITTER_V2, TOKEN_MESSENGER_V2 } from '../src/cctp.ts'
import { beforeSign, cancelRelease, homeOf, nonceUsedAtHead, releaseObs, ReleaseRefused, releaseView, requestRelease, RELEASES_KEPT, settle, unsigned, type SettleChain } from '../src/release.ts'
import type { AccountState } from '../src/state.ts'

// The settle logic is chain-agnostic: these tests run it against the Base registry (USDC, messenger, EntryPoint there).
const REG = baseRegistry
const HOME = '0x00000000000000000000000000000000000000a1'
const SAFE = '0x00000000000000000000000000000000000000b2'
const V4 = '0x00000000000000000000000000000000000000f4'
const UOP = `0x${'ab'.repeat(32)}` as Hex
const UOP2 = `0x${'ef'.repeat(32)}` as Hex
const TX = `0x${'cd'.repeat(32)}` as Hex
const T = '2026-11-02T18:00:00.000Z'
const AMOUNT = 4_000_000n

function remote(over: { home?: string | null; homeDomain?: number } = {}): AccountState {
  const spec = { chainId: 143, policyId: 'one-auth-v4-remote', sessionKey: '0x01', validAfter: 0, validUntil: 0, capUsdc: '1000', ...(over.home === null ? {} : { home: over.home ?? HOME, homeDomain: over.homeDomain ?? 6 }) }
  return { accountKey: 'r-1', ctx: { accountKey: 'r-1', chainId: 143, address: SAFE, remote: spec } as unknown as AccountContext, ops: [] } as unknown as AccountState
}

const signing = (over: Partial<BridgeSigning> = {}): BridgeSigning => ({
  opId: 'op-1', account: SAFE, recipient: HOME, depositor: V4, chainId: 8453, pool: 'pool:WMON/USDC/3000', bucket: 'growth', amount: AMOUNT, destinationDomain: 6,
  userOpHash: UOP, nonceKey: 0n, nonce: 7n, prepareBlock: 1_000n, ...over,
})

const refused = (f: () => unknown) => {
  try {
    f()
  } catch (e) {
    return e instanceof ReleaseRefused ? `${e.status} ${e.code}` : String(e)
  }
  return 'no error'
}

const opened = () => {
  const acc = remote()
  requestRelease(acc, { id: 'r1', amount: AMOUNT.toString() }, T)
  return acc
}

describe('release (otto/mamoru#278): requests', () => {
  test('the home comes from the spec: home address, its chain and domain; none for a design-C or unknown domain', () => {
    expect(homeOf(remote())).toEqual({ home: '0x00000000000000000000000000000000000000A1' as never, chainId: 8453, homeDomain: 6 })
    expect(homeOf(remote({ home: null }))).toBeNull()
    expect(homeOf(remote({ homeDomain: 3 }))).toBeNull()
  })

  test('a request opens and the engine reads it; another is refused while it is open', () => {
    const acc = opened()
    expect(releaseView(acc)).toMatchObject({ id: 'r1', state: 'open', chainId: 8453 })
    expect(releaseObs(acc)).toEqual({ amount: AMOUNT, chainId: 8453 as never })
    expect(refused(() => requestRelease(acc, { id: 'r2', amount: '1' }, T))).toBe('409 RELEASE_OPEN')
  })

  test('review r1 (P0): the same id is the same request in every state, burned included; with another amount it is refused', () => {
    const acc = opened()
    expect(requestRelease(acc, { id: 'r1', amount: AMOUNT.toString() }, T)).toMatchObject({ state: 'open' })
    expect(refused(() => requestRelease(acc, { id: 'r1', amount: '5' }, T))).toBe('409 RELEASE_ID_REUSED')
    Object.assign(acc.release!, { state: 'burned', burn: { userOpHash: UOP, amount: AMOUNT.toString(), txHash: TX, block: 9 } })
    expect(requestRelease(acc, { id: 'r1', amount: AMOUNT.toString() }, T)).toMatchObject({ id: 'r1', state: 'burned', burn: { txHash: TX } })
    expect(releaseObs(acc)).toBeUndefined()
    // A new id after the burn: r1 is kept, still answered by id, and asking r1 again never reopens it.
    expect(requestRelease(acc, { id: 'r2', amount: '1000' }, T)).toMatchObject({ id: 'r2', state: 'open' })
    expect(releaseView(acc, 'r1')).toMatchObject({ id: 'r1', state: 'burned' })
    expect(requestRelease(acc, { id: 'r1', amount: AMOUNT.toString() }, T)).toMatchObject({ id: 'r1', state: 'burned' })
    expect(acc.release!.id).toBe('r2')
  })

  test('finished requests kept for status are bounded', () => {
    const acc = remote()
    for (let i = 0; i < RELEASES_KEPT + 3; i++) {
      requestRelease(acc, { id: `r${i}`, amount: '1' }, T)
      cancelRelease(acc, { id: `r${i}` }, T)
    }
    expect(acc.releasesDone!.length).toBe(RELEASES_KEPT)
  })

  test('cancel: an open request is withdrawn; a sending or burned one is refused; cancelled again is as it is', () => {
    const acc = opened()
    expect(cancelRelease(acc, { id: 'r1' }, T)).toMatchObject({ state: 'cancelled' })
    expect(cancelRelease(acc, { id: 'r1' }, T)).toMatchObject({ state: 'cancelled' })
    expect(releaseObs(acc)).toBeUndefined()
    expect(cancelRelease(acc, { id: 'nope' }, T)).toEqual({ state: 'none' })
    const s = opened()
    beforeSign(s, signing(), T)
    expect(refused(() => cancelRelease(s, { id: 'r1' }, T))).toBe('409 RELEASE_NOT_OPEN')
  })

  test('bad bodies and non-remote Safes are refused', () => {
    expect(refused(() => requestRelease(remote({ home: null }), { id: 'r1', amount: '1' }, T))).toBe('400 NOT_A_REMOTE')
    for (const body of [null, {}, { id: 'r1' }, { id: 'r 1', amount: '1' }, { id: 'r1', amount: '0' }, { id: 'r1', amount: '-1' }, { id: 'r1', amount: 1 }, { id: 'r1', amount: '01' }, { id: 'r1', amount: (1n << 128n).toString() }])
      expect(refused(() => requestRelease(remote(), body, T))).toBe('400 BAD_REQUEST')
  })
})

describe('release: signing', () => {
  test('the first try goes on disk as sending; tries at the same nonce are added; another nonce is refused until settled', () => {
    const acc = opened()
    beforeSign(acc, signing(), T)
    expect(acc.release).toMatchObject({ state: 'sending', sending: { nonceKey: '0', nonce: '7', fromBlock: '1000', tries: [{ userOpHash: UOP, amount: AMOUNT.toString() }] } })
    beforeSign(acc, signing(), T)
    beforeSign(acc, signing({ userOpHash: UOP2, amount: AMOUNT - 1n }), T)
    expect(acc.release!.sending!.tries.map((t) => t.userOpHash)).toEqual([UOP, UOP2])
    expect(() => beforeSign(acc, signing({ userOpHash: `0x${'99'.repeat(32)}`, nonce: 8n }), T)).toThrow('not settled yet')
    // Still read by the engine while sending: nothing else is placed, and a try never sent is replaced at the same nonce.
    expect(releaseObs(acc)).toEqual({ amount: AMOUNT, chainId: 8453 as never })
  })

  test('an unsigned try is dropped; with none left the request is open again', () => {
    const acc = opened()
    beforeSign(acc, signing(), T)
    beforeSign(acc, signing({ userOpHash: UOP2 }), T)
    expect(unsigned(acc, `0x${'00'.repeat(32)}`, T)).toBe(false)
    expect(unsigned(acc, UOP, T)).toBe(true)
    expect(acc.release!.state).toBe('sending')
    expect(unsigned(acc, UOP2, T)).toBe(true)
    expect(acc.release).toMatchObject({ state: 'open' })
    expect(acc.release!.sending).toBeUndefined()
  })

  test('a burn that is not the request is never signed: no request, wrong chain, domain or recipient, more than asked', () => {
    expect(() => beforeSign(remote(), signing(), T)).toThrow('without an open release')
    const acc = opened()
    expect(() => beforeSign(acc, signing({ chainId: 143 }), T)).toThrow("not this Safe's home")
    expect(() => beforeSign(acc, signing({ destinationDomain: 15 }), T)).toThrow("not this Safe's home")
    expect(() => beforeSign(acc, signing({ recipient: SAFE }), T)).toThrow("not this Safe's home")
    expect(() => beforeSign(acc, signing({ amount: AMOUNT + 1n }), T)).toThrow('more than')
    expect(() => beforeSign(acc, signing({ amount: 0n }), T)).toThrow('more than')
    acc.release!.state = 'cancelled'
    expect(() => beforeSign(acc, signing(), T)).toThrow('without an open release')
  })
})

// ---- settle against a fake chain ----

const EP = address('EntryPointV07', REG)
const u = (v: bigint | number, n: number) => pad(toHex(v), { size: n })
const userOpEvent = parseAbiItem('event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)')
const beforeExecution = parseAbiItem('event BeforeExecution()')
const log = (addr: Hex, topics: Hex[], data: Hex, logIndex: number): Log => ({ address: addr, topics: topics as [Hex, ...Hex[]], data, logIndex, blockNumber: 1_010n, blockHash: zeroHash, transactionHash: TX, transactionIndex: 0, removed: false }) as Log

/** The handleOps receipt of a release burn: BeforeExecution, MessageSent, DepositForBurn (V4 to the home, domain 6), UserOperationEvent. */
function receiptLogs(o: { amount?: bigint; recipient?: Hex; depositor?: Hex } = {}): Log[] {
  const amount = o.amount ?? AMOUNT
  const usdc = address('USDC', REG)
  const message = concat([
    u(1, 4), u(15, 4), u(6, 4), u(0n, 32), pad(TOKEN_MESSENGER_V2, { size: 32 }), pad(TOKEN_MESSENGER_V2, { size: 32 }), u(0, 32), u(2000, 4), u(0, 4),
    u(1, 4), pad(usdc, { size: 32 }), pad(o.recipient ?? HOME, { size: 32 }), u(amount, 32), pad(o.depositor ?? V4, { size: 32 }), u(0, 32), u(0, 32), u(0, 32),
  ])
  const dfb = encodeEventTopics({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', args: { burnToken: usdc, depositor: o.depositor ?? V4, minFinalityThreshold: 2000 } }) as Hex[]
  const dfbData = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
    [amount, pad(o.recipient ?? HOME, { size: 32 }), 6, pad(TOKEN_MESSENGER_V2, { size: 32 }), zeroHash, 0n, '0x'],
  )
  return [
    log(EP, encodeEventTopics({ abi: [beforeExecution], eventName: 'BeforeExecution' }) as Hex[], '0x', 0),
    log(MESSAGE_TRANSMITTER_V2, encodeEventTopics({ abi: messageTransmitterV2Abi, eventName: 'MessageSent' }) as Hex[], encodeAbiParameters([{ type: 'bytes' }], [message]), 1),
    log(TOKEN_MESSENGER_V2, dfb, dfbData, 2),
    log(EP, encodeEventTopics({ abi: [userOpEvent], eventName: 'UserOperationEvent', args: { userOpHash: UOP, sender: SAFE, paymaster: '0x0000000000000000000000000000000000000000' } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [7n, true, 1n, 1n]), 3),
  ]
}

/** `nonce` at safe; `landed`: the try whose UserOperationEvent is on chain, with its outcome and receipt. */
function chain(o: { safe?: bigint; nonce: bigint; landed?: { hash: Hex; success?: boolean; logs?: Log[]; sender?: Hex; eventNonce?: bigint } }): SettleChain & { ranges: [bigint, bigint][] } {
  const ranges: [bigint, bigint][] = []
  return {
    ranges,
    getBlock: async () => ({ number: o.safe ?? 1_020n }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getNonce') return o.nonce
      throw new Error(functionName)
    },
    getLogs: async ({ args, fromBlock, toBlock }: { args: { userOpHash: Hex }; fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock])
      const l = o.landed
      if (!l || l.hash !== args.userOpHash || 1_010n < fromBlock || 1_010n > toBlock) return []
      return [{ args: { userOpHash: l.hash, sender: l.sender ?? SAFE, nonce: l.eventNonce ?? 7n, success: l.success ?? true }, blockNumber: 1_010n, transactionHash: TX, logIndex: 3 }]
    },
    getTransactionReceipt: async () => ({ logs: o.landed?.logs ?? receiptLogs() }),
  } as unknown as SettleChain & { ranges: [bigint, bigint][] }
}

const sending = (tries: Hex[] = [UOP]) => {
  const acc = opened()
  for (const h of tries) beforeSign(acc, signing({ userOpHash: h }), T)
  return acc
}

describe('release: settled by the chain', () => {
  test('nonce unused at safe: still sending, no log read', async () => {
    const acc = sending()
    const c = chain({ nonce: 7n })
    expect(await settle(acc, c, REG, T)).toBe(false)
    expect(acc.release!.state).toBe('sending')
    expect(c.ranges).toHaveLength(0)
  })

  test('nonce used and one of its tries landed with exactly its burn: burned with tx, block and that try amount', async () => {
    const acc = sending([UOP, UOP2])
    expect(await settle(acc, chain({ nonce: 8n, landed: { hash: UOP } }), REG, T)).toBe(true)
    expect(releaseView(acc)).toEqual({ id: 'r1', amount: AMOUNT.toString(), chainId: 8453, state: 'burned', burn: { amount: AMOUNT.toString(), txHash: TX, block: 1010 } })
    expect(acc.release!.sending).toBeUndefined()
    expect(releaseObs(acc)).toBeUndefined()
  })

  test('nonce used by another op, none of the tries on chain: open again (it can never land)', async () => {
    const acc = sending([UOP, UOP2])
    expect(await settle(acc, chain({ nonce: 8n }), REG, T)).toBe(true)
    expect(acc.release).toMatchObject({ state: 'open' })
    expect(acc.release!.sending).toBeUndefined()
  })

  test('its try reverted: open again, nothing burned', async () => {
    const acc = sending()
    expect(await settle(acc, chain({ nonce: 8n, landed: { hash: UOP, success: false } }), REG, T)).toBe(true)
    expect(acc.release!.state).toBe('open')
  })

  test('landed but not exactly its burn (other recipient, depositor or amount), or an event of another sender: throws, stays sending', async () => {
    for (const logs of [receiptLogs({ recipient: SAFE }), receiptLogs({ depositor: SAFE }), receiptLogs({ amount: AMOUNT - 1n })]) {
      const acc = sending()
      await expect(settle(acc, chain({ nonce: 8n, landed: { hash: UOP, logs } }), REG, T)).rejects.toThrow('without exactly its burn')
      expect(acc.release!.state).toBe('sending')
    }
    const acc = sending()
    await expect(settle(acc, chain({ nonce: 8n, landed: { hash: UOP, sender: HOME } }), REG, T)).rejects.toThrow('UserOperationEvent of')
  })

  test('nonce used at the head (landed or taken, not settled at safe yet): the engine is not told of the request', async () => {
    const read = (n: bigint) => ({ readContract: async () => n }) as never
    expect(await nonceUsedAtHead(opened(), read(9n), REG)).toBe(false)
    expect(await nonceUsedAtHead(sending(), read(7n), REG)).toBe(false)
    expect(await nonceUsedAtHead(sending(), read(8n), REG)).toBe(true)
  })
})
