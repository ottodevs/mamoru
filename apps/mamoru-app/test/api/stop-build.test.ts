import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, getAddress, hashTypedData, type Hex } from 'viem'
import type { StopInput } from '@mamoru/domain'
import { ownerSafeTx } from '@mamoru/account/live'
import { safeTxTypedData, type MultiSendCall } from '@mamoru/account/safe'
import { buildStop, stopCalls } from '@mamoru/account/stop'
import { address, baseRegistry, erc20Abi } from '@mamoru/registry'
import { harness, ORIGIN, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#430: the Worker rebuilds a Stop with buildStop before the owner signs it, and passes it on only when the
// operator's hash is the one the builder gives for the row's own Safe and chain. Any extra call, other target, other Safe,
// other chain or value gives another hash: 502 BUILD_MISMATCH, nothing to sign.

const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const ATTACKER = '0x9999999999999999999999999999999999999999' as Hex

function world(prepare: (safe: Hex) => unknown, status = 200) {
  let safe: Hex = '0x0000000000000000000000000000000000000000'
  const seen: string[] = []
  const operatorFetch = async (url: string) => {
    seen.push(url)
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/stop/prepare')) return new Response(JSON.stringify(prepare(safe)), { status, headers: { 'content-type': 'application/json' } })
    return json({ ok: true })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET }, operatorFetch })
  return {
    seen,
    async owner() {
      const res = await register(h, PASSKEY_A)
      const cookie = sessionCookie(res)
      const base = (await res.json()) as { accountKey: string; address: Hex }
      safe = base.address
      return (path: string) => h.app.request(`${ORIGIN}/api/accounts/${base.accountKey}${path}`, { method: 'POST', body: '{}', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } }, h.env)
    },
  }
}

