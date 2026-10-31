// otto/mamoru#215: the engine's bridge-out leg. The calls are exactly what the bridge-out grant of conservador-live-v6
// allows (precheck passes them, and refuses any other domain, recipient, fee, finality or spender); the simulated deltas
// must be -amount of USDC and nothing else, with one DepositForBurn on the grant's terms; and a bridge-out is never
// signed without the operator's bridge journal. `prepareCalls`/`deltaMismatch`/`journalBridge` are private; reached
// with a cast, like engine-v5.test.ts.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, getAddress, pad, zeroHash, type Hex, type Log } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ReasonError, type Address } from '@mamoru/domain'
import type { Proposal } from '@mamoru/decide'
import { computeCaps, conservadorLabV6, conservadorLiveV6, instantiateGrant, withActionPolicy, V4_POOLS, type GrantContext, type PolicyVersion } from '@mamoru/policy'
import { precheck, SessionLedger } from '@mamoru/account/precheck'
import { executeCallData, useModeSignature } from '@mamoru/account/sessions'
import type { Execution } from '@mamoru/account/safe'
import { address, baseRegistry, erc20Abi, mamoruActionPolicyV2Abi, tokenMessengerV2Abi } from '@mamoru/registry'
import type { Simulation } from '@mamoru/rpc'
import { FakeChain, Revert } from '../../rpc/test/fake-chain.ts'
import { CCTP_DOMAIN_BY_CHAIN, Engine, type BridgeSigning, type EngineHooks, type EngineSession } from './engine.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
/** otto/mamoru#251: the account's own Safe on Monad, the bridge-out grant's only mint recipient. */
const MONAD_SAFE = '0x00000000000000000000000000000000000000ee' as Address
const OTHER = '0x00000000000000000000000000000000000000cc' as Address
const POLICY_V2 = '0x00000000000000000000000000000000000000b2' as Address
const CAP = 10_000n * 1_000_000n
const AMOUNT = 1_500n * 1_000_000n
const USDC = address('USDC', baseRegistry)
const MESSENGER = address('TokenMessengerV2', baseRegistry)
const sessionKey = privateKeyToAccount(generatePrivateKey())
const PERMISSION = `0x${'07'.repeat(32)}` as Hex

const bridge = (over: Partial<Extract<Proposal, { kind: 'bridge_out' }>> = {}): Proposal => ({ kind: 'bridge_out', grant: 'bridge-out', bucket: 'growth', chainId: 143, pool: 'pool:WMON/USDC/3000', amount: AMOUNT, ...over })

function grantCtx(): GrantContext {
  const caps = computeCaps(conservadorLiveV6, CAP, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } })
  return { account: ACCOUNT, sessionKey: sessionKey.address, chainId: 8453, salt: `0x${'00'.repeat(32)}`, validAfter: 0, validUntil: 2_000_000_000, caps, remoteAccount: MONAD_SAFE }
}

function session(): EngineSession {
  return { name: 'bridge-out', grant: instantiateGrant(conservadorLiveV6, 'bridge-out', grantCtx()), permissionId: PERMISSION }
}

type Prepared = { calls: Execution[]; expiresAt: bigint | null }

