import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData, toFunctionSelector, type Hex } from 'viem'
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
const RELAYER = `0x${'ab'.repeat(20)}` as Hex
const POLICY = `8453:${RELAYER}:1000000000`

/** What QuoterV2 answers the Worker for a swap: 1,440,000 units, so input()'s minimum out (1,400,000) is over 97 % of it. */
const QUOTE = 1_440_000n
const GET_PERMISSION_IDS = toFunctionSelector('getPermissionIDs(address)')
/**
 * A provider that answers SmartSession.getPermissionIDs with `enabled` and any other eth_call as QuoterV2 with `quote`,
 * or is down (`quote` null); `calls` counts what it was asked.
 */
const node = (quote: bigint | null, calls: string[] = [], enabled: Hex[] = []) => async (_url: string, init: RequestInit) => {
  calls.push(String(init.body))
  if (quote === null) throw new TypeError('connect ECONNREFUSED')
  const { params } = JSON.parse(String(init.body)) as { params: [{ data: Hex }] }
  const result = params[0].data.startsWith(GET_PERMISSION_IDS)
    ? encodeAbiParameters([{ type: 'bytes32[]' }], [enabled])
    : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }], [quote, 1n, 1, 1n])
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
}

function world(prepare: (safe: Hex) => unknown, status = 200, policy: string | undefined = POLICY, quote: bigint | null = QUOTE, enabled: Hex[] = []) {
  const reads: string[] = []
  let safe: Hex = '0x0000000000000000000000000000000000000000'
  const seen: string[] = []
  const operatorFetch = async (url: string) => {
    seen.push(url)
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/stop/prepare')) return new Response(JSON.stringify(prepare(safe)), { status, headers: { 'content-type': 'application/json' } })
    return json({ ok: true })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET, BASE_RPC_URLS: 'https://rpc.test', ...(policy ? { STOP_REFUND_POLICY: policy } : {}) }, operatorFetch, chainFetch: node(quote, reads, enabled) })
  return {
    seen,
    reads,
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
  vaultExits: [{ vault: 'vault:gtUSDCp', mode: 'redeem', assets: '5009999', shares: '4900000000000000000' }],
  swaps: [{ token: 'cbBTC', pool: 'pool:USDC/cbBTC/500', amountIn: '1500', amountOutMinimum: '1400000' }],
  ...o,
})
/** The lines the operator writes for `i` (planFullStop / planRevokeOnly / feePlan), spelled out here on purpose. */
const linesOf = (i: StopInput): string[] => {
  const revokeOnly = i.deadline === '0' && !i.positions.length && !i.vaultExits.length && !i.swaps.length
  const fee = i.refund ? [`Your Safe pays this transaction's network fee to Mamoru's relayer, at most about ${feeEth(i)} ETH (sponsored transactions are used up until 2026-11-23T10:00:00.000Z)`] : []
  if (revokeOnly) return [`Revoke the engine's ${i.revokes.length} session grant(s)`, 'Your positions and tokens stay in your Safe as they are; Stop again closes them', ...fee]
  return [
    ...(i.revokes.length ? [`Revoke the engine's ${i.revokes.length} session grant(s)`] : []),
    ...i.positions.map((p) => `Close and burn position #${p.tokenId} (USDC/cbBTC 0.05%)`),
    ...i.vaultExits.map((x) => `Take ${(Math.floor(Number(x.assets) / 1e4) / 100).toFixed(2)} USDC out of Morpho · Gauntlet USDC Prime`),
    ...i.swaps.map((sw) => `Swap ${sw.amountIn} ${sw.token} units to at least ${(Math.floor(Number(sw.amountOutMinimum) / 1e4) / 100).toFixed(2)} USDC`),
    'Everything stays in your Safe as USDC',
    ...fee,
  ]
}
const feeEth = (i: StopInput) => {
  const wei = (BigInt(i.refund!.safeTxGas) + BigInt(i.refund!.baseGas)) * BigInt(i.refund!.gasPrice)
  const t = wei.toString().padStart(19, '0')
  const frac = t.slice(-18).slice(0, 6).replace(/0+$/, '')
  return frac ? `${t.slice(0, -18)}.${frac}` : t.slice(0, -18)
}
const offer = (i: StopInput, hash?: string, summary?: string[]) => ({ safe: i.safe, chainId: i.chainId, safeTxHash: hash ?? buildStop(i, baseRegistry).safeTxHash, summary: summary ?? linesOf(i), expiresAt: 'x', prepareId: 'p1', stop: i })
const paid = (safe: Hex, r: Partial<NonNullable<StopInput['refund']>> = {}) => input(safe, { refund: { safeTxGas: '4000000', baseGas: '620000', gasPrice: '20000000', refundReceiver: RELAYER, ...r } })
/** The hash of a Safe tx of `calls` on `safe`: what a dishonest operator would hand the owner beside an honest input. */
const hashOf = (safe: Hex, calls: MultiSendCall[], nonce = 4n, chainId = 8453) => hashTypedData(safeTxTypedData(getAddress(safe), chainId, ownerSafeTx(calls, nonce, baseRegistry)))
const steal = (): MultiSendCall => ({ to: address('USDC', baseRegistry), value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ATTACKER, 5_000_000n] }) })

