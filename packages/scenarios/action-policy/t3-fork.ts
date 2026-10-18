// Spec 007 (otto/mamoru#151), task T3: proves the engine's OWN math (packages/scenarios/driver/engine.ts's
// `prepareCalls`, via `@mamoru/uniswap-v3/policy-bounds`) against the deployed MamoruActionPolicy on a Base fork —
// not the contract's own views (t1-fork.ts, t2-fork.ts did that for the PoC/T1/T2 shapes). Three things:
//
// 1. TS-vs-contract cross-check: for a grid of bandTicks and amountIn (swap) / tick ranges (decrease), the TS port
//    at factor 1.0 (`oracleFromObserve` -> `priceRange` -> `swapBoundsInRange`/`decreaseMinsInRange`, T6) equals
//    the contract's `priceRange`/`swapBounds`/`decreaseMins` views exactly; at the engine's default 0.8x factor,
//    the TS bound is strictly inside (a higher minimum, a tighter limit).
// 2. Engine-equivalent calls — built with the SAME functions `prepareCalls` calls (`priceRange`,
//    `swapBoundsInRange`, `decreaseMinsInRange`, mint through the policy with approvals to the policy) — pass `handleOps` validation and
//    execution under T2's production v4 grants (`enter-swap`, `manage-any`, merged mint+decrease+collect+burn).
// 3. TWAP drift: a swap is "prepared" (bounds computed) at one block; the pool is then pushed and a few blocks
//    pass before the prepared userOp is actually submitted. The on-chain TWAP has moved by then, but the engine's
//    narrower (0.8x) band still clears the policy's own band (1.0x) at the new TWAP — spec 007 T3's "still inside
//    what the policy accepts a few blocks later".
//
// Run (builds the contract, then the scenario):
//   PATH="$HOME/.foundry/bin:$PATH" bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t3-fork.ts'
//
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1/t2-fork.ts.
import { encodeFunctionData, parseAbi, parseEventLogs, type Hex, type TransactionReceipt } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, erc20Abi, nonfungiblePositionManagerAbi, smartSessionAbi, swapRouter02Abi, uniswapV3PoolAbi } from '@mamoru/registry'
import { computeCaps, conservadorLabV4, encodeMamoruInit, instantiateGrant, mamoruInitFor, retargetToPolicy, TWAP_SHORT_WINDOW_SECONDS, V4_POOLS, withActionPolicy, type Price, type SessionGrant } from '@mamoru/policy'
import { permissionIdOf, toSmartSession } from '@mamoru/account/sessions'
import { approve, collect, decreaseLiquidity, exactInputSingle } from '@mamoru/uniswap-v3'
import { quoteMint, sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decreaseMinsInRange, narrowBand, oracleFromObserve, priceRange, swapBoundsInRange, DEFAULT_BAND_FACTOR_BPS, type OracleRead, type PriceRange } from '@mamoru/uniswap-v3/policy-bounds'
import { Lab, devAccount } from '../fixtures/lab.ts'
import { buildBasicWorld, ownerExec, poolTick, rangeAround, WHALE, type World } from '../fixtures/world.ts'
import { sendSessionOp, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'
import { attestMamoruPolicyCall, deployGasPolicy, deployMamoruPolicy, loadPolicyArtifact, v4Policies } from './v4-grant.ts'

const POOL = V4_POOLS.btc.pool // 'pool:USDC/cbBTC/500'
const DEPOSIT_USDC = 100_000_000_000n // 100,000 USDC
const observeAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])

type Line = { step: string; ok: boolean | null; detail: string }
const reportLines: Line[] = []
const t0 = Date.now()
let exitCode = 0

function note(step: string, ok: boolean | null, detail: string): void {
  reportLines.push({ step, ok, detail })
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${ok === null ? 'info' : ok ? 'ok  ' : 'FAIL'} ${step}: ${detail}`)
  if (ok === false) exitCode = 1
}

process.on('uncaughtException', (e) => {
  console.error(`t3-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t3-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})

