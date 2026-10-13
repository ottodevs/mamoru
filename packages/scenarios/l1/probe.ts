// Feasibility probe (otto/mamoru#125): does the account path Mamoru runs on Base work on Ethereum Mainnet?
// It forks Ethereum with anvil and runs the same fixtures the Base scenarios start from: a Safe deployed with a
// passkey owner, session grants enabled, then a swap and a mint sent through the session. The fixtures sign owner
// steps with a backup owner, so it then does what the product does: an account whose only owner is the passkey,
// deployed by the relayer, then trusted and granted with WebAuthn signatures alone, and used by its session key. Nothing is sent to a real chain and no product code path changes.
//
// The fixtures look contracts up by name in the Base registry. Here, in this process only, those names are
// pointed at Ethereum addresses (OVERLAY) before the fixtures are loaded. That is a lab trick to learn what
// works; the real thing is a registry per chain (unit C of otto/mamoru#123).
//
// Run: nix shell nixpkgs#foundry --command bun packages/scenarios/l1/probe.ts
// Upstream RPC: L1_RPC_URL, or QUICKNODE_ETH_MAINNET_HTTP from ~/.config/quicknode/endpoints.env. It reaches anvil
// through a loopback proxy and is never printed.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { BaseError, createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, erc20Abi, moduleRegistryAbi } from '@mamoru/registry'
import { ATTESTATION_SCHEMA_UID } from '@mamoru/account/sessions'
import { anvilBinary, assertNoKeyInArgv, sanitizedEnv } from '../fork/anvil.ts'
import { startEnginePort, startForkProxy, withoutUpstream } from '../proxy/index.ts'
import { Lab, devAccount } from '../fixtures/lab.ts'
import { checkP256 } from '../webauthn/index.ts'

/** The lab chain id of scenarios/manifest.json, the one the lab policies allow signing on. Not a real chain: a signature made here is valid on no network. */
const LAB_CHAIN_ID = 31_337
const BASE_PUBLIC_RPC = 'https://base-rpc.publicnode.com'

// Ethereum Mainnet addresses for the names the fixtures use. Uniswap v3 and the tokens are the canonical
// deployments; the pool is what UniswapV3Factory.getPool answers, checked below before anything runs.
const OVERLAY: Record<string, Address> = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  EURC: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  UniswapV3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  NonfungiblePositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  SwapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  QuoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  'pool:USDC/cbBTC/500': '0x54E58c986818903d2d86dAfE03f5F5E6C2cA6710',
}
/** Holders on Ethereum the fork takes test funds from (impersonated on the fork only). */
const L1_USDC_HOLDER: Address = '0x28C6c06298d514Db089934071355E5743bf21d60'
const L1_CBBTC_HOLDER: Address = '0xe8f7c89C5eFa061e340f2d2F206EC78FD8f7e124' // the cbBTC/WBTC 0.01% pool

type Line = { step: string; ok: boolean | null; detail: string }
const report: Line[] = []
const t0 = Date.now()
/** Everything this script prints passes through here: the upstream URL and its parts never reach the terminal. */
const redact = (text: string) => (process.env.L1_RPC_URL ? withoutUpstream(text, process.env.L1_RPC_URL) : text)

// A failure anywhere, including before the fork exists, is printed through the same filter and nothing else is.
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

loadUpstream()
const proxy = startForkProxy('L1_RPC_URL')
const real = createPublicClient({ transport: http(proxy.url, { timeout: 60_000 }) })
const baseClient = createPublicClient({ transport: http(BASE_PUBLIC_RPC, { timeout: 60_000 }) })
const realChainId = await real.getChainId()
if (realChainId !== 1) throw new Error(`the upstream RPC is chain ${realChainId}, not Ethereum Mainnet`)
const forkBlock = (await real.getBlock({ blockTag: 'finalized' })).number
note('upstream', true, `Ethereum Mainnet, finalized block ${forkBlock}`)

// --- 1. What is on Ethereum at the addresses the Base registry pins -------------------------------------------
const codeHash = async (client: typeof real, a: Address) => {
  const code = await client.getCode({ address: a })
  return code && code !== '0x' ? keccak256(code) : null
}
const infra = baseRegistry.entries.filter((e) => !['token', 'pool', 'uniswap'].includes(e.kind))
const missing: { name: string; address: Address }[] = []
const different: string[] = []
for (const e of infra) {
  const h = await codeHash(real, e.address)
  if (h === null) missing.push({ name: e.name, address: e.address })
  else if (h !== e.codeHash) different.push(e.name)
}
note('same code as Base', true, infra.filter((e) => !missing.some((m) => m.name === e.name) && !different.includes(e.name)).map((e) => e.name).join(', '))
note('different code on Ethereum', different.length === 0 ? true : null, different.join(', ') || 'none')
note('no code on Ethereum', missing.length === 0, missing.map((m) => m.name).join(', ') || 'none')