describe('stop/prepare is rebuilt by the Worker (#430)', () => {
  test.each([
    ['a full Stop: revokes, a position, a vault exit, a swap back', (safe: Hex) => offer(input(safe))],
    ['a revoke-only Stop', (safe: Hex) => offer(input(safe, { positions: [], deadline: '0', vaultExits: [], swaps: [] }))],
    ['a Safe-paid Stop (refund to the relayer, under the gas price cap)', (safe: Hex) => offer(paid(safe))],
    ['a Stop whose positions could not be read (revoke-only fallback line)', (safe: Hex) => {
      const i = input(safe, { positions: [], deadline: '0', vaultExits: [], swaps: [] })
      return offer(i, undefined, [`Revoke the engine's 2 session grant(s)`, 'Your positions could not be read just now: they stay in your Safe as they are, and Stop again closes them'])
    }],
    ['a full Stop that leaves positions and vault money for later', (safe: Hex) => {
      const i = input(safe)
      const l = linesOf(i)
      return offer(i, undefined, [...l.slice(0, 3), '12.50 USDC stays in a lending vault that cannot pay it out right now: Stop again later to take it', ...l.slice(3), '2 more position(s) stay in your Safe: Stop again to close them'])
    }],
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
    ['a refund to another receiver', (safe: Hex) => offer(paid(safe, { refundReceiver: ATTACKER }))],
    ['a refund over the gas price cap', (safe: Hex) => offer(paid(safe, { gasPrice: '1000000001' }))],
    ['a summary line the input does not build', (safe: Hex) => offer(input(safe), undefined, [...linesOf(input(safe)), 'Mamoru also keeps 5 USDC'])],
    ['a summary that hides a revocation count', (safe: Hex) => offer(input(safe), undefined, linesOf(input(safe)).map((l) => l.replace("engine's 2", "engine's 3")))],
    ['a summary with another swap minimum', (safe: Hex) => offer(input(safe), undefined, linesOf(input(safe)).map((l) => l.replace('at least 1.40', 'at least 9.40')))],
    ['a summary missing a position', (safe: Hex) => offer(input(safe), undefined, linesOf(input(safe)).filter((l) => !l.startsWith('Close')))],
    ['a summary that hides the refund', (safe: Hex) => offer(paid(safe), undefined, linesOf(paid(safe)).slice(0, -1))],
    ['a summary that understates the refund', (safe: Hex) => offer(paid(safe), undefined, linesOf(paid(safe)).map((l) => l.replace(feeEth(paid(safe)), '0.000001')))],
    ['a fee line with no refund', (safe: Hex) => offer(input(safe), undefined, [...linesOf(input(safe)), linesOf(paid(safe)).at(-1)!])],
    ['no summary', (safe: Hex) => ({ ...offer(input(safe)), summary: undefined })],
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

  test('a Safe-paid Stop on a Worker with no refund policy: refused; one Mamoru pays: passed on', async () => {
    const w = world((safe) => offer(paid(safe)), 200, '')
    const call = await w.owner()
    expect(((await (await call('/stop/prepare')).json()) as { code: string }).code).toBe('BUILD_MISMATCH')
    const free = world((safe) => offer(input(safe)), 200, '')
    expect((await (await free.owner())('/stop/prepare')).status).toBe(200)
  })

  test("each swap's minimum out against QuoterV2: at 97 % of the Worker's quote passed on; far under it (a sandwich) refused", async () => {
    const near = world((safe) => offer(input(safe)))
    expect((await (await near.owner())('/stop/prepare')).status).toBe(200)
    expect(near.reads.some((b) => b.includes('eth_call'))).toBe(true)
    const low = world((safe) => offer(input(safe)), 200, POLICY, QUOTE * 2n)
    const res = await (await low.owner())('/stop/prepare')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string; safeTxHash?: string }).code).toBe('BUILD_MISMATCH')
  })

  test('#434: a Stop that leaves a session SmartSession lists as enabled is refused; one that revokes them all is passed on', async () => {
    const ids = input('0x0000000000000000000000000000000000000000').revokes as Hex[]
    const all = world((safe) => offer(input(safe)), 200, POLICY, QUOTE, [ids[1]!.toUpperCase().replace('0X', '0x') as Hex, ids[0]!])
    expect((await (await all.owner())('/stop/prepare')).status).toBe(200)
    const extra = world((safe) => offer(input(safe)), 200, POLICY, QUOTE, [...ids, `0x${'ee'.repeat(32)}`])
    const res = await (await extra.owner())('/stop/prepare')
    expect(res.status).toBe(502)
    const body = (await res.json()) as { code: string; safeTxHash?: string }
    expect(body.code).toBe('BUILD_MISMATCH')
    expect(body.safeTxHash).toBeUndefined()
    // A revoke-only Stop that revokes another session than the one enabled: refused all the same.
    const other = world((safe) => offer(input(safe, { revokes: [ids[1]!], positions: [], deadline: '0', vaultExits: [], swaps: [] })), 200, POLICY, QUOTE, [ids[0]!])
    expect((await (await other.owner())('/stop/prepare')).status).toBe(502)
  })

  test('the chain unreadable: 503 STOP_CHECK_UNAVAILABLE, nothing to sign, whether the Stop swaps or not', async () => {
    const down = world((safe) => offer(input(safe)), 200, POLICY, null)
    const res = await (await down.owner())('/stop/prepare')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; safeTxHash?: string }
    expect(body.code).toBe('STOP_CHECK_UNAVAILABLE')
    expect(body.safeTxHash).toBeUndefined()
    const none = world((safe) => offer(input(safe, { swaps: [] })), 200, POLICY, null)
    expect((await (await none.owner())('/stop/prepare')).status).toBe(503)
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
