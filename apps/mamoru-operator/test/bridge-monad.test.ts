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
import { BASE_USDC, burnOf, inFlightOf, MonadBridge, sleeveValueAtTwap, type BridgeBurn, type MonadSender } from '../src/bridge-monad.ts'
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

/** Base: the safe head, the UserOperationEvent of the burn (or none) and the EntryPoint nonce at safe. */
function baseClient(o: { safe: bigint; landed?: { block: bigint; success?: boolean; recipient?: Hex; amount?: bigint }; nonceAtSafe?: bigint }): PublicClient {
  return {
    getBlock: async () => ({ number: o.safe }),
    getLogs: async () => (o.landed ? [{ args: { userOpHash: UOP, sender: ACCOUNT, nonce: 7n, success: o.landed.success ?? true, actualGasCost: 1n }, blockNumber: o.landed.block, blockHash: zeroHash, transactionHash: BURN_TX, logIndex: 3 }] : []),
    getTransactionReceipt: async () => ({ logs: burnReceiptLogs(o.landed ?? {}) }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getNonce') return o.nonceAtSafe ?? 7n
      throw new Error(functionName)
    },
  } as unknown as PublicClient
}

const attester = privateKeyToAccount(generatePrivateKey())
const attest = async (m: Hex) => ({ message: m, attestation: await attester.sign({ hash: keccak256(m) }) })

type MonadState = { used: Set<string>; block: bigint; balance: bigint; gasPrice: bigint; receipts: Map<string, { status: 'success' | 'reverted'; blockNumber: bigint }> }
function monadClient(st: MonadState): PublicClient {
  return {
    getBlockNumber: async () => st.block,
    getGasPrice: async () => st.gasPrice,
    getBalance: async () => st.balance,
    estimateGas: async () => 150_000n,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => st.receipts.get(hash) ?? null,
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === 'signatureThreshold') return 1n
      if (functionName === 'isEnabledAttester') return (args![0] as string).toLowerCase() === attester.address.toLowerCase()
      if (functionName === 'usedNonces') return st.used.has((args![0] as string).toLowerCase()) ? 1n : 0n
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
      return { hash, receipt: { status: 'success', blockNumber: st.block + 1n, gasUsed: 150_000n, effectiveGasPrice: 100_000_000_000n, logs: [] } as never }
    },
  }
}

function setup(o: { dir?: string; base?: PublicClient; monad?: MonadState; iris?: Record<string, { message: Hex; attestation: Hex }[]>; now?: () => number; relayer?: boolean } = {}) {
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
  const bridge = new MonadBridge(dir, o.base ?? baseClient({ safe: 900n }), monadClient(st), relayer, fetcher as typeof fetch, o.now ?? (() => T0))
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
