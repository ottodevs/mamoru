// otto/mamoru#293 (review of #202, round 2, Argon 1): under MamoruActionPolicyV4 (contractVersion 4) every step the engine
// can propose reaches the chain only through V4 or the position manager's exits: a swap of any purpose (an entry, a
// convert/sale of the volatile side) is `approve(V4) + V4.swap`, never SwapRouter02; mints and increases go through V4;
// decrease/collect/burn go to the manager; a bridge is `approve(V4) + V4.bridge`. Each prepared batch also passes the
// precheck mirror of V4's checkAction. Decide's proposal kinds: enter_swap (entries and converts), enter_mint,
// increase_liquidity, harvest, rerange, reduce, bridge_out: all walked here.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, getAddress, toFunctionSelector, zeroAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import type { Proposal } from '@mamoru/decide'
import { oneAuthV4Live, staticPool, withRegistryPools, type RegistryPool, type SessionGrant } from '@mamoru/policy'
import { address, baseRegistry, entry, mamoruActionPolicyV2Abi } from '@mamoru/registry'
import { precheck, SessionLedger } from '@mamoru/account/precheck'
import { executeCallData, useModeSignature } from '@mamoru/account/sessions'
import type { Execution } from '@mamoru/account/safe'
import { FakeChain, Revert } from '../../rpc/test/fake-chain.ts'
import { Engine, type BridgeSigning, type EngineHooks, type EngineSession } from './engine.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const V4 = '0x00000000000000000000000000000000000000b4' as Address
const POOL = 'pool:USDC/cbBTC/500'
const REMOTE = '0x00000000000000000000000000000000000000cc' as Address
const sessionKey = privateKeyToAccount(generatePrivateKey())
const pool = (name: string): RegistryPool => ({ ...staticPool(name, baseRegistry), entry: { twapWindow: 1800, twapShortWindow: 300, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 10_000, active: true } })
const { policy } = withRegistryPools(oneAuthV4Live, { policy: V4, gasPolicy: '0x00000000000000000000000000000000000000b5' }, [pool(POOL)], baseRegistry)
const ROUTER = address('SwapRouter02', baseRegistry).toLowerCase()
const NPM = address('NonfungiblePositionManager', baseRegistry)

const grant = { policyId: 'one-auth-v4', policyHash: `0x${'00'.repeat(32)}`, name: 'manage-any', salt: `0x${'02'.repeat(32)}`, chainId: 8453, account: ACCOUNT, sessionValidator: 'OwnableValidator', sessionKey: sessionKey.address, userOp: { validAfter: 0, validUntil: 2 ** 32 - 1, usageLimit: 2 ** 31 - 1 }, permitERC4337Paymaster: false, erc7739: 'none', fallbackAction: 'none', actions: [], requiresActionPolicy: true, actionPolicyOnly: true, oneAuthV4: { policy: V4, npm: NPM } } as unknown as SessionGrant
const session: EngineSession = { name: `manage-any:${POOL}`, grant, permissionId: `0x${'0d'.repeat(32)}` }

