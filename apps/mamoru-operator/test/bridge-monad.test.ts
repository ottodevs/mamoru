// otto/mamoru#215: the bridge leg's journal, its settlement from Base, the mint relay on Monad and the remote value.
// Every client here is a mock: no RPC, no key, no transaction. Iris is a mocked fetch.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, encodeAbiParameters, encodeEventTopics, keccak256, pad, parseAbiItem, toHex, zeroHash, type Hex, type Log, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { address, baseRegistry, entry, messageTransmitterV2Abi, monadRegistry, tokenMessengerV2Abi } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import { afterAll } from 'bun:test'
import { BASE_USDC, burnOf, inFlightOf, MONAD_MINT_PENDING_MS, MonadBridge, SETTLE_CHUNKS_PER_TICK, SETTLE_LOG_CHUNK, sleeveValueAtTwap, type BridgeBurn, type MonadSender } from '../src/bridge-monad.ts'
import { Relayer } from '../src/relayer.ts'
import { cctpMessageKey, MESSAGE_TRANSMITTER_V2, TOKEN_MESSENGER_V2 } from '../src/cctp.ts'
import type { SafeRead } from '../src/chain.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
const OTHER = '0x00000000000000000000000000000000000000cc' as const
const AMOUNT = 1_500_000_000n
const UOP = `0x${'11'.repeat(32)}` as Hex
const BURN_TX = `0x${'22'.repeat(32)}` as Hex
const T0 = Date.parse('2026-10-27T10:00:00Z')
const EP = address('EntryPointV07', baseRegistry)

const signing = (over: Partial<BridgeSigning> = {}): BridgeSigning => ({
  opId: 'op-1', account: ACCOUNT, chainId: 143, pool: 'pool:WMON/USDC/3000', bucket: 'growth', amount: AMOUNT, destinationDomain: 15,
  userOpHash: UOP, nonceKey: 0n, nonce: 7n, prepareBlock: 1_000n, ...over,
})

const u = (v: bigint | number, n: number) => pad(toHex(v), { size: n })
/** A CCTP V2 message of a Base -> Monad burn of this account; `nonce` 0 and zeroed executed fields as MessageSent has it. */
const message = (o: { nonce?: bigint; amount?: bigint; recipient?: Hex; source?: number; destination?: number; executed?: boolean } = {}): Hex =>
  concat([
    u(1, 4), u(o.source ?? 6, 4), u(o.destination ?? 15, 4), u(o.nonce ?? 0n, 32), pad(TOKEN_MESSENGER_V2, { size: 32 }), pad(TOKEN_MESSENGER_V2, { size: 32 }), u(0, 32), u(2000, 4), u(o.executed ? 2000 : 0, 4),
    u(1, 4), pad(BASE_USDC, { size: 32 }), pad(o.recipient ?? ACCOUNT, { size: 32 }), u(o.amount ?? AMOUNT, 32), pad(o.recipient ?? ACCOUNT, { size: 32 }), u(0, 32), u(0, 32), u(o.executed ? 99 : 0, 32),
  ])

const log = (addr: Hex, topics: Hex[], data: Hex, logIndex: number): Log => ({ address: addr, topics: topics as [Hex, ...Hex[]], data, logIndex, blockNumber: 1_010n, blockHash: zeroHash, transactionHash: BURN_TX, transactionIndex: 0, removed: false }) as Log
const userOpEvent = parseAbiItem('event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)')
const beforeExecution = parseAbiItem('event BeforeExecution()')

/** The handleOps receipt logs of the burn userOp: BeforeExecution, MessageSent, DepositForBurn, UserOperationEvent. */
function burnReceiptLogs(o: { recipient?: Hex; amount?: bigint; success?: boolean } = {}): Log[] {
  const dfb = encodeEventTopics({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', args: { burnToken: BASE_USDC, depositor: ACCOUNT, minFinalityThreshold: 2000 } }) as Hex[]
  const dfbData = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
    [o.amount ?? AMOUNT, pad(o.recipient ?? ACCOUNT, { size: 32 }), 15, pad(TOKEN_MESSENGER_V2, { size: 32 }), zeroHash, 0n, '0x'],
  )
  const sent = encodeEventTopics({ abi: messageTransmitterV2Abi, eventName: 'MessageSent' }) as Hex[]
  const uoe = encodeEventTopics({ abi: [userOpEvent], eventName: 'UserOperationEvent', args: { userOpHash: UOP, sender: ACCOUNT, paymaster: '0x0000000000000000000000000000000000000000' } }) as Hex[]
  return [
    log(EP, encodeEventTopics({ abi: [beforeExecution], eventName: 'BeforeExecution' }) as Hex[], '0x', 0),
    log(MESSAGE_TRANSMITTER_V2, sent, encodeAbiParameters([{ type: 'bytes' }], [message({ recipient: o.recipient, amount: o.amount })]), 1),
    log(TOKEN_MESSENGER_V2, dfb, dfbData, 2),
    log(EP, uoe, encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [7n, o.success ?? true, 1n, 1n]), 3),
  ]
}

