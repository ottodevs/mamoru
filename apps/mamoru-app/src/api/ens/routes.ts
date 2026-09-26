import { Hono } from 'hono'
import { createPublicClient, fallback, http } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import type { AppEnv } from '../context.ts'
import { apiError } from '../errors.ts'

// Mainnet RPC pool for ENS; tried in order, the next one on any failure.
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://cloudflare-eth.com']
const client = createPublicClient({ chain: mainnet, transport: fallback(RPCS.map((u) => http(u, { timeout: 8_000, retryCount: 1 }))) })

// GET /api/ens?name=alice.eth -> { name, address } ; public, read-only.
export const ens = new Hono<AppEnv>()
ens.get('/', async (c) => {
  const raw = (c.req.query('name') ?? '').trim()
  if (!/^[^\s.]{1,64}(\.[^\s.]{1,64}){1,4}$/.test(raw)) return apiError(c, 400, 'Enter a name like alice.eth.', 'INTENT_REJECTED_STATE')
  let name: string
  try {
    name = normalize(raw)
  } catch {
    return apiError(c, 400, 'This is not a valid name.', 'INTENT_REJECTED_STATE')
  }
  try {
    const address = await client.getEnsAddress({ name })
    return c.json({ name, address: address ?? null }, 200, { 'cache-control': 'public, max-age=60' })
  } catch (e) {
    console.error('ens resolve failed', e instanceof Error ? e.message.slice(0, 200) : String(e))
    return apiError(c, 503, 'Could not reach the name service. Try again.', 'OPERATOR_UNAVAILABLE')
  }
})
