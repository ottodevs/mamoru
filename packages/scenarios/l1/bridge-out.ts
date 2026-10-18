// Bridge-out probe (otto/mamoru#133, first instance of the routing layer): USDC that arrived on Ethereum at the
// address of a Mamoru account, before the account exists there, leaves for the same account on Base.
//
// This is the situation of otto/mamoru#117: the USDC sits at the counterfactual address, the Safe is not deployed
// on Ethereum, and the account holds no ETH. On a fork of Ethereum the relayer deploys the Safe (a factory call
// needs no owner signature) and then submits one owner transaction whose only signature is the passkey's:
// approve + Across SpokePool.depositV3 with recipient = the same address, destination Base. The relayer pays the
// L1 gas, as on Base. The route parameters come from Across's live quote. The script checks the deposit event
// names the account as depositor and as recipient on chain 8453, and that nothing is left behind.
//
// Nothing is sent to a real chain and no product code path changes. The fill on Base is Across's relayer and is
// not part of this probe.
//
// Run: nix shell nixpkgs#foundry --command bun packages/scenarios/l1/bridge-out.ts
// Upstream RPC: L1_RPC_URL, or QUICKNODE_ETH_MAINNET_HTTP from ~/.config/quicknode/endpoints.env. It reaches anvil
// through a loopback proxy and is never printed.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, parseEventLogs } from 'viem'
import type { Address, Hex } from '@mamoru/domain'
import { address, erc20Abi } from '@mamoru/registry'
import { anvilBinary, assertNoKeyInArgv, sanitizedEnv } from '../fork/anvil.ts'
import { startForkProxy } from '../proxy/index.ts'
import { Lab, devAccount } from '../fixtures/lab.ts'

const LAB_CHAIN_ID = 31_337
const BASE_CHAIN_ID = 8453
const L1_USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
/** Across SpokePool on Ethereum Mainnet. The live quote must name the same contract or the probe stops. */
const ACROSS_SPOKE_POOL: Address = '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'
const L1_USDC_HOLDER: Address = '0x28C6c06298d514Db089934071355E5743bf21d60'
/** The amount of otto/mamoru#117, rounded. */
const AMOUNT = 150_000_000n

const spokePoolAbi = parseAbi([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
  'event V3FundsDeposited(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, address indexed depositor, address recipient, address exclusiveRelayer, bytes message)',
])

