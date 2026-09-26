import { concat, encodeFunctionData, parseEventLogs, type Hex, type TransactionReceipt } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'
import type { Address } from '@mamoru/domain'
import { address, entryPointV07Abi, safe7579Abi } from '@mamoru/registry'
import {
  CALLTYPE_BATCH,
  CALLTYPE_DELEGATECALL,
  CALLTYPE_SINGLE,
  EXECTYPE_DEFAULT,
  EXECTYPE_TRY,
  encodeBatchExecution,
  encodeDelegateExecution,
  encodeMode,
  encodeSingleExecution,
  type Execution,
} from '@mamoru/account/safe'
import { draftUserOp, handleOpsData, sessionKeySignature, sessionNonceKey, userOpHash, SMART_SESSION_MODE_ENABLE } from '@mamoru/account/sessions'
import { decodeExecute, precheck, type PrecheckResult } from '@mamoru/account/precheck'
import { decodeEntryPointError, type Lab } from './lab.ts'
import type { AccountFixture, ActiveGrant, World } from './world.ts'

export type CallLike = { to: Address; value?: bigint; data: Hex }

export type SessionOpOptions = {
  /** How the calls are wrapped. Default: single for one call, batch for more. */
  mode?: 'auto' | 'single' | 'batch' | 'delegatecall' | 'try-single' | 'try-batch' | 'executor'
  /** Replaces the account callData entirely (calls are ignored). */
  rawCallData?: Hex
  signatureMode?: 'use' | 'enable'
  permissionId?: Hex
  paymaster?: Address
  /** Chain id the session key signs for. Default: the lab's. */
  signChainId?: number
  /** Where the userOp is submitted. Default: world.lab. */
  submitTo?: Lab
  lane?: number
}

export type Verdict = 'INCLUDED' | 'CHAIN_REJECTED_VALIDATION' | 'CHAIN_REVERTED_EXECUTION'

export type SessionOpOutcome = {
  verdict: Verdict
  precheck: PrecheckResult
  failedOp?: { name: string; reason?: string; inner?: Hex } | null
  userOp: UserOperation<'0.7'>
  userOpHash: Hex
  txHash?: Hex
  receipt?: TransactionReceipt
  actualGasCost?: bigint
  calls: Execution[]
  handleOpsData: Hex
}

function toExec(c: CallLike): Execution {
  return { target: c.to, value: c.value ?? 0n, callData: c.data }
}

export function accountCallData(calls: CallLike[], mode: SessionOpOptions['mode'] = 'auto'): Hex {
  const execs = calls.map(toExec)
  const exec = (callType: number, execType: number, payload: Hex) =>
    encodeFunctionData({ abi: safe7579Abi, functionName: 'execute', args: [encodeMode(callType, execType), payload] })
  switch (mode) {
    case 'auto':
      return execs.length === 1 ? exec(CALLTYPE_SINGLE, EXECTYPE_DEFAULT, encodeSingleExecution(execs[0]!)) : exec(CALLTYPE_BATCH, EXECTYPE_DEFAULT, encodeBatchExecution(execs))
    case 'single':
      return exec(CALLTYPE_SINGLE, EXECTYPE_DEFAULT, encodeSingleExecution(execs[0]!))
    case 'batch':
      return exec(CALLTYPE_BATCH, EXECTYPE_DEFAULT, encodeBatchExecution(execs))
    case 'try-single':
      return exec(CALLTYPE_SINGLE, EXECTYPE_TRY, encodeSingleExecution(execs[0]!))
    case 'try-batch':
      return exec(CALLTYPE_BATCH, EXECTYPE_TRY, encodeBatchExecution(execs))
    case 'delegatecall':
      return exec(CALLTYPE_DELEGATECALL, EXECTYPE_DEFAULT, encodeDelegateExecution(execs[0]!.target, execs[0]!.callData))
    case 'executor':
      return encodeFunctionData({
        abi: safe7579Abi,
        functionName: 'executeFromExecutor',
        args: [encodeMode(CALLTYPE_SINGLE, EXECTYPE_DEFAULT), encodeSingleExecution(execs[0]!)],
      })
  }
}

