import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, type Hex, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import type { Proposal } from '@mamoru/decide'
import { conservadorLabIncreaseV1, instantiateGrant } from '@mamoru/policy'
import { address, entry, erc20Abi, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import { precheck, SessionLedger } from '@mamoru/account/precheck'
import { executeCallData, permissionIdOf, toSmartSession, useModeSignature } from '@mamoru/account/sessions'
import type { Simulation } from '@mamoru/rpc'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { Engine, type EngineSession } from './engine.ts'

// otto/mamoru#171: the engine's increaseLiquidity batch, and what the session grants admit of it.
const policy = conservadorLabIncreaseV1
const CHAIN = 31337
const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const POOL = 'pool:WETH/USDC/3000'
const TICK = -193_380
const RANGE = { tickLower: -194_400, tickUpper: -192_420 }
const WINDOW = BigInt(policy.execution.twapWindowSeconds)
const sessionKey = privateKeyToAccount(generatePrivateKey())
const caps = new Proxy({}, { get: () => 10n ** 30n }) as Record<string, bigint>

function session(key: string, tokenId?: bigint): EngineSession {
  const grant = instantiateGrant(policy, key, { account: ACCOUNT, sessionKey: sessionKey.address, chainId: CHAIN, salt: `0x${'01'.repeat(32)}`, validAfter: 0, validUntil: 2_000_000_000, caps, ...(tokenId ? { tokenId, admittedTokenIds: [tokenId] } : {}) })
  return { name: tokenId ? `${grant.name}:${tokenId}` : key, grant, permissionId: permissionIdOf(toSmartSession(grant)) }
}

const proposal: Proposal = { kind: 'increase_liquidity', grant: 'increase:3', pool: POOL, tokenId: 3n, ...RANGE, amount0Desired: 10n ** 15n, amount1Desired: 4_000_000n }

/** An engine whose pool sits at `tick` (spot and TWAP) and whose position 3 has `pos` ticks in `pool`'s tokens. */
function engineAt(chain: { tick?: number; pos?: { tickLower: number; tickUpper: number }; posPool?: string } = {}) {
  const tick = chain.tick ?? TICK
  const pos = chain.pos ?? RANGE
  const pe = entry(chain.posPool ?? POOL)
  const e = new Engine(
    { mode: 'lab', chainId: CHAIN, signingChainIds: [CHAIN], rpcUrl: 'http://127.0.0.1:9/', bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 0n, historyFromBlock: 0n, sessions: [] },
    { waitBlock: async () => {} },
  )
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'slot0') return [sqrtRatioAtTick(tick), tick, 0, 0, 0, 0, true]
      if (functionName === 'observe') return [[0n, BigInt(tick) * WINDOW], [0n, 0n]]
      if (functionName === 'positions') return [0n, address('NonfungiblePositionManager'), address(pe.token0!), address(pe.token1!), pe.fee!, pos.tickLower, pos.tickUpper, 10n ** 12n, 0n, 0n, 0n, 0n]
      throw new Error(`unexpected read ${functionName}`)
    },
  } as unknown as PublicClient
  ;(e as unknown as { client: PublicClient }).client = client
  return e as unknown as {
    prepareCalls(p: Proposal, block: bigint, timestamp: bigint, s: EngineSession): Promise<{ calls: { target: Address; callData: Hex }[]; expiresAt: bigint | null }>
    deltaMismatch(p: Proposal, prepared: unknown, sim: Pick<Simulation, 'deltas' | 'nftDelta'>): string | null
  }
}

function check(s: EngineSession, calls: { target: Address; callData: Hex }[]) {
  const ledger = new SessionLedger()
  ledger.activate(s.permissionId, s.grant)
  return precheck({ sender: ACCOUNT, callData: executeCallData(calls.map((c) => ({ target: c.target, value: 0n, callData: c.callData }))), signature: useModeSignature(s.permissionId, '0x') }, { chainId: CHAIN, now: 1_000, ledger })
}