const input = (safe: Hex, o: Partial<StopInput> = {}): StopInput => ({
  chainId: 8453,
  safe,
  safeNonce: '4',
  revokes: [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`],
  positions: [{ tokenId: '123456', liquidity: '987654321', amount0Min: '1000', amount1Min: '20' }],
  deadline: '1790000000',
  vaultExits: [{ vault: 'vault:gtUSDCp', mode: 'redeem', assets: '5000000', shares: '4900000000000000000' }],
  swaps: [{ token: 'cbBTC', pool: 'pool:USDC/cbBTC/500', amountIn: '1500', amountOutMinimum: '1400000' }],
  ...o,
})
const offer = (i: StopInput, hash?: string) => ({ safe: i.safe, chainId: i.chainId, safeTxHash: hash ?? buildStop(i, baseRegistry).safeTxHash, summary: ['Stop'], expiresAt: 'x', prepareId: 'p1', stop: i })
/** The hash of a Safe tx of `calls` on `safe`: what a dishonest operator would hand the owner beside an honest input. */
const hashOf = (safe: Hex, calls: MultiSendCall[], nonce = 4n, chainId = 8453) => hashTypedData(safeTxTypedData(getAddress(safe), chainId, ownerSafeTx(calls, nonce, baseRegistry)))
const steal = (): MultiSendCall => ({ to: address('USDC', baseRegistry), value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ATTACKER, 5_000_000n] }) })

describe('stop/prepare is rebuilt by the Worker (#430)', () => {
  test.each([
    ['a full Stop: revokes, a position, a vault exit, a swap back', (safe: Hex) => offer(input(safe))],
    ['a revoke-only Stop', (safe: Hex) => offer(input(safe, { positions: [], deadline: '0', vaultExits: [], swaps: [] }))],
    ['a Safe-paid Stop (refund to the relayer)', (safe: Hex) => offer(input(safe, { refund: { safeTxGas: '4000000', baseGas: '620000', gasPrice: '20000000', refundReceiver: `0x${'ab'.repeat(20)}` } }))],
  ])("%s, the builder's tx on the row's own Safe and chain: passed on", async (_why, prepare) => {
    const w = world(prepare)
    const call = await w.owner()
    const res = await call('/stop/prepare')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { stop: StopInput }).stop.chainId).toBe(8453)
  })

  test.each([
    ['an extra call (a USDC transfer out) in the signed tx', (safe: Hex) => offer(input(safe), hashOf(safe, [...stopCalls(input(safe), baseRegistry), steal()]))],
    ['another target (a call swapped for a transfer out)', (safe: Hex) => {
      const calls = stopCalls(input(safe), baseRegistry)
      return offer(input(safe), hashOf(safe, [...calls.slice(0, -1), steal()]))
    }],
    ['value on a call', (safe: Hex) => {
      const calls = stopCalls(input(safe), baseRegistry)
      return offer(input(safe), hashOf(safe, [{ ...calls[0]!, value: 1n }, ...calls.slice(1)]))
    }],
    ['a single call with value (no MultiSend)', (safe: Hex) => {
      const i = input(safe, { revokes: [`0x${'01'.repeat(32)}`], positions: [], deadline: '0', vaultExits: [], swaps: [] })
      return offer(i, hashOf(safe, [{ ...stopCalls(i, baseRegistry)[0]!, value: 10n ** 18n }]))
    }],
    ['another Safe in the input', (safe: Hex) => offer(input(safe, { safe: `0x${'66'.repeat(20)}` }))],
    ['another Safe in the answer', (safe: Hex) => ({ ...offer(input(safe)), safe: `0x${'66'.repeat(20)}` })],
    ['another chain in the input', (safe: Hex) => ({ ...offer(input(safe)), stop: input(safe, { chainId: 143 }) })],
    ['another chain in the answer', (safe: Hex) => ({ ...offer(input(safe)), chainId: 143 })],
    ['the same calls signed for another chain', (safe: Hex) => offer(input(safe), hashOf(safe, stopCalls(input(safe), baseRegistry), 4n, 143))],
    ['another nonce', (safe: Hex) => offer(input(safe), hashOf(safe, stopCalls(input(safe), baseRegistry), 5n))],
    ['a "vault" that is not one', (safe: Hex) => ({ ...offer(input(safe)), stop: input(safe, { vaultExits: [{ vault: 'USDC', mode: 'redeem', assets: '1', shares: '1' }] }) })],
    ['a swap on a pool the token is not in', (safe: Hex) => ({ ...offer(input(safe)), stop: input(safe, { swaps: [{ token: 'cbBTC', pool: 'pool:EURC/USDC/500', amountIn: '1', amountOutMinimum: '1' }] }) })],
    ['a refund over what a Stop is given', (safe: Hex) => ({ ...offer(input(safe)), stop: input(safe, { refund: { safeTxGas: '4000000', baseGas: '50000000', gasPrice: '1', refundReceiver: ATTACKER } }) })],
    ['a hash the input does not give', (safe: Hex) => offer(input(safe), `0x${'12'.repeat(32)}`)],
    ['no input', (safe: Hex) => ({ ...offer(input(safe)), stop: undefined })],
    ['an answer that is not an object', () => 'not an offer'],
    ['a malformed input', (safe: Hex) => ({ ...offer(input(safe)), stop: { ...input(safe), positions: [null] } })],
  ])('%s: refused (BUILD_MISMATCH), nothing to sign', async (_why, prepare) => {
    const w = world(prepare)
    const call = await w.owner()
    const res = await call('/stop/prepare')
    expect(res.status).toBe(502)
    const body = (await res.json()) as { code: string; safeTxHash?: string }
    expect(body.code).toBe('BUILD_MISMATCH')
    expect(body.safeTxHash).toBeUndefined()
  })

  test('a refusal of the operator (nothing to sign) and the Stop submit itself are passed on as they are', async () => {
    const w = world(() => ({ error: 'no grant, no position and nothing to swap back', code: 'NOTHING_TO_STOP' }), 409)
    const call = await w.owner()
    const res = await call('/stop/prepare')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('NOTHING_TO_STOP')
    expect((await call('/stop')).status).toBe(200)
  })
})