/**
 * Builds a session userOp by hand, as the attacker with the session key would,
 * runs the engine pre-check on it, then submits it to EntryPoint.handleOps
 * from an anvil development account and classifies the chain's answer.
 */
export async function sendSessionOp(
  world: World,
  acct: AccountFixture,
  grant: ActiveGrant,
  batch: string,
  calls: CallLike[],
  opts: SessionOpOptions = {},
): Promise<SessionOpOutcome> {
  const outcome = await buildAndSend(world, acct, grant, calls, opts)
  world.opLog.push({
    context: world.context,
    grant: grant.name,
    batch,
    precheck: outcome.precheck.ok ? 'ACCEPT' : outcome.precheck.code,
    verdict: outcome.verdict,
    failedOp: outcome.failedOp?.reason,
  })
  return outcome
}

async function buildAndSend(
  world: World,
  acct: AccountFixture,
  grant: ActiveGrant,
  calls: CallLike[],
  opts: SessionOpOptions,
): Promise<SessionOpOutcome> {
  const lab = opts.submitTo ?? world.lab
  const callData = opts.rawCallData ?? accountCallData(calls, opts.mode)
  const key = sessionNonceKey(opts.lane ?? 0)
  const nonce = await lab.entryPointNonce(acct.safe, key)
  const block = await lab.client.getBlock()
  const maxFeePerGas = (block.baseFeePerGas ?? 1_000_000n) * 2n + 1_000_000n
  let op = draftUserOp(acct.safe, nonce, callData, {
    verificationGasLimit: 3_000_000n,
    callGasLimit: 2_000_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas,
    maxPriorityFeePerGas: 1_000_000n,
  })
  if (opts.paymaster) {
    op = { ...op, paymaster: opts.paymaster, paymasterVerificationGasLimit: 200_000n, paymasterPostOpGasLimit: 50_000n, paymasterData: '0x' }
  }
  const signChainId = opts.signChainId ?? world.lab.chainId
  const hash = userOpHash(op, signChainId)
  const pid = opts.permissionId ?? grant.permissionId
  const inner = await sessionKeySignature(acct.sessionKey, hash)
  const signature = concat([opts.signatureMode === 'enable' ? SMART_SESSION_MODE_ENABLE : '0x00', pid, inner])
  op = { ...op, signature }

  const pre = precheck(
    { sender: op.sender, callData: op.callData, signature: op.signature, paymaster: op.paymaster },
    { chainId: lab.chainId, now: lab === world.lab ? await world.engineNow() : Number(block.timestamp), ledger: acct.ledger },
  )

  const data = handleOpsData([op], world.relayer.address)
  const decoded = decodeExecute(callData)
  const execs = 'calls' in decoded ? decoded.calls : []
  let failedOp: SessionOpOutcome['failedOp'] = null
  try {
    await lab.client.call({ account: world.relayer.address, to: address('EntryPointV07'), data, gas: 15_000_000n })
  } catch (e) {
    failedOp = decodeEntryPointError(revertData(e)) ?? { name: 'unknown' }
  }
  const sent = await lab.send(world.relayer, address('EntryPointV07'), data)
  const base = { precheck: pre, userOp: op, userOpHash: hash, txHash: sent.hash, receipt: sent.receipt, calls: execs, handleOpsData: data }
  if (!sent.ok) return { ...base, verdict: 'CHAIN_REJECTED_VALIDATION', failedOp }
  const ev = parseEventLogs({ abi: entryPointV07Abi, logs: sent.receipt.logs, eventName: 'UserOperationEvent' })[0]
  if (!ev) return { ...base, verdict: 'CHAIN_REJECTED_VALIDATION', failedOp }
  if (lab === world.lab) acct.ledger.recordIncluded(pid, execs)
  return { ...base, verdict: ev.args.success ? 'INCLUDED' : 'CHAIN_REVERTED_EXECUTION', failedOp, actualGasCost: ev.args.actualGasCost }
}

function revertData(e: unknown): Hex | undefined {
  let cur: any = e
  for (let i = 0; i < 8 && cur; i++) {
    if (typeof cur.data === 'string' && cur.data.startsWith('0x')) return cur.data as Hex
    if (cur.data && typeof cur.data.data === 'string') return cur.data.data as Hex
    cur = cur.cause
  }
  return undefined
}
