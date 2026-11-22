import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeFunctionData, hashTypedData, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { ownerSafeTx, stopBatch } from '@mamoru/account/live'
import { uniswapV3 } from '@mamoru/uniswap-v3'
import { safeTxTypedData, type MultiSendCall, type SafeTx } from '@mamoru/account/safe'
import { address, baseRegistry, erc20Abi } from '@mamoru/registry'
import { harness, ORIGIN, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#430: the Worker reads a Stop's Safe tx before the owner signs it, and passes it on only when it is this
// account's own Safe, hashes to what is signed, and makes only the calls a Stop makes, each paying the Safe.

const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const THIEF: Address = '0x9999999999999999999999999999999999999999'
const ZERO: Address = '0x0000000000000000000000000000000000000000'

const wire = (tx: SafeTx) => ({ to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: tx.nonce.toString() })
const revokes = (safe: Address): MultiSendCall[] => stopBatch({ account: safe, permissionIds: [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`], positions: [{ tokenId: 7n, liquidity: 1_000n, amount0Min: 1n, amount1Min: 1n }], deadline: 1_800_000_000n, registry: baseRegistry })
const offer = (safe: Address, calls: MultiSendCall[], o: Record<string, unknown> = {}, refund?: SafeTx['refund']) => {
  const tx: SafeTx = { ...ownerSafeTx(calls, 3n, baseRegistry), ...(refund ? { refund } : {}) }
  const w = refund ? { ...wire(tx), safeTxGas: refund.safeTxGas.toString(), baseGas: refund.baseGas.toString(), gasPrice: refund.gasPrice.toString(), refundReceiver: refund.refundReceiver } : wire(tx)
  return { safe, chainId: 8453, safeTxHash: hashTypedData(safeTxTypedData(safe, 8453, tx)), summary: ['Revoke'], expiresAt: 'x', prepareId: 'p1', safeTx: w, ...o }
}
/** The Stop swaps 50_000 cbBTC units back to USDC with this minimum out. */
const swapBack = (safe: Address, min: bigint): MultiSendCall[] => {
  const { approve, exactInputSingle } = uniswapV3(baseRegistry)
  return [approve('cbBTC', 'SwapRouter02', 50_000n), exactInputSingle({ account: safe, tokenIn: 'cbBTC', tokenOut: 'USDC', fee: 500, amountIn: 50_000n, amountOutMinimum: min }), approve('cbBTC', 'SwapRouter02', 0n)].map((c) => ({ to: c.to, value: c.value, data: c.data }))
}
const QUOTE = 45_000_000n
const GAS_PRICE = 10_000_000n
const RELAYER: Address = '0x7777777777777777777777777777777777777777'
/** A provider that answers QuoterV2 with QUOTE and eth_gasPrice with GAS_PRICE (odd-length QUANTITY), or is down. */
const node = (up = true) => async (_url: string, init: RequestInit) => {
  if (!up) throw new TypeError('connect ECONNREFUSED')
  const { method } = JSON.parse(String(init.body)) as { method: string }
  const result = method === 'eth_gasPrice' ? `0x${GAS_PRICE.toString(16)}` : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }], [QUOTE, 1n, 1, 1n])
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
}

async function stopPrepare(prepare: (safe: Address) => unknown, chain: { rpc?: string; up?: boolean } = {}) {
  let safe: Address = ZERO
  const operatorFetch = async (url: string) => new Response(JSON.stringify(url.endsWith('/stop/prepare') ? prepare(safe) : { ok: true }), { headers: { 'content-type': 'application/json' } })
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET, BASE_RPC_URLS: chain.rpc ?? 'https://rpc.test' }, operatorFetch, chainFetch: node(chain.up ?? true) })
  const res = await register(h, PASSKEY_A)
  const cookie = sessionCookie(res)
  const account = (await res.json()) as { accountKey: string; address: Address }
  safe = account.address
  return h.app.request(`${ORIGIN}/api/accounts/${account.accountKey}/stop/prepare`, { method: 'POST', body: '{}', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } }, h.env)
}

describe('stop/prepare is read by the Worker (#430)', () => {
  test('revokes and a close-and-burn on the own Safe: passed on', async () => {
    const res = await stopPrepare((safe) => offer(safe, revokes(safe)))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { prepareId: string }).prepareId).toBe('p1')
  })

  test.each([
    ['a USDC transfer out added to the Stop', (safe: Address) => offer(safe, [...revokes(safe), { to: address('USDC', baseRegistry), value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [THIEF, 1_000_000n] }) }])],
    ['another Safe', (safe: Address) => ({ ...offer(safe, revokes(safe)), safe: THIEF })],
    ['a hash the tx does not give', (safe: Address) => offer(safe, revokes(safe), { safeTxHash: `0x${'12'.repeat(32)}` as Hex })],
    ['no safeTx (an operator older than the check)', (safe: Address) => offer(safe, revokes(safe), { safeTx: undefined })],
  ])('%s: refused (BUILD_MISMATCH), nothing to sign', async (_why, prepare) => {
    const res = await stopPrepare(prepare)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('BUILD_MISMATCH')
  })

  test('a swap back with a minimum out near the Worker quote: passed on; far under it (a sandwich): refused', async () => {
    expect((await stopPrepare((safe) => offer(safe, [...revokes(safe), ...swapBack(safe, (QUOTE * 995n) / 1000n)]))).status).toBe(200)
    const res = await stopPrepare((safe) => offer(safe, [...revokes(safe), ...swapBack(safe, QUOTE / 2n)]))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('BUILD_MISMATCH')
  })

  test('a Stop the Safe pays for: up to three times the chain gas price passed on, above it refused', async () => {
    const refund = (gasPrice: bigint) => ({ safeTxGas: 4_000_000n, baseGas: 120_000n, gasPrice, refundReceiver: RELAYER })
    expect((await stopPrepare((safe) => offer(safe, revokes(safe), {}, refund(GAS_PRICE * 2n)))).status).toBe(200)
    expect((await stopPrepare((safe) => offer(safe, revokes(safe), {}, refund(GAS_PRICE * 3n + 1n)))).status).toBe(502)
  })

  test('a swap back with no chain to read (no provider, or every one down): 503 STOP_CHECK_UNAVAILABLE; a Stop that needs no read still passes', async () => {
    for (const chain of [{ rpc: '' }, { up: false }]) {
      const res = await stopPrepare((safe) => offer(safe, [...revokes(safe), ...swapBack(safe, QUOTE)]), chain)
      expect(res.status).toBe(503)
      expect(((await res.json()) as { code: string }).code).toBe('STOP_CHECK_UNAVAILABLE')
      expect((await stopPrepare((safe) => offer(safe, revokes(safe)), chain)).status).toBe(200)
    }
  })
})
