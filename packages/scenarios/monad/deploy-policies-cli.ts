// otto/mamoru#62: TimeFramePolicy and UsageLimitPolicy on Monad mainnet at their Base addresses.
//
//   bun run monad:deploy-policies                 dry run against https://rpc.monad.xyz (default, sends nothing)
//   bun run monad:deploy-policies --execute       sign with MAMORU_MONAD_DEPLOYER_KEY and send
//   --rpc <url>     another Monad RPC (an anvil fork of Monad for a rehearsal); its chain id must still be 143
//   --base-rpc <url> Base RPC for the byte-for-byte runtime comparison (default https://mainnet.base.org)
//   --from <addr>   address to price and check the balance of in a dry run without the key
//
// Idempotent: a policy with its Base code is not redeployed, one with its ModuleRecord is not re-registered. The key is
// read from the environment only and never printed.
import { createPublicClient, createWalletClient, defineChain, http, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import {
  ARACHNID_DEPLOYER,
  MODULE_REGISTRY,
  MONAD_CHAIN_ID,
  RESOLVER_UID,
  estimate,
  formatMon,
  monadscan,
  observe,
  planPolicy,
  policySpecs,
  predictAddress,
  totalCost,
  type PolicyPlan,
} from './mainnet-policies.ts'

const KEY_ENV = 'MAMORU_MONAD_DEPLOYER_KEY'
const EXPECTED_DEPLOYER = '0x40eDADDd19dCE5478BEAbF9b0cA12202Fb90d0F3' as Address

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const execute = process.argv.includes('--execute')
const rpc = arg('--rpc') ?? 'https://rpc.monad.xyz'
const baseRpc = arg('--base-rpc') ?? 'https://mainnet.base.org'

const monadChain = defineChain({ id: MONAD_CHAIN_ID, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
const client = createPublicClient({ chain: monadChain, transport: http(rpc, { timeout: 60_000 }) }) as PublicClient
const base = createPublicClient({ transport: http(baseRpc, { timeout: 60_000 }) }) as PublicClient

function host(u: string): string {
  try {
    return new URL(u).host
  } catch {
    return 'unparseable'
  }
}

function fail(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

async function main(): Promise<void> {
  console.log(`mode: ${execute ? 'EXECUTE' : 'dry run'} · rpc ${host(rpc)} · base ${host(baseRpc)}`)
  const chainId = await client.getChainId()
  if (chainId !== MONAD_CHAIN_ID) fail(`chain id ${chainId}, expected ${MONAD_CHAIN_ID} (Monad mainnet)`)
  console.log(`chain id ${chainId} ok, block ${await client.getBlockNumber()}`)

  // Signer: from the env key only. A dry run without it prices for --from or the expected deployer.
  const raw = process.env[KEY_ENV]
  let account: ReturnType<typeof privateKeyToAccount> | null = null
  if (raw) {
    const k = (raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`) as Hex
    try {
      account = privateKeyToAccount(k)
    } catch {
      fail(`${KEY_ENV} is not a valid private key`)
    }
  } else if (execute) fail(`--execute needs ${KEY_ENV} in the environment`)
  const from = (account?.address ?? (arg('--from') as Address | undefined) ?? EXPECTED_DEPLOYER) as Address
  console.log(`signer ${from}${account ? ' (from env key)' : ' (no key: dry run pricing only)'}${from.toLowerCase() === EXPECTED_DEPLOYER.toLowerCase() ? '' : ` — NOTE: expected deployer is ${EXPECTED_DEPLOYER}`}`)

  // Preconditions on the chain: the Arachnid deployer and ModuleRegistry exist.
  if (((await client.getCode({ address: ARACHNID_DEPLOYER })) ?? '0x') === '0x') fail(`Arachnid CREATE2 deployer ${ARACHNID_DEPLOYER} has no code`)
  if (((await client.getCode({ address: MODULE_REGISTRY })) ?? '0x') === '0x') fail(`ModuleRegistry ${MODULE_REGISTRY} has no code`)

  // The specs check (offline) that the Base calldata CREATE2s to the Base registry address.
  const specs = policySpecs()
  const baseRuntime: Record<string, Hex> = {}
  for (const s of specs) {
    const code = (await base.getCode({ address: s.address })) ?? '0x'
    if (code === '0x') fail(`${s.name}: no code on Base at ${s.address}`)
    baseRuntime[s.name] = code
  }

  const plans: PolicyPlan[] = []
  for (const s of specs) {
    const predicted = predictAddress(ARACHNID_DEPLOYER, s.input)
    const p = planPolicy(s, await observe(client, s))
    plans.push(p)
    console.log(`\n${s.name}`)
    console.log(`  target    ${s.address} (CREATE2 predicted ${predicted}: ${predicted.toLowerCase() === s.address.toLowerCase() ? 'equal' : 'DIFFERENT'})`)
    console.log(`  code      ${p.deployed ? 'present, Base code hash' : 'none'}`)
    console.log(`  record    ${p.registered ? `registered under ${RESOLVER_UID}` : 'none'}`)
    console.log(`  to do     ${p.steps.length ? p.steps.map((x) => x.kind).join(' + ') : 'nothing'}`)
  }

  const steps = plans.flatMap((p) => p.steps)
  if (steps.length === 0) {
    console.log('\nnothing to send: both policies deployed with Base code and registered.')
    await verify(plans)
    return
  }

  const lines = await estimate(client, from, steps, baseRuntime)
  const gasPrice = await client.getGasPrice()
  const fees = await client.estimateFeesPerGas().catch(() => null)
  const maxFee = fees?.maxFeePerGas ?? gasPrice
  const need = totalCost(lines, maxFee)
  const balance = await client.getBalance({ address: from })

  console.log(`\nplan (Monad charges gas LIMIT x price):`)
  for (const l of lines) console.log(`  ${l.step.kind.padEnd(8)} ${l.step.name.padEnd(17)} estimate ${l.estimate} (${l.estimatedWith}) -> limit ${l.limit} = ${formatMon(l.limit * maxFee)} MON`)
  console.log(`  gas price ${gasPrice} wei (${Number(gasPrice) / 1e9} gwei), max fee used ${maxFee} wei`)
  console.log(`  total     ${formatMon(totalCost(lines, gasPrice))} MON at gas price, ${formatMon(need)} MON at max fee`)
  console.log(`  balance   ${formatMon(balance)} MON at ${from}`)
  const short = need - balance
  if (short > 0n) console.log(`  SHORTFALL ${formatMon(short)} MON (send at least this to ${from})`)

  if (!execute) {
    console.log('\ndry run: nothing sent. Re-run with --execute to send.')
    return
  }
  if (short > 0n) fail(`insufficient MON: shortfall ${formatMon(short)} MON at ${from}`)

  const wallet = createWalletClient({ account: account!, chain: monadChain, transport: http(rpc, { timeout: 120_000 }) })
  for (const l of lines) {
    const hash = await wallet.sendTransaction({ to: l.step.to, data: l.step.data, gas: l.limit, maxFeePerGas: maxFee, maxPriorityFeePerGas: fees?.maxPriorityFeePerGas ?? 0n })
    const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    console.log(`  ${l.step.kind} ${l.step.name}: ${r.status} gasUsed ${r.gasUsed}/${l.limit} ${monadscan.tx(hash)}`)
    if (r.status !== 'success') fail(`${l.step.kind} ${l.step.name} reverted (${hash})`)
  }

  // Re-read: the plan must now be empty, then the byte-for-byte check.
  const after: PolicyPlan[] = []
  for (const s of specs) after.push(planPolicy(s, await observe(client, s)))
  const left = after.flatMap((p) => p.steps)
  if (left.length) fail(`after sending, still to do: ${left.map((x) => `${x.kind} ${x.name}`).join(', ')}`)
  await verify(after)
}

async function verify(plans: PolicyPlan[]): Promise<void> {
  console.log('\nverify (Monad runtime == Base runtime, byte for byte):')
  for (const p of plans) {
    const [m, b] = await Promise.all([client.getCode({ address: p.spec.address }), base.getCode({ address: p.spec.address })])
    const same = !!m && !!b && m.toLowerCase() === b.toLowerCase()
    console.log(`  ${p.spec.name.padEnd(17)} ${same ? 'IDENTICAL' : 'DIFFERENT'} (${((m?.length ?? 2) - 2) / 2} bytes) ${monadscan.address(p.spec.address)}`)
    if (!same) fail(`${p.spec.name}: Monad runtime differs from Base`)
  }
}

main().catch((e) => {
  // Error messages from viem never carry the key (it is not in any request); print the short message only.
  console.error(`ABORT: ${(e as Error).message?.split('\n')[0] ?? e}`)
  process.exit(1)
})
