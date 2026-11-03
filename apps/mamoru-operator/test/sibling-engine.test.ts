// otto/mamoru#309 (c): the sibling's engine on Ethereum, its edges. The happy path (wrap + swap under V4, then the burn
// home as a CCTP route) ran on a fork in e2e-ethereum-sibling.ts against T7 (deleted with T7, #348; an A1 fork E2E comes with the operator's A1 batch shape); here, on a fake chain: what is never sent, what an
// op that may or may not have run becomes, the day's limit on failed ops, and the burn's checks before a route exists.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, encodeAbiParameters, encodeEventTopics, pad, parseAbi, toHex, TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { address, ethereumRegistry } from '@mamoru/registry'
import { oneAuthV4Deployment } from '@mamoru/policy'
import { BridgeOut, L1_USDC, SIBLING_IDLE_MS, SIBLING_LEG_FAILS, SIBLING_LEG_RETRY_MS, UNCONFIRMED_GIVEUP_MS, type SiblingLeg, type StoredSibling } from '../src/bridge-out.ts'
import { MESSAGE_TRANSMITTER_V2, TOKEN_MESSENGER_V2 } from '../src/cctp.ts'
import { pinTestA1 } from './v4-pin.ts'

const SAFE = '0x0000000000000000000000000000000000000aaa' as const
const TX = `0x${'ab'.repeat(32)}` as Hex
const OTHER_TX = `0x${'cd'.repeat(32)}` as Hex
const T0 = Date.parse('2026-11-05T20:00:00Z')
const EP = address('EntryPointV07', ethereumRegistry)
// #348: A1 is undeployed on Ethereum; a test A1 stack is pinned in memory for these tests.
const unpin = pinTestA1(ethereumRegistry)
afterAll(unpin)
const V4 = oneAuthV4Deployment(ethereumRegistry)!.policy
const epAbi = parseAbi(['event BeforeExecution()', 'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)'])
const v4Abi = parseAbi(['event Bridged(address indexed account, uint32 indexed domain, address indexed recipient, address token, uint256 amount)'])
const mtAbi = parseAbi(['event MessageSent(bytes message)'])

/** A CCTP v2 message Ethereum -> Base burning `amount` of USDC for `recipient`, burned by `burner`. */
function cctpMessage(amount: bigint, recipient: `0x${string}`, burner: `0x${string}`): Hex {
  const w = (a: `0x${string}`) => pad(a, { size: 32 })
  const u = (v: bigint | number, size: number) => toHex(v, { size })
  const header = concat([u(1, 4), u(0, 4), u(6, 4), u(0, 32), w(TOKEN_MESSENGER_V2), w(TOKEN_MESSENGER_V2), u(0, 32), u(2000, 4), u(0, 4)])
  const body = concat([u(1, 4), w(L1_USDC), w(recipient), u(amount, 32), w(burner), u(0, 32), u(0, 32), u(0, 32)])
  return concat([header, body])
}

type Fake = {
  eth: bigint
  usdc: bigint
  ready: boolean
  paused: boolean
  nonce: bigint
  baseFee: bigint
  /** What the relayer's send does: lands the op (with these logs), throws before signing, or throws after signing. */
  send: 'lands' | 'refusedBeforeSign' | 'throwsAfterSign'
  opSuccess: boolean
  burn: 'good' | 'wrongRecipient' | 'none'
  receipt: 'none' | 'ours' | 'withoutOp'
  pending: boolean
  /** An op with the leg's nonce ran elsewhere: its UserOperationEvent in the logs. */
  ranElsewhere: boolean
  /** WETH held, and V4's room (USD units) for a swap. */
  weth?: bigint
  room?: bigint
}