/**
 * Base: the safe head, the UserOperationEvent of the burn (or none, only inside the range asked) and the EntryPoint
 * nonce at a block: 8 from the block the burn landed in (inclusion spends it), else `nonceAtSafe` or 7. `ranges`
 * records every getLogs range.
 */
function baseClient(o: { safe: bigint; landed?: { block: bigint; success?: boolean; recipient?: Hex; amount?: bigint }; nonceAtSafe?: bigint; ranges?: [bigint, bigint][] }): PublicClient {
  return {
    getBlock: async () => ({ number: o.safe }),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      o.ranges?.push([fromBlock, toBlock])
      return o.landed && o.landed.block >= fromBlock && o.landed.block <= toBlock ? [{ args: { userOpHash: UOP, sender: ACCOUNT, nonce: 7n, success: o.landed.success ?? true, actualGasCost: 1n }, blockNumber: o.landed.block, blockHash: zeroHash, transactionHash: BURN_TX, logIndex: 3 }] : []
    },
    getTransactionReceipt: async () => ({ logs: burnReceiptLogs(o.landed ?? {}) }),
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      if (functionName === 'getNonce') return o.landed && (blockNumber ?? o.safe) >= o.landed.block ? 8n : (o.nonceAtSafe ?? 7n)
      throw new Error(functionName)
    },
  } as unknown as PublicClient
}

const attester = privateKeyToAccount(generatePrivateKey())
const attest = async (m: Hex) => ({ message: m, attestation: await attester.sign({ hash: keccak256(m) }) })

/** `usedFrom`: the Monad block the used nonces are used from (a read at an earlier block sees them unused). `mintStatus`: how the relayer's mints end. */
type MonadState = { used: Set<string>; usedFrom?: bigint; block: bigint; balance: bigint; gasPrice: bigint; receipts: Map<string, { status: 'success' | 'reverted'; blockNumber: bigint }>; mintStatus?: 'success' | 'reverted' }
function monadClient(st: MonadState): PublicClient {
  return {
    getBlockNumber: async () => st.block,
    getGasPrice: async () => st.gasPrice,
    getBalance: async () => st.balance,
    estimateGas: async () => 150_000n,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => st.receipts.get(hash) ?? null,
    readContract: async ({ functionName, args, blockNumber }: { functionName: string; args?: unknown[]; blockNumber?: bigint }) => {
      if (functionName === 'signatureThreshold') return 1n
      if (functionName === 'isEnabledAttester') return (args![0] as string).toLowerCase() === attester.address.toLowerCase()
      if (functionName === 'usedNonces') return st.used.has((args![0] as string).toLowerCase()) && (blockNumber ?? st.block) >= (st.usedFrom ?? 0n) ? 1n : 0n
      throw new Error(functionName)
    },
  } as unknown as PublicClient
}

function relayerMock(st: MonadState, onSend?: () => void): MonadSender & { sent: Hex[] } {
  const sent: Hex[] = []
  let n = 0
  return {
    address: '0x0000000000000000000000000000000000000002',
    sent,
    send: async (tx, _onSent, onSending, onSigned) => {
      const hash = u(++n, 32)
      onSending?.(150_000n * 200_000_000_000n, { hash, nonce: n, maxFeePerGas: 200_000_000_000n })
      onSigned?.(hash, n)
      sent.push(tx.data!)
      onSend?.()
      const status = st.mintStatus ?? 'success'
      st.receipts.set(hash, { status, blockNumber: st.block + 1n })
      return { hash, receipt: { status, blockNumber: st.block + 1n, gasUsed: 150_000n, effectiveGasPrice: 100_000_000_000n, logs: [] } as never }
    },
  }
}

