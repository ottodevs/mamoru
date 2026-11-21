// otto/mamoru#427: a chain exit's reduce through the engine. It takes the whole position out and burns the NFT
// (decrease, collect, burn: nothing leaves the account), burns only when it takes every unit the chain shows, and every
// call it makes, and the WMON sale that follows, is an action of the Monad Safe's one session (manageAnyV3Only on
// WMON/USDC): no new grant is needed. `prepareCalls` is private; reached with a cast, like engine-v4-bounds.test.ts.
// The FakeChain serves Base's registry, so the calls are mapped back to registry names before they are compared.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, toFunctionSelector, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import type { Proposal } from '@mamoru/decide'
import { POLICIES, liveWmonUsdcMonadV6, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { baseRegistry, address, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import type { Execution } from '@mamoru/account/safe'
import { FakeChain } from '../../rpc/test/fake-chain.ts'
import { Engine, type EngineSession } from './engine.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const POOL = 'pool:USDC/cbBTC/500'
const TOKEN_ID = 42n
const sessionKey = privateKeyToAccount(generatePrivateKey())

type Prepared = { calls: Execution[] }

function session(grantName: string): EngineSession {
  const grant: SessionGrant = {
    policyId: 'test', policyHash: `0x${'00'.repeat(32)}`, name: grantName as SessionGrant['name'], salt: `0x${'02'.repeat(32)}`, chainId: 8453, account: ACCOUNT,
    sessionValidator: 'OwnableValidator', sessionKey: sessionKey.address,
    userOp: { validAfter: 0, validUntil: 2_000_000_000, usageLimit: 100 },
    permitERC4337Paymaster: false, erc7739: 'none', fallbackAction: 'none', actions: [],
  }
  return { name: grantName, grant, permissionId: `0x${'00'.repeat(32)}` }
}

async function withEngine<T>(policy: PolicyVersion, fn: (e: Engine, chain: FakeChain) => Promise<T>): Promise<T> {
  const chain = new FakeChain()
  chain.code.set(ACCOUNT.toLowerCase(), '0x6001')
  const rpc = chain.serve()
  try {
    const e = new Engine(
      { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: rpc.url, bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 800n, historyFromBlock: 800n, sessions: [] },
      { waitBlock: async () => {} },
    )
    return await fn(e, chain)
  } finally {
    rpc.stop()
  }
}

const prepare = (e: Engine, p: Proposal, chain: FakeChain): Promise<Prepared> =>
  (e as unknown as { prepareCalls: (p: Proposal, b: bigint, t: bigint, s: EngineSession) => Promise<Prepared> }).prepareCalls(p, chain.head, 1_790_000_000n + chain.head * 2n, session(p.grant))

/** Registry name and selector of a call on the FakeChain (Base addresses). */
function named(c: Execution): string {
  const name = baseRegistry.entries.find((v) => v.address.toLowerCase() === c.target.toLowerCase())?.name
  return `${name}|${c.callData.slice(0, 10)}`
}

/** The Monad Safe's session, as registry name and selector per action. */
const MONAD_GRANT = new Set(liveWmonUsdcMonadV6.session.grants.flatMap((g) => g.actions.map((a) => `${a.target}|${toFunctionSelector(`function ${a.signature}`)}`)))

describe('chain exit reduce through the engine (otto/mamoru#427)', () => {
  test('burn: the whole position is decreased, collected to the Safe and burnt; each call is an action of the Monad session', async () => {
    await withEngine(POLICIES['conservador-live-v2']!, async (e, chain) => {
      chain.addPosition(ACCOUNT, TOKEN_ID, POOL)
      const pos = chain.positions.find((p) => p.tokenId === TOKEN_ID)!
      const out = await prepare(e, { kind: 'reduce', grant: 'manage-any', pool: POOL, tokenId: TOKEN_ID, liquidity: pos.liquidity, burn: true }, chain)
      expect(out.calls.map((c) => decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: c.callData as Hex }).functionName)).toEqual(['decreaseLiquidity', 'collect', 'burn'])
      expect(out.calls.every((c) => c.target.toLowerCase() === address('NonfungiblePositionManager', baseRegistry).toLowerCase())).toBe(true)
      const collect = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: out.calls[1]!.callData as Hex })
      expect((collect.args[0] as { recipient: Address }).recipient.toLowerCase()).toBe(ACCOUNT)
      for (const c of out.calls) expect(MONAD_GRANT.has(named(c))).toBe(true)
    })
  })

  test('no burn when the proposal asks for less than the chain shows, or does not ask', async () => {
    await withEngine(POLICIES['conservador-live-v2']!, async (e, chain) => {
      chain.addPosition(ACCOUNT, TOKEN_ID, POOL)
      const pos = chain.positions.find((p) => p.tokenId === TOKEN_ID)!
      const part = await prepare(e, { kind: 'reduce', grant: 'manage-any', pool: POOL, tokenId: TOKEN_ID, liquidity: pos.liquidity - 1n, burn: true }, chain)
      expect(part.calls.length).toBe(2)
      const plain = await prepare(e, { kind: 'reduce', grant: 'manage-any', pool: POOL, tokenId: TOKEN_ID, liquidity: pos.liquidity }, chain)
      expect(plain.calls.length).toBe(2)
    })
  })

  test('the WMON sale that follows is in the same session: WMON approve and SwapRouter02 exactInputSingle', () => {
    expect(MONAD_GRANT.has(`WMON|${toFunctionSelector('function approve(address,uint256)')}`)).toBe(true)
    expect(MONAD_GRANT.has(`SwapRouter02|${toFunctionSelector('function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))')}`)).toBe(true)
  })

  test('the simulation check expects one position fewer only when the prepared batch burns it', async () => {
    await withEngine(POLICIES['conservador-live-v2']!, async (e, chain) => {
      chain.addPosition(ACCOUNT, TOKEN_ID, POOL)
      const pos = chain.positions.find((p) => p.tokenId === TOKEN_ID)!
      const check = (p: Proposal, prepared: Prepared, nftDelta: bigint) =>
        (e as unknown as { deltaMismatch: (p: Proposal, prepared: Prepared, sim: unknown) => string | null }).deltaMismatch(p, prepared, { block: chain.head, ok: true, deltas: {}, nftDelta, gasUsed: 0n, logs: [] })
      const full: Proposal = { kind: 'reduce', grant: 'manage-any', pool: POOL, tokenId: TOKEN_ID, liquidity: pos.liquidity, burn: true }
      const burnt = await prepare(e, full, chain)
      expect(check(full, burnt, -1n)).toBeNull()
      expect(check(full, burnt, 0n)).toContain('intent -1')
      const part: Proposal = { ...full, liquidity: pos.liquidity - 1n }
      const kept = await prepare(e, part, chain)
      expect(check(part, kept, 0n)).toBeNull()
      expect(check(part, kept, -1n)).toContain('intent 0')
      const plain: Proposal = { kind: 'reduce', grant: 'manage-any', pool: POOL, tokenId: TOKEN_ID, liquidity: pos.liquidity }
      expect(check(plain, await prepare(e, plain, chain), -1n)).toContain('intent 0')
    })
  })
})
