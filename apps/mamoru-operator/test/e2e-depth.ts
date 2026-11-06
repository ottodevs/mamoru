// E2E of a large account under depth sizing (otto/mamoru#376): DEPOSIT_USDC (default 10,000) lands in one Safe, the
// operator runs with the prod engine settings (depth 30,500,5 as MAMORU_DEPTH) and MAMORU_CAP_USDC equal to the deposit
// (the signed cap C a renewed account would have, so the policy's spending windows bind as in production), Start is not refused by size, the engine places what each pool's depth
// allows and reports the rest as waiting (DECIDE_WAIT_DEPTH), then the owner's Stop brings everything back as USDC.
// Opt-in, not in CI: a cold fork of Base and up to 10 min. Same harness as e2e-fork.ts (anvil fork of Base keeping
// chain id 8453, upstream from RPC_URL or BASE_RPC_URL or ~/.config/mamoru-operator/env, the operator behind the
// engine port that refuses anvil_* methods). Run: DEPOSIT_USDC=100000 bun test/e2e-depth.ts
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { toHex } from 'viem'
import * as policyPkg from '@mamoru/policy'
import type { PolicyVersion } from '@mamoru/policy'
import type { AccountContext, FundingView, OpView, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { baseRegistry, address } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startEnginePort, startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { bootOperator } from '../src/boot.ts'
import { DEFAULT_SPONSOR, SPONSOR_BOUNDS, type SponsorPolicy } from '../src/sponsorship.ts'
import { signedCall, warmPrepare } from './e2e-client.ts'
import { catchUpClock, forkUpstreamArgs, fundUsdc } from './fork-funding.ts'

const envFile = join(homedir(), '.config/mamoru-operator/env')
if (!process.env.RPC_URL && existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
}
if (!process.env.RPC_URL && process.env.BASE_RPC_URL) process.env.RPC_URL = process.env.BASE_RPC_URL

const DEPOSIT = BigInt(process.env.DEPOSIT_USDC ?? '10000') * 1_000_000n
const POLICY = process.env.MAMORU_POLICY ?? 'conservador-live-v5'
const SETTLE_MS = Number(process.env.E2E_SETTLE_MS ?? 600_000)
// The policy's own definition, for the window limits of assertion (b).
const POLICY_DEF = Object.values(policyPkg).find((v): v is PolicyVersion => typeof v === 'object' && v !== null && (v as PolicyVersion).policyId === POLICY)
const CAP_WHOLE = (DEPOSIT / 1_000_000n).toString()
const t0 = Date.now()
// Chain revert reasons the operator logs while it runs (assertion b): teed from the console, never swallowed.
const REVERTS = ['POLICY_DENIED_AMOUNT', 'BudgetExceeded', 'Cap24hExceeded', 'Cap30Exceeded']
const seenReverts = new Map<string, number>()
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    const line = args.map(String).join(' ')
    for (const r of REVERTS) if (line.includes(r)) seenReverts.set(r, (seenReverts.get(r) ?? 0) + 1)
    if (/revert/i.test(line) && !REVERTS.some((r) => line.includes(r))) seenReverts.set('other-revert', (seenReverts.get('other-revert') ?? 0) + 1)
    if (/revert/i.test(line)) orig(`[e2e revert-seen] ${line.slice(0, 400)}`)
    orig(...args)
  }
}
const log = (m: string) => console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`E2E FAILED: ${what}`)
  log(`ok  ${what}`)
}
const usd = (raw: string | bigint) => (Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })

