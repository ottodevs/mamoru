// otto/mamoru#140 (part2 #3-#7): a small fake Base for the owner-flow hardening tests (owner-hardening.test.ts): one
// counterfactual Safe, its USDC and ETH, position NFTs in the USDC/cbBTC 0.05% pool, the relayer, and optional
// trusted providers. Kept apart from over-cap.test.ts's world so the two evolve without stepping on each other.
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, stringToHex, toFunctionSelector, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import type { AccountContext, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, entry, nonfungiblePositionManagerAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { deployCall, liveAccountFromContext } from '@mamoru/account/live'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'
import { answerAggregate3 } from './fake-multicall.ts'

export const RELAYER = `0x${'7'.repeat(40)}` as const
export const TO = getAddress(`0x${'c'.repeat(40)}`)
const EXECUTION_SUCCESS = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'))
const TRUE = `0x${'0'.repeat(63)}1` as const
const POOL = 'pool:USDC/cbBTC/500'

export const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
export const odd = new SoftwarePasskey(PASSKEY_SCALARS.a2)
const owners = [address('SafeWebAuthnSharedSigner')]
const saltNonce = 42n
export const ctx: AccountContext = {
  accountKey: 'k',
  chainId: 8453,
  address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))),
  owners,
  saltNonce: saltNonce.toString(),
  passkey: { credentialId: 'unit', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
}
export const SAFE = ctx.address

export type Answer = 'ok' | 'revert' | 'down' | 'empty'

/** A trusted provider: answers eth_simulateV1 and eth_call of execTransaction with `answer`. */
export function trusted(answer: { v: Answer }): PublicClient {
  return {
    getBlockNumber: async () => 100n,
    request: async ({ params }: { params: [{ blockStateCalls: [{ calls: unknown[] }] }] }) => {
      if (answer.v === 'down') throw new Error('HTTP request failed. Status: 429')
      const calls = params[0].blockStateCalls[0].calls
      const last = calls.length - 1
      return [{ calls: calls.map((_, i) => (answer.v === 'revert' && i === last ? { status: '0x0', returnData: '0x', gasUsed: '0x5208', logs: [], error: { message: 'GS026' } } : { status: '0x1', returnData: answer.v === 'empty' && i === last ? '0x' : TRUE, gasUsed: '0x5208', logs: [] })) }]
    },
    call: async () => {
      if (answer.v === 'down') throw new Error('HTTP request failed. Status: 429')
      if (answer.v === 'revert') throw Object.assign(new Error('execution reverted: GS026'), { code: 3, data: '0x08c379a0' })
      return { data: answer.v === 'empty' ? '0x' : TRUE }
    },
  } as unknown as PublicClient
}