function setup(o: { dir?: string; base?: PublicClient; monad?: MonadState; iris?: Record<string, { message: Hex; attestation: Hex }[]>; now?: () => number; relayer?: boolean; verify?: () => Promise<void> } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'mamoru-bridge-monad-'))
  const st: MonadState = o.monad ?? { used: new Set(), block: 5_000n, balance: 10n ** 18n, gasPrice: 100_000_000_000n, receipts: new Map() }
  const urls: string[] = []
  const fetcher = async (url: string) => {
    urls.push(url)
    const tx = new URL(url).searchParams.get('transactionHash')
    if (o.iris && tx && o.iris[tx]) return new Response(JSON.stringify({ messages: o.iris[tx]!.map((a) => ({ status: 'complete', ...a })) }))
    return new Response('{}', { status: 404 })
  }
  const relayer = o.relayer === false ? null : relayerMock(st)
  const bridge = new MonadBridge(dir, o.base ?? baseClient({ safe: 900n }), monadClient(st), relayer, fetcher as typeof fetch, o.now ?? (() => T0), baseRegistry, monadRegistry, o.verify)
  const j = () => JSON.parse(readFileSync(join(dir, 'bridge-monad.json'), 'utf8')) as { burns: Record<string, BridgeBurn> }
  return { dir, bridge, st, relayer, urls, j }
}

describe('the bridge journal (otto/mamoru#215)', () => {
  test('a burn is on disk (0600) as sending before signing, counts in flight, and survives a restart', () => {
    const { dir, bridge, j } = setup()
    bridge.recordSending('acc-1', signing())
    expect(j().burns[UOP]).toMatchObject({ state: 'sending', amount: AMOUNT.toString(), nonce: '7', fromBlock: '1000', accountKey: 'acc-1' })
    expect(statSync(join(dir, 'bridge-monad.json')).mode & 0o777).toBe(0o600)
    expect(bridge.inFlight('acc-1', 0n)).toBe(AMOUNT)
    expect(bridge.inFlight('acc-2', 0n)).toBe(0n)
    // A restart: the same file, a new process. The burn is still in flight, so no second bridge goes out.
    const again = setup({ dir })
    expect(again.bridge.inFlight('acc-1', 0n)).toBe(AMOUNT)
    // The same userOp journaled again is the same burn; another account or amount under its hash is refused.
    again.bridge.recordSending('acc-1', signing())
    expect(again.bridge.burns()).toHaveLength(1)
    expect(() => again.bridge.recordSending('acc-2', signing())).toThrow('already journaled')
  })

  test('only a burn to Monad is followed; anything else is refused before signing', () => {
    const { bridge } = setup()
    expect(() => bridge.recordSending('acc-1', signing({ chainId: 8453 }))).toThrow('only Monad')
    expect(() => bridge.recordSending('acc-1', signing({ destinationDomain: 0 }))).toThrow('only Monad')
    expect(bridge.burns()).toHaveLength(0)
  })

  test('a minted burn stays in flight against a sleeve read from before its mint', () => {
    const b = { accountKey: 'a', amount: '10', state: 'minted', mintedBlock: '100' } as BridgeBurn
    expect(inFlightOf([b], 'a', 99n)).toBe(10n)
    expect(inFlightOf([b], 'a', 100n)).toBe(0n)
    expect(inFlightOf([{ ...b, state: 'burned' }], 'a', 1_000n)).toBe(10n)
    expect(inFlightOf([{ ...b, state: 'failed' }, { ...b, state: 'dropped' }], 'a', 0n)).toBe(0n)
  })
})

describe('settling a sending burn from Base', () => {
  test('not landed and the nonce unmoved at safe: still in flight', async () => {
    const { bridge, j } = setup({ base: baseClient({ safe: 1_005n }) })
    bridge.recordSending('acc-1', signing())
    await bridge.tick()
    expect(j().burns[UOP]!.state).toBe('sending')
  })

  test('landed above safe: still in flight; at safe with exactly this burn: burned, with its message key', async () => {
    const above = setup({ base: baseClient({ safe: 1_005n, landed: { block: 1_010n } }) })
    above.bridge.recordSending('acc-1', signing())
    await above.bridge.tick()
    expect(above.j().burns[UOP]!.state).toBe('sending')
    const { bridge, j } = setup({ dir: above.dir, base: baseClient({ safe: 1_020n, landed: { block: 1_010n } }) })
    await bridge.tick()
    expect(j().burns[UOP]).toMatchObject({ state: 'burned', txHash: BURN_TX, burnBlock: '1010', messageKey: cctpMessageKey(message()) })
    expect(bridge.inFlight('acc-1', 0n)).toBe(AMOUNT)
  })

  test('reverted: failed, nothing in flight; nonce spent by another op: dropped', async () => {
    const r = setup({ base: baseClient({ safe: 1_020n, landed: { block: 1_010n, success: false } }) })
    r.bridge.recordSending('acc-1', signing())
    await r.bridge.tick()
    expect(r.j().burns[UOP]!.state).toBe('failed')
    expect(r.bridge.inFlight('acc-1', 0n)).toBe(0n)
    const d = setup({ base: baseClient({ safe: 1_020n, nonceAtSafe: 8n }) })
    d.bridge.recordSending('acc-1', signing())
    await d.bridge.tick()
    expect(d.j().burns[UOP]!.state).toBe('dropped')
  })

  test('landed with a burn to someone else: never marked burned, kept in flight', async () => {
    const { bridge, j } = setup({ base: baseClient({ safe: 1_020n, landed: { block: 1_010n, recipient: OTHER } }) })
    bridge.recordSending('acc-1', signing())
    await bridge.tick()
    expect(j().burns[UOP]!.state).toBe('sending')
    expect(bridge.inFlight('acc-1', 0n)).toBe(AMOUNT)
    expect(burnOf(burnReceiptLogs({ amount: AMOUNT - 1n }), { account: ACCOUNT, amount: AMOUNT.toString(), destinationDomain: 15 })).toBeNull()
  })
})