// --- fork -----------------------------------------------------------------
const proxy = startForkProxy('RPC_URL')
const anvilBin = process.env.ANVIL_BIN ?? Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = portProbe.port as number
portProbe.stop(true)
const argv = ['--fork-url', proxy.url, ...forkUpstreamArgs(), '--chain-id', '8453', '--host', '127.0.0.1', '--port', String(port), '--slots-in-an-epoch', '1', '--block-time', '1', '--no-request-size-limit']
assertNoKeyInArgv(argv, ['RPC_URL', 'BASE_RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-operator-e2e-'))
const anvil = Bun.spawn([anvilBin, ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const anvilUrl = `http://127.0.0.1:${port}/`
const lab = new Lab(anvilUrl, 8453)
for (let i = 0; ; i++) {
  try {
    await lab.client.getBlockNumber()
    break
  } catch {
    if (i > 300) throw new Error('anvil did not start')
    await Bun.sleep(200)
  }
}
const enginePort = startEnginePort(anvilUrl)
let stopOperator = () => {}
const cleanup = async () => {
  stopOperator()
  enginePort.stop()
  anvil.kill()
  await anvil.exited
  proxy.stop()
}

try {
  log(`fork of Base at block ${await lab.client.getBlockNumber()}, chain ${await lab.client.getChainId()}, deposit ${usd(DEPOSIT)} USDC, policy ${POLICY}`)
  await catchUpClock(lab)

  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner', baseRegistry)]
  const saltNonce = BigInt(Date.now())
  const ctx: AccountContext = {
    accountKey: `e2e-${saltNonce}`,
    chainId: 8453,
    address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))),
    owners,
    saltNonce: saltNonce.toString(),
    passkey: { credentialId: 'e2e', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
  }
  await fundUsdc(lab, address('USDC', baseRegistry), ctx.address, DEPOSIT)
  log(`counterfactual Safe ${ctx.address} funded with ${usd(DEPOSIT)} USDC`)

  // --- operator, live on "8453", with the prod engine settings --------------------
  process.env.MAMORU_LIVE = '1'
  process.env.MAMORU_HEAD_LAG = '0' // anvil is one node
  const secret = randomBytes(32).toString('hex')
  const op = await bootOperator({ rpcUrl: enginePort.url, secret, stateDir: join(dir, 'state'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100, policyId: POLICY, depth: '30,500,5', capUsdc: CAP_WHOLE })
  stopOperator = () => op.stop()
  // anvil quotes a gas price ~100x Base's: the extension renewal below is over the default daily sponsorship there; on
  // Base it costs ~1e-4 ETH. Raised to the top of SPONSOR_BOUNDS, as e2e-rerange and e2e-v4 do.
  ;(op.operator.cfg as { sponsor?: SponsorPolicy }).sponsor = { ...DEFAULT_SPONSOR, weiPerDay: SPONSOR_BOUNDS.weiPerDay[1] }
  check(op.operator.cfg.live, 'operator is live on chain 8453 with MAMORU_LIVE=1')
  await lab.setBalance(op.operator.relayer.address, 10n ** 18n)

  const header = Buffer.from(JSON.stringify(ctx)).toString('base64url')
  const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => signedCall<T>(op.url, secret, method, path, header, body)
  const base = `/api/accounts/${ctx.accountKey}`
  const funding = async () => (await call<FundingView>('GET', `${base}/funding`)).json
  const ops = async () => (await call<{ ops: OpView[] }>('GET', `${base}/ops`)).json.ops

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
  function browserSign(t: OwnerTxToSign): OwnerSignature {
    const a = passkey.assert(t.safeTxHash)
    const s = randomBytes(1)[0]! & 1 ? P256_N - a.s : a.s
    return {
      prepareId: t.prepareId,
      authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'),
      clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'),
      signature: Buffer.from(der(a.r, s)).toString('base64url'),
    }
  }
  async function ownerAction(kind: 'activate' | 'stop'): Promise<OpView> {
    const prep = await call<OwnerTxToSign | { ownerTx: OwnerTxToSign; warning?: { quoteId: string } }>('POST', `${base}/${kind}/prepare`)
    if (prep.status !== 200) throw new Error(`E2E FAILED: ${kind}/prepare ${prep.status} ${JSON.stringify(prep.json)}`)
    const tx = 'ownerTx' in prep.json ? prep.json.ownerTx : prep.json
    log(`${kind} to sign: ${tx.summary.join(' | ')}`)
    const res = await call<OpView>('POST', `${base}/${kind}`, browserSign(tx))
    if (res.status !== 200) throw new Error(`E2E FAILED: ${kind} ${res.status} ${JSON.stringify(res.json)}`)
    const until = Date.now() + 180_000
    for (;;) {
      const o = (await ops()).find((x) => x.opId === res.json.opId)
      if (o && (o.state === 'confirmed' || o.state === 'failed')) {
        check(o.state === 'confirmed', `owner ${kind} confirmed (${o.txHash} block ${o.block})`)
        return o
      }
      if (Date.now() > until) throw new Error(`E2E FAILED: owner ${kind} still ${o?.state}`)
      await Bun.sleep(1_000)
    }
  }

  const f0 = await funding()
  check(f0.usdc === DEPOSIT.toString() && !f0.overCap && BigInt(f0.capUsdc) >= DEPOSIT, `before Start: ${usd(f0.usdc)} USDC, cap ${usd(f0.capUsdc)}, no over-cap report`)

  // --- Start: not refused by size --------------------------------------------------
  await warmPrepare(op.operator, () => op.operator.prepareActivate(ctx))
  const activate = await ownerAction('activate')
  check((await funding()).active, `engine active after Start of ${usd(DEPOSIT)} USDC (tx ${activate.txHash})`)
  // A multi-pool activation leaves the manage-any/convert-any pairs of the lower-preference pools out to fit Base's 2^24
  // per-tx gas cap (fitActivation); the app offers the rest as one more approval (renew → planExtend). A real owner
  // signs it from the home screen; without it the engine holds SESSION_MISSING after the first entry (as e2e-rerange).
  const extensions: string[] = []
  for (let i = 0; i < 4 && (await funding()).approval?.missing; i++) {
    const p = await op.operator.prepareRenew(ctx)
    log(`extension to sign: ${p.summary.join(' | ')}`)
    const r = await op.operator.submit(ctx, 'renew', browserSign(p))
    const until = Date.now() + 180_000
    for (;;) {
      const o = (await ops()).find((x) => x.opId === r.opId)
      if (o?.state === 'failed') throw new Error(`E2E FAILED: the extension failed ${o.code}`)
      if (o?.state === 'confirmed') { extensions.push(o.txHash!); break }
      if (Date.now() > until) throw new Error(`E2E FAILED: the extension still ${o?.state}`)
      await Bun.sleep(1_000)
    }
  }
  check(!(await funding()).approval?.missing, `every grant enabled (${extensions.length} extension(s)${extensions.length ? `: ${extensions.join(', ')}` : ''})`)

  // --- the engine places until it waits ---------------------------------------------
  // Settled: no engine op in flight, at least one entry confirmed, and the last review either waits or has nothing left.
  const until = Date.now() + SETTLE_MS
  let f: FundingView
  let quiet = 0
  for (;;) {
    f = await funding()
    const all = await ops()
    const failed = all.filter((o) => o.kind === 'enter' && o.state === 'failed')
    if (failed.length) throw new Error(`E2E FAILED: engine op failed ${JSON.stringify(failed)}`)
    const inFlight = all.some((o) => o.kind === 'enter' && o.state !== 'confirmed')
    const entered = all.filter((o) => o.kind === 'enter' && o.state === 'confirmed').length
    quiet = !inFlight && entered > 0 && !f.engine?.placing ? quiet + 1 : 0
    if (quiet >= 5) break
    if (Date.now() > until) throw new Error(`E2E FAILED: engine did not settle in ${SETTLE_MS} ms: ${JSON.stringify(f.engine)}`)
    await Bun.sleep(3_000)
  }
  const enters = (await ops()).filter((o) => o.kind === 'enter')
  const byPool = new Map<string, bigint>()
  for (const p of f.positions) byPool.set(p.pool, (byPool.get(p.pool) ?? 0n) + BigInt(p.valueUsdc ?? '0'))
  const waiting = f.engine?.waiting ?? []
  log(`settled after ${enters.length} engine ops: ${[...byPool].map(([p, v]) => `${p} ${usd(v)}`).join(', ')}; idle USDC ${usd(f.usdc)}; waiting ${waiting.map((w) => `${w.bucket} ${w.code} ${usd(w.amountUsdc)}`).join(', ') || 'none'}`)
  check(f.positions.length > 0, `${f.positions.length} positions open`)
  check(waiting.every((w) => ['DECIDE_WAIT_DEPTH', 'DECIDE_WAIT_GAS'].includes(w.code)), 'whatever waits says why, with a typed code')

  // Every waiting code, one line each, and every chain revert reason seen.
  const waitedByCode = new Map<string, bigint>()
  for (const w of waiting) waitedByCode.set(w.code, (waitedByCode.get(w.code) ?? 0n) + BigInt(w.amountUsdc))
  for (const [code, amount] of waitedByCode) log(`waited code=${code} usdc=${usd(amount)}`)
  if (waitedByCode.size === 0) log('waited code=none usdc=0')
  log(`chain revert reasons seen: ${seenReverts.size ? [...seenReverts].map(([r, n]) => `${r} x${n}`).join(', ') : 'none'}`)

  // Settled is not enough: a stalled engine (a hold such as SESSION_MISSING) leaves money idle with no typed wait.
  const idleUsdc = BigInt(f.usdc)
  const typedWait = [...waitedByCode.values()].reduce((x, y) => x + y, 0n)
  check(idleUsdc <= typedWait + DEPOSIT / 100n, `idle USDC ${usd(idleUsdc)} is explained by typed waits (${usd(typedWait)}) within 1 % of the deposit`)

  // (a) placed + idle = deposit, give or take gas and swap costs (0.5 %). Waiting money is still idle in the Safe.
  const placed = f.positions.reduce((a, p) => a + BigInt(p.valueUsdc ?? '0'), 0n)
  const waitingSum = [...waitedByCode.values()].reduce((a, b) => a + b, 0n)
  const idle = (f.idle ?? []).reduce((a, i) => a + BigInt(i.valueUsdc), 0n)
  log(`placed ${usd(placed)} + idle ${usd(idle)} = ${usd(placed + idle)} of ${usd(DEPOSIT)}; waiting ${usd(waitingSum)} (part of idle)`)
  const drift = placed + idle > DEPOSIT ? placed + idle - DEPOSIT : DEPOSIT - (placed + idle)
  check(drift * 10_000n <= DEPOSIT * 50n, `(a) placed + idle accounts for the deposit within 0.5 % (off by ${usd(drift)})`)
  check(waitingSum <= idle + DEPOSIT / 1000n, `(a) waiting ${usd(waitingSum)} is part of idle ${usd(idle)}`)

  // (b) the spending-window wait expected from the policy's own limits for C = the deposit: the entries a pool needs
  // (its target share of the deposit) against its BudgetWindow. Above it, a window denial has to be in the log and at
  // least the excess has to be waiting.
  if (!POLICY_DEF) throw new Error(`E2E FAILED: policy ${POLICY} is not exported by @mamoru/policy, cannot read its window limits`)
  const windows = policyPkg.v4BudgetCaps(POLICY_DEF, DEPOSIT)
  let excess = 0n
  for (const b of POLICY_DEF.buckets) {
    const prefix = b.id === 'risk' ? 'risk' : b.id === 'btc-usdc' ? 'btc' : b.id === 'stables' ? 'stables' : null
    const limit = prefix ? windows[`${prefix}BudgetWindow`] : undefined
    if (limit === undefined || b.preference === 0 || b.pools.length === 0) continue
    const need = (DEPOSIT * BigInt(b.preference)) / 10_000n
    log(`window ${b.id}: needs ${usd(need)} against ${usd(limit)} per day`)
    if (need > limit) excess += need - limit
  }
  log(`expected window excess: ${usd(excess)} USDC (zero when every bucket's target fits its BudgetWindow: then no window denial is expected and (b) checks that none is needed)`)
  if (excess > 0n) {
    check(REVERTS.some((r) => seenReverts.has(r)), '(b) a spending-window denial is in the log')
    check(waitingSum >= excess, `(b) at least the window excess (${usd(excess)}) is waiting (${usd(waitingSum)})`)
  } else {
    check(true, '(b) required entries fit the policy windows: no window wait expected')
  }

  // --- Stop: everything back ----------------------------------------------------------
  const stop = await ownerAction('stop')
  const f2 = await funding()
  check(!f2.active && f2.positions.length === 0, `after stop: inactive, no positions, USDC ${usd(f2.usdc)}`)
  check(BigInt(f2.usdc) * 10_000n >= DEPOSIT * 9_990n, `the Stop returned ${usd(f2.usdc)} USDC of ${usd(DEPOSIT)} (c: within 0.1 %, gas reserve and costs included)`)

  const stats = enginePort.stats()
  check(stats.rejectedLabMethods === 0, `operator made ${stats.forwarded} RPC calls, 0 anvil_/evm_ methods`)
  log(`RESULT PASS: start ${activate.txHash}, ${enters.length} engine ops, stop ${stop.txHash}`)
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await cleanup()
}
process.exit(process.exitCode ?? 0)