// --- 2. Passkey verification on the real chain ----------------------------------------------------------------
const p256Real = await checkP256(real as never)
note('P-256 on Ethereum (real chain, eth_call)', p256Real.available, p256Real.detail)

// --- 3. The pool the overlay names -----------------------------------------------------------------------------
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const pool = await real.readContract({ address: OVERLAY.UniswapV3Factory!, abi: factoryAbi, functionName: 'getPool', args: [OVERLAY.USDC!, OVERLAY.cbBTC!, 500] })
const poolOk = pool.toLowerCase() === OVERLAY['pool:USDC/cbBTC/500']!.toLowerCase()
const poolFunds = await Promise.all([OVERLAY.USDC!, OVERLAY.cbBTC!].map((t) => real.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [pool] })))
note('pool USDC/cbBTC 0.05% on Ethereum', poolOk, `${pool} holds ${(Number(poolFunds[0]) / 1e6).toFixed(0)} USDC and ${(Number(poolFunds[1]) / 1e8).toFixed(4)} cbBTC`)

// --- 4. Fork ----------------------------------------------------------------------------------------------------
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = portProbe.port as number
portProbe.stop(true)
const argv = ['--fork-url', proxy.url, '--fork-block-number', String(forkBlock), '--chain-id', String(LAB_CHAIN_ID), '--host', '127.0.0.1', '--port', String(port), '--slots-in-an-epoch', '1', '--no-request-size-limit']
assertNoKeyInArgv(argv, ['L1_RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-l1-probe-'))
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
  const p256Fork = await checkP256(lab.client)
  note('P-256 on the fork', p256Fork.available, p256Fork.detail)

  // Contracts that do not exist on Ethereum are placed on the fork with their Base code, so the rest of the path
  // can be tried. Each one is something to deploy, or to find at its Ethereum address, before going live.
  for (const m of missing) {
    const code = await baseClient.getCode({ address: m.address })
    if (!code || code === '0x') throw new Error(`${m.name} has no code on Base either`)
    await lab.rpc('anvil_setCode', [m.address, code])
    note(`placed on the fork: ${m.name}`, null, `${(code.length - 2) / 2} bytes of its Base code at ${m.address}`)
  }

  // The ERC-7484 module registry holds state per chain: which modules are registered, which attester vouches for
  // which module, which schema an attestation uses. The account's first owner transaction trusts the Rhinestone
  // attester and itself and then attests the two policies Rhinestone has not attested. Ask the registry, on both
  // chains, for everything that transaction and the session grants depend on.
  const registryAbi = parseAbi([
    'function findModule(address moduleAddress) view returns ((bytes32 resolverUID, address sender, bytes metadata))',
    'function findSchema(bytes32 uid) view returns ((uint48 registeredAt, address validator, string schema))',
  ])
  const registry = address('ModuleRegistry')
  const attester = address('RhinestoneAttester')
  const reason = (e: unknown) => (e instanceof BaseError ? ((e.walk() as { data?: string; shortMessage?: string }).data ?? e.shortMessage) : String(e)).slice(0, 140)
  for (const [chain, client] of [['Base', baseClient], ['Ethereum', lab.client]] as const) {
    const schema = await client.readContract({ address: registry, abi: registryAbi, functionName: 'findSchema', args: [ATTESTATION_SCHEMA_UID] }).then((r) => (r.registeredAt > 0 ? `registered, validator ${r.validator}` : 'NOT registered'), reason)
    note(`registry on ${chain}: attestation schema`, null, schema)
    for (const name of ['SmartSession', 'OwnableValidator', 'UniActionPolicy', 'TimeFramePolicy', 'UsageLimitPolicy', 'Safe7579']) {
      const module = address(name)
      const registered = await client.readContract({ address: registry, abi: registryAbi, functionName: 'findModule', args: [module] }).then((r) => (/^0x0+$/.test(r.resolverUID) ? 'not registered' : `registered by ${r.sender}`), reason)
      const now = (await client.getBlock()).timestamp
      // The record as the registry's own ABI describes it. A record that was revoked or has expired does not count.
      const attested = await client.readContract({ address: registry, abi: moduleRegistryAbi, functionName: 'findAttestation', args: [module, attester] }).then(
        (r) => (r.time === 0 ? 'not attested by Rhinestone' : r.revocationTime > 0 ? 'Rhinestone attestation REVOKED' : r.expirationTime > 0 && BigInt(r.expirationTime) <= now ? 'Rhinestone attestation EXPIRED' : 'attested by Rhinestone, in force'),
        reason,
      )
      note(`registry on ${chain}: ${name}`, null, `${registered}; ${attested}`)
    }
  }
  // The two calls of the trust transaction, each on its own, as an account would send them.
  const probeAccount = devAccount(8).address
  const trust = encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'trustAttesters', args: [1, [attester, probeAccount].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))] })
  const tried = (data: `0x${string}`) => lab.client.call({ account: probeAccount, to: registry, data }).then(() => ({ ok: true, detail: 'accepted' }), (e) => ({ ok: false, detail: `reverts: ${reason(e)}` }))
  const trusted = await tried(trust)
  note('registry on Ethereum: trustAttesters', trusted.ok, trusted.detail)
  for (const name of ['TimeFramePolicy', 'UsageLimitPolicy']) {
    const attested = await tried(encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'attest', args: [ATTESTATION_SCHEMA_UID, [{ moduleAddress: address(name), expirationTime: 0, data: '0x', moduleTypes: [] }]] }))
    note(`registry on Ethereum: an account attests ${name} before it is registered`, attested.ok ? true : null, attested.detail)
  }

  // A module the registry does not know cannot be attested. On Base both policies are registered under a resolver;
  // try the same registration on the fork, from an ordinary account, to learn whether anyone may do it.
  const registerAbi = parseAbi([
    'function registerModule(bytes32 resolverUID, address moduleAddress, bytes metadata, bytes resolverContext)',
    'function findResolver(bytes32 uid) view returns ((address resolver, address resolverOwner))',
  ])
  for (const m of missing) {
    const onBase = await baseClient.readContract({ address: registry, abi: registryAbi, functionName: 'findModule', args: [m.address] })
    const resolver = await lab.client.readContract({ address: registry, abi: registerAbi, functionName: 'findResolver', args: [onBase.resolverUID] }).then((r) => r.resolver, () => null)
    if (!resolver || /^0x0+$/.test(resolver)) {
      note(`registered on the fork: ${m.name}`, false, `its resolver on Base (${onBase.resolverUID}) does not exist in the registry on Ethereum`)
      continue
    }
    const r = await lab.send(devAccount(8), registry, encodeFunctionData({ abi: registerAbi, functionName: 'registerModule', args: [onBase.resolverUID, m.address, '0x', '0x'] })).catch(() => null)
    note(`registered on the fork: ${m.name}`, r?.ok ?? false, r?.ok ? `registerModule from an ordinary account, same resolver as on Base (${resolver}), ${r.receipt.gasUsed} gas` : 'registerModule from an ordinary account reverts')
  }

  // Point the names at Ethereum. From here on every lookup by name in this process answers an Ethereum address.
  for (const e of baseRegistry.entries) {
    const to = OVERLAY[e.name]
    if (to) e.address = getAddress(to)
  }

  // The fixtures take test funds from one holder (WHALE). Fill it on the fork from holders on Ethereum.
  const { WHALE, DEPOSIT_USDC, SECOND_DEPOSIT_USDC, GAS_RESERVE_WEI, buildSessWorld, ownerBatch, ownerExec, poolTick } = await import('../fixtures/world.ts')
  const { conservadorLabV1 } = await import('@mamoru/policy')
  const fund = async (token: Address, from: Address, amount: bigint) => {
    await lab.setBalance(from, 10n ** 18n)
    const r = await lab.sendAs(from, token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [WHALE, amount] }))
    if (!r.ok) throw new Error(`could not fund the test holder with ${token}`)
  }
  await fund(OVERLAY.USDC!, L1_USDC_HOLDER, (DEPOSIT_USDC + SECOND_DEPOSIT_USDC) * 2n)
  await fund(OVERLAY.cbBTC!, L1_CBBTC_HOLDER, 1_000_000n)
  note('test funds', true, 'USDC and cbBTC moved to the fixtures\' holder on the fork')

  const enginePort = startEnginePort(anvilUrl)
  const engineClient = createPublicClient({ transport: http(enginePort.url) })
  const engineNow = async () => Number((await engineClient.getBlock()).timestamp)
  const relayer = devAccount(0)
  const startBlock = await lab.client.getBlockNumber()

  // The same fixture chain the Base scenarios start from. Each name it pushes is a step that worked.
  const expected = ['fx-owners', 'fx-safe', 'fx-gas', 'fx-usdc', 'fx-whale', 'fx-owner-position', 'fx-sessions', 'fx-lp-direct', 'fx-second-account']
  const meaning: Record<string, string> = {
    'fx-safe': 'Safe deployed with a passkey owner and a backup owner, Safe7579 and Smart Sessions; registry trust set by an owner transaction (signed by the backup owner, as the fixtures do)',
    'fx-owner-position': 'an owner transaction mints a Uniswap v3 position',
    'fx-sessions': 'session grants enter-swap and enter-mint enabled by the owner',
    'fx-lp-direct': 'the session key swaps USDC to cbBTC and mints a position through EntryPoint, inside its grants; a manage grant is scoped to the new position',
    'fx-second-account': 'a second account is deployed, gets its grants, and its session key swaps and mints',
  }
  let world: Awaited<ReturnType<typeof buildSessWorld>> | undefined
  let failure: string | null = null
  try {
    world = await buildSessWorld(lab, conservadorLabV1, engineNow)
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e)
  }
  const reached = world?.fixtures ?? []
  for (const fx of expected) {
    if (!meaning[fx]) continue
    const ok = reached.includes(fx)
    note(fx, world ? ok : null, world ? meaning[fx]! : `${meaning[fx]} (not confirmed: the chain stopped, see below)`)
  }
  if (failure) {
    note('fixture chain', false, failure.slice(0, 600))
    exitCode = 1
  } else if (world) {
    const a1 = world.a1
    note('account A1', true, `${a1.safe}, grants ${a1.grants.map((g) => g.name).join(', ')}, positions ${[...a1.ownerTokenIds, ...a1.managedTokenIds].join(', ')}`)
    // The fixtures sign owner transactions with the backup owner. In the product the passkey is the only owner, so
    // this is the step that matters: a Safe transaction whose only signature is a WebAuthn assertion, checked on
    // chain by SafeWebAuthnSharedSigner.
    const sink: Address = '0x000000000000000000000000000000000000dEaD'
    const usdcBefore = await lab.balanceOf('USDC', sink)
    const byPasskey = await ownerExec(lab, relayer, a1, { to: address('USDC'), data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [sink, 1_000_000n] }) }, 'passkey').catch((e) => ({ ok: false, error: reason(e) }) as const)
    const moved = (await lab.balanceOf('USDC', sink)) - usdcBefore
    note('owner transaction signed by the passkey alone', byPasskey.ok && moved === 1_000_000n, byPasskey.ok ? `1 USDC left the account; ${'receipt' in byPasskey ? byPasskey.receipt.gasUsed : '?'} gas` : `refused: ${'error' in byPasskey ? byPasskey.error : 'reverted'}`)
    if (!(byPasskey.ok && moved === 1_000_000n)) exitCode = 1
    // What the account's own check says today, module by module: this is the call SmartSession makes before it lets a
    // module act for the account.
    for (const name of ['SmartSession', 'OwnableValidator', 'UniActionPolicy', 'TimeFramePolicy', 'UsageLimitPolicy']) {
      const passes = await lab.client.readContract({ address: registry, abi: moduleRegistryAbi, functionName: 'checkForAccount', args: [a1.safe, address(name)] }).then(() => true, () => false)
      note(`registry check for the account: ${name}`, passes, passes ? 'trusted for this account' : 'NOT trusted for this account')
      if (!passes) exitCode = 1
    }

    // The product's account, not the fixtures': the passkey is the only owner. The relayer deploys it (a factory call
    // needs no owner signature); trust and grants carry a WebAuthn signature and nothing else; then the session key swaps.
    try {
      const { accountSetup, counterfactualAddress } = await import('@mamoru/account/recovery')
      const { createProxyCall, webAuthnSigner } = await import('@mamoru/account/safe')
      const { activationCall, registryTrustCalls } = await import('@mamoru/account/sessions')
      const { SessionLedger } = await import('@mamoru/account/precheck')
      const { computeCaps, instantiateGrant } = await import('@mamoru/policy')
      const { approve, exactInputSingle } = await import('@mamoru/uniswap-v3')
      const { sendSessionOp } = await import('../fixtures/session-op.ts')
      const { SoftwarePasskey, PASSKEY_SCALARS } = await import('../webauthn/index.ts')
      const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
      const setup = accountSetup([address('SafeWebAuthnSharedSigner')], 3n, webAuthnSigner(passkey.x, passkey.y))
      const safe = counterfactualAddress(setup)
      const deploy = createProxyCall(setup)
      const deployed = await lab.send(relayer, deploy.to, deploy.data)
      const hasCode = ((await lab.client.getCode({ address: safe })) ?? '0x') !== '0x'
      note('product account: deployed', deployed.ok && hasCode, `${safe}, owner: the passkey only; ${deployed.receipt.gasUsed} gas`)
      const deposit = 100_000_000n
      await lab.send(world.gasPayer, safe, '0x', GAS_RESERVE_WEI)
      await lab.whaleTransfer('USDC', WHALE, safe, deposit)
      // The backup owner of this fixture object owns nothing: every signature below is asked from the passkey.
      const acct = { label: 'P1', safe, backupOwner: devAccount(9), passkey, sessionKey: devAccount(4), caps: {}, grants: [], managedTokenIds: [], ownerTokenIds: [], ledger: new SessionLedger(), signedOwnerTxs: [] } as (typeof world)['a1']
      const trustTx = await ownerBatch(lab, relayer, acct, registryTrustCalls(safe), 'passkey')
      note('product account: registry trust, signed by the passkey', trustTx.ok, `${trustTx.receipt.gasUsed} gas`)
      const { sqrtPriceX96 } = await poolTick(lab)
      acct.caps = computeCaps(world.policy, deposit, { cbBTC: { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n } })
      const now = Number(await lab.timestamp())
      const grants = (['enter-swap', 'enter-mint'] as const).map((name, i) =>
        instantiateGrant(world.policy, name, { account: safe, sessionKey: acct.sessionKey.address, chainId: lab.chainId, salt: `0x${(0xa300 + i).toString(16).padStart(64, '0')}`, validAfter: now - 60, validUntil: now + world.policy.session.validitySeconds, caps: acct.caps, tokenId: undefined, admittedTokenIds: [] }),
      )
      const act = activationCall(grants, [])
      const activation = await ownerExec(lab, relayer, acct, { to: act.to, data: act.data }, 'passkey')
      note('product account: session grants enabled, signed by the passkey', activation.ok, `${activation.receipt.gasUsed} gas`)
      grants.forEach((g, i) => {
        acct.ledger.activate(act.permissionIds[i]!, g)
        acct.grants.push({ name: g.name, grant: g, permissionId: act.permissionIds[i]! })
      })
      const amount = 10_000_000n
      const cbbtcBefore = await lab.balanceOf('cbBTC', safe)
      const swap = await sendSessionOp(world, acct, acct.grants[0]!, 'product-swap', [
        approve('USDC', 'SwapRouter02', amount),
        exactInputSingle({ account: safe, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: amount, amountOutMinimum: 1n }),
      ])
      const got = (await lab.balanceOf('cbBTC', safe)) - cbbtcBefore
      note('product account: the session key swaps 10 USDC to cbBTC through EntryPoint', swap.verdict === 'INCLUDED' && got > 0n, `${swap.verdict}${swap.failedOp?.reason ? ` ${swap.failedOp.reason}` : ''}; ${got} sats of cbBTC arrived`)
      if (!(deployed.ok && hasCode && trustTx.ok && activation.ok && swap.verdict === 'INCLUDED' && got > 0n)) exitCode = 1
    } catch (e) {
      note('product account', false, e instanceof Error ? e.message.slice(0, 400) : String(e))
      exitCode = 1
    }

    const ops = world.opLog.map((o) => `${o.batch}:${o.verdict}`)
    note('session operations', ops.every((o) => o.endsWith('INCLUDED')), ops.join(' '))
    // Gas is what the receipts say, block by block since the fixtures started: every transaction of the path,
    // whoever paid for it.
    const head = await lab.client.getBlockNumber()
    let gasUsed = 0n
    let txs = 0
    for (let n = startBlock + 1n; n <= head; n++) {
      const block = await lab.client.getBlock({ blockNumber: n })
      for (const hash of block.transactions) {
        gasUsed += (await lab.client.getTransactionReceipt({ hash })).gasUsed
        txs++
      }
    }
    const realGas = await real.getGasPrice()
    note('gas', null, `${gasUsed} gas in ${txs} transactions for three accounts (two fixture accounts end to end, one product account up to its first swap); at the ${(Number(realGas) / 1e9).toFixed(3)} gwei Ethereum asks right now that is ${(Number(gasUsed * realGas) / 1e18).toFixed(6)} ETH`)
  }
  enginePort.stop()
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
