// otto/mamoru#225: the app lays out an approval by reading its signed lines (apps/mamoru-app/src/web/lib/approval-read.ts).
// The operator's real v6 summaries are held to that reader here: every line read, none left as raw text. A new or
// reworded line fails this test; teach the reader (and its labels in the dialog) the sentence, never loosen the check.
// Setup as in v6-operator.test.ts.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, getAddress, pad, parseAbi, slice, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address } from '@mamoru/domain'
import { address as registryAddress, baseRegistry, smartSessionAbi } from '@mamoru/registry'
import { V4_TX_GAS_TARGET, conservadorLiveV5, conservadorLiveV6, grantKey, orderV4Keys, splitV4Keys } from '@mamoru/policy'
import { remoteInput, remoteSafe } from '@mamoru/account/remote'
import { resolveV4Policy, resolveV5Policy, resolveV6Policy } from '../src/boot.ts'
import { HttpError, upgradeSplitOf, type Operator, type OperatorConfig } from '../src/operator.ts'
import type { RemoteProvision } from '../src/remote-peer.ts'
import type { AccountState, StoredGrant } from '../src/state.ts'
import { FIXTURE_SESSION_KEY, GATE_V3_BASE_PINNED, V3_BASE_PINNED, withPinnedV3, withPinnedV6Base } from '../../../packages/account/remote/fixture.ts'
import { ctx, quiet, sign, world } from './owner-world.ts'

const V1 = `0x${'11'.repeat(20)}`
const GAS = `0x${'22'.repeat(20)}`
const V2 = `0x${'33'.repeat(20)}`
const env = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: V1, MAMORU_ACTION_POLICY_V2_ADDRESS: V2, MAMORU_GAS_POLICY_ADDRESS: GAS }
const reg6 = withPinnedV6Base()
const V3 = V3_BASE_PINNED.toLowerCase()
const GATE = GATE_V3_BASE_PINNED.toLowerCase()
const UNI = registryAddress('UniActionPolicy', baseRegistry).toLowerCase()
const v4 = resolveV4Policy('base', env)!
const v5 = resolveV5Policy('base', env)!
const v6 = resolveV6Policy('base', env, reg6)!

type Privates = { settleRenewals(a: AccountState): Promise<void>; assertRenewable(a: AccountState): void; readOf(a: AccountState, safe: Hex): Promise<{ block: bigint }>; prepared: Map<string, { grants?: StoredGrant[]; revokes?: Hex[]; extend?: boolean; tx: { to: string; data: Hex } }>; client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown> } }
const priv = (op: Operator) => op as unknown as Privates

/** MultiSend (packed) -> its calls. */
function unpack(data: Hex): { to: string; data: Hex }[] {
  const packed = decodeFunctionData({ abi: parseAbi(['function multiSend(bytes transactions)']), data }).args[0] as Hex
  const out: { to: string; data: Hex }[] = []
  let at = 0
  const len = (packed.length - 2) / 2
  while (at < len) {
    const to = slice(packed, at + 1, at + 21)
    const n = Number(BigInt(slice(packed, at + 53, at + 85)))
    out.push({ to, data: slice(packed, at + 85, at + 85 + n) })
    at += 85 + n
  }
  return out
}

/** Every session the owner transaction enables, with the policy contracts it names (per action, and as sets). */
function sessionsOf(tx: { to: string; data: Hex }) {
  const smartSession = registryAddress('SmartSession', baseRegistry).toLowerCase()
  const calls = tx.data.startsWith('0x8d80ff0a') ? unpack(tx.data) : [tx]
  const enable = calls.filter((c) => c.to.toLowerCase() === smartSession).map((c) => decodeFunctionData({ abi: smartSessionAbi, data: c.data })).filter((d) => d.functionName === 'enableSessions')
  expect(enable).toHaveLength(1)
  const sessions = enable[0]!.args![0] as unknown as { userOpPolicies: { policy: string }[]; actions: { actionPolicies: { policy: string }[] }[] }[]
  return sessions.map((s) => ({
    userOp: new Set(s.userOpPolicies.map((p) => p.policy.toLowerCase())),
    perAction: s.actions.map((a) => a.actionPolicies.map((p) => p.policy.toLowerCase())),
    action: new Set(s.actions.flatMap((a) => a.actionPolicies.map((p) => p.policy.toLowerCase()))),
  }))
}

const UID = `0x${'ab'.repeat(32)}`
const asked: string[] = []
/** The registry, the policy contracts and the guardian pause answer as a deployed, attested world would. */
function chain(w: ReturnType<typeof world>, generation: bigint, paused = false) {
  const client = priv(w.op).client
  const base = client.readContract.bind(client)
  client.readContract = async (a) => {
    if (a.functionName === 'findModule') {
      asked.push(String(a.args?.[0]).toLowerCase())
      return { resolverUID: UID, sender: `0x${'01'.repeat(20)}` }
    }
    if (a.functionName === 'findAttestation') return { time: 0, expirationTime: 0, revocationTime: 0, attester: `0x${'00'.repeat(20)}` }
    if (a.functionName === 'generationOf') return generation
    if (a.functionName === 'configOf') return { generation }
    if (a.functionName === 'isPaused') return paused
    return base(a)
  }
}