export function world(usdc: bigint, cfgExtra: Partial<OperatorConfig> = {}) {
  const sent: { to: string; data?: Hex; value?: bigint }[] = []
  const chain = { deployed: false, usdc, nonce: 0n, safeEth: 0n, positions: [] as { tokenId: bigint; liquidity: bigint }[] }
  const knobs = {
    sim: 'ok' as Answer,
    call: 'ok' as Answer,
    /** Reads of position NFTs fail (an inventory too large for the provider). */
    npmDown: false,
    /** While set, every Multicall3 read waits for it. */
    stall: null as Promise<void> | null,
    gasPrice: 10_000_000n,
    /** Permissions the owner enabled again outside Mamoru (read enabled on top of the operator's own record). */
    reenabled: new Set<string>(),
    /** isPermissionEnabled throws (an unreadable chain). */
    grantsDown: false,
    /** otto/mamoru#163: execTransactions revert (GS013: the Safe nonce stays where it was) while false. */
    execOk: true,
    /** Receipts by relayer tx hash, and the Safe's ExecutionSuccess logs (`topics[1]`: the Safe tx hash). */
    receipts: new Map<string, TransactionReceipt>(),
    safeLogs: [] as { topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: bigint }[],
    /** The head `getBlock()` answers, and hashes a node answers for a height instead of its own. */
    blockHead: 100n,
    blockHashes: new Map<bigint, Hex>(),
    /** otto/mamoru#163: the Safe nonce at a past block (default: today's), and a node that cannot serve a block's logs by hash. */
    nonceAt: null as ((block: bigint) => bigint) | null,
    blockLogsDown: false,
    /** A log backend behind the chain: a range search answers empty, whatever happened. */
    rangeLogsLag: false,
    /** The Safe's guard slot, and every range-search request made (block ranges). */
    guard: `0x${'0'.repeat(64)}` as Hex,
    rangeScans: [] as { from: bigint; to: bigint }[],
  }
  const npmCalls: string[] = []
  let saves = 0
  const factory = deployCall(liveAccountFromContext(ctx))
  const npm = address('NonfungiblePositionManager').toLowerCase()
  const positionResult = (tokenId: bigint) => {
    const p = chain.positions.find((x) => x.tokenId === tokenId)
    if (!p) throw new Error('Invalid token ID')
    const e = entry(POOL)
    return encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'positions', result: [0n, `0x${'0'.repeat(40)}`, address(e.token0!), address(e.token1!), e.fee!, -600, 600, p.liquidity, 0n, 0n, 0n, 0n] })
  }
  const client = {
    getBlockNumber: async () => (knobs.blockHead > 101n ? knobs.blockHead : 101n), // at least the block its receipts land in (101): #60 never reads grants below it
    // A block has a hash of its own; `blockHashes` is what a read of that height by number answers instead (another
    // node, behind or on another view, than the one that gave the head).
    getBlock: async (a: { blockNumber?: bigint } = {}) => {
      const n = a.blockNumber ?? knobs.blockHead
      return { number: n, hash: (a.blockNumber !== undefined ? knobs.blockHashes.get(n) : undefined) ?? keccak256(stringToHex(`block-${n}`)), timestamp: 1_790_000_000n }
    },
    getGasPrice: async () => knobs.gasPrice,
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const r = knobs.receipts.get(hash.toLowerCase())
      if (r) return r
      throw new Error('no receipt')
    },
    getLogs: async (a: { blockHash?: Hex } = {}) => {
      // EIP-234, a block's logs by its hash: the Safe executions of that block, in order.
      if (a.blockHash) {
        if (knobs.blockLogsDown) throw new Error('HTTP request failed. Status: 503')
        return knobs.safeLogs.filter((l) => keccak256(stringToHex(`block-${l.blockNumber}`)) === a.blockHash).map((l, i) => ({ address: SAFE, logIndex: i, ...l }))
      }
      const r = a as { fromBlock?: bigint; toBlock?: bigint }
      knobs.rangeScans.push({ from: r.fromBlock ?? 0n, to: r.toBlock ?? 0n })
      return knobs.rangeLogsLag ? [] : knobs.safeLogs
    },
    getCode: async () => (chain.deployed ? '0x01' : undefined),
    getBalance: async ({ address: at }: { address: string }) => (at.toLowerCase() === RELAYER.toLowerCase() ? 10n ** 18n : at.toLowerCase() === SAFE.toLowerCase() ? chain.safeEth : 0n),
    getTransactionCount: async () => 5,
    readContract: async ({ address: at, functionName, args, blockNumber }: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      if (functionName === 'slot0') return [1n << 96n, 0, 0, 0, 0, 0, true]
      // #64: activations and engine swaps price at the pool TWAP; tick 0, as slot0.
      if (functionName === 'observe') return [[0n, 0n], [0n, 0n]]
      if (functionName === 'nonce') return blockNumber !== undefined && knobs.nonceAt ? knobs.nonceAt(blockNumber) : chain.nonce
      if (functionName === 'balanceOf' && at.toLowerCase() === npm) {
        if (knobs.npmDown) throw new Error('HTTP request failed. Status: 503')
        return BigInt(chain.positions.length)
      }
      if (functionName === 'balanceOf') return at.toLowerCase() === address('USDC').toLowerCase() ? chain.usdc : 0n
      if (functionName === 'isPermissionEnabled') return enabled(args?.[0])
      throw new Error(`unexpected read ${functionName}`)
    },
    request: async ({ method, params }: { method?: string; params: [{ blockStateCalls: [{ calls: { from?: string; to: string; data: Hex }[] }] }] }) => {
      // The Safe's guard slot (otto/mamoru#163): no guard unless a test sets one.
      if (method === 'eth_getStorageAt') return knobs.guard
      const calls = params[0].blockStateCalls[0].calls
      if (knobs.sim === 'down') throw new Error('the method eth_simulateV1 does not exist')
      const last = calls.length - 1
      return [
        {
          calls: calls.map((c, i) => {
            if (knobs.sim === 'revert' && i === last) return { status: '0x0', returnData: '0x', gasUsed: '0x5208', logs: [], error: { message: 'GS026' } }
            // A collect of a position pays out USDC worth a fiftieth of its liquidity, whatever the decrease before it.
            const isCollect = c.data.startsWith(toFunctionSelector('collect((uint256,address,uint128,uint128))'))
            const tokenId = isCollect ? (decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: c.data }).args[0] as { tokenId: bigint }).tokenId : 0n
            const owed = (chain.positions.find((x) => x.tokenId === tokenId)?.liquidity ?? 0n) / 50n
            const data = isCollect ? encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', result: [owed, 0n] }) : TRUE
            return { status: '0x1', returnData: data, gasUsed: '0x5208', logs: [] }
          }),
        },
      ]
    },
    call: async ({ to, data }: { to: string; data: Hex }) => {
      if (to.toLowerCase() === address('Multicall3').toLowerCase()) {
        if (knobs.stall) await knobs.stall
        const word = (v: bigint) => toHex(v, { size: 32 })
        return {
          data: answerAggregate3(data, (target, callData) => {
            if (target.toLowerCase() === npm) {
              npmCalls.push(callData.slice(0, 10))
              if (knobs.npmDown) throw new Error('execution reverted')
              if (callData.startsWith('0x70a08231')) return word(BigInt(chain.positions.length))
              if (callData.startsWith(toFunctionSelector('tokenOfOwnerByIndex(address,uint256)'))) {
                const i = Number(BigInt(`0x${callData.slice(74)}`))
                const p = chain.positions[i]
                if (!p) throw new Error('index out of bounds')
                return word(p.tokenId)
              }
              const call = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: callData })
              if (call.functionName === 'positions') return positionResult(call.args[0] as bigint)
              if (call.functionName === 'ownerOf') {
                if (!chain.positions.some((p) => p.tokenId === call.args[0])) throw new Error('execution reverted: ERC721: invalid token ID')
                return encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', result: SAFE })
              }
              throw new Error('execution reverted')
            }
            if (callData.startsWith('0x3850c7bd')) return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'slot0', result: [1n << 96n, 0, 0, 0, 0, 0, true] })
            if (callData.startsWith('0x70a08231')) return word(target.toLowerCase() === address('USDC').toLowerCase() ? chain.usdc : 0n)
            if (callData.startsWith('0x4d2301cc')) return word(chain.safeEth)
            if (callData.startsWith(toFunctionSelector('getBlockNumber()'))) return word(100n)
            if (callData.startsWith(toFunctionSelector('isPermissionEnabled(bytes32,address)'))) return word(enabled(`0x${callData.slice(10, 74)}`) ? 1n : 0n)
            throw new Error('execution reverted')
          }),
        }
      }
      if (knobs.call === 'revert') throw Object.assign(new Error('execution reverted: GS026'), { code: 3, data: '0x08c379a0' })
      if (knobs.call === 'down') throw new Error('HTTP request failed. Status: 429')
      return { data: knobs.call === 'empty' ? '0x' : TRUE }
    },
  } as unknown as PublicClient
  /** #60's grant sweeps: a permission reads enabled while the operator's own record has it (grants or superseded). */
  const enabled = (id: unknown) => {
    if (knobs.grantsDown) throw new Error('HTTP request failed. Status: 429')
    return knobs.reenabled.has(String(id).toLowerCase()) || recorded(id)
  }
  const recorded = (id: unknown) => Object.values(state.accounts).some((a) => [...a.grants.map((g) => g.permissionId), ...(a.superseded ?? [])].some((x) => x.toLowerCase() === String(id).toLowerCase()))
  const relayer = {
    address: RELAYER,
    send: async (tx: { to: string; data?: Hex; value?: bigint }, onSent?: (h: Hex) => void, onSending?: (maxFeeWei: bigint, signed: { hash: Hex; nonce: number }) => void) => {
      sent.push(tx)
      const hash = toHex(sent.length, { size: 32 })
      onSending?.(0n, { hash, nonce: 4 + sent.length })
      onSent?.(hash)
      const isDeploy = tx.to.toLowerCase() === factory.to.toLowerCase()
      if (isDeploy) chain.deployed = true
      else if (tx.data && knobs.execOk) chain.nonce++
      const logs = isDeploy || !knobs.execOk ? [] : [{ address: SAFE, topics: [EXECUTION_SUCCESS] }]
      return { hash, receipt: { transactionHash: hash, status: 'success', blockNumber: 101n, logs, gasUsed: 200_000n, effectiveGasPrice: knobs.gasPrice } as unknown as TransactionReceipt }
    },
  } as unknown as Relayer
  const state = { accounts: {} as Record<string, AccountState> }
  const store = { state, save: () => void saves++ } as unknown as StateStore
  const cfg = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1, ...cfgExtra } satisfies OperatorConfig
  const op = new Operator(cfg, client, relayer, store)
  ;(op as unknown as { retryMs: number }).retryMs = 0
  return { op, chain, sent, knobs, factory, state, npmCalls, saves: () => saves }
}

function der(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    let b = Buffer.from(v.toString(16).padStart(64, '0'), 'hex')
    while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1)
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b])
    return Buffer.concat([Buffer.from([0x02, b.length]), b])
  }
  const body = Buffer.concat([int(r), int(s)])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

export function sign(t: OwnerTxToSign, key = passkey): OwnerSignature {
  const a = key.assert(t.safeTxHash)
  return {
    prepareId: t.prepareId,
    authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'),
    clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'),
    signature: Buffer.from(der(a.r, a.s)).toString('base64url'),
  }
}

/** Runs `fn` with console.error captured. */
export async function quiet<T>(fn: () => Promise<T>): Promise<{ out: T; logged: string[] }> {
  const logged: string[] = []
  const error = console.error
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
  try {
    return { out: await fn(), logged }
  } finally {
    console.error = error
  }
}