async function withEngine<T>(policy: PolicyVersion, fn: (e: Engine, state: { paused: boolean }) => Promise<T>, hooks: Partial<EngineHooks> = {}, opts: { sessions?: EngineSession[] } = {}): Promise<T> {
  const chain = new FakeChain()
  chain.code.set(ACCOUNT.toLowerCase(), '0x6001')
  const state = { paused: false }
  chain.contracts.set(POLICY_V2.toLowerCase(), (data: Hex) => {
    const call = decodeFunctionData({ abi: mamoruActionPolicyV2Abi, data })
    if (call.functionName === 'isPaused') return encodeFunctionResult({ abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', result: state.paused })
    throw new Revert('unknown policy call')
  })
  const rpc = chain.serve()
  try {
    const e = new Engine(
      { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: rpc.url, bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 800n, historyFromBlock: 800n, sessions: opts.sessions ?? [session()] },
      { waitBlock: async () => {}, ...hooks },
    )
    return await fn(e, state)
  } finally {
    rpc.stop()
  }
}

const prepare = (e: Engine, p: Proposal): Promise<Prepared> =>
  (e as unknown as { prepareCalls: (p: Proposal, b: bigint, t: bigint, s: EngineSession) => Promise<Prepared> }).prepareCalls(p, 1000n, 1_790_002_000n, session())
const mismatch = (e: Engine, p: Proposal, sim: Simulation): string | null =>
  (e as unknown as { deltaMismatch: (p: Proposal, prepared: Prepared, sim: Simulation) => string | null }).deltaMismatch(p, { calls: [], expiresAt: null }, sim)

async function code(f: () => Promise<unknown>): Promise<string> {
  try {
    await f()
  } catch (e) {
    if (e instanceof ReasonError) return e.code
    throw e
  }
  return 'OK'
}

/** precheck of `calls` under the instantiated bridge-out grant of conservador-live-v6. */
function check(calls: Execution[]): string {
  const ledger = new SessionLedger()
  const s = session()
  ledger.activate(s.permissionId, s.grant)
  const r = precheck({ sender: ACCOUNT, callData: executeCallData(calls), signature: useModeSignature(s.permissionId, '0x') }, { chainId: 8453, now: 1_790_002_000, ledger })
  return r.ok ? 'OK' : r.code
}

const burnCall = (args: { amount?: bigint; domain?: number; recipient?: Address; caller?: Hex; maxFee?: bigint; finality?: number; token?: Address }): Execution => ({
  target: MESSENGER,
  value: 0n,
  callData: encodeFunctionData({
    abi: tokenMessengerV2Abi,
    functionName: 'depositForBurn',
    args: [args.amount ?? AMOUNT, args.domain ?? 15, pad(args.recipient ?? MONAD_SAFE, { size: 32 }), args.token ?? USDC, args.caller ?? zeroHash, args.maxFee ?? 0n, args.finality ?? 2000],
  }),
})
const approveCall = (spender: Address = MESSENGER, amount: bigint = AMOUNT): Execution => ({ target: USDC, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) })

/** A DepositForBurn log of TokenMessengerV2, as the simulation would return it. */
function burnLog(over: { depositor?: Address; amount?: bigint; recipient?: Address; domain?: number; maxFee?: bigint; finality?: number; caller?: Hex; hookData?: Hex } = {}): Log {
  const topics = encodeEventTopics({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', args: { burnToken: USDC, depositor: over.depositor ?? ACCOUNT, minFinalityThreshold: over.finality ?? 2000 } })
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
    [over.amount ?? AMOUNT, pad(over.recipient ?? MONAD_SAFE, { size: 32 }), over.domain ?? 15, pad(MESSENGER, { size: 32 }), over.caller ?? zeroHash, over.maxFee ?? 0n, over.hookData ?? '0x'],
  )
  return { address: MESSENGER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 1n, blockHash: zeroHash, transactionHash: zeroHash, transactionIndex: 0, logIndex: 0, removed: false } as Log
}
const sim = (over: Partial<Simulation> = {}): Simulation => ({ block: 1000n, ok: true, deltas: { USDC: -AMOUNT, USDT: 0n, WETH: 0n, cbBTC: 0n }, nftDelta: 0n, gasUsed: 200_000n, logs: [burnLog()], ...over })

describe('bridge-out calls (otto/mamoru#215)', () => {
  test("approve TokenMessengerV2 for the amount, then depositForBurn to the account's own Safe on Monad (#251): any caller, no fee, Standard finality", async () => {
    await withEngine(conservadorLabV6, async (e) => {
      const out = await prepare(e, bridge())
      expect(out.expiresAt).toBeNull()
      expect(out.calls.map((c) => c.target)).toEqual([USDC, MESSENGER])
      expect(out.calls.every((c) => c.value === 0n)).toBe(true)
      expect(decodeFunctionData({ abi: erc20Abi, data: out.calls[0]!.callData }).args).toEqual([MESSENGER, AMOUNT])
      const burn = decodeFunctionData({ abi: tokenMessengerV2Abi, data: out.calls[1]!.callData })
      expect(burn.functionName).toBe('depositForBurn')
      expect(burn.args).toEqual([AMOUNT, 15, pad(MONAD_SAFE, { size: 32 }), USDC, zeroHash, 0n, 2000])
      expect(CCTP_DOMAIN_BY_CHAIN[143]).toBe(15)
      // Exactly what the grant allows.
      expect(check(out.calls)).toBe('OK')
    })
  })

  test('no domain known for the chain, a zero amount, or a paused account: nothing is built', async () => {
    await withEngine(conservadorLabV6, async (e) => {
      expect(await code(() => prepare(e, bridge({ chainId: 8453 as 143 })))).toBe('POLICY_DENIED_TARGET')
      expect(await code(() => prepare(e, bridge({ amount: 0n })))).toBe('POLICY_DENIED_AMOUNT')
    })
    const v6 = withActionPolicy(conservadorLabV6, POLICY_V2, Object.values(V4_POOLS), { contractVersion: 2 })
    await withEngine(v6, async (e, state) => {
      expect(await code(() => prepare(e, bridge()))).toBe('OK')
      state.paused = true
      expect(await code(() => prepare(e, bridge()))).toBe('POLICY_PAUSED')
    })
  })

  test('#251: the recipient is the one the bridge-out session names; none, or the account itself, builds nothing', async () => {
    await withEngine(conservadorLabV6, async (e) => {
      expect(await code(() => prepare(e, bridge()))).toBe('POLICY_DENIED_RECIPIENT')
    }, {}, { sessions: [] })
    const self = { ...session(), grant: instantiateGrant(conservadorLiveV6, 'bridge-out', { ...grantCtx(), remoteAccount: '0x00000000000000000000000000000000000000dd' as Address }) }
    self.grant.actions[1]!.params.find((r) => r.field === 'mintRecipient')!.ref = BigInt(ACCOUNT)
    await withEngine(conservadorLabV6, async (e) => {
      expect(await code(() => prepare(e, bridge()))).toBe('POLICY_DENIED_RECIPIENT')
    }, {}, { sessions: [self] })
  })
})

describe('precheck refuses any other bridge under the bridge-out grant', () => {
  test('another domain, recipient, caller, fee, finality, token, spender, or over the per-call cap', () => {
    expect(check([approveCall(), burnCall({})])).toBe('OK')
    expect(check([approveCall(), burnCall({ domain: 0 })])).toBe('POLICY_DENIED_TARGET')
    expect(check([approveCall(), burnCall({ domain: 6 })])).toBe('POLICY_DENIED_TARGET')
    expect(check([approveCall(), burnCall({ recipient: OTHER })])).toBe('POLICY_DENIED_RECIPIENT')
    expect(check([approveCall(), burnCall({ caller: pad(OTHER, { size: 32 }) })])).toBe('POLICY_DENIED_TARGET')
    expect(check([approveCall(), burnCall({ maxFee: 1n })])).toBe('POLICY_DENIED_AMOUNT')
    expect(check([approveCall(), burnCall({ finality: 1000 })])).toBe('POLICY_DENIED_AMOUNT')
    expect(check([approveCall(), burnCall({ token: OTHER })])).toBe('POLICY_DENIED_TARGET')
    expect(check([approveCall(OTHER), burnCall({})])).toBe('POLICY_DENIED_APPROVAL')
    const perCall = (CAP * 2000n) / 10_000n
    expect(check([approveCall(MESSENGER, perCall + 1n), burnCall({ amount: perCall + 1n })])).toBe('POLICY_DENIED_APPROVAL')
    expect(check([approveCall(MESSENGER, perCall), burnCall({ amount: perCall + 1n })])).toBe('POLICY_DENIED_AMOUNT')
  })
})

describe('bridge-out simulated deltas', () => {
  test('USDC by exactly -amount, nothing else, one DepositForBurn on the grant terms', async () => {
    await withEngine(conservadorLabV6, async (e) => {
      expect(mismatch(e, bridge(), sim())).toBeNull()
      expect(mismatch(e, bridge(), sim({ deltas: { USDC: -AMOUNT + 1n } }))).toContain('USDC moved')
      expect(mismatch(e, bridge(), sim({ deltas: { USDC: -AMOUNT, WETH: 5n } }))).toContain('WETH moved')
      expect(mismatch(e, bridge(), sim({ nftDelta: 1n }))).toContain('positions changed')
      expect(mismatch(e, bridge(), sim({ logs: [] }))).toContain('0 DepositForBurn')
      expect(mismatch(e, bridge(), sim({ logs: [burnLog(), burnLog()] }))).toContain('2 DepositForBurn')
      for (const bad of [{ recipient: OTHER }, { depositor: OTHER }, { domain: 6 }, { maxFee: 1n }, { finality: 1000 }, { amount: AMOUNT - 1n }, { hookData: '0x01' as Hex }, { caller: pad(OTHER, { size: 32 }) }]) {
        expect(mismatch(e, bridge(), sim({ logs: [burnLog(bad)] }))).toContain('not this account to its own Safe')
      }
    })
  })
})

describe('a bridge-out is journaled before it is signed', () => {
  const hash = `0x${'ab'.repeat(32)}` as Hex
  const journal = (e: Engine, p: Proposal) => (e as unknown as { journalBridge: (opId: string, p: Proposal, h: Hex, n: bigint, b: bigint) => string | null }).journalBridge('op-1', p, hash, 5n, 1000n)

  test('no journal: never signed', async () => {
    await withEngine(conservadorLabV6, async (e) => {
      expect(journal(e, bridge())).toContain('no bridge journal')
    })
  })

  test('the journal gets the burn and its userOp; a journal that throws refuses the signature', async () => {
    const got: BridgeSigning[] = []
    await withEngine(conservadorLabV6, async (e) => {
      expect(journal(e, bridge())).toBeNull()
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ opId: 'op-1', account: ACCOUNT, recipient: getAddress(MONAD_SAFE), chainId: 143, destinationDomain: 15, amount: AMOUNT, userOpHash: hash, nonce: 5n, prepareBlock: 1000n, bucket: 'growth' })
    }, { beforeBridgeSign: (b) => void got.push(b) })
    await withEngine(conservadorLabV6, async (e) => {
      expect(journal(e, bridge())).toContain('disk full')
    }, { beforeBridgeSign: () => { throw new Error('disk full') } })
  })

  test('review of #144: a bridge-out whose signing fails is handed back to the journal as never signed', async () => {
    const unsigned: Hex[] = []
    await withEngine(conservadorLabV6, async (e) => {
      const boom = () => {
        throw new Error('signer unavailable')
      }
      ;(e as unknown as { cfg: { sessionKey: unknown } }).cfg.sessionKey = { ...sessionKey, sign: boom, signMessage: boom, signTypedData: boom, signTransaction: boom }
      const sign = (p: Proposal) => (e as unknown as { signUserOp: (p: Proposal, u: unknown, h: Hex, id: Hex) => Promise<unknown> }).signUserOp(p, { sender: ACCOUNT, nonce: 5n, callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x' }, hash, PERMISSION)
      await expect(sign(bridge())).rejects.toThrow()
      expect(unsigned).toEqual([hash])
    }, { bridgeUnsigned: (h) => void unsigned.push(h) })
  })

  test('review round 2 of #144: every bridge-out that ends discarded or failed goes to bridgeFailed once; a nonce taken by another op does not', async () => {
    const got: [string, string][] = []
    await withEngine(conservadorLabV6, async (e) => {
      const ops = e.journal.ops as unknown as { opId: string; intent: Proposal; state: string; stateCode: string }[]
      ops.push({ opId: 'b1', intent: bridge(), state: 'discarded', stateCode: 'EHG_SIM_REVERT' })
      ops.push({ opId: 'b2', intent: bridge(), state: 'failed', stateCode: 'RECON_NONCE_CONSUMED_BY_OTHER' })
      ops.push({ opId: 'b3', intent: bridge(), state: 'submitted', stateCode: 'BUNDLER_ACCEPTED' })
      ops.push({ opId: 'l1', intent: { kind: 'enter_swap' } as unknown as Proposal, state: 'failed', stateCode: 'EXEC_INNER_REVERT' })
      const report = () => (e as unknown as { reportBridgeFailures: () => void }).reportBridgeFailures()
      report()
      report()
      expect(got).toEqual([['b1', 'EHG_SIM_REVERT']])
      ops[2]!.state = 'failed'
      ops[2]!.stateCode = 'EXEC_INNER_REVERT'
      report()
      expect(got).toEqual([['b1', 'EHG_SIM_REVERT'], ['b3', 'EXEC_INNER_REVERT']])
    }, { bridgeFailed: (id, code) => void got.push([id, code]) })
  })
})
