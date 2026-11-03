// otto/mamoru#309 (b), security review of #227: after a failed enable, a new prepare + submit installs the new row (its
// l1Tx and every signed id), and the sibling gates hold inside the send path too.
import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toHex, type Hex } from 'viem'
import type { AccountContext, OwnerSignature } from '@mamoru/domain'
import { address, baseRegistry, ethereumRegistry } from '@mamoru/registry'
import { oneAuthV4Deployment } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { BridgeOut, type StoredSibling } from '../src/bridge-out.ts'
import { HttpError } from '../src/operator.ts'
import { pinTestA1 } from '../../../packages/account/one-auth/pin-fixture.ts'

const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
const owners = [address('SafeWebAuthnSharedSigner', baseRegistry)]
const saltNonce = 309n
const ctx: AccountContext = {
  accountKey: 'k',
  chainId: 8453,
  address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))),
  owners,
  saltNonce: saltNonce.toString(),
  passkey: { credentialId: 'u', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
}
const TX = `0x${'cd'.repeat(32)}` as Hex
const SUCCESS = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e'

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
function sign(t: { safeTxHash: Hex; prepareId: string }): OwnerSignature {
  const a = passkey.assert(t.safeTxHash)
  const s = randomBytes(1)[0]! & 1 ? P256_N - a.s : a.s
  return { prepareId: t.prepareId, authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'), clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'), signature: Buffer.from(der(a.r, s)).toString('base64url') }
}

function world(prior?: Partial<StoredSibling>) {
  const dir = mkdtempSync(join(tmpdir(), 'mamoru-sib-submit-'))
  writeFileSync(join(dir, 'bridge-out.json'), JSON.stringify({ routes: {}, spent: { day: '', wei: '0' }, moves: {}, ...(prior ? { siblings: { k: { id: 'old', safe: ctx.address, safeNonce: '0', safeTxHash: `0x${'11'.repeat(32)}`, permissionId: `0x${'aa'.repeat(32)}`, sessionKey: '0x0000000000000000000000000000000000000bbb', capUsdc: '1', fromBlock: '1', state: 'failed', signedIds: [`0x${'aa'.repeat(32)}`], at: new Date().toISOString(), ...prior } } } : {}) }))
  let enabled = false
  const l1 = {
    getBalance: async () => 55_000_000_000_000_000n,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'balanceOf') return 0n
      if (functionName === 'getPermissionIDs') return []
      if (functionName === 'isPermissionEnabled') return enabled
      if (functionName === 'nonce') return 0n
      throw new Error(functionName)
    },
    getCode: async () => '0x',
    getBlockNumber: async () => 100n,
    getGasPrice: async () => 1_000_000n,
    estimateGas: async () => 1_500_000n,
    call: async () => ({ data: `0x${'1'.padStart(64, '0')}` }),
  }
  const sent: string[] = []
  const relayer = {
    address: '0x0000000000000000000000000000000000000001' as const,
    send: async (tx: { to: Hex; data?: Hex }, onSent?: (h: Hex) => void, _s?: unknown, onSigned?: (h: Hex, n: number) => void) => {
      sent.push(tx.to)
      onSigned?.(TX, sent.length)
      onSent?.(TX)
      const exec = tx.to.toLowerCase() === ctx.address.toLowerCase()
      if (exec) enabled = true
      return { hash: TX, receipt: { status: 'success', gasUsed: 1n, effectiveGasPrice: 1n, logs: exec ? [{ address: ctx.address, topics: [SUCCESS, sentHash], data: '0x' }] : [] } as never }
    },
  }
  let sentHash: Hex = '0x'
  const bo = new BridgeOut({ ...l1, getBalanceOf: undefined } as never, relayer, dir, fetch, Date.now, undefined, () => true)
  ;(bo as unknown as { l1: { getBalance: () => Promise<bigint> } }).l1.getBalance = async () => 55_000_000_000_000_000n
  bo.siblingCapUsd = () => 1_000_000_000n
  bo.siblingInScope = () => true
  return { bo, sent, journal: () => JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8')).siblings.k as StoredSibling, setHash: (h: Hex) => { sentHash = h } }
}

describe('#243 / #348: no V4 pinned on Ethereum (A1 undeployed until T8)', () => {
  test('the ethereum-sibling endpoints answer SIBLING_NOT_OFFERED (404), so the one-approval screen falls back to plain Start', async () => {
    expect(oneAuthV4Deployment(ethereumRegistry)).toBeNull()
    const w = world({})
    expect(w.bo.siblingView('k', ctx)).toEqual({ state: 'failed', offered: false, safe: ctx.address, sessionKey: '0x0000000000000000000000000000000000000bbb' })
    expect(new BridgeOut({} as never, { address: '0x0000000000000000000000000000000000000001', send: async () => { throw new Error('never') } } as never, mkdtempSync(join(tmpdir(), 'mamoru-sib-none-')), fetch, Date.now, undefined, () => true).siblingView('k', ctx)).toEqual({ state: 'none', offered: false })
    for (const call of [() => w.bo.prepareSibling(ctx), () => w.bo.submitSibling(ctx, { prepareId: 'x', authenticatorData: '', clientDataJSON: '', signature: '' })]) {
      const err = await call().then(() => null, (e) => e)
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).status).toBe(404)
      expect((err as HttpError).code).toBe('SIBLING_NOT_OFFERED')
    }
    expect(w.sent).toEqual([])
  })
})

describe('sibling submit (a test A1 stack pinned on Ethereum)', () => {
  let unpin = () => {}
  const pinned = <T>(f: () => Promise<T>) => async () => {
    unpin = pinTestA1(ethereumRegistry)
    try {
      return await f()
    } finally {
      unpin()
    }
  }
  afterAll(() => unpin())
  test('after a failed enable, prepare + submit installs the new row: its l1Tx, and every signed id kept', pinned(async () => {
    const w = world({})
    const p = await w.bo.prepareSibling(ctx)
    w.setHash(p.safeTxHash)
    const v = await w.bo.submitSibling(ctx, sign(p))
    expect(v.state).toBe('done')
    const row = w.journal()
    expect(row.id).toBe(p.prepareId)
    expect(row.l1Tx).toBe(TX)
    expect(row.signedIds).toContain(`0x${'aa'.repeat(32)}`)
    expect(row.signedIds!.length).toBe(2)
    expect(w.sent.length).toBe(2) // deploy, then the enable
  }))

  test('a live row blocks the send path itself, not only the prepare', pinned(async () => {
    const w = world({ state: 'unconfirmed', l1Tx: TX })
    const err = await w.bo.prepareSibling(ctx).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe('SIBLING_IN_PROGRESS')
  }))
})
