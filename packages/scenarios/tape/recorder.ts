import { createPublicClient, http, toHex } from 'viem'
import type { Address, ReasonCode, ScenarioTape, TapeFrame, TapeId } from '@mamoru/domain'
import { decide, type Decision, type Observation } from '@mamoru/decide'
import { POLICIES, computeCaps, type PolicyVersion, type Price } from '@mamoru/policy'
import { assertCodeHashes, entry, uniswapV3PoolAbi } from '@mamoru/registry'
import { approve, exactInputSingle } from '@mamoru/uniswap-v3'
import { Engine, MAX_PRIORITY_FEE_PER_GAS, type ReviewResult } from '../driver/engine.ts'
import { startLabBundler, type LabBundler } from '../bundler/index.ts'
import { Lab, devAccount } from '../fixtures/lab.ts'
import { DEPOSIT_USDC, POOL, WHALE, activateGrants, type World } from '../fixtures/world.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import type { AnvilHandle } from '../fork/anvil.ts'
import { timeWarp } from '../perturb/index.ts'
import { startEnginePort, startForkProxy, type EnginePort } from '../proxy/index.ts'
import { artifactsRoot, ensureDir } from '../report/index.ts'
import { buildEngineWorld } from '../runner/engine-world.ts'
import { loadManifest, REPO_ROOT, type Manifest } from '../runner/manifest.ts'
import { amountToTick, buildFrame, checkTape, type FrameMeta } from './frame.ts'

const POLICY_ID = 'conservador-lab-v1'
/** Anvil development account that submits the lab bundler's handleOps (as the runner). */
const BUNDLER_EXECUTOR = 4
const GWEI = 1_000_000_000n

/** One fork, one engine world, one engine: the same wiring as the runner's engine group. */
export class TapeSession {
  readonly frames: TapeFrame[] = []
  private t0: bigint | undefined
  engine!: Engine

  private constructor(
    readonly manifest: Manifest,
    readonly lab: Lab,
    readonly world: World,
    readonly policy: PolicyVersion,
    private readonly handle: AnvilHandle,
    private readonly enginePort: EnginePort,
    private readonly bundler: LabBundler,
    private readonly stopProxy: () => void,
  ) {}