describe('the mint relay on Monad', () => {
  const burned = async (o: Parameters<typeof setup>[0] = {}) => {
    const s = setup({ ...o, base: baseClient({ safe: 1_020n, landed: { block: 1_010n } }) })
    s.bridge.recordSending('acc-1', signing())
    await s.bridge.tick()
    expect(s.j().burns[UOP]!.state).toBe('burned')
    return s
  }

  test('attestation pending: waits, polling politely, for source domain 6', async () => {
    let now = T0
    const s = await burned({ now: () => now, iris: {} })
    await s.bridge.tick()
    expect(s.urls).toHaveLength(0) // before the first poll delay
    now += 6 * 60_000
    await s.bridge.tick()
    await s.bridge.tick()
    expect(s.urls).toHaveLength(1) // once per ATTEST_POLL_MS
    expect(s.urls[0]).toContain(`/v2/messages/6?transactionHash=${BURN_TX}`)
    expect(s.j().burns[UOP]!.state).toBe('burned')
    expect(s.relayer!.sent).toHaveLength(0)
  })

  test('attested and valid: receiveMessage once, its hash on disk, then minted; in flight drops only past the mint block', async () => {
    let now = T0
    const att = await attest(message({ nonce: 42n, executed: true }))
    const s = await burned({ now: () => now, iris: { [BURN_TX]: [att] } })
    now += 6 * 60_000
    await s.bridge.tick()
    expect(s.relayer!.sent).toHaveLength(1)
    const b = s.j().burns[UOP]!
    expect(b).toMatchObject({ state: 'minted', cctpNonce: u(42n, 32), mintedBlock: '5001' })
    expect(b.mintTx).toBeDefined()
    expect(s.bridge.inFlight('acc-1', 5_000n)).toBe(AMOUNT)
    expect(s.bridge.inFlight('acc-1', 5_001n)).toBe(0n)
    now += 10 * 60_000
    await s.bridge.tick()
    expect(s.relayer!.sent).toHaveLength(1)
  })

  test('already used on Monad (anyone may mint): minted without a transaction', async () => {
    let now = T0
    const att = await attest(message({ nonce: 42n, executed: true }))
    const s = await burned({ now: () => now, iris: { [BURN_TX]: [att] } })
    s.st.used.add(u(42n, 32).toLowerCase())
    now += 6 * 60_000
    await s.bridge.tick()
    expect(s.relayer!.sent).toHaveLength(0)
    expect(s.j().burns[UOP]).toMatchObject({ state: 'minted', mintedBlock: '5000' })
  })

  test('an attestation for another recipient, another amount or another route, or not signed by Monad attesters: refused', async () => {
    const forger = privateKeyToAccount(generatePrivateKey())
    const forged = { message: message({ nonce: 42n, executed: true }), attestation: await forger.sign({ hash: keccak256(message({ nonce: 42n, executed: true })) }) }
    for (const atts of [
      [await attest(message({ nonce: 42n, recipient: OTHER, executed: true }))],
      [await attest(message({ nonce: 42n, amount: AMOUNT + 1n, executed: true }))],
      [await attest(message({ nonce: 42n, source: 0, executed: true }))],
      [await attest(message({ nonce: 42n, destination: 6, executed: true }))],
      [forged],
    ]) {
      let now = T0
      const s = await burned({ now: () => now, iris: { [BURN_TX]: atts } })
      now += 6 * 60_000
      await s.bridge.tick()
      expect(s.relayer!.sent).toHaveLength(0)
      expect(s.j().burns[UOP]!.state).toBe('burned')
    }
  })

  test('above the gas ceiling, or a relayer without MON: not sent, still in flight', async () => {
    for (const patch of [{ gasPrice: 600_000_000_000n }, { balance: 0n }]) {
      let now = T0
      const s = await burned({ now: () => now, iris: { [BURN_TX]: [await attest(message({ nonce: 42n, executed: true }))] } })
      Object.assign(s.st, patch)
      now += 6 * 60_000
      await s.bridge.tick()
      expect(s.relayer!.sent).toHaveLength(0)
      expect(s.bridge.inFlight('acc-1', 10_000n)).toBe(AMOUNT)
    }
  })
})

