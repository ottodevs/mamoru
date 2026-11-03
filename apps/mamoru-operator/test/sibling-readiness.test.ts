// otto/mamoru#348 (spec 010 A1), Base -> Ethereum: the home's readiness on its Ethereum sibling through BridgeOut's tick, on
// a fake Ethereum: announceReady on Base (the home hook, the Base operator's lane 1), Circle's attestation (a fake iris,
// signed by a test attester the fake transmitter enables), relayMessage as a sibling leg (receiveMessage in the op), then
// V4.isReady: only then the bridge home. Plus: out of scope, already ready, a restart mid-flow, a forged attestation.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeEventTopics, keccak256, numberToHex, pad, parseAbi, toHex, TransactionNotFoundError, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts'
import { address, ethereumRegistry } from '@mamoru/registry'
import { oneAuthV4Deployment } from '@mamoru/policy'
import { BridgeOut, type StoredSibling } from '../src/bridge-out.ts'
import { MESSAGE_TRANSMITTER_V2 } from '../src/cctp.ts'
import type { AnnounceAnswer, OpOutcome, SentOp } from '../src/readiness.ts'
import { pinTestA1 } from '../../../packages/account/one-auth/pin-fixture.ts'

const SAFE = '0x0000000000000000000000000000000000000aaa' as const
const TX = `0x${'ab'.repeat(32)}` as Hex
const BASE_TX = `0x${'ba'.repeat(32)}` as Hex
const T0 = Date.parse('2026-11-05T20:00:00Z')
const EP = address('EntryPointV07', ethereumRegistry)
const unpin = pinTestA1(ethereumRegistry)
afterAll(unpin)
const V4 = oneAuthV4Deployment(ethereumRegistry)!.policy
const ATTESTER = generatePrivateKey()
const FORGER = generatePrivateKey()
const epAbi = parseAbi(['event BeforeExecution()', 'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)'])
const handleOpsAbi = parseAbi(['struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }', 'function handleOps(PackedUserOperation[] ops, address beneficiary)'])

/** V4's readiness message Base -> Ethereum for the sibling (home == safe), as Circle attests it. */
function readiness(o: { source?: number; safe?: `0x${string}` } = {}): Hex {
  const u = (v: bigint | number, size: number) => toHex(v, { size })
  const w = (a: `0x${string}`) => pad(a, { size: 32 })
  const header = concat([u(1, 4), u(o.source ?? 6, 4), u(0, 4), u(42, 32), w(V4), w(V4), u(0, 32), u(2000, 4), u(2000, 4)])
  return concat([header, encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [o.safe ?? SAFE, o.safe ?? SAFE, `0x${'0c'.repeat(32)}`])])
}

async function attest(m: Hex, key: Hex): Promise<Hex> {
  const s = await sign({ hash: keccak256(m), privateKey: key })
  return concat([s.r, s.s, numberToHex(s.v ?? (s.yParity === 1 ? 28n : 27n), { size: 1 })])
}

type Chain = { ready: boolean; eth: bigint; usdc: bigint; nonce: bigint; logs: { args: { userOpHash: Hex; success: boolean; nonce: bigint; sender: string }; transactionHash: Hex }[]; head: bigint; relayLands: boolean }

