// otto/mamoru#151, #171: the engine under MamoruActionPolicyV2 (conservador-live-v5): an entry added to a held position
// goes through the policy's increase (never the position manager's increaseLiquidity), a guardian pause makes the
// engine wait, swaps are quoted with their price limit and sized down to fill within it, and the observation marks
// which positions the policy admitted. `prepareCalls`/`withAdmission` are private; reached with a cast, like
// engine-v4-bounds.test.ts.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector, zeroAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ReasonError, type Address } from '@mamoru/domain'
import type { Observation, Proposal } from '@mamoru/decide'
import { POLICIES, computeCaps, conservadorLabV4, conservadorLabV5, conservadorLiveV5, grantKeyFor, instantiateGrant, retargetToPolicy, withActionPolicy, V4_POOLS, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { precheck, SessionLedger } from '@mamoru/account/precheck'
import { executeCallData, useModeSignature } from '@mamoru/account/sessions'
import { convertKey } from '../../decide/src/rerange/index.ts'
import { address, entry, erc20Abi, mamoruActionPolicyV2Abi, swapRouter02Abi, baseRegistry } from '@mamoru/registry'
import type { Execution } from '@mamoru/account/safe'
import { FakeChain, Revert } from '../../rpc/test/fake-chain.ts'
import { Engine, V4_SWAP_SIZE_DOWN_STEPS, type EngineSession } from './engine.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const POOL = 'pool:USDC/cbBTC/500'
const POLICY_V2 = '0x00000000000000000000000000000000000000b2' as Address
const sessionKey = privateKeyToAccount(generatePrivateKey())
const V5 = withActionPolicy(conservadorLabV5, POLICY_V2, Object.values(V4_POOLS), { contractVersion: 2 })
const V4 = withActionPolicy(conservadorLabV4, POLICY_V2, Object.values(V4_POOLS))
const NPM_INCREASE = toFunctionSelector('function increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))')
const POLICY_INCREASE = toFunctionSelector('function increase((uint256,uint256,uint256,uint256,uint256,uint256))')

type Prepared = { calls: Execution[]; quote?: { amountIn: bigint; amountOut: bigint; amountOutMinimum: bigint } }

function session(name: string): EngineSession {
  const grant: SessionGrant = {
    policyId: 'test', policyHash: `0x${'00'.repeat(32)}`, name: name as SessionGrant['name'], salt: `0x${'02'.repeat(32)}`, chainId: 8453, account: ACCOUNT,
    sessionValidator: 'OwnableValidator', sessionKey: sessionKey.address,
    userOp: { validAfter: 0, validUntil: 2_000_000_000, usageLimit: 100 },
    permitERC4337Paymaster: false, erc7739: 'none', fallbackAction: 'none', actions: [],
  }
  return { name, grant, permissionId: `0x${'00'.repeat(32)}` }
}

/** The V2 policy on the fake chain: `admitted` tokenIds (to POOL), and the guardian's pause. */
function policyAt(chain: FakeChain, state: { admitted: Set<bigint>; paused: boolean }): void {
  chain.contracts.set(POLICY_V2.toLowerCase(), (data: Hex) => {
    const call = decodeFunctionData({ abi: mamoruActionPolicyV2Abi, data })
    if (call.functionName === 'isPaused') return encodeFunctionResult({ abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', result: state.paused })
    if (call.functionName === 'admittedPool') return encodeFunctionResult({ abi: mamoruActionPolicyV2Abi, functionName: 'admittedPool', result: state.admitted.has(call.args[1] as bigint) ? entry(POOL, baseRegistry).address : zeroAddress })
    throw new Revert('unknown policy call')
  })
}

async function withEngine<T>(policy: PolicyVersion, fn: (e: Engine, chain: FakeChain, state: { admitted: Set<bigint>; paused: boolean }) => Promise<T>): Promise<T> {
  const chain = new FakeChain()
  chain.code.set(ACCOUNT.toLowerCase(), '0x6001')
  const state = { admitted: new Set<bigint>(), paused: false }
  policyAt(chain, state)
  const rpc = chain.serve()
  try {
    const e = new Engine(
      { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: rpc.url, bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 800n, historyFromBlock: 800n, sessions: [] },
      { waitBlock: async () => {} },
    )
    return await fn(e, chain, state)
  } finally {
    rpc.stop()
  }
}

const prepare = (e: Engine, p: Proposal, s: EngineSession): Promise<Prepared> =>
  (e as unknown as { prepareCalls: (p: Proposal, b: bigint, t: bigint, s: EngineSession) => Promise<Prepared> }).prepareCalls(p, 1000n, 1_790_002_000n, s)

async function code(f: () => Promise<unknown>): Promise<string> {
  try {
    await f()
  } catch (e) {
    if (e instanceof ReasonError) return e.code
    throw e
  }
  return 'OK'
}

// FakeChain: positions span ticks -600..600; the btc pool's slot0 tick is 10 and both TWAPs read -2.
const increase = (tokenId: bigint, over: Partial<Extract<Proposal, { kind: 'increase_liquidity' }>> = {}): Proposal => ({
  kind: 'increase_liquidity', grant: `manage-any:${POOL}`, pool: POOL, tokenId, tickLower: -600, tickUpper: 600, amount0Desired: 1_000_000n, amount1Desired: 1_000_000n, ...over,
})

describe('increase through MamoruActionPolicyV2 (otto/mamoru#171)', () => {
  test('approve the policy for the desired amounts, then the policy\'s increase; nothing at the position manager', async () => {
    await withEngine(V5, async (e, chain, state) => {
      chain.addPosition(ACCOUNT, 7n, POOL)
      state.admitted.add(7n)
      const out = await prepare(e, increase(7n), session(`manage-any:${POOL}`))
      expect(out.calls.map((c) => c.target)).toEqual([address('USDC', baseRegistry), address('cbBTC', baseRegistry), POLICY_V2])
      for (const c of out.calls.slice(0, 2)) expect(decodeFunctionData({ abi: erc20Abi, data: c.callData }).args).toEqual([POLICY_V2, 1_000_000n])
      expect(out.calls[2]!.callData.startsWith(POLICY_INCREASE)).toBe(true)
      const d = decodeFunctionData({ abi: mamoruActionPolicyV2Abi, data: out.calls[2]!.callData })
      expect(d.args[0]).toMatchObject({ tokenId: 7n, amount0Desired: 1_000_000n, amount1Desired: 1_000_000n })
      const args = d.args[0] as { amount0Min: bigint; amount1Min: bigint; deadline: bigint }
      expect(args.amount0Min > 0n && args.amount1Min > 0n && args.deadline > 0n).toBe(true)
      expect(out.calls.some((c) => c.callData.startsWith(NPM_INCREASE) || c.target === address('NonfungiblePositionManager', baseRegistry))).toBe(false)
    })
  })

  test('refused before anything is signed: not admitted, not owned, another range, or no V2 policy', async () => {
    await withEngine(V5, async (e, chain, state) => {
      chain.addPosition(ACCOUNT, 7n, POOL)
      chain.addPosition('0x00000000000000000000000000000000000000cc', 8n, POOL)
      state.admitted.add(8n)
      expect(await code(() => prepare(e, increase(7n), session(`manage-any:${POOL}`)))).toBe('POLICY_NOT_ADMITTED')
      expect(await code(() => prepare(e, increase(8n), session(`manage-any:${POOL}`)))).toBe('POLICY_DENIED_POSITION')
      state.admitted.add(7n)
      expect(await code(() => prepare(e, increase(7n, { tickLower: -660 }), session(`manage-any:${POOL}`)))).toBe('OP_DECISION_STALE')
    })
    await withEngine(V4, async (e, chain, state) => {
      chain.addPosition(ACCOUNT, 7n, POOL)
      state.admitted.add(7n)
      expect(await code(() => prepare(e, increase(7n), session(`manage-any:${POOL}`)))).toBe('SESSION_MISSING')
    })
  })
})

describe('guardian pause (MamoruActionPolicyV2)', () => {
  test('a paused account: every op waits with POLICY_PAUSED; unpaused it prepares again', async () => {
    await withEngine(V5, async (e, chain, state) => {
      chain.addPosition(ACCOUNT, 7n, POOL)
      state.admitted.add(7n)
      state.paused = true
      const swap: Proposal = { kind: 'enter_swap', grant: `enter-swap:${POOL}`, pool: POOL, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 1_000_000n }
      expect(await code(() => prepare(e, swap, session(`enter-swap:${POOL}`)))).toBe('POLICY_PAUSED')
      expect(await code(() => prepare(e, increase(7n), session(`manage-any:${POOL}`)))).toBe('POLICY_PAUSED')
      state.paused = false
      expect(await code(() => prepare(e, swap, session(`enter-swap:${POOL}`)))).toBe('OK')
    })
  })

  test('the deployed V1 (v4) has no pause: no isPaused read', async () => {
    await withEngine(V4, async (e, chain) => {
      const swap: Proposal = { kind: 'enter_swap', grant: `enter-swap:${POOL}`, pool: POOL, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 1_000_000n }
      await prepare(e, swap, session(`enter-swap:${POOL}`))
      const isPaused = toFunctionSelector('function isPaused(address)')
      expect(chain.requests.some((r) => r.method === 'eth_call' && String(r.params[0]?.data ?? '').startsWith(isPaused))).toBe(false)
    })
  })
})

describe('swaps under V2: quoted with the price limit, sized down to fill (#151 review P1-3)', () => {
  test('a size that does not meet the bound is halved until it does; the prepared quote names the size sent', async () => {
    await withEngine(V5, async (e, chain) => {
      chain.quoteAmountOut = ({ amountIn }) => (amountIn > 500_000n ? amountIn / 2n : amountIn)
      const swap: Proposal = { kind: 'enter_swap', grant: `enter-swap:${POOL}`, pool: POOL, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 2_000_000n }
      const out = await prepare(e, swap, session(`enter-swap:${POOL}`))
      expect(out.quote?.amountIn).toBe(500_000n)
      const s = decodeFunctionData({ abi: swapRouter02Abi, data: out.calls.at(-1)!.callData })
      const params = s.args[0] as { amountIn: bigint; sqrtPriceLimitX96: bigint }
      expect(params.amountIn).toBe(500_000n)
      expect(params.sqrtPriceLimitX96).not.toBe(0n)
    })
  })

  test('no size fills within the bound: not sent', async () => {
    await withEngine(V5, async (e, chain) => {
      chain.quoteAmountOut = ({ amountIn }) => amountIn / 2n
      const swap: Proposal = { kind: 'enter_swap', grant: `enter-swap:${POOL}`, pool: POOL, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 2_000_000n }
      expect(await code(() => prepare(e, swap, session(`enter-swap:${POOL}`)))).toBe('EHG_PRICE_DIVERGENCE')
      expect(V4_SWAP_SIZE_DOWN_STEPS).toBe(4)
    })
  })
})

describe('observation: admitted positions (otto/mamoru#171)', () => {
  const obs = (positions: Observation['positions']) => ({ block: { number: 1000n }, positions }) as unknown as Observation
  const pos = (tokenId: bigint, pool: string | null) => ({ tokenId, pool, tickLower: -600, tickUpper: 600, liquidity: 1n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true })
  const withAdmission = (e: Engine, o: Observation): Promise<Observation> => (e as unknown as { withAdmission: (o: Observation) => Promise<Observation> }).withAdmission(o)

  test('v5: each position of a pool the policy can increase in is marked admitted or not, from admittedPool', async () => {
    await withEngine(V5, async (e, _chain, state) => {
      state.admitted.add(7n)
      const out = await withAdmission(e, obs([pos(7n, POOL), pos(8n, POOL), pos(9n, null)]))
      expect(out.positions.map((p) => p.admitted)).toEqual([true, false, undefined])
    })
  })

  test('v4 (no increase action): unchanged, and no read', async () => {
    await withEngine(V4, async (e, chain) => {
      const o = obs([pos(7n, POOL)])
      expect(await withAdmission(e, o)).toBe(o)
      expect(chain.requests.length).toBe(0)
    })
  })
})

// otto/mamoru#189 for v5: v5 merges convert-any into manage-any like v4, so every convert names the pool's manage-any,
// whose v5 session also holds the swap deadline under MamoruActionPolicyV2.
describe('v5 converts go through the merged manage-any session (#189)', () => {
  test('convertKey: manage-any of the pool under v5; convert-any (unchanged) under v2', () => {
    for (const p of Object.values(V4_POOLS)) expect(convertKey(V5, p.pool)).toBe(`manage-any:${p.pool}`)
    const v2 = POLICIES['conservador-live-v2']!
    expect<string>(convertKey(v2, POOL)).toBe(grantKeyFor(v2, 'convert-any', POOL))
  })

  test('a convert swap under the real v5 manage-any grant: deadline + approve + swap, and it passes that grant\'s pre-check', async () => {
    const key = `manage-any:${POOL}`
    const caps = computeCaps(conservadorLiveV5, 10_000n * 1_000_000n, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } })
    const grant = retargetToPolicy(instantiateGrant(conservadorLiveV5, key, { account: ACCOUNT, sessionKey: sessionKey.address, chainId: 8453, salt: `0x${'03'.repeat(32)}`, validAfter: 0, validUntil: 2_000_000_000, caps }), POLICY_V2)
    const s: EngineSession = { name: key, grant, permissionId: `0x${'0c'.repeat(32)}` }
    const convert: Proposal = { kind: 'enter_swap', grant: convertKey(V5, POOL) as never, pool: POOL, tokenIn: 'cbBTC', tokenOut: 'USDC', fee: 500, amountIn: 50_000n }
    await withEngine(V5, async (e) => {
      const prepared = await prepare(e, convert, s)
      expect(prepared.calls[0]!.callData.startsWith('0x5ae401dc')).toBe(true) // multicall(deadline, [])
      const ledger = new SessionLedger()
      ledger.activate(s.permissionId, s.grant)
      const r = precheck({ sender: ACCOUNT, callData: executeCallData(prepared.calls), signature: useModeSignature(s.permissionId, '0x') }, { chainId: 8453, now: 1_000, ledger })
      expect(r).toMatchObject({ ok: true })
    })
  })
})