describe('the remote value of a v6 account', () => {
  const POOL = 'pool:WMON/USDC/3000'
  const TICK = -300_000
  const WINDOW = 1_800

  /** Monad: observe answers a TWAP of TICK for the WMON pool; slot0 (in the read) is somewhere else entirely. */
  const observeClient = (fail = false) =>
    ({
      readContract: async ({ functionName, address: a }: { functionName: string; address: Hex }) => {
        if (functionName !== 'observe' || fail) throw new Error('no observe')
        expect(a.toLowerCase()).toBe(entry(POOL, monadRegistry).address.toLowerCase())
        return [[0n, BigInt(TICK * WINDOW)], [0n, 0n]]
      },
    }) as unknown as PublicClient

  const read = (o: Partial<SafeRead> = {}): SafeRead => ({
    block: 7_000n, deployed: true, eth: 10n ** 18n, usdc: 5_000_000n, sqrtPriceX96: sqrtRatioAtTick(-200_000), tick: -200_000,
    tokens: { USDC: 5_000_000n, WMON: 10n ** 20n, EURW: 0n }, prices: {}, positions: [], ...o,
  })

  test('tokens and positions at the TWAP, never slot0; MON itself not counted', async () => {
    const price = 1.0001 ** TICK * 1e12 // USDC per WMON
    const v = await sleeveValueAtTwap(observeClient(), read(), monadRegistry, WINDOW)
    const want = 5_000_000 + 100 * price * 1e6
    expect(Math.abs(Number(v) - want) / want).toBeLessThan(1e-4)
    const s = sqrtRatioAtTick(TICK)
    const pos = { tokenId: 1n, pool: POOL, token0: 'WMON', token1: 'USDC', fee: 3000, liquidity: 10n ** 15n, tickLower: TICK - 600, tickUpper: TICK + 600, inRange: true, amount0: 0n, amount1: 0n, tokensOwed0: 0n, tokensOwed1: 7n }
    const withPos = await sleeveValueAtTwap(observeClient(), read({ tokens: { USDC: 0n, WMON: 0n, EURW: 0n }, positions: [pos] }), monadRegistry, WINDOW)
    expect(withPos > 7n).toBe(true)
    // Same position valued at slot0 would differ: the TWAP is what counts.
    expect(s).not.toBe(read().sqrtPriceX96)
    await expect(sleeveValueAtTwap(observeClient(true), read(), monadRegistry, WINDOW)).rejects.toThrow()
  })

  test('sleeve plus in flight; Monad down: not ready, last value plus in flight, never dropping in flight; never read: the review holds', async () => {
    const { bridge } = setup()
    bridge.recordSending('acc-1', signing())
    const live = bridge as unknown as { readSleeve: () => Promise<{ value: bigint; block: bigint; ready: boolean }> }
    live.readSleeve = async () => {
      throw new Error('Monad RPC down')
    }
    await expect(bridge.remote('acc-1', ACCOUNT, WINDOW)).rejects.toThrow('never read')
    live.readSleeve = async () => ({ value: 3_000_000n, block: 7_000n, ready: true })
    expect(await bridge.remote('acc-1', ACCOUNT, WINDOW)).toEqual({ value: 3_000_000n + AMOUNT, inFlight: AMOUNT, ready: true })
    live.readSleeve = async () => {
      throw new Error('Monad RPC down')
    }
    expect(await bridge.remote('acc-1', ACCOUNT, WINDOW)).toEqual({ value: 3_000_000n + AMOUNT, inFlight: AMOUNT, ready: false })
    // After a restart the last value is still known.
    const again = setup({ dir: (bridge as unknown as { stateDir: string }).stateDir })
    ;(again.bridge as unknown as typeof live).readSleeve = live.readSleeve
    expect(await again.bridge.remote('acc-1', ACCOUNT, WINDOW)).toEqual({ value: 3_000_000n + AMOUNT, inFlight: AMOUNT, ready: false })
  })
})

// ---- Review of PR #144 (Claude Opus 5.5 + Gemini Argon): one regression test per finding fixed. ----