async function withEngine<T>(fn: (e: Engine, chain: FakeChain) => Promise<T>, hooks: Partial<EngineHooks> = {}): Promise<T> {
  const chain = new FakeChain()
  chain.code.set(ACCOUNT.toLowerCase(), '0x6001')
  chain.contracts.set(V4.toLowerCase(), (data: Hex) => {
    const call = decodeFunctionData({ abi: mamoruActionPolicyV2Abi, data })
    if (call.functionName === 'isPaused') return encodeFunctionResult({ abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', result: false })
    if (call.functionName === 'admittedPool') return encodeFunctionResult({ abi: mamoruActionPolicyV2Abi, functionName: 'admittedPool', result: entry(POOL, baseRegistry).address })
    throw new Revert('unknown V4 call')
  })
  const rpc = chain.serve()
  try {
    const e = new Engine(
      { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: rpc.url, bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 800n, historyFromBlock: 800n, sessions: [], v4BridgeRecipient: () => REMOTE },
      { waitBlock: async () => {}, ...hooks },
    )
    return await fn(e, chain)
  } finally {
    rpc.stop()
  }
}
const prepare = (e: Engine, p: Proposal): Promise<{ calls: Execution[] }> => (e as unknown as { prepareCalls: (p: Proposal, b: bigint, t: bigint, s: EngineSession) => Promise<{ calls: Execution[] }> }).prepareCalls(p, 1000n, 1_790_002_000n, session)

const passesV4Precheck = (calls: Execution[]) => {
  const ledger = new SessionLedger()
  ledger.activate(session.permissionId, grant)
  return precheck({ sender: ACCOUNT, callData: executeCallData(calls), signature: useModeSignature(session.permissionId, '0x') }, { chainId: 8453, now: 1_000, ledger })
}

const kinds: [string, Proposal][] = [
  ['enter_swap (entry)', { kind: 'enter_swap', grant: `manage-any:${POOL}`, pool: POOL, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 1_000_000n } as Proposal],
  ['enter_swap (convert: sell the volatile side)', { kind: 'enter_swap', grant: `manage-any:${POOL}`, pool: POOL, tokenIn: 'cbBTC', tokenOut: 'USDC', fee: 500, amountIn: 1_000n } as Proposal],
  ['enter_mint', { kind: 'enter_mint', grant: `manage-any:${POOL}`, pool: POOL, tickLower: -600, tickUpper: 600, amount0Desired: 1_000_000n, amount1Desired: 1_000n } as Proposal],
  ['increase_liquidity', { kind: 'increase_liquidity', grant: `manage-any:${POOL}`, pool: POOL, tokenId: 7n, tickLower: -600, tickUpper: 600, amount0Desired: 1_000_000n, amount1Desired: 1_000_000n } as Proposal],
  ['rerange', { kind: 'rerange', grant: `manage-any:${POOL}`, pool: POOL, tokenId: 7n } as unknown as Proposal],
  ['reduce', { kind: 'reduce', grant: `manage-any:${POOL}`, pool: POOL, tokenId: 7n, liquidity: 1n } as unknown as Proposal],
  ['harvest', { kind: 'harvest', grant: `manage-any:${POOL}`, pool: POOL, tokenId: 7n } as unknown as Proposal],
  ['bridge_out', { kind: 'bridge_out', grant: 'bridge-out', bucket: 'growth', chainId: 143, pool: 'pool:WMON/USDC/3000', amount: 1_000_000n } as unknown as Proposal],
]

describe('V4: every engine step goes through V4 or the manager exits, never SwapRouter02', () => {
  for (const [name, p] of kinds) {
    test(name, async () => {
      await withEngine(async (e, chain) => {
        chain.addPosition(ACCOUNT, 7n, POOL)
        const out = await prepare(e, p)
        expect(out.calls.length).toBeGreaterThan(0)
        for (const c of out.calls) {
          expect(c.target.toLowerCase()).not.toBe(ROUTER)
          if (c.callData.startsWith('0x095ea7b3')) expect((decodeFunctionData({ abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }], data: c.callData }).args[0] as string).toLowerCase()).toBe(V4.toLowerCase())
        }
        if (p.kind === 'enter_swap') expect(out.calls.at(-1)!.callData.startsWith(toFunctionSelector('function swap((address,address,uint256,uint256,uint160,uint256))'))).toBe(true)
        expect(passesV4Precheck(out.calls)).toMatchObject({ ok: true })
      })
    })
  }
  void zeroAddress
})

describe('V4 bridge journal (#293): the burn is journaled with V4 as its depositor', () => {
  test('beforeBridgeSign gets depositor = V4, recipient = the ready remote', async () => {
    const got: BridgeSigning[] = []
    const p = { kind: 'bridge_out', grant: 'bridge-out', bucket: 'growth', chainId: 143, pool: 'pool:WMON/USDC/3000', amount: 1_000_000n } as unknown as Proposal
    await withEngine(async (e) => {
      const err = (e as unknown as { journalBridge: (opId: string, p: Proposal, h: Hex, n: bigint, b: bigint) => string | null }).journalBridge('op-1', p, `0x${'33'.repeat(32)}`, 5n, 1000n)
      expect(err).toBeNull()
    }, { beforeBridgeSign: (b) => void got.push(b) })
    expect(got).toHaveLength(1)
    expect(getAddress(got[0]!.depositor)).toBe(getAddress(V4))
    expect(getAddress(got[0]!.recipient)).toBe(getAddress(REMOTE))
  })
})

describe('V4 bridge to this chain (#278): refused before any call is built', () => {
  test('bridge_out with chainId = the engine chain is POLICY_DENIED_TARGET', async () => {
    const p = { kind: 'bridge_out', grant: 'bridge-out', bucket: 'growth', chainId: 8453, pool: 'pool:WMON/USDC/3000', amount: 1_000_000n } as unknown as Proposal
    await withEngine(async (e) => {
      await expect(prepare(e, p)).rejects.toThrow('POLICY_DENIED_TARGET')
    })
  })
})