function running(w: ReturnType<typeof world>, policy = v5, only?: (name: string) => boolean): AccountState {
  const grants = policy.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ name: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(64, '0')}`, grant: { policyId: policy.policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } })).filter((g) => !only || only(g.name))
  const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: policy.policyId, grants, ops: [], revoked: [] } as unknown as AccountState
  w.state.accounts.k = acc
  return acc
}

function ready(w: ReturnType<typeof world>): void {
  const p = priv(w.op)
  ;(p as unknown as { settleRenewals: () => Promise<void> }).settleRenewals = async () => {}
  ;(p as unknown as { assertRenewable: () => void }).assertRenewable = () => {}
  ;(p as unknown as { readOf: () => Promise<unknown> }).readOf = async () => ({ block: 100n, deployed: false, usdc: 0n, eth: 0n })
}

const SESSION_KEY = privateKeyToAccount(FIXTURE_SESSION_KEY).address
const pinnedV3 = withPinnedV3()

/** The Monad operator as the Base one sees it: gives the session key, records what it was asked, answers `provision`. */
function fakePeer(answer: { provision: RemoteProvision; keyFails?: boolean } = { provision: { state: 'active', address: SESSION_KEY } }) {
  const keyAsked: AccountContext[] = []
  const provisioned: AccountContext[] = []
  const peer = {
    key: async (c: AccountContext): Promise<Address> => {
      keyAsked.push(c)
      if (answer.keyFails) throw new Error('remote operator of chain 143 gave no session key (502 )')
      return SESSION_KEY
    },
    provision: async (c: AccountContext): Promise<RemoteProvision> => {
      provisioned.push(c)
      return answer.provision.state === 'active' ? { state: 'active', address: c.address as Address } : answer.provision
    },
  }
  return { peer, keyAsked, provisioned, answer }
}

const scopedOn = { multichain_v6: null }
/** A Base operator offering v6 (flag on for everyone) with the Monad operator `peer`; V3 on Monad is the pinned fixture one. */
const cfg6 = (peer?: ReturnType<typeof fakePeer>['peer'], extra: Partial<OperatorConfig> = {}): Partial<OperatorConfig> => ({
  registry: reg6,
  v4Policy: v4,
  v5Policy: v5,
  v6Policy: v6,
  opsFlags: () => ({ multichain_v6: true }),
  opsScopedFlags: () => scopedOn,
  remoteRegistry: () => pinnedV3,
  ...(peer ? { remotePeers: { 143: peer } } : {}),
  ...extra,
})

import { POLICIES } from '@mamoru/policy'
import { linesOf, readApproval } from '../../mamoru-app/src/web/lib/approval-read.ts'

describe("the app reads every line of the operator's v6 approvals", () => {
  for (const [label, from] of [['move v5 -> v6', () => v5], ['renewal of v6', () => v6], ['move legacy v2 -> v6', () => POLICIES['conservador-live-v2']!]] as const) {
    test(label, async () => {
      const w = world(0n, cfg6(fakePeer().peer))
      running(w, from())
      ready(w)
      chain(w, 7n)
      const t = await w.op.prepareRenew(ctx)
      const r = readApproval(t.summary)
      expect(r.text.map((x) => x.text)).toEqual([])
      expect(linesOf(r)).toEqual(t.summary.map((_, i) => i))
      expect(r.pools).toHaveLength(3)
      expect(r.engine?.days).toBe(365)
    })
  }

  // #225 review:pr: the operator puts the guardian-pause warning before the head; the head is still read there, and
  // the move's new Monad Safe stays a change.
  test('move v5 -> v6 on a paused Safe', async () => {
    const w = world(0n, cfg6(fakePeer().peer))
    running(w, v5)
    ready(w)
    chain(w, 7n, true)
    const t = await w.op.prepareRenew(ctx)
    const r = readApproval(t.summary)
    expect(r.text.map((x) => x.text)).toEqual([])
    expect(linesOf(r)).toEqual(t.summary.map((_, i) => i))
    expect(r.head).toMatchObject({ line: 1, move: true, newVersion: false })
    expect(r.changes.map((c) => c.key)).toEqual(expect.arrayContaining(['paused', 'remote']))
  })

  test('move v4 -> v5 names the new version of the on-chain limits', async () => {
    const w = world(0n, { registry: reg6, v4Policy: v4, v5Policy: v5, opsFlags: () => ({ onchain_action_policy_v5: true }) })
    running(w, v4)
    ready(w)
    chain(w, 7n)
    const t = await w.op.prepareRenew(ctx)
    const r = readApproval(t.summary)
    expect(r.head).toMatchObject({ line: 0, move: true, newVersion: true })
    expect(r.text.map((x) => x.text)).toEqual([])
    expect(linesOf(r)).toEqual(t.summary.map((_, i) => i))
  })
})