describe('review of #144: settling a sending burn reads a bounded range', () => {
  test('nonce unmoved at safe: no eth_getLogs at all, and the cursor moves past safe', async () => {
    const ranges: [bigint, bigint][] = []
    const { bridge, j } = setup({ base: baseClient({ safe: 500_000n, ranges }) })
    bridge.recordSending('acc-1', signing())
    await bridge.tick()
    expect(ranges).toHaveLength(0)
    expect(j().burns[UOP]).toMatchObject({ state: 'sending', scanFrom: '500001' })
  })

  test('nonce moved after a long outage: chunks of SETTLE_LOG_CHUNK, at most SETTLE_CHUNKS_PER_TICK a pass, resumed from the cursor on disk', async () => {
    const ranges: [bigint, bigint][] = []
    const far = 1_000n + SETTLE_LOG_CHUNK * BigInt(SETTLE_CHUNKS_PER_TICK) + 500n
    const first = setup({ base: baseClient({ safe: far + 10_000n, landed: { block: far }, ranges }) })
    first.bridge.recordSending('acc-1', signing())
    await first.bridge.tick()
    expect(ranges).toHaveLength(SETTLE_CHUNKS_PER_TICK)
    for (const [a, b] of ranges) expect(b - a + 1n <= SETTLE_LOG_CHUNK).toBe(true)
    expect(first.j().burns[UOP]).toMatchObject({ state: 'sending', scanFrom: (1_000n + SETTLE_LOG_CHUNK * BigInt(SETTLE_CHUNKS_PER_TICK)).toString() })
    // A new process resumes from the cursor, not from the prepare block.
    ranges.length = 0
    const again = setup({ dir: first.dir, base: baseClient({ safe: far + 10_000n, landed: { block: far }, ranges }) })
    await again.bridge.tick()
    expect(ranges[0]![0]).toBe(1_000n + SETTLE_LOG_CHUNK * BigInt(SETTLE_CHUNKS_PER_TICK))
    expect(again.j().burns[UOP]).toMatchObject({ state: 'burned', burnBlock: far.toString() })
  })

  test('nonce moved and no event anywhere up to safe: dropped once the whole range is read', async () => {
    const d = setup({ base: baseClient({ safe: 1_000n + SETTLE_LOG_CHUNK + 10n, nonceAtSafe: 8n }) })
    d.bridge.recordSending('acc-1', signing())
    await d.bridge.tick()
    expect(d.j().burns[UOP]!.state).toBe('dropped')
  })
})

describe('review of #144: the remote value never counts the same USDC twice', () => {
  const WINDOW = 1_800
  type Live = { readSleeve: () => Promise<{ value: bigint; block: bigint; ready: boolean }> }

  test('a lagging Monad provider: a read older than the last one recorded is not used', async () => {
    const { bridge } = setup()
    const live = bridge as unknown as Live
    live.readSleeve = async () => ({ value: AMOUNT, block: 5_002n, ready: true })
    expect(await bridge.remote('acc-1', ACCOUNT, WINDOW)).toEqual({ value: AMOUNT, inFlight: 0n, ready: true })
    // A node at 5000 (before a mint the journal places at 5001) answers 0: the last read (5002) stands.
    const b = { ...(signing() as unknown as object), id: UOP, accountKey: 'acc-1', account: ACCOUNT, amount: AMOUNT.toString(), state: 'minted', mintedBlock: '5001' } as unknown as BridgeBurn
    ;(bridge as unknown as { journal: { burns: Record<string, BridgeBurn> } }).journal.burns[UOP] = b
    live.readSleeve = async () => ({ value: 0n, block: 5_000n, ready: true })
    expect(await bridge.remote('acc-1', ACCOUNT, WINDOW)).toEqual({ value: AMOUNT, inFlight: 0n, ready: true })
  })

  test('minted by someone else, seen at the head: a sleeve read at an earlier block where the nonce is already used counts it once', async () => {
    let now = T0
    const att = await attest(message({ nonce: 42n, executed: true }))
    const s = setup({ now: () => now, base: baseClient({ safe: 1_020n, landed: { block: 1_010n } }), iris: { [BURN_TX]: [att] } })
    s.bridge.recordSending('acc-1', signing())
    await s.bridge.tick()
    // Minted at Monad block 4_900 by another relayer; the journal sees it at the head, 5_010.
    s.st.used.add(u(42n, 32).toLowerCase())
    s.st.usedFrom = 4_900n
    s.st.block = 5_010n
    now += 6 * 60_000
    await s.bridge.tick()
    expect(s.j().burns[UOP]).toMatchObject({ state: 'minted', mintedBlock: '5010' })
    const live = s.bridge as unknown as Live
    // A read from before the real mint counts it in flight, exactly once.
    live.readSleeve = async () => ({ value: 0n, block: 4_800n, ready: true })
    expect(await s.bridge.remote('acc-1', ACCOUNT, WINDOW)).toEqual({ value: AMOUNT, inFlight: AMOUNT, ready: true })
    // A read between the real mint (4_900) and the head the journal saw it at (5_010) has the USDC: not in flight too.
    live.readSleeve = async () => ({ value: AMOUNT, block: 5_008n, ready: true })
    expect(await s.bridge.remote('acc-1', ACCOUNT, WINDOW)).toEqual({ value: AMOUNT, inFlight: 0n, ready: true })
  })

  test('a bridge signed but not landed at the local read block is still in the local balances: not in flight; landed: in flight', async () => {
    const s = setup({ base: baseClient({ safe: 1_000n, landed: { block: 1_010n } }) })
    s.bridge.recordSending('acc-1', signing())
    ;(s.bridge as unknown as Live).readSleeve = async () => ({ value: 0n, block: 7_000n, ready: true })
    expect(await s.bridge.remote('acc-1', ACCOUNT, WINDOW, 1_005n)).toEqual({ value: 0n, inFlight: 0n, ready: true })
    expect(await s.bridge.remote('acc-1', ACCOUNT, WINDOW, 1_010n)).toEqual({ value: AMOUNT, inFlight: AMOUNT, ready: true })
    // No local block (or the nonce unreadable): counted, never under the real value.
    expect((await s.bridge.remote('acc-1', ACCOUNT, WINDOW)).inFlight).toBe(AMOUNT)
  })

  test('journaled and then never signed: dropped, out of flight; a burn recorded by an earlier process is never discarded', () => {
    const s = setup()
    s.bridge.recordSending('acc-1', signing())
    s.bridge.discardUnsigned(UOP)
    expect(s.j().burns[UOP]).toMatchObject({ state: 'dropped' })
    expect(s.bridge.inFlight('acc-1', 0n)).toBe(0n)
    const other = setup()
    other.bridge.recordSending('acc-1', signing())
    const restarted = setup({ dir: other.dir })
    restarted.bridge.recordSending('acc-1', signing())
    restarted.bridge.discardUnsigned(UOP)
    expect(restarted.j().burns[UOP]!.state).toBe('sending')
  })

  test('the provider error quoted in the review detail has no keyed URL', async () => {
    const { bridge } = setup()
    ;(bridge as unknown as Live).readSleeve = async () => {
      throw new Error('HTTP request failed. URL: https://monad.example/v2/testkeyZZ0123456789abcdef0123456789abcdef')
    }
    const e = await bridge.remote('acc-1', ACCOUNT, WINDOW).catch((x: unknown) => x as Error)
    expect(String((e as { detail?: string }).detail ?? (e as Error).message)).not.toContain('testkeyZZ')
  })
})