function make(fake: Fake, now: () => number, leg?: Partial<SiblingLeg>, extra: Partial<StoredSibling> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mamoru-sib-engine-'))
  const c: StoredSibling = { id: 'p', safe: SAFE, safeNonce: '0', safeTxHash: `0x${'11'.repeat(32)}`, permissionId: `0x${'22'.repeat(32)}`, sessionKey: '0x0000000000000000000000000000000000000bbb', capUsdc: '1', fromBlock: '1', state: 'done', at: new Date(T0).toISOString(), ...extra }
  if (leg) c.leg = { kind: 'bridge', userOpHash: `0x${'33'.repeat(32)}`, nonce: '0', nonceFrom: '90', amount: '5000000', state: 'unconfirmed', at: new Date(T0).toISOString(), ...leg }
  writeFileSync(join(dir, 'bridge-out.json'), JSON.stringify({ routes: {}, spent: { day: '', wei: '0' }, moves: {}, siblings: { k: c } }))
  writeFileSync(join(dir, 'ethereum-sibling-keys.json'), JSON.stringify({ k: generatePrivateKey() }), { mode: 0o600 })
  const sent: Hex[] = []
  /** The receipt of a bundle that ran op `hash` with the chain's outcome. */
  const receiptOf = (hash: Hex, tx: Hex) => {
    const amount = fake.usdc
    const burnLogs =
      fake.burn === 'none' || !fake.opSuccess
        ? []
        : [
            { address: V4, topics: encodeEventTopics({ abi: v4Abi, eventName: 'Bridged', args: { account: SAFE, domain: 6, recipient: fake.burn === 'good' ? SAFE : '0x0000000000000000000000000000000000000bad' } }), data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [L1_USDC, amount]) },
            { address: MESSAGE_TRANSMITTER_V2, topics: encodeEventTopics({ abi: mtAbi, eventName: 'MessageSent' }), data: encodeAbiParameters([{ type: 'bytes' }], [cctpMessage(amount, SAFE, V4)]) },
          ]
    return {
      status: 'success',
      transactionHash: tx,
      gasUsed: 400_000n,
      effectiveGasPrice: 1_000_000_000n,
      logs: [
        { address: EP, topics: encodeEventTopics({ abi: epAbi, eventName: 'BeforeExecution' }), data: '0x' },
        ...burnLogs,
        { address: EP, topics: encodeEventTopics({ abi: epAbi, eventName: 'UserOperationEvent', args: { userOpHash: hash, sender: SAFE, paymaster: '0x0000000000000000000000000000000000000000' } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [fake.nonce, fake.opSuccess, 390_000_000_000_000n, 390_000n]) },
      ],
    }
  }
  let lastHash: Hex | undefined
  const l1 = {
    getBlockNumber: async () => 200n,
    getBlock: async () => ({ number: 100n, timestamp: BigInt(Math.floor(now() / 1000)), baseFeePerGas: fake.baseFee }),
    getGasPrice: async () => fake.baseFee,
    getBalance: async () => fake.eth,
    call: async () => ({ data: '0x' }),
    // QuoterV2 at 2,500 USD per ETH
    simulateContract: async ({ args }: { args: [{ amountIn: bigint }] }) => ({ result: [(args[0].amountIn * 2_500n * 10n ** 6n) / 10n ** 18n] }),
    readContract: async ({ functionName, address: at, args }: { functionName: string; address: string; args?: readonly unknown[] }) => {
      if (functionName === 'balanceOf' && at.toLowerCase() === EP.toLowerCase()) return 0n
      if (functionName === 'balanceOf') return at.toLowerCase() === L1_USDC.toLowerCase() ? fake.usdc : (fake.weth ?? 0n)
      // A1: MamoruV4Helper.priced is V4's eligibility check; it gives the pool, its class entry and the sub-bucket key (WETH)
      if (functionName === 'priced') return [{ token0: L1_USDC, token1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', fee: 500, in1: false, stablePair: false }, { twapWindow: 720, twapShortWindow: 180, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 10_000, active: true }, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2']
      if (functionName === 'budgetLeft') return [fake.room ?? 10n ** 12n, 10n ** 12n, 10n ** 12n, 10n ** 12n]
      if (functionName === 'swapBoundsAt') return [1n, 0n]
      // V4 values WETH at its band's edge: 4% above the quote here
      if (functionName === 'swapValue') return (args![4] as bigint) * 2_600n * 10n ** 6n / 10n ** 18n
      if (functionName === 'latestRoundData') return [0n, 2_500n * 10n ** 8n, 0n, BigInt(Math.floor(now() / 1000)), 0n]
      if (functionName === 'isReady') return fake.ready
      if (functionName === 'isPaused') throw new Error('V4 has no pause (A1): never read')
      if (functionName === 'getNonce') return fake.nonce
      throw new Error(functionName)
    },
    getLogs: async () => (fake.ranElsewhere ? [{ args: { nonce: 0n, userOpHash: `0x${'44'.repeat(32)}` }, transactionHash: OTHER_TX }] : []),
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (fake.pending) return { hash }
      throw new TransactionNotFoundError({ hash })
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash === OTHER_TX) return receiptOf(`0x${'44'.repeat(32)}`, OTHER_TX)
      if (fake.receipt === 'none') throw new TransactionReceiptNotFoundError({ hash })
      const r = receiptOf(lastHash ?? `0x${'33'.repeat(32)}`, hash)
      return fake.receipt === 'ours' ? r : { ...r, logs: [] }
    },
  }
  const relayer = {
    address: '0x0000000000000000000000000000000000000001' as const,
    send: async (tx: { data?: Hex }, onSent?: (h: Hex) => void, _s?: unknown, onSigned?: (h: Hex, n: number) => void) => {
      if (fake.send === 'refusedBeforeSign') throw new Error('nonce too low')
      sent.push(tx.data!)
      onSigned?.(TX, 0)
      if (fake.send === 'throwsAfterSign') throw new Error('accepted, then the call timed out')
      onSent?.(TX)
      const j = JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8'))
      lastHash = j.siblings.k.leg.userOpHash
      fake.nonce += 1n
      return { hash: TX, receipt: receiptOf(lastHash!, TX) as never }
    },
  }
  const bo = new BridgeOut(l1 as never, relayer, dir, fetch, now, undefined, () => true)
  const journal = () => JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8')) as { siblings: { k: StoredSibling }; routes: Record<string, { state: string; amountUsdc: string; cctp?: { sender?: string; message?: Hex } }>; spent: { wei: string } }
  return { bo, sent, journal }
}