type Line = { step: string; ok: boolean | null; detail: string }
const report: Line[] = []
const t0 = Date.now()
function redact(text: string): string {
  const upstream = process.env.L1_RPC_URL
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
  if (process.env.L1_RPC_URL) return
  const file = join(homedir(), '.config/quicknode/endpoints.env')
  if (!existsSync(file)) throw new Error('set L1_RPC_URL to an Ethereum Mainnet archive RPC')
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('QUICKNODE_ETH_MAINNET_HTTP='))
  if (!line) throw new Error('QUICKNODE_ETH_MAINNET_HTTP is not in ~/.config/quicknode/endpoints.env')
  process.env.L1_RPC_URL = line.slice(line.indexOf('=') + 1).replace(/^["']|["']$/g, '').trim()
}

// --- 1. The live route ------------------------------------------------------------------------------------------
type AcrossQuote = {
  totalRelayFee: { total: string; pct: string }
  timestamp: string
  fillDeadline: string
  exclusiveRelayer: Address
  exclusivityDeadline: number
  spokePoolAddress: Address
  estimatedFillTimeSec: number
  isAmountTooLow: boolean
}
const url = `https://app.across.to/api/suggested-fees?inputToken=${L1_USDC}&outputToken=${BASE_USDC}&originChainId=1&destinationChainId=${BASE_CHAIN_ID}&amount=${AMOUNT}`
const quote = (await (await fetch(url)).json()) as AcrossQuote
if (getAddress(quote.spokePoolAddress) !== getAddress(ACROSS_SPOKE_POOL)) throw new Error(`Across quotes SpokePool ${quote.spokePoolAddress}, pinned ${ACROSS_SPOKE_POOL}`)
if (quote.isAmountTooLow) throw new Error('Across says the amount is too low')
const fee = BigInt(quote.totalRelayFee.total)
const outputAmount = AMOUNT - fee
note('route', true, `Across, ${Number(AMOUNT) / 1e6} USDC → ${Number(outputAmount) / 1e6} USDC on Base, fee ${Number(fee) / 1e6} USDC, fill ~${quote.estimatedFillTimeSec} s`)

// --- 2. Fork ----------------------------------------------------------------------------------------------------
loadUpstream()
const proxy = startForkProxy('L1_RPC_URL')
const real = createPublicClient({ transport: http(proxy.url, { timeout: 60_000 }) })
if ((await real.getChainId()) !== 1) throw new Error('the upstream RPC is not Ethereum Mainnet')
// Latest, not finalized: the quote timestamp must not be ahead of the fork's clock.
const forkBlock = await real.getBlockNumber()
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = portProbe.port as number
portProbe.stop(true)
const argv = ['--fork-url', proxy.url, '--fork-block-number', String(forkBlock), '--chain-id', String(LAB_CHAIN_ID), '--host', '127.0.0.1', '--port', String(port), '--no-request-size-limit']
assertNoKeyInArgv(argv, ['L1_RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-l1-bridge-'))
const anvil = Bun.spawn([anvilBinary(), ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const lab = new Lab(`http://127.0.0.1:${port}/`, LAB_CHAIN_ID)
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
  note('fork', true, `Ethereum at block ${forkBlock}`)

  const { accountSetup, counterfactualAddress } = await import('@mamoru/account/recovery')
  const { createProxyCall, webAuthnSigner } = await import('@mamoru/account/safe')
  const { SessionLedger } = await import('@mamoru/account/precheck')
  const { ownerBatch } = await import('../fixtures/world.ts')
  const { SoftwarePasskey, PASSKEY_SCALARS } = await import('../webauthn/index.ts')
  const relayer = devAccount(0)
  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const setup = accountSetup([address('SafeWebAuthnSharedSigner')], 3n, webAuthnSigner(passkey.x, passkey.y))
  const safe = counterfactualAddress(setup)

  // The USDC arrives before the account exists, as it did for the user of #117.
  await lab.setBalance(L1_USDC_HOLDER, 10n ** 18n)
  const sent = await lab.sendAs(L1_USDC_HOLDER, L1_USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [safe, AMOUNT] }))
  const codeBefore = (await lab.client.getCode({ address: safe })) ?? '0x'
  const ethBefore = await lab.client.getBalance({ address: safe })
  note('USDC at the counterfactual address', sent.ok && codeBefore === '0x' && ethBefore === 0n, `${safe}: ${Number(AMOUNT) / 1e6} USDC, no code, ${ethBefore} wei`)

  const deploy = createProxyCall(setup)
  const deployed = await lab.send(relayer, deploy.to, deploy.data)
  const hasCode = ((await lab.client.getCode({ address: safe })) ?? '0x') !== '0x'
  note('relayer deploys the account', deployed.ok && hasCode, `same address as on Base; ${deployed.receipt.gasUsed} gas`)

  const acct = { label: 'B1', safe, backupOwner: devAccount(9), passkey, sessionKey: devAccount(4), caps: {}, grants: [], managedTokenIds: [], ownerTokenIds: [], ledger: new SessionLedger(), signedOwnerTxs: [] } as unknown as Parameters<typeof ownerBatch>[2]
  const quoteTimestamp = Number(quote.timestamp)
  const deposit: Hex = encodeFunctionData({
    abi: spokePoolAbi,
    functionName: 'depositV3',
    args: [safe, safe, L1_USDC, BASE_USDC, AMOUNT, outputAmount, BigInt(BASE_CHAIN_ID), quote.exclusiveRelayer, quoteTimestamp, Number(quote.fillDeadline), quote.exclusivityDeadline, '0x'],
  })
  const approveCall: Hex = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ACROSS_SPOKE_POOL, AMOUNT] })
  const poolBefore = await lab.client.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [ACROSS_SPOKE_POOL] })
  const tx = await ownerBatch(lab, relayer, acct, [
    { to: L1_USDC, value: 0n, data: approveCall },
    { to: ACROSS_SPOKE_POOL, value: 0n, data: deposit },
  ], 'passkey')
  note('owner transaction, passkey only: approve + depositV3', tx.ok, `${tx.receipt.gasUsed} gas, paid by the relayer`)

  const events = parseEventLogs({ abi: spokePoolAbi, logs: tx.receipt.logs.filter((l) => getAddress(l.address) === getAddress(ACROSS_SPOKE_POOL)) })
  const ev = events[0]
  const asAddr = (v: Address | Hex) => getAddress(v.length === 66 ? `0x${v.slice(26)}` : v)
  if (!ev) {
    note('deposit event', false, 'SpokePool emitted no deposit event')
    exitCode = 1
  } else {
    const a = ev.args as { depositor: Hex; recipient: Hex; destinationChainId: bigint; inputAmount: bigint; outputAmount: bigint; depositId: bigint | number; outputToken: Hex }
    const ok = asAddr(a.depositor) === safe && asAddr(a.recipient) === safe && a.destinationChainId === BigInt(BASE_CHAIN_ID) && a.inputAmount === AMOUNT && a.outputAmount === outputAmount && asAddr(a.outputToken) === BASE_USDC
    note(`deposit event (${ev.eventName})`, ok, `id ${a.depositId}, depositor and recipient ${ok ? '= the account' : `${asAddr(a.depositor)} / ${asAddr(a.recipient)}`}, chain ${a.destinationChainId}, out ${Number(a.outputAmount) / 1e6} USDC (native USDC on Base)`)
    if (!ok) exitCode = 1
  }
  const left = await lab.client.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [safe] })
  const poolAfter = await lab.client.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [ACROSS_SPOKE_POOL] })
  const allowance = await lab.client.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'allowance', args: [safe, ACROSS_SPOKE_POOL] })
  const clean = left === 0n && poolAfter - poolBefore === AMOUNT && allowance === 0n
  note('nothing left behind', clean, `account USDC ${left}, SpokePool +${Number(poolAfter - poolBefore) / 1e6} USDC, allowance ${allowance}`)
  if (!(sent.ok && deployed.ok && hasCode && tx.ok && clean)) exitCode = 1

  const gas = deployed.receipt.gasUsed + tx.receipt.gasUsed
  const price = await real.getGasPrice()
  note('relayer cost', null, `${gas} gas; at ${(Number(price) / 1e9).toFixed(3)} gwei now = ${(Number(gas * price) / 1e18).toFixed(6)} ETH`)
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