describe('review of #144: the mint relay persists what it learns and does not hammer a reverting mint', () => {
  const burnedAt = async (now: () => number, iris: Record<string, { message: Hex; attestation: Hex }[]>, o: { dir?: string } = {}) => {
    const s = setup({ ...o, now, base: baseClient({ safe: 1_020n, landed: { block: 1_010n } }), iris })
    s.bridge.recordSending('acc-1', signing())
    await s.bridge.tick()
    return s
  }

  test('attestPolledAt is on disk: a restart does not poll Iris again before ATTEST_POLL_MS', async () => {
    let now = T0
    const s = await burnedAt(() => now, {})
    now += 6 * 60_000
    await s.bridge.tick()
    expect(s.urls).toHaveLength(1)
    expect(s.j().burns[UOP]!.attestPolledAt).toBe(new Date(now).toISOString())
    const restarted = setup({ dir: s.dir, now: () => now + 10_000, base: baseClient({ safe: 1_020n, landed: { block: 1_010n } }) })
    await restarted.bridge.tick()
    expect(restarted.urls).toHaveLength(0)
  })

  test('the CCTP nonce is on disk before the relayer is called, and stays there when the send fails', async () => {
    let now = T0
    const att = await attest(message({ nonce: 42n, executed: true }))
    const s = await burnedAt(() => now, { [BURN_TX]: [att] })
    let onDisk: string | undefined
    ;(s.bridge as unknown as { relayer: MonadSender }).relayer = {
      address: '0x0000000000000000000000000000000000000002',
      send: async () => {
        onDisk = s.j().burns[UOP]!.cctpNonce
        throw new Error('nonce too low')
      },
    }
    now += 6 * 60_000
    await s.bridge.tick()
    expect(onDisk).toBe(u(42n, 32))
    expect(s.j().burns[UOP]).toMatchObject({ state: 'burned', cctpNonce: u(42n, 32) })
  })

  test('a reverting receiveMessage waits longer after each revert and stops after MONAD_MINT_MAX_REVERTS', async () => {
    let now = T0
    const att = await attest(message({ nonce: 42n, executed: true }))
    const s = await burnedAt(() => now, { [BURN_TX]: [att] })
    s.st.mintStatus = 'reverted'
    const step = async (ms: number) => {
      now += ms
      await s.bridge.tick()
      return s.relayer!.sent.length
    }
    expect(await step(6 * 60_000)).toBe(1)
    expect(await step(60_000)).toBe(1) // reverted: not sent again a minute later
    expect(await step(MONAD_MINT_PENDING_MS)).toBe(2)
    expect(await step(60_000)).toBe(2)
    expect(await step(MONAD_MINT_PENDING_MS)).toBe(2) // the second wait is twice as long
    expect(await step(MONAD_MINT_PENDING_MS)).toBe(3)
    for (let i = 0; i < 20; i++) await step(MONAD_MINT_PENDING_MS)
    expect(s.relayer!.sent).toHaveLength(3)
    expect(s.j().burns[UOP]).toMatchObject({ state: 'burned', mintReverts: 3 })
    // Someone else mints it meanwhile: still recorded.
    s.st.used.add(u(42n, 32).toLowerCase())
    await step(60_000)
    expect(s.j().burns[UOP]!.state).toBe('minted')
  })
})