describe('engine increaseLiquidity (otto/mamoru#171)', () => {
  test('exact approvals, increaseLiquidity on the held tokenId with positive minimums and the deadline, approvals back to 0', async () => {
    const p = await engineAt().prepareCalls(proposal, 100n, 1_000n, session('increase:pool:WETH/USDC/3000', 3n))
    const deadline = 1_000n + BigInt(policy.execution.observationTtlSeconds)
    expect(p.expiresAt).toBe(deadline)
    expect(p.calls.map((c) => c.target)).toEqual([address('WETH'), address('USDC'), address('NonfungiblePositionManager'), address('WETH'), address('USDC')])
    const approvals = [0, 1, 3, 4].map((i) => decodeFunctionData({ abi: erc20Abi, data: p.calls[i]!.callData }).args)
    expect(approvals).toEqual([
      [address('NonfungiblePositionManager'), 10n ** 15n],
      [address('NonfungiblePositionManager'), 4_000_000n],
      [address('NonfungiblePositionManager'), 0n],
      [address('NonfungiblePositionManager'), 0n],
    ])
    const inc = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: p.calls[2]!.callData })
    expect(inc.functionName).toBe('increaseLiquidity')
    const a = inc.args![0] as { tokenId: bigint; amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint }
    expect([a.tokenId, a.amount0Desired, a.amount1Desired, a.deadline]).toEqual([3n, 10n ** 15n, 4_000_000n, deadline])
    expect(a.amount0Min > 0n && a.amount1Min > 0n).toBe(true)
  })

  test("the pre-check admits it under that tokenId's increase grant only; manage-any, enter-mint and another tokenId's grant refuse it", async () => {
    const own = session('increase:pool:WETH/USDC/3000', 3n)
    const { calls } = await engineAt().prepareCalls(proposal, 100n, 1_000n, own)
    expect(check(own, calls)).toMatchObject({ ok: true })
    expect(check(session('increase:pool:WETH/USDC/3000', 4n), calls)).toMatchObject({ ok: false, code: 'POLICY_DENIED_POSITION' })
    // No grant an owner already signs holds increaseLiquidity (SESS-13 for `manage`).
    expect(check(session('manage-any:pool:WETH/USDC/3000'), calls)).toMatchObject({ ok: false, code: 'POLICY_DENIED_TARGET' })
    expect(check(session('enter-mint:pool:WETH/USDC/3000'), calls)).toMatchObject({ ok: false, code: 'POLICY_DENIED_TARGET' })
  })

  test('a position that is no longer the one decided on (range, pool) or a price outside it: no call is built', async () => {
    const s = session('increase:pool:WETH/USDC/3000', 3n)
    await expect(engineAt({ pos: { tickLower: RANGE.tickLower + 60, tickUpper: RANGE.tickUpper } }).prepareCalls(proposal, 100n, 1_000n, s)).rejects.toMatchObject({ code: 'EHG_OBSERVATION_STALE' })
    await expect(engineAt({ posPool: 'pool:USDC/cbBTC/500' }).prepareCalls(proposal, 100n, 1_000n, s)).rejects.toMatchObject({ code: 'EHG_OBSERVATION_STALE' })
    await expect(engineAt({ tick: RANGE.tickUpper + 10 }).prepareCalls(proposal, 100n, 1_000n, s)).rejects.toMatchObject({ code: 'EHG_OBSERVATION_STALE' })
  })

  test('the simulation must move no NFT and take no more than the desired amounts', () => {
    const e = engineAt()
    const ok = { nftDelta: 0n, deltas: { WETH: -(10n ** 15n), USDC: -3_900_000n } }
    expect(e.deltaMismatch(proposal, {}, ok)).toBeNull()
    expect(e.deltaMismatch(proposal, {}, { ...ok, nftDelta: 1n })).toBe('positions changed by 1, intent 0')
    expect(e.deltaMismatch(proposal, {}, { ...ok, deltas: { WETH: -(10n ** 15n), USDC: -4_000_001n } })).toContain('USDC moved')
  })
})