const ready: Fake = { eth: 10n ** 16n, usdc: 5_000_000n, ready: true, paused: false, nonce: 0n, baseFee: 1_000_000_000n, send: 'lands', opSuccess: true, burn: 'good', receipt: 'ours', pending: false, ranElsewhere: false }

describe('the sibling engine (#309 c)', () => {
  test('ready on Base with USDC: one bridge op, and its burn becomes the CCTP route (V4 the burner)', async () => {
    const m = make({ ...ready }, () => T0)
    await m.bo.tick()
    const j = m.journal()
    expect(m.sent.length).toBe(1)
    expect(j.siblings.k.leg?.kind).toBe('bridge')
    expect(j.siblings.k.leg?.state).toBe('done')
    expect(j.routes.k?.state).toBe('deposited')
    expect(j.routes.k?.amountUsdc).toBe('5000000')
    expect(j.routes.k?.cctp?.sender?.toLowerCase()).toBe(V4.toLowerCase())
    // the day is charged the relayer's NET cost: the EntryPoint paid it back (400k at 1 gwei, 0.00039 ETH back)
    expect(BigInt(j.spent.wei)).toBe(400_000n * 1_000_000_000n - 390_000_000_000_000n)
  })

  test('a burn whose recipient is not the account itself: no route (alerted)', async () => {
    const m = make({ ...ready, burn: 'wrongRecipient' }, () => T0)
    await m.bo.tick()
    expect(m.journal().routes.k).toBeUndefined()
  })

  test('not ready, no ETH beyond the reserve: nothing signed (A1 has no pause: V4 is never asked for one)', async () => {
    const a = make({ ...ready, ready: false, eth: 10n ** 15n }, () => T0)
    await a.bo.tick()
    expect(a.sent).toEqual([])
    expect(a.journal().siblings.k.leg).toBeUndefined()
  })

  test('gas above the caps: nothing signed', async () => {
    const m = make({ ...ready, baseFee: 6_000_000_000n }, () => T0)
    await m.bo.tick()
    expect(m.sent).toEqual([])
    expect(m.journal().siblings.k.leg).toBeUndefined()
  })

  test('refused before a transaction was signed: the op is dropped (it never left), no failure counted', async () => {
    const m = make({ ...ready, send: 'refusedBeforeSign' }, () => T0)
    await m.bo.tick()
    const s = m.journal().siblings.k
    expect(s.leg).toBeUndefined()
    expect(s.legFails).toBeUndefined()
  })

  test('signed then the call failed: unconfirmed; the op that ran with its nonce settles it, from its logs', async () => {
    const fake: Fake = { ...ready, send: 'throwsAfterSign', receipt: 'none' }
    let now = T0
    const m = make(fake, () => now)
    await m.bo.tick()
    expect(m.journal().siblings.k.leg?.state).toBe('unconfirmed')
    // a copy of it (or an earlier op with that nonce) ran in another bundle
    fake.nonce = 1n
    fake.ranElsewhere = true
    now += 60_000
    await m.bo.tick()
    expect(m.journal().siblings.k.leg?.state).toBe('done')
    expect(m.journal().routes.k?.state).toBe('deposited')
  })

  test('dropped (nonce unspent, not pending): failed only after the give-up, then retried only after the retry wait', async () => {
    const fake: Fake = { ...ready, receipt: 'none' }
    let now = T0
    const m = make(fake, () => now, { l1Tx: TX })
    await m.bo.tick()
    expect(m.journal().siblings.k.leg?.state).toBe('unconfirmed')
    now += UNCONFIRMED_GIVEUP_MS + 1
    await m.bo.tick()
    expect(m.journal().siblings.k.leg?.state).toBe('failed')
    expect(m.journal().siblings.k.legFails?.n).toBe(1)
    now += SIBLING_IDLE_MS + 1
    await m.bo.tick()
    expect(m.sent).toEqual([])
    now += SIBLING_LEG_RETRY_MS
    fake.receipt = 'ours'
    await m.bo.tick()
    expect(m.sent.length).toBe(1)
  })

  test('still pending in the mempool: never failed by the clock', async () => {
    const m = make({ ...ready, receipt: 'none', pending: true }, () => T0 + UNCONFIRMED_GIVEUP_MS * 4, { l1Tx: TX })
    await m.bo.tick()
    expect(m.journal().siblings.k.leg?.state).toBe('unconfirmed')
  })

  test("a reverted op is failed; SIBLING_LEG_FAILS of them stop the engine for the day", async () => {
    let now = T0
    const m = make({ ...ready, opSuccess: false }, () => now)
    for (let i = 0; i < SIBLING_LEG_FAILS; i++) {
      await m.bo.tick()
      now += SIBLING_LEG_RETRY_MS + 1
    }
    expect(m.sent.length).toBe(SIBLING_LEG_FAILS)
    expect(m.journal().siblings.k.legFails?.n).toBe(SIBLING_LEG_FAILS)
    await m.bo.tick()
    expect(m.sent.length).toBe(SIBLING_LEG_FAILS)
  })

  test('its move to Base not minted yet: the engine waits', async () => {
    let now = T0
    const fake = { ...ready }
    const m = make(fake, () => now)
    await m.bo.tick()
    expect(m.journal().routes.k?.state).toBe('deposited')
    fake.usdc = 7_000_000n
    now += SIBLING_IDLE_MS + 1
    await m.bo.tick()
    expect(m.sent.length).toBe(1)
  })

  test("review r1 of #238: a swap is sized to V4's room (never a revert nor its breaker)", async () => {
    const m = make({ ...ready, ready: false, usdc: 0n, eth: 10n ** 17n, room: 50_000_000n }, () => T0)
    await m.bo.tick()
    const leg = m.journal().siblings.k.leg
    expect(leg?.kind).toBe('swap')
    // sized by V4's own valuation ($2,600 an ETH here, 4% above the quote), not the quote: within the $50 room
    const a = BigInt(leg!.amount)
    expect((a * 2_600n * 10n ** 6n) / 10n ** 18n).toBeLessThanOrEqual(50_000_000n)
    expect(a).toBeGreaterThan(18_000_000_000_000_000n)
  })

  test('review r1 of #238: the reserve covers the bridge at the highest fee a sibling op pays', async () => {
    const m = make({ ...ready, ready: false, usdc: 0n, eth: 10n ** 17n }, () => T0)
    await m.bo.tick()
    const leg = m.journal().siblings.k.leg!
    const swapGas = 600_000n + 1_300_000n + 80_000n
    const bridgeGas = 600_000n + 450_000n + 80_000n
    expect(BigInt(leg.amount)).toBe(10n ** 17n - swapGas * (2n * 1_000_000_000n + 100_000_000n) - bridgeGas * 3_000_000_000n)
  })

  test('review r1 of #238: a send refused before signing gives the day its bound back and keeps the previous leg', async () => {
    const prevLeg = { state: 'failed' as const, l1Tx: OTHER_TX }
    const m = make({ ...ready, send: 'refusedBeforeSign' }, () => T0 + SIBLING_LEG_RETRY_MS * 2, prevLeg, { legAt: new Date(T0).toISOString() })
    await m.bo.tick()
    const j = m.journal()
    expect(BigInt(j.spent.wei)).toBe(0n)
    expect(j.siblings.k.leg?.l1Tx).toBe(OTHER_TX)
  })

  test('review r1 of #238: the nonce spent and its op not found yet: nothing new is signed, the search goes on from where it stopped', async () => {
    const m = make({ ...ready, nonce: 1n }, () => T0, undefined, { opNonce: { nonce: '0', from: '90', scan: '90' } })
    await m.bo.tick()
    const j = m.journal()
    expect(m.sent).toEqual([])
    expect(j.siblings.k.opNonce?.scan).toBe('90') // searched up to the head (200) less SIBLING_SCAN_LAG: next pass starts again from the first block
    expect(j.siblings.k.leg?.state).toBeUndefined()
  })

  test('review r1 of #238: an old op of the outstanding nonce that ran late is settled before anything new (its burn minted)', async () => {
    const m = make({ ...ready, nonce: 1n, ranElsewhere: true }, () => T0 + SIBLING_LEG_RETRY_MS * 2, { state: 'failed' }, { legAt: new Date(T0).toISOString(), opNonce: { nonce: '0', from: '90', scan: '90' } })
    await m.bo.tick()
    const j = m.journal()
    expect(m.sent).toEqual([])
    expect(j.routes.k?.state).toBe('deposited')
    expect(j.siblings.k.opNonce).toBeUndefined()
  })

  test('review r2 of #238: a leg written before the nonce ledger is still recovered when its nonce is spent', async () => {
    const m = make({ ...ready, nonce: 1n, ranElsewhere: true, receipt: 'none' }, () => T0, { state: 'unconfirmed', l1Tx: TX })
    await m.bo.tick()
    const j = m.journal()
    expect(j.routes.k?.state).toBe('deposited')
    expect(j.siblings.k.leg?.state).toBe('done')
  })
})