function make(chain: Chain, now: () => number, o: { inScope?: boolean; iris?: () => { message: Hex; attestation: Hex }[]; c?: Partial<StoredSibling>; dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'mamoru-sib-ready-'))
  if (!o.dir) {
    const c: StoredSibling = { id: 'p', safe: SAFE, safeNonce: '0', safeTxHash: `0x${'11'.repeat(32)}`, permissionId: `0x${'22'.repeat(32)}`, sessionKey: '0x0000000000000000000000000000000000000bbb', capUsdc: '1', fromBlock: '1', state: 'done', at: new Date(T0).toISOString(), ...o.c }
    writeFileSync(join(dir, 'bridge-out.json'), JSON.stringify({ routes: {}, spent: { day: '', wei: '0' }, moves: {}, siblings: { k: c } }))
    writeFileSync(join(dir, 'ethereum-sibling-keys.json'), JSON.stringify({ k: generatePrivateKey() }), { mode: 0o600 })
  }
  const sent: { kind: string; inner: Hex }[] = []
  const last: { receipt: unknown } = { receipt: null }
  const l1 = {
    getBlockNumber: async () => chain.head,
    getBlock: async () => ({ number: chain.head, timestamp: BigInt(Math.floor(now() / 1000)), baseFeePerGas: 50_000_000n }),
    getGasPrice: async () => 50_000_000n,
    getBalance: async () => chain.eth,
    call: async () => ({ data: '0x' }),
    readContract: async ({ functionName, address: at, args }: { functionName: string; address: string; args?: readonly unknown[] }) => {
      if (functionName === 'balanceOf' && at.toLowerCase() === EP.toLowerCase()) return 0n
      if (functionName === 'balanceOf') return at.toLowerCase().startsWith('0xa0b8') ? chain.usdc : 0n
      if (functionName === 'isReady') return chain.ready
      if (functionName === 'getNonce') return chain.nonce
      if (functionName === 'signatureThreshold') return 1n
      if (functionName === 'isEnabledAttester') return (args![0] as string).toLowerCase() === privateKeyToAccount(ATTESTER).address.toLowerCase()
      throw new Error(functionName)
    },
    getLogs: async ({ args }: { args: { userOpHash?: Hex; sender?: string } }) => chain.logs.filter((l) => (args.userOpHash ? l.args.userOpHash === args.userOpHash : l.args.sender === args.sender)),
    getTransaction: async ({ hash }: { hash: Hex }) => {
      throw new TransactionNotFoundError({ hash })
    },
    getTransactionReceipt: async () => last.receipt,
  }
  const relayer = {
    address: '0x0000000000000000000000000000000000000001' as const,
    send: async (tx: { data?: Hex }, onSent?: (h: Hex) => void, _s?: unknown, onSigned?: (h: Hex, n: number) => void) => {
      const op = decodeFunctionData({ abi: handleOpsAbi, data: tx.data! }).args[0][0]!
      const j = JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8'))
      const leg = j.siblings.k.leg
      sent.push({ kind: leg.kind, inner: op.callData })
      onSigned?.(TX, 0)
      onSent?.(TX)
      const success = leg.kind !== 'relay' || chain.relayLands
      chain.logs.push({ args: { userOpHash: leg.userOpHash, success, nonce: chain.nonce, sender: SAFE }, transactionHash: TX })
      chain.nonce += 1n
      if (leg.kind === 'relay' && success) chain.ready = true
      const event = { address: EP, topics: encodeEventTopics({ abi: epAbi, eventName: 'UserOperationEvent', args: { userOpHash: leg.userOpHash, sender: SAFE, paymaster: '0x0000000000000000000000000000000000000000' } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [chain.nonce - 1n, success, 1n, 1n]) }
      last.receipt = { status: 'success', transactionHash: TX, gasUsed: 300_000n, effectiveGasPrice: 50_000_000n, logs: [{ address: EP, topics: encodeEventTopics({ abi: epAbi, eventName: 'BeforeExecution' }), data: '0x' }, event] }
      return { hash: TX, receipt: last.receipt as never }
    },
  }
  const irisCalls: string[] = []
  const fetcher = async (url: string) => {
    irisCalls.push(url)
    const list = o.iris?.() ?? []
    return new Response(JSON.stringify({ messages: list.map((x) => ({ status: 'complete', message: x.message, attestation: x.attestation })) }), { status: 200 })
  }
  const bo = new BridgeOut(l1 as never, relayer, dir, fetcher as never, now, undefined, () => true)
  bo.siblingInScope = () => o.inScope ?? true
  const announced: string[] = []
  const homeOutcome: { v: OpOutcome } = { v: { txHash: BASE_TX, success: true } }
  bo.home = {
    announce: async (k: string): Promise<AnnounceAnswer> => (announced.push(k), { op: { userOpHash: `0x${'5a'.repeat(32)}`, fromBlock: '1000', t: String(Math.floor(now() / 1000)) } }),
    outcome: async (_op: SentOp) => homeOutcome.v,
  }
  const journal = () => JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8')) as { siblings: { k: StoredSibling } }
  return { bo, sent, journal, announced, irisCalls, homeOutcome, dir }
}

const receiveAbi = parseAbi(['function receiveMessage(bytes message, bytes attestation) returns (bool)'])
const executeAbi = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)'])