function expect(outcome: SessionOpOutcome, label: string, want: SessionOpOutcome['verdict']): SessionOpOutcome {
  const ok = outcome.verdict === want
  const extra = [outcome.failedOp?.reason ? `reason=${outcome.failedOp.reason}` : undefined, outcome.validator ? `validator=${outcome.validator}` : undefined].filter(Boolean).join(' ')
  note(label, ok, `${outcome.verdict}${extra ? ` (${extra})` : ''}`)
  return outcome
}

function mintedPosition(receipt: TransactionReceipt, safe: Address): { tokenId: bigint; liquidity: bigint } {
  const npm = address('NonfungiblePositionManager')
  const t = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: receipt.logs, eventName: 'Transfer' }).find((l) => l.address.toLowerCase() === npm.toLowerCase() && l.args.to.toLowerCase() === safe.toLowerCase())
  if (!t) throw new Error('no position minted to the account (no NPM Transfer log)')
  const inc = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: receipt.logs, eventName: 'IncreaseLiquidity' }).find((l) => l.args.tokenId === t.args.tokenId)
  if (!inc) throw new Error('no IncreaseLiquidity log for the minted position')
  return { tokenId: t.args.tokenId, liquidity: inc.args.liquidity }
}

/** Same floor-rounding `Engine.poolTwapTick` / `OracleLibrary.consult` use. One `observe` eth_call. */
async function twapTick(lab: Lab, pool: Address, windowSeconds: number): Promise<number> {
  const [cumulatives] = await lab.client.readContract({ address: pool, abi: observeAbi, functionName: 'observe', args: [[windowSeconds, 0]] })
  const delta = cumulatives[1]! - cumulatives[0]!
  let t = delta / BigInt(windowSeconds)
  if (delta < 0n && delta % BigInt(windowSeconds) !== 0n) t -= 1n
  return Number(t)
}

/** T6: what `Engine.poolOracle` and `MamoruActionPolicy._oracle` read — one `observe([1800, 300, 0])`. */
async function oracleRead(lab: Lab, pool: Address): Promise<OracleRead> {
  const long = conservadorLabV4.execution.twapWindowSeconds
  const [ticks] = await lab.client.readContract({ address: pool, abi: observeAbi, functionName: 'observe', args: [[long, TWAP_SHORT_WINDOW_SECONDS, 0]] })
  return oracleFromObserve(ticks, long, TWAP_SHORT_WINDOW_SECONDS)
}

/** The engine's own range: `priceRange` at `bandTicks` (the btc pool has no anchor); throws where the policy refuses. */
function rangeAt(o: OracleRead, bandTicks: number): PriceRange {
  const r = priceRange(o, bandTicks, V4_POOLS.btc.anchor)
  if (!r) throw new Error(`empty range at bandTicks ${bandTicks}: twap ${o.twapLong}/${o.twapShort}`)
  return r
}

/** computeCaps needs a price for every non-USDC asset of conservadorLabV4's three pools, even though this
 * scenario only enables the btc pool's grants (packages/scenarios/action-policy/t2-fork.ts's own helper). */
