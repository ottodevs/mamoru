import { concat, decodeErrorResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, slice, stringToHex, type Hex } from 'viem'
import { ReasonError, isReasonCode } from '@mamoru/domain'
import { address, erc20Abi, safe7579Abi, smartSessionAbi, smartSessionErrorsAbi } from '@mamoru/registry'
import { activationCall, revocationCalls } from '@mamoru/account/sessions'
import { sendSessionOp, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { WHALE, activateGrants, grantOf, ownerMint, revokeGrants, type ActiveGrant, type OpRecord, type World } from '../fixtures/world.ts'
import { Lab } from '../fixtures/lab.ts'
import { dumpState, secondFork, timeWarp } from '../perturb/index.ts'
import type { StepResult } from '../report/index.ts'
import { buildAttack } from './attacks.ts'
import type { ScenarioCtx, StepHandler } from './context.ts'
import { checkRecipient, checkTargets, diffDigest, stateDigest } from './state.ts'

const MAGIC_1271 = '0x1626ba7e'
const ANY_PAYMASTER = '0x0000000000000039cd5e8aE05257CE51C473ddd1' as const

type Expect = {
  chain?: string | string[]
  precheck?: string | string[]
  state?: 'unchanged' | 'changed'
  failedOp?: 'account-validation'
}

function world(ctx: ScenarioCtx): World {
  if (!ctx.world) throw new Error(`${ctx.scenario.id} needs a world`)
  return ctx.world
}

function resolveGrant(w: World, name: string): ActiveGrant {
  if (name === 'manage') return grantOf(w.a1, `manage:${w.a1.managedTokenIds[0]}`)
  return grantOf(w.a1, name)
}

function list(v: string | string[] | undefined): string[] | undefined {
  return v === undefined ? undefined : Array.isArray(v) ? v : [v]
}

function matchesPrecheck(o: SessionOpOutcome, allowed: string[] | undefined): boolean {
  if (!allowed) return true
  const got = o.precheck.ok ? 'ACCEPT' : o.precheck.code
  if (allowed.includes('ANY_DENIAL')) return got !== 'ACCEPT'
  return allowed.includes(got)
}

/** ETH the account can spend on gas: its balance plus its EntryPoint deposit, where unused prefund is kept. */
function gasFunds(d: Record<string, string>): bigint {
  return BigInt(d['A1.eth']!) + BigInt(d['A1.entryPointDeposit']!)
}

async function checkIncludedInvariants(ctx: ScenarioCtx, o: SessionOpOutcome, fundsBefore: bigint, after: Record<string, string>): Promise<string[]> {
  const w = world(ctx)
  const errs: string[] = []
  const rec = checkRecipient(w.a1.safe, o.calls, o.receipt!)
  for (const e of rec) ctx.invariantErrors.push({ name: 'INV-RECIPIENT', detail: e })
  const tgt = checkTargets(o.calls)
  for (const e of tgt) ctx.invariantErrors.push({ name: 'INV-TARGETS', detail: e })
  const spent = fundsBefore - gasFunds(after)
  if (o.verdict === 'INCLUDED' && spent !== (o.actualGasCost ?? 0n)) {
    ctx.invariantErrors.push({ name: 'INV-ETH-GAS', detail: `account ETH plus deposit moved by ${spent}, gas cost ${o.actualGasCost}` })
  }
  errs.push(...rec, ...tgt)
  return errs
}

/** One session userOp built by the attacker, pre-checked by the engine and judged by the chain. */
async function runOne(ctx: ScenarioCtx, grant: ActiveGrant, batch: string, args: Record<string, unknown>, exp: Expect, label: string): Promise<StepResult> {
  const w = world(ctx)
  const params = { ...(args.params as Record<string, unknown> | undefined), permissionId: grant.permissionId }
  const calls = await buildAttack(batch, { world: w, params })
  const opts = (args.options as Record<string, unknown> | undefined) ?? {}
  const before = await stateDigest(w)
  const fundsBefore = gasFunds(before)
  const o = await sendSessionOp(w, w.a1, grant, batch, calls, {
    mode: opts.mode as never,
    rawCallData: opts.raw ? calls[0]!.data : undefined,
    signatureMode: opts.signatureMode as never,
    paymaster: opts.paymaster ? ANY_PAYMASTER : undefined,
  })
  const got = o.precheck.ok ? 'ACCEPT' : o.precheck.code
  if (!o.precheck.ok) ctx.codes.add(o.precheck.code)
  ctx.codes.add(o.verdict === 'INCLUDED' ? 'INCLUDED' : o.verdict)
  const problems: string[] = []
  const chainOk = list(exp.chain)
  if (chainOk && !chainOk.includes(o.verdict)) problems.push(`chain ${o.verdict}, expected ${chainOk.join('|')}`)
  if (chainOk && !chainOk.includes('INCLUDED') && o.verdict === 'INCLUDED') ctx.kt1.push(`${label}: attack included on chain`)
  if (chainOk && !chainOk.includes('CHAIN_REVERTED_EXECUTION') && !chainOk.includes('INCLUDED') && o.verdict === 'CHAIN_REVERTED_EXECUTION') {
    ctx.kt1.push(`${label}: attack passed validation and reverted in execution`)
  }
  if (!matchesPrecheck(o, list(exp.precheck))) problems.push(`precheck ${got}, expected ${list(exp.precheck)!.join('|')}`)
  if (exp.failedOp === 'account-validation' && o.verdict === 'CHAIN_REJECTED_VALIDATION' && !/^AA2/.test(o.failedOp?.reason ?? '')) {
    problems.push(`rejected outside account validation: ${o.failedOp?.reason}`)
  }
  const after = await stateDigest(w)
  const diff = diffDigest(before, after)
  const expectUnchanged = exp.state === 'unchanged' || (exp.state === undefined && o.verdict !== 'INCLUDED')
  if (expectUnchanged && diff.length > 0) {
    problems.push(`state changed: ${diff.slice(0, 4).join('; ')}`)
    if (o.verdict !== 'INCLUDED') ctx.kt1.push(`${label}: state changed without inclusion`)
  }
  if (o.verdict !== 'CHAIN_REJECTED_VALIDATION') problems.push(...(await checkIncludedInvariants(ctx, o, fundsBefore, after)))
  return {
    step: label,
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${got} / ${o.verdict}${o.failedOp?.reason ? ` (${o.failedOp.reason}${o.validator ? `; SmartSession: ${o.validator}` : ''})` : ''}`,
    codes: [got, o.verdict],
  }
}

const sessionOp: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const batch = args.batch as string
  const exp = (args.expect as Expect) ?? {}
  const repeat = Number(args.repeat ?? 1)
  const out: StepResult[] = []
  const grant = resolveGrant(w, args.grant as string)
  for (let i = 0; i < repeat; i++) {
    w.context = `${ctx.scenario.id}`
    out.push(await runOne(ctx, grant, batch, args, exp, `${batch} under ${grant.name}${repeat > 1 ? ` #${i + 1}` : ''}`))
  }
  if (args.otherGrants === 'reject') {
    for (const g of w.a1.grants) {
      if (g.permissionId === grant.permissionId || w.a1.ledger.get(g.permissionId)?.revoked) continue
      out.push(await runOne(ctx, g, batch, args, { chain: 'CHAIN_REJECTED_VALIDATION', precheck: 'ANY_DENIAL', state: 'unchanged' }, `${batch} under ${g.name}`))
    }
  }
  return out
}

const ownerRevoke: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const names = (args.grants as string[]).map((n) => resolveGrant(w, n).name)
  const r = await revokeGrants(w, w.a1, names)
  const still: string[] = []
  for (const n of names) {
    const g = resolveGrant(w, n)
    const on = await w.lab.client.readContract({ address: address('SmartSession'), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [g.permissionId, w.a1.safe] })
    if (on) still.push(n)
  }
  return { step: `owner revokes ${names.join(', ')}`, ok: r.ok && still.length === 0, detail: still.length ? `still enabled: ${still.join(', ')}` : 'removed on chain' }
}

const ownerReplay: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const which = (args.which as string) ?? 'activation'
  const txs = w.a1.signedOwnerTxs
  const target = which === 'activation' ? txs.find((t) => t.tx.to.toLowerCase() === address('SmartSession').toLowerCase()) : txs.at(-1)
  if (!target) return { step: `replay ${which}`, ok: false, detail: 'no signed owner transaction to replay' }
  const before = await stateDigest(w)
  const r = await w.lab.send(w.relayer, w.a1.safe, target.data)
  const diff = diffDigest(before, await stateDigest(w))
  const ok = !r.ok && diff.length === 0
  if (r.ok) ctx.kt1.push(`replayed owner ${which} was accepted`)
  return { step: `replay owner ${which} transaction`, ok, detail: r.ok ? 'replay accepted' : 'reverted: the Safe nonce was already used' }
}

const engineReactivate: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const g = resolveGrant(w, args.grant as string)
  const nonceBefore = await w.lab.client.getTransactionCount({ address: w.relayer.address })
  let code = 'NONE'
  try {
    activationCall([g.grant], w.a1.ledger.revokedIds())
  } catch (e) {
    if (e instanceof ReasonError) code = e.code
  }
  const nonceAfter = await w.lab.client.getTransactionCount({ address: w.relayer.address })
  ctx.codes.add(code)
  const ok = code === 'SESSION_PERMISSION_ID_REUSED' && nonceAfter === nonceBefore
  return { step: `engine asked to reactivate ${g.name}`, ok, detail: `${code}, ${nonceAfter - nonceBefore} transactions sent`, codes: [code] }
}

const ownerRenew: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const old = resolveGrant(w, args.grant as string)
  const [renewed] = await activateGrants(w, w.a1, [{ name: old.grant.name, tokenId: old.grant.tokenId }])
  const on = await w.lab.client.readContract({ address: address('SmartSession'), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [renewed!.permissionId, w.a1.safe] })
  const ok = renewed!.permissionId !== old.permissionId && renewed!.grant.salt !== old.grant.salt && on
  return { step: `owner renews ${old.name}`, ok, detail: `new permissionId ${renewed!.permissionId.slice(0, 10)}… (old ${old.permissionId.slice(0, 10)}…), enabled ${on}` }
}

const ownerMintPosition: StepHandler = async (ctx) => {
  const w = world(ctx)
  await w.lab.whaleTransfer('cbBTC', WHALE, w.a1.safe, 100_000n)
  const id = await ownerMint(w, w.a1, 50_000_000n, 100_000n)
  return { step: 'owner mints a position after activation', ok: true, detail: `tokenId ${id}` }
}

const timeWarpStep: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  let seconds = Number(args.seconds ?? 0)
  if (args.past === 'validUntil') {
    const g = resolveGrant(w, (args.grant as string) ?? 'enter-swap')
    seconds = g.grant.userOp.validUntil - Number(await w.lab.timestamp()) + 3600
  }
  await timeWarp(w.lab, seconds)
  return { step: `time-warp ${seconds}s`, ok: true }
}

const erc1271: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const g = resolveGrant(w, 'enter-swap')
  const hash = keccak256(stringToHex(`mamoru SESS-12 ${ctx.run.runId}`))
  const sk = w.a1.sessionKey
  const raw = await sk.sign!({ hash })
  const personal = await sk.signMessage({ message: { raw: hash } })
  const usdcDomain = await w.lab.client.readContract({ address: address('USDC'), abi: erc20Abi, functionName: 'DOMAIN_SEPARATOR' })
  const contentsDescription = 'Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'
  const envelope = concat([personal, usdcDomain, hash, stringToHex(contentsDescription), `0x${contentsDescription.length.toString(16).padStart(4, '0')}`])
  const variants: Record<string, Hex> = {
    raw,
    'eth-signed': personal,
    'smartsession-prefix': concat([address('SmartSession'), g.permissionId, personal]),
    'smartsession-mode-prefix': concat([address('SmartSession'), '0x00', g.permissionId, personal]),
    erc7739: concat([address('SmartSession'), g.permissionId, envelope]),
  }
  const out: StepResult[] = []
  for (const [name, data] of Object.entries(variants)) {
    let result = 'revert'
    try {
      result = await w.lab.client.readContract({ address: w.a1.safe, abi: safe7579Abi, functionName: 'isValidSignature', args: [hash, data] })
    } catch {}
    const ok = result.toLowerCase() !== MAGIC_1271
    if (!ok) ctx.kt1.push(`isValidSignature accepted the session key (${name})`)
    out.push({ step: `isValidSignature ${name}`, ok, detail: result })
  }
  return out
}

const permitStep: StepHandler = async (ctx) => {
  const w = world(ctx)
  const g = resolveGrant(w, 'enter-swap')
  const c = w.lab.client
  const usdc = address('USDC')
  const nonce = await c.readContract({ address: usdc, abi: erc20Abi, functionName: 'nonces', args: [w.a1.safe] })
  const domain = await c.readContract({ address: usdc, abi: erc20Abi, functionName: 'DOMAIN_SEPARATOR' })
  const value = 1_000_000_000n
  const deadline = BigInt(Number(await w.lab.timestamp()) + 3600)
  const typeHash = keccak256(stringToHex('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'))
  const structHash = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [typeHash, w.a1.safe, w.attacker.address, value, nonce, deadline]),
  )
  const digest = keccak256(concat(['0x1901', domain, structHash]))
  const raw = await w.a1.sessionKey.sign!({ hash: digest })
  const out: StepResult[] = []
  for (const [name, sig] of Object.entries({ raw, 'smartsession-prefix': concat([address('SmartSession'), g.permissionId, raw]) })) {
    const before = await stateDigest(w)
    const r = await w.lab.send(w.attacker, usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'permit', args: [w.a1.safe, w.attacker.address, value, deadline, sig as Hex] }))
    const diff = diffDigest(before, await stateDigest(w)).filter((d) => !d.startsWith('attacker.eth'))
    if (r.ok) ctx.kt1.push(`USDC permit signed by the session key was accepted (${name})`)
    out.push({ step: `USDC permit signed by the session key (${name})`, ok: !r.ok && diff.length === 0, detail: r.ok ? 'permit accepted' : 'reverted' })
  }
  return out
}

/** SESS-19: the same state on a fork with chain id 31338. */
const secondForkStep: StepHandler = async (ctx) => {
  const w = world(ctx)
  const run = ctx.run
  const statePath = `${ctx.dir}/state-for-31338.json.gz`
  await dumpState(w.lab, statePath)
  const fork2 = await secondFork(run.manifest, run.proxyUrl, { chainId: run.manifest.fork.secondChainId, statePath, logPath: `${ctx.dir}/anvil-31338.log` })
  run.anvils.push(fork2)
  run.rpcUrls.add(fork2.url)
  const lab2 = new Lab(fork2.url, run.manifest.fork.secondChainId)
  const out: StepResult[] = []
  try {
    const g = resolveGrant(w, 'enter-swap')
    const calls = await buildAttack('valid-swap', { world: w, params: {} })
    w.context = ctx.scenario.id
    const o = await sendSessionOp(w, w.a1, g, 'valid-swap signed for 31337', calls, { submitTo: lab2 })
    const got = o.precheck.ok ? 'ACCEPT' : o.precheck.code
    ctx.codes.add(got)
    if (o.verdict !== 'CHAIN_REJECTED_VALIDATION') ctx.kt1.push('userOp signed for 31337 was accepted on 31338')
    out.push({ step: 'userOp signed for 31337 sent to 31338', ok: o.verdict === 'CHAIN_REJECTED_VALIDATION' && got === 'SIGN_CHAIN_NOT_ALLOWED', detail: `${got} / ${o.verdict} (${o.failedOp?.reason ?? ''})` })

    w.context = `${ctx.scenario.id}:control`
    const ctl = await sendSessionOp(w, w.a1, g, 'valid-swap signed for 31338 (control)', calls, { submitTo: lab2, signChainId: lab2.chainId })
    out.push({ step: 'control: the same userOp signed for 31338 is valid there', ok: ctl.verdict === 'INCLUDED', detail: ctl.verdict })

    const revoke = revocationCalls([g.permissionId])[0]!
    const nonce = await w.lab.client.readContract({ address: w.a1.safe, abi: parseAbi(['function nonce() view returns (uint256)']), functionName: 'nonce' })
    const { signSafeTx, execTransactionData } = await import('@mamoru/account/safe')
    const tx = { to: revoke.to, value: 0n, data: revoke.data, operation: 0 as const, nonce }
    const sig31337 = await signSafeTx(w.a1.backupOwner, w.a1.safe, w.lab.chainId, tx)
    const r = await lab2.send(w.relayer, w.a1.safe, execTransactionData(tx, sig31337))
    if (r.ok) ctx.kt1.push('owner transaction signed for 31337 was accepted on 31338')
    out.push({ step: 'owner transaction signed for 31337 sent to 31338', ok: !r.ok, detail: r.ok ? 'accepted' : 'reverted: invalid signature' })
  } finally {
    await fork2.stop()
  }
  return out
}

function chainError(r: OpRecord): string {
  const outer = !r.inner || r.inner === '0x' ? (r.failedOp ?? 'unknown') : `${r.failedOp} ${innerName(r.inner)}`
  return r.validator ? `${outer} ← SmartSession: ${r.validator}` : outer
}

function innerName(inner: Hex): string {
  try {
    return decodeErrorResult({ abi: [...smartSessionErrorsAbi, ...parseAbi(['error ExecutionFailed()'])], data: inner }).errorName
  } catch {
    return slice(inner, 0, 4)
  }
}

/** SESS-25: the pre-check rejects exactly what the chain rejects, with the table's codes. */
const precheckParity: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const from = (args.scenarios as string[]) ?? []
  const records = w.opLog.filter((r) => r.context === 'fixtures' || from.includes(r.context))
  const controls = w.opLog.filter((r) => r.context.endsWith(':control'))
  const covered = new Set(records.map((r) => r.context))
  const missing = from.filter((id) => !covered.has(id))
  const mismatches = records.filter((r) => (r.verdict === 'INCLUDED') !== (r.precheck === 'ACCEPT'))
  const bad = records.filter((r) => r.precheck !== 'ACCEPT' && !isReasonCode(r.precheck))
  for (const r of records) if (r.precheck !== 'ACCEPT') ctx.codes.add(r.precheck)
  const rejections = records.filter((r) => r.verdict === 'CHAIN_REJECTED_VALIDATION').map((r) => ({ ...r, chainError: chainError(r) }))
  const byError: Record<string, number> = {}
  for (const r of rejections) byError[r.chainError] = (byError[r.chainError] ?? 0) + 1
  await Bun.write(`${ctx.dir}/parity.json`, JSON.stringify({ records, rejections, byError, excludedControls: controls }, null, 2))
  const rejected = records.filter((r) => r.verdict !== 'INCLUDED').length
  return [
    { step: 'chain errors behind the rejections', ok: true, detail: Object.entries(byError).map(([k, v]) => `${k} ×${v}`).join('; ') },
    { step: 'every SESS-01..SESS-23 scenario ran in this run', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : `${covered.size - 1} scenarios` },
    {
      step: 'pre-check and chain agree on every batch',
      ok: mismatches.length === 0 && records.length > 0,
      detail: mismatches.length
        ? mismatches.slice(0, 5).map((m) => `${m.context} ${m.batch} under ${m.grant}: precheck ${m.precheck}, chain ${m.verdict}`).join('; ')
        : `${records.length} batches: ${rejected} rejected by both, ${records.length - rejected} accepted by both; ${controls.length} chain-id control ops excluded`,
    },
    { step: 'every pre-check code is in the ReasonCode catalog', ok: bad.length === 0, detail: bad.map((b) => b.precheck).join(', ') || 'all catalogued' },
  ]
}

export const SESSION_STEPS: Record<string, StepHandler> = {
  'session-op': sessionOp,
  'owner-revoke': ownerRevoke,
  'owner-replay': ownerReplay,
  'engine-reactivate': engineReactivate,
  'owner-renew': ownerRenew,
  'owner-mint-position': ownerMintPosition,
  'time-warp': timeWarpStep,
  erc1271,
  permit: permitStep,
  'second-fork': secondForkStep,
  'precheck-parity': precheckParity,
}