  static async start(tag: string): Promise<TapeSession> {
    const manifest = await loadManifest()
    const proxy = startForkProxy()
    const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/tape`)
    const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil-${tag}.log` })
    try {
      const lab = new Lab(handle.url, manifest.fork.chainId)
      await assertCodeHashes(lab.client)
      const enginePort = startEnginePort(handle.url)
      const engineClient = createPublicClient({ transport: http(enginePort.url) })
      const policy = POLICIES[POLICY_ID]!
      const world = await buildEngineWorld(lab, policy, async () => Number((await engineClient.getBlock()).timestamp))
      world.policy = policy
      const bundler = startLabBundler(lab, devAccount(BUNDLER_EXECUTOR))
      const s = new TapeSession(manifest, lab, world, policy, handle, enginePort, bundler, () => proxy.stop())
      await s.activateEntryGrants()
      const base = (await lab.client.getBlock()).number
      s.engine = new Engine(
        {
          mode: 'lab',
          chainId: manifest.fork.chainId,
          signingChainIds: [manifest.fork.chainId],
          rpcUrl: enginePort.url,
          bundlerUrl: bundler.url,
          policy,
          account: world.a1.safe,
          sessionKey: world.a1.sessionKey,
          nonceLane: 0,
          depositsAfter: base,
          sessions: world.a1.grants.map((g) => ({ name: g.name, grant: g.grant, permissionId: g.permissionId })),
        },
        {
          waitBlock: async () => void (await lab.rpc('evm_mine')),
          requestManageGrant: async (tokenId) => {
            world.a1.managedTokenIds.push(tokenId)
            const [g] = await activateGrants(world, world.a1, [{ name: 'manage', tokenId }])
            return { name: g!.name, grant: g!.grant, permissionId: g!.permissionId }
          },
        },
      )
      return s
    } catch (e) {
      await handle.stop()
      proxy.stop()
      throw e
    }
  }

  async stop(): Promise<void> {
    this.bundler.stop()
    this.enginePort.stop()
    await this.handle.stop()
    this.stopProxy()
  }

  /** fx-sessions: caps from the pools' slot0, then enter-swap and enter-mint activated by the owner. */
  private async activateEntryGrants(): Promise<void> {
    const prices: Record<string, Price> = {}
    for (const name of this.policy.buckets.flatMap((b) => b.pools)) {
      const e = entry(name)
      const [sqrt] = await this.lab.client.readContract({ address: e.address, abi: uniswapV3PoolAbi, functionName: 'slot0' })
      const q192 = 1n << 192n
      if (e.token0 === 'USDC') prices[e.token1!] = { num: sqrt * sqrt, den: q192 }
      else prices[e.token0!] = { num: q192, den: sqrt * sqrt }
    }
    this.world.a1.caps = computeCaps(this.policy, DEPOSIT_USDC, prices)
    await activateGrants(this.world, this.world.a1, [{ name: 'enter-swap' }, { name: 'enter-mint' }])
  }

  async deposit(): Promise<void> {
    const r = await this.lab.whaleTransfer('USDC', WHALE, this.world.a1.safe, DEPOSIT_USDC)
    if (!r.ok) throw new Error('deposit failed')
  }

  async mineUntilSafe(): Promise<void> {
    const target = (await this.lab.client.getBlock()).number
    while ((await this.lab.client.getBlock({ blockTag: 'safe' })).number < target) await this.lab.rpc('evm_mine')
  }

  /** fx-lp: the engine itself runs its two entries until one managed position is in range. */
  async enterThroughEngine(): Promise<bigint> {
    await this.deposit()
    await this.mineUntilSafe()
    for (let i = 0; i < 4 && this.engine.allowedTokenIds.length === 0; i++) {
      const r = await this.engine.review()
      if (r.kind === 'decided' && r.op && this.engine.journal.op(r.op.opId).state !== 'confirmed') throw new Error(`entry ${r.op.kind} ended ${this.engine.journal.op(r.op.opId).state}`)
    }
    const id = this.engine.allowedTokenIds[0]
    if (id === undefined) throw new Error('the engine did not mint a managed position')
    return id
  }

  /** The next block carries exactly this base fee; one block is mined so the engine observes it. */
  async pinBaseFee(gwei: bigint | number): Promise<void> {
    const wei = typeof gwei === 'number' ? BigInt(Math.round(gwei * 1e9)) : gwei * GWEI
    await this.lab.rpc('anvil_setNextBlockBaseFeePerGas', [toHex(wei)])
    await this.lab.rpc('evm_mine')
  }

  async warp(seconds: number): Promise<void> {
    await timeWarp(this.lab, seconds)
  }

  async slot0(): Promise<{ sqrtPriceX96: bigint; tick: number; liquidity: bigint }> {
    const e = entry(POOL)
    const [sqrtPriceX96, tick] = await this.lab.client.readContract({ address: e.address, abi: uniswapV3PoolAbi, functionName: 'slot0' })
    const liquidity = await this.lab.client.readContract({ address: e.address, abi: uniswapV3PoolAbi, functionName: 'liquidity' })
    return { sqrtPriceX96, tick, liquidity }
  }

  /** A whale swap on the policy pool; returns what it received. */
  async swap(tokenIn: string, amountIn: bigint): Promise<bigint> {
    const e = entry(POOL)
    const tokenOut = tokenIn === e.token0 ? e.token1! : e.token0!
    await this.lab.setBalance(WHALE, 10n ** 18n)
    const a = approve(tokenIn, 'SwapRouter02', amountIn)
    if (!(await this.lab.sendAs(WHALE, a.to, a.data)).ok) throw new Error('whale approve failed')
    const before = await this.lab.balanceOf(tokenOut, WHALE)
    const s = exactInputSingle({ account: WHALE, tokenIn, tokenOut, fee: e.fee!, amountIn, amountOutMinimum: 1n })
    if (!(await this.lab.sendAs(WHALE, s.to, s.data)).ok) throw new Error(`whale swap ${tokenIn} -> ${tokenOut} failed`)
    return (await this.lab.balanceOf(tokenOut, WHALE)) - before
  }

  /** Moves the pool toward `targetTick` in one swap at the current in-range liquidity; returns the token in and what came out. */
  async swapToward(targetTick: number): Promise<{ tokenIn: string; out: bigint }> {
    const e = entry(POOL)
    const s = await this.slot0()
    const { zeroForOne, amountIn } = amountToTick(s.sqrtPriceX96, s.liquidity, targetTick)
    const tokenIn = zeroForOne ? e.token0! : e.token1!
    if (tokenIn !== 'USDC') {
      // The whale holds USDC; it buys the volatile token first at the same pool.
      const got = await this.swap('USDC', await this.usdcFor(amountIn))
      return { tokenIn, out: await this.swap(tokenIn, got < amountIn ? got : amountIn) }
    }
    return { tokenIn, out: await this.swap(tokenIn, amountIn) }
  }

  private async usdcFor(volatileAmount: bigint): Promise<bigint> {
    const s = await this.slot0()
    // USDC is token0: token0 per token1 = Q192 / sqrt^2, plus 1% for the fee and impact.
    return ((volatileAmount << 192n) / (s.sqrtPriceX96 * s.sqrtPriceX96)) * 101n / 100n
  }

  /** One fee round: the whale buys half-way toward the lower edge of the range and sells it all back. */
  async feeRound(tickLower: number): Promise<void> {
    const s = await this.slot0()
    const target = s.tick - Math.floor((s.tick - tickLower) / 2)
    const { tokenIn, out } = await this.swapToward(target)
    const e = entry(POOL)
    await this.swap(tokenIn === e.token0 ? e.token1! : e.token0!, out)
  }

  async observe(): Promise<{ obs: Observation; decision: Decision }> {
    const obs = await this.engine.observe()
    return { obs, decision: decide(obs, this.policy) }
  }

  /** A full engine review (observe, decide, and at most one operation). */
  async review(): Promise<{ obs: Observation; decision: Decision; tx: TapeFrame['tx'] }> {
    const r: ReviewResult = await this.engine.review()
    if (r.kind !== 'decided') throw new Error(`observation failed: ${r.code} ${r.detail ?? ''}`)
    const op = r.op ? this.engine.journal.op(r.op.opId) : null
    const inc = op?.included
    const tx = op && inc ? { hash: inc.txHash, label: op.kind, ok: op.state === 'confirmed' } : null
    if (op && !inc) throw new Error(`${op.kind} ended ${op.state} ${op.stateCode ?? ''}`)
    return { obs: r.observation, decision: r.record.decision, tx }
  }

  /** Appends a frame; `expect` makes the recorder stop instead of writing a tape whose story is not what the fork did. */
  push(at: { obs: Observation; decision: Decision; tx?: TapeFrame['tx'] }, meta: FrameMeta | ((f: TapeFrame) => FrameMeta), expect?: ReasonCode[]): TapeFrame {
    this.t0 ??= at.obs.block.timestamp
    const input = { obs: at.obs, decision: at.decision, policy: this.policy, pool: POOL, t0: this.t0, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS }
    const draft = buildFrame(input, { title: '', note: '' })
    const m = typeof meta === 'function' ? meta(draft) : meta
    const frame = buildFrame(input, { ...m, tx: at.tx ?? m.tx ?? null })
    const seen = [frame.decision.reason, ...at.decision.positions.flatMap((p) => p.codes)]
    if (expect && !expect.some((c) => seen.includes(c))) {
      throw new Error(`frame "${frame.title}": decide said ${seen.join(',')}, the script expects ${expect.join(' or ')}`)
    }
    this.frames.push(frame)
    console.log(`  ${frame.block} ${frame.decision.code}/${frame.decision.reason} fees ${frame.position?.feesValue ?? '-'} thr ${frame.cost.threshold} tick ${frame.pool.tick}${frame.tx ? ` tx ${frame.tx.label}` : ''}  ${frame.title}`)
    return frame
  }

  tape(id: TapeId, title: string, summary: string): ScenarioTape {
    const tape: ScenarioTape = {
      id,
      title,
      summary,
      savingsAsset: this.policy.savingsAsset,
      chainId: this.manifest.fork.chainId,
      forkOf: 'Base',
      forkBlock: this.manifest.fork.block,
      recordedAt: new Date().toISOString(),
      frames: this.frames,
    }
    const errs = checkTape(tape)
    if (errs.length) throw new Error(`${id}: ${errs.join('; ')}`)
    return tape
  }

  get account(): Address {
    return this.world.a1.safe
  }
}