async function usdcPrice(lab: Lab, pool: string, token0: string, token1: string, asset: string): Promise<Price> {
  const [sqrtPriceX96] = await lab.client.readContract({ address: address(pool), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const ratio: Price = { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n }
  if (token0 === 'USDC' && token1 === asset) return ratio
  if (token1 === 'USDC' && token0 === asset) return { num: ratio.den, den: ratio.num }
  throw new Error(`usdcPrice: ${pool} does not pair USDC with ${asset}`)
}

// ------------------------------------------------------------------------------------------------ setup

const manifest = await loadManifest()
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t3`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  await assertCodeHashes(lab.client)
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}`)

  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, conservadorLabV4, engineNow)
  note('fx-safe', true, `Safe7579 account ${world.a1.safe}`)
  // buildBasicWorld only funds its own DEPOSIT_USDC (10,000 USDC) — not enough for the swap (10k) + mint (20k) +
  // drift-swap (5k) below, with headroom. Top up, same reasoning as t1-fork.ts's engine-op fixture funding.
  await lab.whaleTransfer('USDC', WHALE, world.a1.safe, 100_000_000_000n)
  await lab.whaleTransfer('cbBTC', WHALE, world.a1.safe, 50_000_000n) // 0.5 cbBTC, for the mint leg
  note('fx-usdc / fx-cbbtc top-up', true, 'A1 funded with 100,000 USDC and 0.5 cbBTC total (on top of fx-usdc\'s own 10,000 USDC from buildBasicWorld)')

  const pool = address(POOL)
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, 'pool:USDC/cbBTC/500', 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, 'pool:WETH/USDC/3000', 'WETH', 'USDC', 'WETH'),
  }
  // conservadorLabV4's caps cover all three pools (stables/btc/risk); this scenario only enables the btc pool's
  // grants below, but computeCaps still needs every asset's price to resolve the whole cap set.
  const caps = computeCaps(conservadorLabV4, DEPOSIT_USDC, prices)
  note('caps computed', true, `deposit ${DEPOSIT_USDC} raw USDC, ${Object.keys(caps).length} cap formulas`)

  // --------------------------------------------------------------------------------------------- deploy + register + attest

  const artifact = await loadPolicyArtifact()
  const mamoruPolicy = await deployMamoruPolicy(lab, artifact, relayer)
  // T7 (P1 2): every v4 session carries MamoruGasPolicy too, deployed and registered the same way.
  const gasPolicy = await deployGasPolicy(lab, relayer)
  const policyAbi = artifact.abi
  note('MamoruActionPolicy deployed + registered (one deployModule tx, T6 L-3)', true, mamoruPolicy)
  const attestTx = await ownerExec(lab, relayer, world.a1, attestMamoruPolicyCall(mamoruPolicy, gasPolicy))
  if (!attestTx.ok) throw new Error('self-attest reverted')
  note('self-attest MamoruActionPolicy', true, `${attestTx.receipt.gasUsed} gas`)

  // --------------------------------------------------------------------------------------------- generation 1: enter-swap + manage-any (T2 production builders)

  const sessionKey = world.a1.sessionKey.address
  const now0 = await engineNow()
  let saltCounter = 0
  const nextSalt = (): Hex => {
    saltCounter++
    return `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex
  }
  const grantCtx = () => ({ account: world.a1.safe, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now0 - 60, validUntil: now0 + conservadorLabV4.session.validitySeconds, caps })
  const btcMamoruInit = encodeMamoruInit(mamoruInitFor(V4_POOLS.btc, 1n, caps))

  const swapGrant: SessionGrant = retargetToPolicy(instantiateGrant(conservadorLabV4, `enter-swap:${POOL}`, grantCtx()), mamoruPolicy)
  const manageGrant: SessionGrant = retargetToPolicy(instantiateGrant(conservadorLabV4, `manage-any:${POOL}`, grantCtx()), mamoruPolicy)
  const swapSession = toSmartSession(swapGrant, v4Policies(mamoruPolicy, gasPolicy, btcMamoruInit))
  const manageSession = toSmartSession(manageGrant, v4Policies(mamoruPolicy, gasPolicy, btcMamoruInit))
  note('manage-any: action count', manageGrant.actions.length === 7, `${manageGrant.actions.length} actions (decrease, collect, burn, approve x2, mint, swap)`)
  const swapPid = permissionIdOf(swapSession)
  const managePid = permissionIdOf(manageSession)

  const enableData = encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableSessions', args: [[swapSession, manageSession]] })
  const enableTx = await ownerExec(lab, relayer, world.a1, { to: address('SmartSession'), data: enableData })
  if (!enableTx.ok) throw new Error('enableSessions reverted')
  note('enableSessions: enter-swap + manage-any (gen 1)', true, `${enableTx.receipt.gasUsed} gas`)
  world.a1.ledger.activate(swapPid, swapGrant)
  world.a1.ledger.activate(managePid, manageGrant)
  world.a1.grants.push({ name: 'enter-swap-v4', grant: swapGrant, permissionId: swapPid }, { name: 'manage-any-v4', grant: manageGrant, permissionId: managePid })

  // The engine's own PolicyVersion, had it been running against this deployed policy (spec 007 T3: the address and
  // band come from the policy config, never hardcoded in prepareCalls — this is the object that would carry them).
  const enginePolicy = withActionPolicy(conservadorLabV4, mamoruPolicy, [V4_POOLS.btc])
  const bandFactorBps = enginePolicy.actionPolicy!.bandFactorBps ?? DEFAULT_BAND_FACTOR_BPS
  note('engine policy', true, `actionPolicy.address ${mamoruPolicy}, btc bandTicks ${V4_POOLS.btc.bandTicks} narrowed to ${narrowBand(V4_POOLS.btc.bandTicks, bandFactorBps)} at ${bandFactorBps} bps`)

  // --------------------------------------------------------------------------------------------- 1. TS-vs-contract cross-check (sandboxed: snapshot + revert)

  {
    const snap = await lab.snapshot()
    try {
      const amounts = [1_000_000_000n, 50_000_000_000n] // 1,000 / 50,000 USDC
      const bandGrid = [10, 50, 100]
      let checks = 0
      // T6 I-1: one config per (account, pool, generation), so each probe band is enabled at the next generation
      // (owner-signed, a renewal in all but name). The views read the account's CURRENT config.
      let generation = 1n
      const enableProbe = async (bandTicks: number, admit: bigint[] = []) => {
        generation++
        const probeInit = encodeMamoruInit(mamoruInitFor({ ...V4_POOLS.btc, bandTicks }, generation, caps, { admit }))
        const probeGrant = retargetToPolicy(instantiateGrant(conservadorLabV4, `enter-swap:${POOL}`, grantCtx()), mamoruPolicy)
        const probeSession = toSmartSession(probeGrant, v4Policies(mamoruPolicy, gasPolicy, probeInit))
        const probeEnable = await ownerExec(lab, relayer, world.a1, { to: address('SmartSession'), data: encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableSessions', args: [[probeSession]] }) })
        if (!probeEnable.ok) throw new Error(`probe enableSessions (bandTicks ${bandTicks}, generation ${generation}) reverted`)
      }
      for (const bandTicks of bandGrid) {
        await enableProbe(bandTicks)
        const o = await oracleRead(lab, pool)
        const [cLo, cHi] = (await lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'priceRange', args: [world.a1.safe, pool] })) as readonly [number, number]
        const range = rangeAt(o, bandTicks)
        note(`priceRange cross-check bandTicks=${bandTicks}`, range.lo === cLo && range.hi === cHi, `TS ${range.lo}..${range.hi} vs contract ${cLo}..${cHi} (twap ${o.twapLong}/${o.twapShort})`)
        for (const amountIn of amounts) {
          const [contractMinOut, contractLimit] = (await lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'swapBounds', args: [world.a1.safe, pool, address('USDC'), amountIn] })) as readonly [bigint, bigint]
          const tsAt1 = swapBoundsInRange({ range, feePips: 500, zeroForOne: true, tokenIn: address('USDC'), tokenOut: address('cbBTC'), amountIn })
          const eq = tsAt1.minOut === contractMinOut && tsAt1.sqrtPriceLimitX96 === contractLimit
          note(`swapBounds cross-check bandTicks=${bandTicks} amountIn=${amountIn}`, eq, eq ? 'TS factor 1.0 == contract view' : `TS ${tsAt1.minOut}/${tsAt1.sqrtPriceLimitX96} != contract ${contractMinOut}/${contractLimit}`)
          const tsAt08 = swapBoundsInRange({ range: rangeAt(o, narrowBand(bandTicks, bandFactorBps)), feePips: 500, zeroForOne: true, tokenIn: address('USDC'), tokenOut: address('cbBTC'), amountIn })
          const inside = tsAt08.minOut >= tsAt1.minOut && tsAt08.sqrtPriceLimitX96 >= tsAt1.sqrtPriceLimitX96
          note(`  at 0.8x: strictly inside bandTicks=${bandTicks} amountIn=${amountIn}`, inside, `minOut ${tsAt08.minOut} >= ${tsAt1.minOut}, limit ${tsAt08.sqrtPriceLimitX96} >= ${tsAt1.sqrtPriceLimitX96}`)
          checks++
        }
      }
      note('swapBounds cross-check: grid size', checks === bandGrid.length * amounts.length, `${checks} (bandTicks x amountIn) combinations`)

      // decreaseMins cross-check: a grid of tick ranges (owner-minted positions, NonfungiblePositionManager directly
      // — not through any grant), bandTicks back at the real 100. T6: the view requires admission now, so the
      // probes are admitted the way T7 admits v2/v3 positions: by the owner-signed Init.admit of an enable (M-4).
      const { tick: spot } = await poolTick(lab)
      const ranges = [rangeAround(spot, 200, 10), rangeAround(spot, 1200, 10), rangeAround(spot, 8000, 10)]
      const deadline = BigInt((await engineNow()) + 3600)
      const probes: { r: { tickLower: number; tickUpper: number }; tokenId: bigint; liquidity: bigint }[] = []
      for (const r of ranges) {
        await lab.whaleTransfer('USDC', WHALE, world.a1.safe, 5_000_000_000n)
        await lab.whaleTransfer('cbBTC', WHALE, world.a1.safe, 5_000_000n)
        const approve0 = await ownerExec(lab, relayer, world.a1, { to: address('USDC'), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address('NonfungiblePositionManager'), 5_000_000_000n] }) })
        const approve1 = await ownerExec(lab, relayer, world.a1, { to: address('cbBTC'), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address('NonfungiblePositionManager'), 5_000_000n] }) })
        if (!approve0.ok || !approve1.ok) throw new Error('owner approve for probe mint reverted')
        const mintParams = { token0: address('USDC'), token1: address('cbBTC'), fee: 500, tickLower: r.tickLower, tickUpper: r.tickUpper, amount0Desired: 5_000_000_000n, amount1Desired: 5_000_000n, amount0Min: 0n, amount1Min: 0n, recipient: world.a1.safe, deadline }
        const mintTx = await ownerExec(lab, relayer, world.a1, { to: address('NonfungiblePositionManager'), data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [mintParams] }) })
        if (!mintTx.ok) throw new Error(`probe mint (range ${r.tickLower}/${r.tickUpper}) reverted`)
        probes.push({ r, ...mintedPosition(mintTx.receipt, world.a1.safe) })
      }
      await enableProbe(V4_POOLS.btc.bandTicks, probes.map((p) => p.tokenId))
      let decreaseChecks = 0
      for (const { r, tokenId, liquidity } of probes) {
        const o = await oracleRead(lab, pool)
        const [contract0, contract1] = (await lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'decreaseMins', args: [world.a1.safe, pool, tokenId, liquidity] })) as readonly [bigint, bigint]
        const tsAt1 = decreaseMinsInRange({ range: rangeAt(o, V4_POOLS.btc.bandTicks), tickLower: r.tickLower, tickUpper: r.tickUpper, liquidity })
        const eq = tsAt1.amount0Min === contract0 && tsAt1.amount1Min === contract1
        note(`decreaseMins cross-check range [${r.tickLower},${r.tickUpper}]`, eq, eq ? 'TS factor 1.0 == contract view' : `TS ${tsAt1.amount0Min}/${tsAt1.amount1Min} != contract ${contract0}/${contract1}`)
        const tsAt08 = decreaseMinsInRange({ range: rangeAt(o, narrowBand(V4_POOLS.btc.bandTicks, bandFactorBps)), tickLower: r.tickLower, tickUpper: r.tickUpper, liquidity })
        const inside = tsAt08.amount0Min >= tsAt1.amount0Min && tsAt08.amount1Min >= tsAt1.amount1Min
        note(`  at 0.8x: strictly inside range [${r.tickLower},${r.tickUpper}]`, inside, `amount0Min ${tsAt08.amount0Min} >= ${tsAt1.amount0Min}, amount1Min ${tsAt08.amount1Min} >= ${tsAt1.amount1Min}`)
        decreaseChecks++
      }
      note('decreaseMins cross-check: grid size', decreaseChecks === ranges.length, `${decreaseChecks} tick ranges`)
    } finally {
      await lab.revert(snap)
      note('cross-check sandbox reverted', true, 'account/budget/pool state restored to before the probes')
    }
  }

  // --------------------------------------------------------------------------------------------- 2. engine-equivalent swap, mint, decrease through handleOps

  const swapAmountIn = 10_000_000_000n // 10,000 USDC
  {
    const bound = swapBoundsInRange({ range: rangeAt(await oracleRead(lab, pool), narrowBand(V4_POOLS.btc.bandTicks, bandFactorBps)), feePips: 500, zeroForOne: true, tokenIn: address('USDC'), tokenOut: address('cbBTC'), amountIn: swapAmountIn })
    const out = expect(
      await sendSessionOp(world, world.a1, { name: 'enter-swap-v4', grant: swapGrant, permissionId: swapPid }, 'engine-swap-v4', [
        approve('USDC', 'SwapRouter02', swapAmountIn),
        exactInputSingle({ account: world.a1.safe, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: swapAmountIn, amountOutMinimum: bound.minOut, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 }),
      ]),
      'engine swap: prepareCalls-equivalent bounds (0.8x band) pass validation and execution',
      'INCLUDED',
    )
    void out
  }

  let tokenId = 0n
  let liquidity = 0n
  {
    const { tick: spot } = await poolTick(lab)
    const { tickLower, tickUpper } = rangeAround(spot, 1200, 10)
    const [sqrtPriceX96] = await lab.client.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'slot0' })
    const mintUsdc = 20_000_000_000n
    const mintCbbtc = 10_000_000n
    const q = quoteMint({ sqrtPriceX96, tickLower, tickUpper, amount0Desired: mintUsdc, amount1Desired: mintCbbtc, slippageBps: conservadorLabV4.execution.slippageBps })
    const deadline = BigInt((await engineNow()) + 3600)
    const mintParams = { token0: address('USDC'), token1: address('cbBTC'), fee: 500, tickLower, tickUpper, amount0Desired: mintUsdc, amount1Desired: mintCbbtc, amount0Min: q.amount0Min, amount1Min: q.amount1Min, recipient: world.a1.safe, deadline }
    const out = expect(
      await sendSessionOp(world, world.a1, { name: 'manage-any-v4', grant: manageGrant, permissionId: managePid }, 'engine-mint-v4', [
        { to: address('USDC'), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [mamoruPolicy, mintUsdc] }) },
        { to: address('cbBTC'), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [mamoruPolicy, mintCbbtc] }) },
        { to: mamoruPolicy, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [mintParams] }) },
      ]),
      'engine mint: prepareCalls-equivalent (mint through the policy, quoteMint minimums) passes',
      'INCLUDED',
    )
    if (out.verdict === 'INCLUDED' && out.receipt) ({ tokenId, liquidity } = mintedPosition(out.receipt, world.a1.safe))
  }

  if (tokenId > 0n) {
    const { tickLower, tickUpper } = rangeAround((await poolTick(lab)).tick, 1200, 10) // same range the mint used
    const bound = decreaseMinsInRange({ range: rangeAt(await oracleRead(lab, pool), narrowBand(V4_POOLS.btc.bandTicks, bandFactorBps)), tickLower, tickUpper, liquidity })
    const deadline = BigInt((await engineNow()) + 3600)
    const out = expect(
      await sendSessionOp(world, world.a1, { name: 'manage-any-v4', grant: manageGrant, permissionId: managePid }, 'engine-decrease-v4', [
        decreaseLiquidity({ tokenId, liquidity, amount0Min: bound.amount0Min, amount1Min: bound.amount1Min, deadline }),
        collect({ account: world.a1.safe, tokenId }),
      ]),
      'engine decrease: prepareCalls-equivalent bounds (0.8x band) pass validation and execution',
      'INCLUDED',
    )
    void out
  }

  // --------------------------------------------------------------------------------------------- 3. TWAP drift between prepare and validation

  {
    const twapBefore = await twapTick(lab, pool, conservadorLabV4.execution.twapWindowSeconds)
    const bandTicks = narrowBand(V4_POOLS.btc.bandTicks, bandFactorBps)
    const driftAmountIn = 5_000_000_000n // 5,000 USDC
    const bound = swapBoundsInRange({ range: rangeAt(await oracleRead(lab, pool), bandTicks), feePips: 500, zeroForOne: true, tokenIn: address('USDC'), tokenOut: address('cbBTC'), amountIn: driftAmountIn })
    const preparedCalls = [
      approve('USDC', 'SwapRouter02', driftAmountIn),
      exactInputSingle({ account: world.a1.safe, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: driftAmountIn, amountOutMinimum: bound.minOut, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 }),
    ]
    note('drift: prepared at twap', true, `tick ${twapBefore}, narrowed bandTicks ${bandTicks}, minOut ${bound.minOut}, limit ${bound.sqrtPriceLimitX96}`)

    // A genuine TWAP drift needs sustained exposure over a real share of the 1800s window (spec 007 "TWAP
    // manipulation cost": "to shift a W-second TWAP by d, the pool must be held about d away for the whole
    // window"); a few-block manipulation like the attack tests use (test_manipulatedSwapReverts, 500 ticks) barely
    // moves it at all — that is the whole point of a TWAP. So this pushes spot by a MODEST amount (well under the
    // narrowed band's ~(100-80)=20-tick margin from the real band would suggest, but the real limiting factor is
    // the ROUTER's own price-limit check at the swap's EXECUTION block: our prepared sqrtPriceLimitX96 sits at
    // twap_before - 80, so spot at submission time must stay above that, i.e. the push must stay under ~80 ticks)
    // and holds it there for half the window, which drifts the TWAP by roughly half the push (spec's own formula).
    const { tick: spotBefore } = await poolTick(lab)
    const pushTicks = 40
    const target = spotBefore - pushTicks
    const limitAtTarget = sqrtRatioAtTick(target)
    await lab.whaleTransfer('USDC', WHALE, world.attacker.address, 1_000_000_000_000n)
    await lab.send(world.attacker, address('USDC'), encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address('SwapRouter02'), 1_000_000_000_000n] }))
    await lab.send(world.attacker, address('SwapRouter02'), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.attacker.address, amountIn: 1_000_000_000_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: limitAtTarget }] }))
    await lab.warp(900) // half the 1800s window, held at the pushed price — "a few blocks" of inclusion latency in spirit, scaled up so the TWAP shift is actually observable
    const { tick: spotAfter } = await poolTick(lab)
    const twapAfter = await twapTick(lab, pool, conservadorLabV4.execution.twapWindowSeconds)
    note('drift: pool pushed and held for half the TWAP window', true, `spot ${spotBefore} -> ${spotAfter}, twap ${twapBefore} -> ${twapAfter} (drift ${twapAfter - twapBefore} ticks)`)

    const out = expect(
      await sendSessionOp(world, world.a1, { name: 'enter-swap-v4', grant: swapGrant, permissionId: swapPid }, 'engine-swap-v4-drift', preparedCalls),
      `drift: the op prepared at the OLD twap (${twapBefore}) still passes validation+execution at the new one (${twapAfter})`,
      'INCLUDED',
    )
    void out
  }

  // --------------------------------------------------------------------------------------------- report

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, mamoruPolicy, safe: world.a1.safe, lines: reportLines, opLog: world.opLog })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t3-fork', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
  exitCode = 1
} finally {
  await handle.stop()
  proxy.stop()
}

console.log('\n=== summary ===')
for (const l of reportLines) console.log(`${l.ok === null ? '-' : l.ok ? '✓' : '✗'} ${l.step}: ${l.detail}`)
process.exit(exitCode)
