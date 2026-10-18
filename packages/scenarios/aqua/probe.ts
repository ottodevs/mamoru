// Lab probe (otto/mamoru#183): is 1inch Aqua on Base a viable experimental venue for the Lab, next to the
// Uniswap v3 slot we run today? Aqua keeps tokens in the maker's wallet under an ERC-20 allowance to Aqua.sol;
// strategies are immutable (maker, app, strategyHash); ship() allocates virtual balances and dock() revokes them
// with no token transfer; one real balance can back several strategies; fills pull tokens from maker to taker and
// push the taker's tokens back to the maker. This probe forks Base, deploys a passkey-owned Safe as the maker
// (the same fixtures the Base scenarios start from), ships a concentrated-liquidity strategy, has a taker fill it,
// measures the fee the maker earns, demonstrates the overcommit failure mode, docks and re-ships a shifted range
// (a rebalance) and compares its gas against the same Safe's Uniswap v3 decrease+collect+mint cycle on the same
// fork. It also lays out, from real encoded calldata, how far a `UniActionPolicy` session-key grant could scope
// ship()/dock() today. Nothing is sent to a real chain and no product code path changes.
//
// Run: nix shell nixpkgs#foundry --command bun packages/scenarios/aqua/probe.ts
// Upstream RPC: RPC_URL, or QUICKNODE_BASE_MAINNET_HTTP from ~/.config/quicknode/endpoints.env. It reaches anvil
// through a loopback proxy and is never printed.
//
// Sources (primary docs, read 2026-10-18):
// - https://business.1inch.com/portal/documentation/aqua/liquidity-layer/core-concepts
// - https://business.1inch.com/portal/documentation/aqua/liquidity-layer/strategy
// - https://business.1inch.com/portal/documentation/aqua/liquidity-layer/supported-chains
// - https://business.1inch.com/portal/documentation/aqua/reference/contract-addresses
// - https://business.1inch.com/portal/documentation/aqua/reference/smart-contract
// - https://business.1inch.com/portal/documentation/aqua/reference/sdk-overview
// - https://business.1inch.com/portal/documentation/aqua/getting-started/build-an-aquaapp
// - https://business.1inch.com/portal/documentation/aqua/help/swapvm-faq
// - @1inch/aqua-sdk@0.3.4, @1inch/swap-vm-sdk@0.4.4 (npm; built on the 1inch/swap-vm v1.0.2 git tag)
// - https://github.com/1inch/swap-vm/blob/v1.0.2/src/instructions/XYCConcentrate.sol (price convention)
// - https://github.com/1inch/1inch-audits ("Aqua and SwapVM v1" and "v1.0.2" report sets)
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AQUA_CONTRACT_ADDRESSES, AquaProtocolContract, Address as AquaAddress } from '@1inch/aqua-sdk'
import {
  ABI as SWAP_VM_ABI_NS,
  AQUA_SWAP_VM_CONTRACT_ADDRESSES,
  AquaXYCAmmStrategy,
  MakerTraits,
  NetworkEnum,
  Order,
  SwapVMContract,
  TakerTraits,
  instructions,
} from '@1inch/swap-vm-sdk'
import { BaseError, createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseEventLogs } from 'viem'
import type { Address, Hex } from '@mamoru/domain'
import { address, erc20Abi, nonfungiblePositionManagerAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { approve as v3Approve, burn as v3Burn, collect, decreaseLiquidity, mint as v3Mint } from '@mamoru/uniswap-v3'
import { conservadorLabV1 } from '@mamoru/policy'
import { anvilBinary, assertNoKeyInArgv, sanitizedEnv } from '../fork/anvil.ts'
import { startForkProxy } from '../proxy/index.ts'
import { WHALE, buildBasicWorld, ownerBatch, ownerExec } from '../fixtures/world.ts'
import { Lab, devAccount } from '../fixtures/lab.ts'

const { computeLiquidityFromAmounts } = instructions.concentrate

/** The lab chain id of scenarios/manifest.json. Not a real chain: nothing signed here is valid on any network. */
const LAB_CHAIN_ID = 31_337
const BASE_CHAIN_ID = 8453
const ONE_E18 = 10n ** 18n
const Q96 = 1n << 96n

// Aqua is deployed at the same address on 13 EVM chains, Base among them (business.1inch.com, supported-chains
// and reference/contract-addresses, read 2026-10-18). The SDK ships the same constants; both are quoted here so
// the probe fails loudly if a future SDK version ever disagrees with the docs.
const AQUA_FROM_DOCS: Address = getAddress('0x1111113ccf1426a8e30e2bff5e005d929bf6a90a')
const SWAP_VM_FROM_DOCS: Address = getAddress('0x111111338c5091e8440b67b168bae16a668ac0de')

type Line = { step: string; ok: boolean | null; detail: string }
const report: Line[] = []
const t0 = Date.now()

/** Everything this script prints passes through here: the upstream URL and its parts never reach the log. */
function redact(text: string): string {
  const upstream = process.env.RPC_URL
  if (!upstream) return text
  const parts = new Set<string>([upstream])
  try {
    const u = new URL(upstream)
    for (const p of [u.host, u.hostname, u.username, u.password, ...u.pathname.split('/'), ...u.search.replace(/^\?/, '').split(/[&=]/)]) if (p.length >= 3) parts.add(p)
  } catch {
    // not a URL: the whole value is the only part
  }
  let out = text
  for (const part of [...parts].sort((a, b) => b.length - a.length)) out = out.split(part).join('<rpc>')
  return out
}

process.on('uncaughtException', (e) => {
  console.error(redact(`probe failed: ${e instanceof Error ? e.message : String(e)}`))
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(redact(`probe failed: ${e instanceof Error ? e.message : String(e)}`))
  process.exit(1)
})

function note(step: string, ok: boolean | null, rawDetail: string): void {
  const detail = redact(rawDetail)
  report.push({ step, ok, detail })
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${ok === null ? 'info' : ok ? 'ok  ' : 'FAIL'} ${step}: ${detail}`)
}

function loadUpstream(): void {
  if (process.env.RPC_URL) return
  const file = join(homedir(), '.config/quicknode/endpoints.env')
  if (!existsSync(file)) throw new Error('set RPC_URL to a Base archive RPC')
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('QUICKNODE_BASE_MAINNET_HTTP='))
  if (!line) throw new Error('QUICKNODE_BASE_MAINNET_HTTP is not in ~/.config/quicknode/endpoints.env')
  process.env.RPC_URL = line.slice(line.indexOf('=') + 1).replace(/^["']|["']$/g, '').trim()
}

function reason(e: unknown): string {
  if (e instanceof BaseError) {
    const walked = e.walk() as { shortMessage?: string; message?: string; details?: string; reason?: string; data?: unknown }
    const pieces = [walked.shortMessage ?? e.shortMessage, walked.reason, walked.details, typeof walked.data === 'string' ? walked.data : undefined].filter((p): p is string => typeof p === 'string' && p.length > 0)
    return (pieces[0] ?? e.message).slice(0, 300)
  }
  return (e instanceof Error ? e.message : String(e)).slice(0, 300)
}

loadUpstream()
const proxy = startForkProxy('RPC_URL')
const real = createPublicClient({ transport: http(proxy.url, { timeout: 60_000 }) })
const realChainId = await real.getChainId()
if (realChainId !== BASE_CHAIN_ID) throw new Error(`the upstream RPC is chain ${realChainId}, not Base`)
const forkBlock = (await real.getBlock({ blockTag: 'finalized' })).number
note('upstream', true, `Base, finalized block ${forkBlock}`)

// --- 1. Addresses from primary docs, verified against real code on Base and Ethereum -----------------------------
const aquaViewAbi = parseAbi([
  'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)',
])
const codeHash = async (a: Address): Promise<Hex | null> => {
  const code = await real.getCode({ address: a })
  return code && code !== '0x' ? keccak256(code) : null
}
const aquaCodeOnBase = await codeHash(AQUA_FROM_DOCS)
const swapVmCodeOnBase = await codeHash(SWAP_VM_FROM_DOCS)
note('Aqua registry on Base has code', aquaCodeOnBase !== null, `${AQUA_FROM_DOCS}, codehash ${aquaCodeOnBase}`)
note('AquaSwapVMRouter on Base has code', swapVmCodeOnBase !== null, `${SWAP_VM_FROM_DOCS}, codehash ${swapVmCodeOnBase}`)
const sdkAqua = getAddress(AQUA_CONTRACT_ADDRESSES[NetworkEnum.COINBASE].toString())
const sdkSwapVm = getAddress(AQUA_SWAP_VM_CONTRACT_ADDRESSES[NetworkEnum.COINBASE].toString())
note('SDK addresses agree with the docs', sdkAqua === AQUA_FROM_DOCS && sdkSwapVm === SWAP_VM_FROM_DOCS, `aqua-sdk ${sdkAqua}, swap-vm-sdk ${sdkSwapVm}`)
// "Each core contract holds the same address on every chain" (reference/contract-addresses): check it against a
// second, independent public endpoint for Ethereum Mainnet. No key needed, nothing upstream of this call is secret.
try {
  const eth = createPublicClient({ transport: http('https://ethereum-rpc.publicnode.com', { timeout: 20_000 }) })
  const [ethAquaHash, ethSwapVmHash] = await Promise.all([
    eth.getCode({ address: AQUA_FROM_DOCS }).then((c) => (c && c !== '0x' ? keccak256(c) : null)),
    eth.getCode({ address: SWAP_VM_FROM_DOCS }).then((c) => (c && c !== '0x' ? keccak256(c) : null)),
  ])
  note('same bytecode on Ethereum Mainnet', ethAquaHash === aquaCodeOnBase && ethSwapVmHash === swapVmCodeOnBase, `registry ${ethAquaHash === aquaCodeOnBase ? 'matches' : 'DIFFERS'}, router ${ethSwapVmHash === swapVmCodeOnBase ? 'matches' : 'DIFFERS'}`)
} catch (e) {
  note('same bytecode on Ethereum Mainnet', null, `could not reach a second endpoint: ${reason(e)}`)
}

// --- 2. Fork --------------------------------------------------------------------------------------------------
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = portProbe.port as number
portProbe.stop(true)
const argv = ['--fork-url', proxy.url, '--fork-block-number', String(forkBlock), '--chain-id', String(LAB_CHAIN_ID), '--host', '127.0.0.1', '--port', String(port), '--slots-in-an-epoch', '1', '--no-request-size-limit']
assertNoKeyInArgv(argv, ['RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-aqua-probe-'))
const anvil = Bun.spawn([anvilBinary(), ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const anvilUrl = `http://127.0.0.1:${port}/`
const lab = new Lab(anvilUrl, LAB_CHAIN_ID)
let exitCode = 0
try {
  for (let i = 0; ; i++) {
    try {
      await lab.client.getBlockNumber()
      break
    } catch {
      if (i > 300) throw new Error(`anvil did not start (log: ${join(dir, 'anvil.log')})`)
      await Bun.sleep(100)
    }
  }
  note('fork', true, `anvil at block ${forkBlock}, chain id ${LAB_CHAIN_ID}`)

  // --- 3. A passkey-owned Safe as the maker, the same fixtures the Base scenarios start from -------------------
  const engineNow = async () => Number(await lab.timestamp())
  const world = await buildBasicWorld(lab, conservadorLabV1, engineNow)
  const safe = world.a1.safe
  note('maker Safe', true, `${safe}, owners: passkey + backup, funded with 10,000 USDC (fx-usdc)`)

  // Fund the Safe with WETH too. Deposit() on the canonical WETH9 predeploy, from a plain dev EOA, then an
  // ordinary ERC-20 transfer to the Safe: no whale address to trust, no Safe value-call plumbing to add.
  const WETH = address('WETH')
  const USDC = address('USDC')
  const depositAbi = parseAbi(['function deposit() payable'])
  const funder = devAccount(3)
  const wethAmount = 5n * ONE_E18
  await lab.setBalance(funder.address, wethAmount + 10n ** 18n)
  await lab.send(funder, WETH, encodeFunctionData({ abi: depositAbi, functionName: 'deposit' }), wethAmount)
  await lab.send(funder, WETH, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [safe, wethAmount] }))
  note('maker Safe funded with WETH', (await lab.balanceOf('WETH', safe)) === wethAmount, `${wethAmount} wei (5 WETH), via WETH9.deposit() + transfer, no whale impersonation`)

  // --- 4. Spot price from the same Base state the fork carries (Uniswap v3 WETH/USDC 0.05%, token0=WETH) ------
  const pool = address('pool:WETH/USDC/500')
  const slot0 = await lab.client.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const sqrtPriceX96 = slot0[0]
  // P = tokenGt/tokenLt (Aqua's convention, business.1inch.com/.../strategy) where tokenGt is the numerically
  // larger address. On Base, USDC (0x8335...) > WETH (0x4200...), so tokenGt=USDC, tokenLt=WETH, matching
  // Uniswap's token1/token0 on this pool exactly: no inversion needed.
  const tokenLtIsWeth = BigInt(WETH) < BigInt(USDC)
  if (!tokenLtIsWeth) throw new Error('address ordering assumption (WETH < USDC) no longer holds')
  const sqrtSpot = (sqrtPriceX96 * ONE_E18) / Q96
  // A +-~20% price band around spot: tight enough to be "concentrated", wide enough that a 500 USDC fill and a
  // later rebalance both stay inside it.
  const sqrtMin = (sqrtSpot * 9n) / 10n
  const sqrtMax = (sqrtSpot * 10n) / 9n
  const humanPrice = (sqrtP: bigint) => Number((sqrtP * sqrtP * 10n ** 12n) / ONE_E18) / 1e18
  note('spot price (Uniswap v3 oracle on the fork)', true, `pool ${pool}, ${humanPrice(sqrtSpot).toFixed(2)} USDC/WETH; concentrated band ${humanPrice(sqrtMin).toFixed(2)}-${humanPrice(sqrtMax).toFixed(2)} USDC/WETH`)
  // 1inch/swap-vm v1.0.2 src/instructions/XYCConcentrate.sol takes P as a pure raw-unit ratio (no decimals
  // normalization); the swap-vm-sdk README's own worked ship() example (rawPriceMin = 1e18/3000 for a USDC/WETH
  // pair) skips that normalization and is off by 10^12 for this pair. This probe derives P from raw on-chain
  // units directly instead of following that README example; see docs/research/aqua-2026-10.md.
  note('swap-vm-sdk README ship() example', false, 'rawPriceMin=1e18/humanPrice skips decimal normalization (verified against XYCConcentrate.sol); this probe computes P from raw token units instead')

  // --- 5. A tiny control strategy (fee = 0 bps), quoted but never filled, to measure the fee empirically ------
  const aqua = new AquaProtocolContract(new AquaAddress(AQUA_FROM_DOCS))
  const swapVmAddr = new AquaAddress(SWAP_VM_FROM_DOCS)
  const makerAddr = new AquaAddress(safe)

  const feeBps = 5 // matches the 0.05% tier of pool:WETH/USDC/500, the v3 baseline below
  const controlProgram = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin: sqrtMin, sqrtPriceMax: sqrtMax }).build()
  const controlOrder = Order.new({ maker: makerAddr, program: controlProgram, traits: MakerTraits.default() })
  const feeProgram = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin: sqrtMin, sqrtPriceMax: sqrtMax }).withFeeTokenIn(feeBps).build()
  const feeOrder = Order.new({ maker: makerAddr, program: feeProgram, traits: MakerTraits.default() })

  // --- 6. Owner approves USDC and WETH to Aqua.sol, signed by the passkey alone (SESS-style product path) ----
  const approveCap = 50_000n * 10n ** 6n // 50,000 USDC-equivalent allowance headroom; revocable, never spent by Aqua itself
  const approvals = await ownerBatch(
    lab,
    world.relayer,
    world.a1,
    [
      { to: USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [AQUA_FROM_DOCS, approveCap] }) },
      { to: WETH, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [AQUA_FROM_DOCS, wethAmount] }) },
    ],
    'passkey',
  )
  note('owner approves USDC + WETH to Aqua.sol, signed by the passkey alone', approvals.ok, `${approvals.receipt.gasUsed} gas, allowance ${approveCap} USDC + ${wethAmount} WETH`)
  if (!approvals.ok) exitCode = 1

  // --- 7. Ship the control strategy, quote() it against the fee strategy's would-be fill, dock it -------------
  // Aqua's ship()/dock() take no explicit maker parameter: the maker is msg.sender. For the Safe to be the maker
  // (plan section: "the maker can be a contract"), ship()/dock() must be sent as Safe transactions, not as a
  // plain relayer call, same as the approvals above. The control is sized identically to the real strategy
  // below (same L, same price band) so the only difference between the two quotes is the fee: a true A/B.
  const availableWeth = await lab.balanceOf('WETH', safe)
  const availableUsdc = 8_000_000_000n // leave 2,000 USDC idle in the wallet, unshipped
  const sized = computeLiquidityFromAmounts(availableWeth, availableUsdc, sqrtSpot, sqrtMin, sqrtMax)
  const controlAmounts = { app: swapVmAddr, strategy: controlOrder.encode(), amountsAndTokens: [{ token: new AquaAddress(WETH), amount: sized.actualLt }, { token: new AquaAddress(USDC), amount: sized.actualGt }] }
  const controlShipTx = aqua.ship(controlAmounts)
  const controlShip = await ownerExec(lab, world.relayer, world.a1, { to: getAddress(controlShipTx.to), data: controlShipTx.data as Hex }, 'passkey')
  note('control strategy shipped (fee = 0 bps, same size as the real strategy, never filled)', controlShip.ok, `${controlShip.receipt.gasUsed} gas, maker = the Safe (msg.sender)`)
  if (!controlShip.ok) exitCode = 1
  const controlHash = AquaProtocolContract.calculateStrategyHash(controlOrder.encode())
  const quoteArgs = { order: controlOrder, tokenIn: new AquaAddress(USDC), tokenOut: new AquaAddress(WETH), amount: 500_000_000n, takerTraits: TakerTraits.default() }
  const controlQuoteTx = new SwapVMContract(swapVmAddr).quote(quoteArgs)
  let controlOut = 0n
  try {
    const raw = await lab.client.call({ to: getAddress(controlQuoteTx.to), data: controlQuoteTx.data as Hex, account: devAccount(8).address })
    const decoded = decodeFunctionResult({ abi: SWAP_VM_ABI_NS.SWAP_VM_ABI, functionName: 'quote', data: raw.data as Hex })
    controlOut = (decoded as unknown as [bigint, bigint])[1]
    note('control quote (fee = 0 bps)', true, `500 USDC -> ${controlOut} wei WETH, no fee`)
  } catch (e) {
    note('control quote (fee = 0 bps)', null, `could not simulate: ${reason(e)}`)
  }
  const dockControlTx = aqua.dock({ app: swapVmAddr, strategyHash: controlHash, tokens: [new AquaAddress(WETH), new AquaAddress(USDC)] })
  const dockControl = await ownerExec(lab, world.relayer, world.a1, { to: getAddress(dockControlTx.to), data: dockControlTx.data as Hex }, 'passkey')
  note('control strategy docked', dockControl.ok, `${dockControl.receipt.gasUsed} gas, no tokens moved`)
  if (!dockControl.ok) exitCode = 1

  // --- 8. Ship the real strategy (fee = 5 bps, concentrated range) ---------------------------------------------
  const shipAmounts = { app: swapVmAddr, strategy: feeOrder.encode(), amountsAndTokens: [{ token: new AquaAddress(WETH), amount: sized.actualLt }, { token: new AquaAddress(USDC), amount: sized.actualGt }] }
  const shipTx = aqua.ship(shipAmounts)
  const [realUsdcBeforeShip, realWethBeforeShip] = [await lab.balanceOf('USDC', safe), await lab.balanceOf('WETH', safe)]
  const ship1 = await ownerExec(lab, world.relayer, world.a1, { to: getAddress(shipTx.to), data: shipTx.data as Hex }, 'passkey')
  const strategyHash = AquaProtocolContract.calculateStrategyHash(feeOrder.encode())
  note('ship() #1: concentrated strategy, fee 5 bps, maker = the Safe', ship1.ok, `${ship1.receipt.gasUsed} gas, ${sized.actualLt} wei WETH + ${sized.actualGt} USDC virtual balance (L=${sized.targetL}), strategyHash ${strategyHash}`)
  if (!ship1.ok) exitCode = 1
  const [realUsdcAfterShip, realWethAfterShip] = [await lab.balanceOf('USDC', safe), await lab.balanceOf('WETH', safe)]
  const virtualUsdc = await lab.client.readContract({ address: AQUA_FROM_DOCS, abi: aquaViewAbi, functionName: 'rawBalances', args: [safe, SWAP_VM_FROM_DOCS, strategyHash.toString(), USDC] })
  note(
    'no tokens moved by ship()',
    realUsdcAfterShip === realUsdcBeforeShip && realWethAfterShip === realWethBeforeShip,
    `real wallet balance unchanged (${realUsdcBeforeShip} USDC, ${realWethBeforeShip} wei WETH, before and after); Aqua's own counter now shows ${virtualUsdc[0]} virtual USDC backed by the allowance alone`,
  )

  // --- 9. A taker fills against the shipped strategy ---------------------------------------------------------
  const taker = devAccount(8)
  await lab.setBalance(taker.address, 10n ** 18n)
  const takerUsdcIn = 500_000_000n // 500 USDC
  await lab.whaleTransfer('USDC', WHALE, taker.address, takerUsdcIn)
  await lab.send(taker, USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SWAP_VM_FROM_DOCS, takerUsdcIn] }))
  const swapArgs = { order: feeOrder, tokenIn: new AquaAddress(USDC), tokenOut: new AquaAddress(WETH), amount: takerUsdcIn, takerTraits: TakerTraits.default() }
  const swapVm = new SwapVMContract(swapVmAddr)
  const swapTx = swapVm.swap(swapArgs)
  try {
    await lab.client.call({ account: taker.address, to: getAddress(swapTx.to), data: swapTx.data as Hex, gas: 5_000_000n })
    note('taker fill, dry run (eth_call)', true, 'would succeed')
  } catch (e) {
    note('taker fill, dry run (eth_call)', false, reason(e))
  }
  const virtualUsdcBeforeFill = await lab.client.readContract({ address: AQUA_FROM_DOCS, abi: aquaViewAbi, functionName: 'rawBalances', args: [safe, SWAP_VM_FROM_DOCS, strategyHash.toString(), USDC] })
  const wethBeforeFill = await lab.balanceOf('WETH', taker.address)
  const fill = await lab.send(taker, getAddress(swapTx.to), swapTx.data as Hex)
  const wethOut = (await lab.balanceOf('WETH', taker.address)) - wethBeforeFill
  const virtualUsdcAfterFill = await lab.client.readContract({ address: AQUA_FROM_DOCS, abi: aquaViewAbi, functionName: 'rawBalances', args: [safe, SWAP_VM_FROM_DOCS, strategyHash.toString(), USDC] })
  const virtualUsdcDelta = virtualUsdcAfterFill[0] - virtualUsdcBeforeFill[0]
  note('taker fills 500 USDC -> WETH against the strategy', fill.ok && wethOut > 0n, `${fill.ok ? fill.receipt.gasUsed : 'n/a'} gas, taker received ${wethOut} wei WETH, maker's virtual USDC balance moved by ${virtualUsdcDelta} (observed via Aqua's own rawBalances, not computed)`)
  if (!(fill.ok && wethOut > 0n)) exitCode = 1

  // Fee earned. `rawBalances` is the maker's aggregate virtual reserve, not a line-itemed fee balance, so the
  // input-side read below only establishes WHERE the fee acts (it does not, by itself, prove a fee was charged:
  // a push() of the taker's gross amount would look identical with feeBps = 0). What actually demonstrates a fee
  // was charged is the A/B: an identically sized (same L, same price band, same block), fee-free control
  // strategy's quote for the same 500 USDC trade, against what the fee strategy actually delivered. `ok` below
  // is conditioned on that output-side shortfall existing and landing within a wide band of the configured
  // feeBps (not just logged as true regardless) -- a misencoded or missing fee instruction would show up here
  // as ok=false, not be masked.
  const feeOnInputObserved = virtualUsdcDelta > takerUsdcIn ? virtualUsdcDelta - takerUsdcIn : 0n
  if (controlOut > 0n) {
    const outputSideDelta = controlOut > wethOut ? controlOut - wethOut : 0n
    const outputSideBps = controlOut > 0n ? Number((outputSideDelta * 10_000n) / controlOut) : 0
    const feeConfirmed = outputSideBps > 0 && outputSideBps <= feeBps
    note(
      'fee earned by the maker',
      feeConfirmed,
      `output side (the measurement that actually demonstrates a fee, not just a balance read): the fee-free control quote (same L, same price band, same block) would have delivered ${controlOut} wei WETH vs ${wethOut} wei WETH actually delivered, a ${outputSideBps} bps shortfall against a strategy set to ${feeBps} bps. ` +
        `input side (where the fee does NOT show up, for completeness): the maker's virtual USDC balance moved by ${virtualUsdcDelta} against a ${takerUsdcIn} gross input -- ${feeOnInputObserved} more than the input, i.e. no premium credited there; the fee is purely an output-side effect`,
    )
    if (!feeConfirmed) exitCode = 1
  } else {
    note('fee earned by the maker', null, `output-side control-quote cross-check unavailable, so the fee cannot be demonstrated this run (only the nominal ${(takerUsdcIn * BigInt(feeBps)) / 10_000n} raw USDC-equivalent by construction); input side showed ${virtualUsdcDelta} against a ${takerUsdcIn} gross input, no premium credited there`)
  }

  // --- 10. Overcommit: the Safe sends its real WETH away without docking first; the next fill must revert -----
  const dead: Address = '0x000000000000000000000000000000000000dEaD'
  const wethLeft = await lab.balanceOf('WETH', safe)
  const drain = await ownerExec(lab, world.relayer, world.a1, { to: WETH, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [dead, wethLeft] }) }, 'passkey')
  note('owner moves the Safe\'s real WETH away (no dock first)', drain.ok, `${drain.ok ? drain.receipt.gasUsed : 'n/a'} gas; the strategy still advertises its old virtual WETH balance`)
  if (!drain.ok) exitCode = 1
  const takerUsdcIn2 = 200_000_000n
  await lab.whaleTransfer('USDC', WHALE, taker.address, takerUsdcIn2)
  await lab.send(taker, USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SWAP_VM_FROM_DOCS, takerUsdcIn2] }))
  const swapArgs2 = { order: feeOrder, tokenIn: new AquaAddress(USDC), tokenOut: new AquaAddress(WETH), amount: takerUsdcIn2, takerTraits: TakerTraits.default() }
  const swapTx2 = swapVm.swap(swapArgs2)
  let overcommitReverted = false
  let overcommitDetail = ''
  try {
    await lab.client.call({ account: taker.address, to: getAddress(swapTx2.to), data: swapTx2.data as Hex, gas: 5_000_000n })
    overcommitDetail = 'the call did NOT revert'
  } catch (e) {
    overcommitReverted = true
    overcommitDetail = reason(e)
  }
  note('overcommit: a fill against a strategy with no real tokens left reverts', overcommitReverted, overcommitDetail)
  if (!overcommitReverted) exitCode = 1

  // --- 11. Rebalance: dock the old strategy, ship a new one at a shifted range, with what is left ---------------
  await lab.setBalance(funder.address, wethLeft + 10n ** 18n)
  await lab.send(funder, WETH, encodeFunctionData({ abi: depositAbi, functionName: 'deposit' }), wethLeft)
  await lab.send(funder, WETH, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [safe, wethLeft] }))
  const sqrtMinShifted = (sqrtSpot * 10n) / 9n // the old max becomes the new min: price moved up
  const sqrtMaxShifted = (sqrtMinShifted * 10n) / 9n
  const newProgram = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin: sqrtMinShifted, sqrtPriceMax: sqrtMaxShifted }).withFeeTokenIn(feeBps).build()
  const newOrder = Order.new({ maker: makerAddr, program: newProgram, traits: MakerTraits.default() })
  const stillWeth = await lab.balanceOf('WETH', safe)
  const stillUsdc = await lab.balanceOf('USDC', safe)
  const sizedNew = computeLiquidityFromAmounts(stillWeth, stillUsdc > availableUsdc ? availableUsdc : stillUsdc, sqrtSpot, sqrtMinShifted, sqrtMaxShifted)

  const dockTx = aqua.dock({ app: swapVmAddr, strategyHash, tokens: [new AquaAddress(WETH), new AquaAddress(USDC)] })
  const dock1 = await ownerExec(lab, world.relayer, world.a1, { to: getAddress(dockTx.to), data: dockTx.data as Hex }, 'passkey')
  const ship2Amounts = { app: swapVmAddr, strategy: newOrder.encode(), amountsAndTokens: [{ token: new AquaAddress(WETH), amount: sizedNew.actualLt }, { token: new AquaAddress(USDC), amount: sizedNew.actualGt }] }
  const ship2Tx = aqua.ship(ship2Amounts)
  const ship2 = await ownerExec(lab, world.relayer, world.a1, { to: getAddress(ship2Tx.to), data: ship2Tx.data as Hex }, 'passkey')
  const aquaRebalanceGas = (dock1.ok ? dock1.receipt.gasUsed : 0n) + (ship2.ok ? ship2.receipt.gasUsed : 0n)
  note('rebalance: dock() + ship() at a shifted range', dock1.ok && ship2.ok, `dock ${dock1.ok ? dock1.receipt.gasUsed : 'FAIL'} gas + ship ${ship2.ok ? ship2.receipt.gasUsed : 'FAIL'} gas = ${aquaRebalanceGas} gas total, no tokens moved either step`)
  if (!(dock1.ok && ship2.ok)) exitCode = 1
  // Same two calls, batched in one Safe transaction (multiSendCallOnly), as a real rebalance would ship it.
  const batchDock = aqua.dock({ app: swapVmAddr, strategyHash: AquaProtocolContract.calculateStrategyHash(newOrder.encode()), tokens: [new AquaAddress(WETH), new AquaAddress(USDC)] })
  const thirdProgram = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin: sqrtMin, sqrtPriceMax: sqrtMax }).withFeeTokenIn(feeBps).withSalt(777n).build()
  const thirdOrder = Order.new({ maker: makerAddr, program: thirdProgram, traits: MakerTraits.default() })
  const batchShip = aqua.ship({ app: swapVmAddr, strategy: thirdOrder.encode(), amountsAndTokens: ship2Amounts.amountsAndTokens })
  const batched = await ownerBatch(
    lab,
    world.relayer,
    world.a1,
    [
      { to: getAddress(batchDock.to), value: 0n, data: batchDock.data as Hex },
      { to: getAddress(batchShip.to), value: 0n, data: batchShip.data as Hex },
    ],
    'passkey',
  )
  note('rebalance, batched in one Safe transaction (as production would send it)', batched.ok, `${batched.ok ? batched.receipt.gasUsed : 'FAIL'} gas total, signed by the passkey alone`)
  if (!batched.ok) exitCode = 1

  // --- 12. The same Safe's Uniswap v3 cycle on the same fork, for the gas comparison --------------------------
  const v3Pool = address('pool:WETH/USDC/500')
  const v3Slot0 = await lab.client.readContract({ address: v3Pool, abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const tick = v3Slot0[1]
  const spacing = 10
  const base = Math.floor(tick / spacing) * spacing
  const width = 2000 // ticks either side, a "concentrated" v3 range comparable in spirit to the Aqua band above
  const v3MintUsdc = 1_000_000_000n // 1,000 USDC
  const v3MintWeth = await lab.balanceOf('WETH', safe)
  const v3Deadline = BigInt(Number(await lab.timestamp()) + 3600)
  const mint1 = await ownerBatch(
    lab,
    world.relayer,
    world.a1,
    [v3Approve('USDC', 'NonfungiblePositionManager', v3MintUsdc), v3Approve('WETH', 'NonfungiblePositionManager', v3MintWeth), v3Mint({ account: safe, pool: 'pool:WETH/USDC/500', tickLower: base - width, tickUpper: base + width + spacing, amount0Desired: v3MintWeth, amount1Desired: v3MintUsdc, amount0Min: 1n, amount1Min: 1n, deadline: v3Deadline })],
    'passkey',
  )
  note('v3 baseline: mint', mint1.ok, `${mint1.ok ? mint1.receipt.gasUsed : 'FAIL'} gas`)
  if (!mint1.ok) exitCode = 1
  const mintedId = mint1.ok
    ? parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: mint1.receipt.logs, eventName: 'Transfer' }).find((l) => l.args.to.toLowerCase() === safe.toLowerCase())?.args.tokenId
    : undefined
  let v3RebalanceGas = 0n
  if (mintedId !== undefined) {
    const posAbi = parseAbi(['function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'])
    const pos = await lab.client.readContract({ address: address('NonfungiblePositionManager'), abi: posAbi, functionName: 'positions', args: [mintedId] })
    const liquidity = pos[7]
    // decrease + collect + burn + approve*2 + mint: exactly the action set of this repo's own `manage-any`
    // session grant (packages/policy/src/grants.ts) for re-ranging a position, not an ad-hoc cycle invented for
    // this comparison. Burning the emptied NFT is part of a real re-range; omitting it would understate v3's
    // gas cost, not overstate it.
    const rebalance = await ownerBatch(
      lab,
      world.relayer,
      world.a1,
      [
        decreaseLiquidity({ tokenId: mintedId, liquidity, amount0Min: 1n, amount1Min: 1n, deadline: v3Deadline }),
        collect({ account: safe, tokenId: mintedId }),
        v3Burn(mintedId),
        v3Approve('USDC', 'NonfungiblePositionManager', v3MintUsdc),
        v3Approve('WETH', 'NonfungiblePositionManager', v3MintWeth / 2n),
        v3Mint({ account: safe, pool: 'pool:WETH/USDC/500', tickLower: base, tickUpper: base + width * 2 + spacing, amount0Desired: v3MintWeth / 2n, amount1Desired: v3MintUsdc, amount0Min: 1n, amount1Min: 1n, deadline: v3Deadline }),
      ],
      'passkey',
    )
    v3RebalanceGas = rebalance.ok ? rebalance.receipt.gasUsed : 0n
    note('v3 baseline: rebalance (decreaseLiquidity + collect + burn + approve*2 + mint, the `manage-any` grant\'s own action set), batched in one Safe transaction', rebalance.ok, `${rebalance.ok ? rebalance.receipt.gasUsed : 'FAIL'} gas total, signed by the passkey alone`)
    if (!rebalance.ok) exitCode = 1
  } else {
    note('v3 baseline: rebalance', false, 'no position minted to read a tokenId from')
    exitCode = 1
  }

  // --- 13. Gas comparison -----------------------------------------------------------------------------------
  note(
    'gas per rebalance: Aqua dock+ship vs Uniswap v3 decrease+collect+mint',
    null,
    `Aqua, 2 separate txs: ${aquaRebalanceGas} gas; Aqua, 1 batched tx: ${batched.ok ? batched.receipt.gasUsed : 'FAIL'} gas; v3, 1 batched tx: ${v3RebalanceGas} gas (same fork, same Safe, same passkey signer)`,
  )

  // --- 14. Session-key feasibility: how far can UniActionPolicy scope ship()/dock() today? --------------------
  // UniActionPolicy (github.com/erc7579/smartsessions, as this repo's own `enter-swap`/`enter-mint`/`manage`
  // grants in packages/policy/src/grants.ts already use it) compares one 32-byte calldata word at a fixed
  // `index*32` offset after the 4-byte selector, up to 16 rules per (target, selector) pair, with EQUAL,
  // GREATER_THAN, LESS_THAN, GREATER_THAN_OR_EQUAL, LESS_THAN_OR_EQUAL, NOT_EQUAL or IN_RANGE. It has no notion
  // of "iterate this array" or "decode this dynamic blob": a rule can only pin a WORD, not an array element.
  const shipSelector = (shipTx.data as Hex).slice(0, 10)
  const dockSelector = (dockTx.data as Hex).slice(0, 10)
  const word = (data: Hex, i: number) => `0x${data.slice(10 + i * 64, 10 + (i + 1) * 64)}`
  note(
    'ship() calldata layout: only word 0 (app) is a real constraint',
    null,
    `selector ${shipSelector}; word0(app)=${word(shipTx.data as Hex, 0)} [pinnable: EQUAL AquaSwapVMRouter]; ` +
      `word1(strategy offset)=${word(shipTx.data as Hex, 1)} [always 0x80 regardless of strategy content: no containment]; ` +
      `word2(tokens offset)=${word(shipTx.data as Hex, 2)}, word3(amounts offset)=${word(shipTx.data as Hex, 3)} [vary with strategy length, point into the tail: cannot pin WHICH strategy/tokens/amounts ship]`,
  )
  note(
    'dock() calldata layout: app AND strategyHash are both real constraints',
    null,
    `selector ${dockSelector}; word0(app)=${word(dockTx.data as Hex, 0)} [EQUAL AquaSwapVMRouter]; ` +
      `word1(strategyHash)=${word(dockTx.data as Hex, 1)} [EQUAL <one pre-shipped hash>: static bytes32, a real pin, same shape as this repo's 'manage' grant's \`tokenId EQUAL <id>\`]; ` +
      `word2(tokens offset)=${word(dockTx.data as Hex, 2)} [always 0x60: vacuous, but AquaApp already reverts DockingShouldCloseAllTokens unless the full token list is given]`,
  )
  note(
    'session-key answer',
    null,
    'dock() can be scoped tightly (app=AquaSwapVMRouter, strategyHash=<one strategy>): a session key could safely retire one pre-shipped strategy, mirroring how `manage` already pins one tokenId. ' +
      "ship() cannot be meaningfully scoped past the app address with UniActionPolicy alone: the strategy bytes, token list and amounts are a dynamic tail, the same shape problem already flagged for Uniswap v4's modifyLiquidities in the routing design note. " +
      'A session key can safely dock; shipping (entering a new range) needs either an owner-signed step (as this probe does, passkey ownerExec) or a purpose-built executor with fixed-offset arguments.',
  )
} catch (e) {
  note('probe', false, e instanceof Error ? e.message : String(e))
  exitCode = 1
} finally {
  anvil.kill()
  proxy.stop()
}

console.log('\n=== summary ===')
for (const l of report) console.log(`${l.ok === null ? '-' : l.ok ? '✓' : '✗'} ${l.step}: ${l.detail}`)
process.exit(exitCode)