describe('#348 the home readiness on its Ethereum sibling (BridgeOut)', () => {
  test('announce on Base -> Circle -> relay here (receiveMessage in the sibling op) -> ready -> only then the bridge home', async () => {
    const chain: Chain = { ready: false, eth: 5n * 10n ** 14n, usdc: 5_000_000n, nonce: 0n, logs: [], head: 100n, relayLands: true }
    let now = T0
    const msg = readiness()
    const att = await attest(msg, ATTESTER)
    let attested = false
    const mk = make(chain, () => now, { iris: () => (attested ? [{ message: msg, attestation: att }] : []) })
    await mk.bo.tick() // announce (Base, via the home hook); not ready: no bridge, and nothing else signed
    expect(mk.announced).toEqual(['k'])
    expect(mk.journal().siblings.k.ready?.state).toBe('announced')
    expect(mk.sent).toEqual([])
    now += 60_000
    await mk.bo.tick() // the announce ran on Base: attesting; Circle has nothing yet
    expect(mk.journal().siblings.k.ready?.state).toBe('attesting')
    expect(mk.journal().siblings.k.ready?.srcTx).toBe(BASE_TX)
    now += 60_000
    await mk.bo.tick() // Circle has nothing yet: still attesting
    expect(mk.irisCalls.at(-1)).toBe(`https://iris-api.circle.com/v2/messages/6?transactionHash=${BASE_TX}`)
    expect(mk.journal().siblings.k.ready?.state).toBe('attesting')
    attested = true
    now += 60_000
    await mk.bo.tick() // attested and checked: relay
    expect(mk.journal().siblings.k.ready?.state).toBe('relay')
    now += 60_000
    await mk.bo.tick() // the relay leg: receiveMessage(message, attestation) on the transmitter, from the sibling's session
    expect(mk.sent.map((s) => s.kind)).toEqual(['relay'])
    const exec = decodeFunctionData({ abi: executeAbi, data: mk.sent[0]!.inner })
    expect(exec.args[1].toLowerCase()).toContain(MESSAGE_TRANSMITTER_V2.slice(2).toLowerCase())
    expect(exec.args[1].toLowerCase()).toContain(encodeFunctionData({ abi: receiveAbi, functionName: 'receiveMessage', args: [msg, att] }).slice(2).toLowerCase())
    expect(mk.journal().siblings.k.ready?.state).toBe('relayed')
    expect(mk.journal().siblings.k.leg?.kind).toBe('relay')
    now += 60_000
    await mk.bo.tick() // V4 holds the home ready: the flow ends (the engine's idle wait still runs from the relay)
    expect(mk.journal().siblings.k.ready).toBeUndefined()
    now += 10 * 60_000
    await mk.bo.tick() // now the bridge home
    expect(mk.sent.map((s) => s.kind)).toEqual(['relay', 'bridge'])
    expect(mk.announced).toEqual(['k'])
  })

  test('restart mid-flow (a new BridgeOut on the same journal): resumes, never announces again', async () => {
    const chain: Chain = { ready: false, eth: 5n * 10n ** 14n, usdc: 0n, nonce: 0n, logs: [], head: 100n, relayLands: true }
    let now = T0
    const msg = readiness()
    const att = await attest(msg, ATTESTER)
    const a = make(chain, () => now, { iris: () => [{ message: msg, attestation: att }] })
    for (let i = 0; i < 3; i++) {
      await a.bo.tick()
      now += 60_000
    }
    expect(a.journal().siblings.k.ready?.state).toBe('relay')
    const b = make(chain, () => now, { iris: () => [{ message: msg, attestation: att }], dir: a.dir })
    now += 60_000
    await b.bo.tick()
    now += 60_000
    await b.bo.tick()
    expect(b.journal().siblings.k.ready).toBeUndefined()
    expect(chain.ready).toBe(true)
    expect([...a.announced, ...b.announced]).toEqual(['k'])
  })

  test('already ready, out of the one-authorization scope, or no home hook: nothing announced', async () => {
    const chain: Chain = { ready: true, eth: 5n * 10n ** 14n, usdc: 0n, nonce: 0n, logs: [], head: 100n, relayLands: true }
    const r = make(chain, () => T0)
    await r.bo.tick()
    expect(r.announced).toEqual([])
    chain.ready = false
    const s = make(chain, () => T0, { inScope: false })
    await s.bo.tick()
    expect(s.announced).toEqual([])
    expect(s.journal().siblings.k.ready).toBeUndefined()
    const u = make(chain, () => T0)
    u.bo.home = null
    await u.bo.tick()
    expect(u.journal().siblings.k.ready).toBeUndefined()
  })

  test('an attestation not signed by the enabled attesters, or for another Safe or route, is never relayed', async () => {
    const chain: Chain = { ready: false, eth: 5n * 10n ** 14n, usdc: 0n, nonce: 0n, logs: [], head: 100n, relayLands: true }
    let now = T0
    const good = readiness()
    const forged = await attest(good, FORGER)
    const other = readiness({ safe: '0x0000000000000000000000000000000000000bad' })
    const fromMonad = readiness({ source: 15 })
    const m = make(chain, () => now, { iris: () => [{ message: good, attestation: forged }, { message: other, attestation: forged }, { message: fromMonad, attestation: forged }] })
    for (let i = 0; i < 4; i++) {
      await m.bo.tick()
      now += 60_000
    }
    expect(m.journal().siblings.k.ready?.state).toBe('attesting')
    expect(m.journal().siblings.k.ready?.why).toContain('attesters enabled on Ethereum')
    expect(m.sent).toEqual([])
  })

  test('a relay that reverts on chain is relayed again (the same message), never a bridge before ready', async () => {
    const chain: Chain = { ready: false, eth: 5n * 10n ** 14n, usdc: 5_000_000n, nonce: 0n, logs: [], head: 100n, relayLands: false }
    let now = T0
    const msg = readiness()
    const att = await attest(msg, ATTESTER)
    const m = make(chain, () => now, { iris: () => [{ message: msg, attestation: att }] })
    for (let i = 0; i < 5; i++) {
      await m.bo.tick()
      now += 60_000
    }
    expect(m.sent.map((s) => s.kind)).toEqual(['relay'])
    expect(m.journal().siblings.k.ready?.state).toBe('relay')
    expect(m.journal().siblings.k.ready?.fails).toBe(1)
    chain.relayLands = true
    now += 3_600_000
    await m.bo.tick()
    now += 60_000
    await m.bo.tick()
    expect(chain.ready).toBe(true)
    expect(m.sent.map((s) => s.kind)).toEqual(['relay', 'relay'])
  })
})
