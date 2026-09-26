// Read-only: rebuilds an account's activation batch and simulates each inner call from the Safe on real Base.
import { createPublicClient, http, toHex, decodeErrorResult, type Hex } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'
import { POLICIES, computeCaps, grantKey, instantiateGrant } from '@mamoru/policy'
import { LIVE_CAP_USDC, activationBatch, liveAccountFromContext } from '@mamoru/account/live'
import { simulateCalls } from '@mamoru/rpc'
import { priceOf, readSafe } from '../src/chain.ts'

const acc = JSON.parse(await Bun.file(process.argv[2]!).text())
const policyId = process.argv[3] ?? 'conservador-live-v2'
const policy = (POLICIES as any)[policyId] ?? Object.values(POLICIES as any).find((p: any) => p.id === policyId)
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) }) as any
const live = liveAccountFromContext(acc.ctx)
const r = await readSafe(client, live.safe)
const prices = Object.fromEntries([...new Set(['pool:USDC/cbBTC/500', ...policy.buckets.flatMap((b: any) => b.pools)])].map((pool: any) => { const pr = priceOf(pool, r.prices[pool]!.sqrtPriceX96); return [pr.asset, { num: pr.num, den: pr.den }] }))
const caps = computeCaps(policy, LIVE_CAP_USDC, prices)
const t = Number((await client.getBlock({ blockNumber: r.block })).timestamp)
const sessionKey = privateKeyToAccount(acc.sessionKey).address
const keys = policy.session.grants.filter((g: any) => !g.perPosition).map(grantKey)
const grants = keys.map((key: string) => instantiateGrant(policy, key, { account: live.safe, sessionKey, chainId: 8453, salt: toHex(randomBytes(32)), validAfter: t - 60, validUntil: t + policy.session.validitySeconds, caps, admittedTokenIds: [] }))
const only = process.env.ONLY ? process.env.ONLY.split(',') : null
const sel = only ? grants.filter((_: any, i: number) => only.some((o) => keys[i].startsWith(o))) : grants
const batch = activationBatch(live, sel, acc.revoked, { trust: !acc.trusted })
console.log('keys', only ? keys.filter((k: string) => only.some((o) => k.startsWith(o))) : keys, 'calls', batch.calls.length, 'sizes', batch.calls.map((c) => (c.data.length - 2) / 2))
const res = await simulateCalls(client, batch.calls.map((c) => ({ from: live.safe, to: c.to, data: c.data })), r.block)
res.forEach((x, i) => console.log(i, batch.calls[i]!.to, x.status, x.gasUsed, x.error ?? '', x.status === 'reverted' ? x.returnData.slice(0, 200) : ''))

// Whole batch as one real-Base estimateGas: the Safe's code is swapped for MultiSendCallOnly (state override), so the
// batch runs as the Safe's delegatecall would, under the node's per-tx gas cap.
import { multiSendCallOnly } from '@mamoru/account/safe'
const ms = multiSendCallOnly(batch.calls)
const msCode = await client.getCode({ address: ms.to })
try {
  const g = await client.request({ method: 'eth_estimateGas', params: [{ from: '0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0', to: live.safe, data: ms.data }, 'latest', { [live.safe]: { code: msCode } }] as never })
  console.log('batch estimateGas', BigInt(g as string), 'cap 16777216')
} catch (e) { console.log('batch estimateGas FAILS', (e as Error).message.split('\n')[0]) }