describe('review of #144: Monad unreachable at boot', () => {
  test('until the check passes nothing is read on Monad nor minted; then the leg runs', async () => {
    let now = T0
    let reachable = false
    const att = await attest(message({ nonce: 42n, executed: true }))
    const s = setup({
      now: () => now,
      base: baseClient({ safe: 1_020n, landed: { block: 1_010n } }),
      iris: { [BURN_TX]: [att] },
      verify: async () => {
        if (!reachable) throw new Error('unreachable')
      },
    })
    s.bridge.recordSending('acc-1', signing())
    let reads = 0
    ;(s.bridge as unknown as { readSleeve: () => Promise<unknown> }).readSleeve = async () => (reads++, { value: 0n, block: 7_000n, ready: true })
    now += 6 * 60_000
    await s.bridge.tick()
    expect(s.j().burns[UOP]!.state).toBe('burned') // Base side settles regardless
    expect(s.urls).toHaveLength(0)
    expect(s.relayer!.sent).toHaveLength(0)
    await expect(s.bridge.remote('acc-1', ACCOUNT, 1_800)).rejects.toThrow('never read')
    expect(reads).toBe(0)
    reachable = true
    now += 6 * 60_000
    await s.bridge.tick()
    expect(s.relayer!.sent).toHaveLength(1)
    expect((await s.bridge.remote('acc-1', ACCOUNT, 1_800)).ready).toBe(true)
  })
})

// The real Relayer (not relayerMock): a throw from onSending stops the send before anything is broadcast, so the mint's
// gas ceiling and daily budget hold, and the day's charge is given back.
const broadcasts: string[] = []
const stub = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    const body = (await req.json()) as { id: number; method: string } | { id: number; method: string }[]
    const one = (m: { id: number; method: string }) => (broadcasts.push(m.method), { jsonrpc: '2.0', id: m.id, result: null })
    return Response.json(Array.isArray(body) ? body.map(one) : one(body))
  },
})
afterAll(() => stub.stop(true))

describe('review of #144: the real Relayer aborts the mint when onSending throws', () => {
  test('signed above the gas ceiling: no eth_sendRawTransaction, nothing on disk as sent, the budget refunded', async () => {
    let now = T0
    const att = await attest(message({ nonce: 42n, executed: true }))
    const s = setup({ now: () => now, base: baseClient({ safe: 1_020n, landed: { block: 1_010n } }), iris: { [BURN_TX]: [att] } })
    s.bridge.recordSending('acc-1', signing())
    await s.bridge.tick()
    const relayerClient = {
      estimateGas: async () => 150_000n,
      getTransactionCount: async () => 0,
      // The pre-check read 100 gwei; the fees the transaction is signed with come in at 600 gwei.
      estimateFeesPerGas: async () => ({ maxFeePerGas: 600_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
      readContract: async () => 0n,
    } as unknown as PublicClient
    ;(s.bridge as unknown as { relayer: MonadSender }).relayer = new Relayer(`0x${'11'.repeat(32)}`, relayerClient, `http://127.0.0.1:${stub.port}`, 143)
    broadcasts.length = 0
    now += 6 * 60_000
    await s.bridge.tick()
    expect(broadcasts).not.toContain('eth_sendRawTransaction')
    const j = JSON.parse(readFileSync(join(s.dir, 'bridge-monad.json'), 'utf8')) as { burns: Record<string, BridgeBurn>; mintDays: Record<string, { n: number; wei: string }> }
    expect(j.burns[UOP]!.mintTx).toBeUndefined()
    expect(Object.values(j.mintDays)[0]).toEqual({ n: 0, wei: '0' })
  })
})
