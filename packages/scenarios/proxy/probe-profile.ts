// otto/mamoru#273: refresh packages/scenarios/proxy/profiles/<chain>.json from the live public endpoints. Read-only:
// eth_blockNumber, simulations of a harmless call, eth_getLogs ranges, reads past the head. Sends no
// transaction. Writes nothing when any endpoint cannot be reached.
//   bun run scenarios:probe-profile [monad] [--dry]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChainProfile, EndpointProfile, RpcError } from './emulate.ts'

export const MONAD_ENDPOINTS: Record<string, string> = {
  'rpc.monad.xyz': 'https://rpc.monad.xyz',
  'rpc1.monad.xyz': 'https://rpc1.monad.xyz',
  'rpc3.monad.xyz': 'https://rpc3.monad.xyz',
  monadinfra: 'https://rpc-mainnet.monadinfra.com',
  drpc: 'https://monad-mainnet.drpc.org',
}

const EOA = '0x0000000000000000000000000000000000000001'
const TO = '0x0000000000000000000000000000000000000002'
const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' // a contract: has code
const SPANS = [0, 9, 10, 50, 99, 100, 101, 128, 500, 1000, 2000, 10_000]
const GAS = '0x7530'

type Rpc = (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: RpcError }>

function rpcOf(url: string): Rpc {
  let n = 0
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      await Bun.sleep(150)
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (mamoru-probe)' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }), signal: AbortSignal.timeout(20_000) })
      if (res.status === 429 && attempt < 4) {
        await Bun.sleep(1000 * (attempt + 1))
        continue
      }
      try {
        return (await res.json()) as { result?: unknown; error?: RpcError }
      } catch {
        throw new Error(`${method}: HTTP ${res.status}, not JSON`)
      }
    }
  }
}

const err = (e: RpcError): RpcError => ({ code: e.code, message: e.message })
const simulate = (rpc: Rpc, from: string, extra: Record<string, unknown> = {}) =>
  rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ from, to: TO, gas: GAS }] }], ...extra }, 'latest'])

export async function probeEndpoint(rpc: Rpc): Promise<EndpointProfile> {
  const bn = await rpc('eth_blockNumber', [])
  if (typeof bn.result !== 'string') throw new Error(`eth_blockNumber: ${JSON.stringify(bn.error ?? bn)}`)
  const head = Number(BigInt(bn.result))
  const ep: EndpointProfile = { refusedMethods: {}, refusedParams: [], simulateGasUsedIsLimit: false, simulateSenderNotEoa: null, getLogs: null, unknownBlock: null }

  const sim = await simulate(rpc, EOA)
  if (sim.error) ep.refusedMethods.eth_simulateV1 = err(sim.error)
  else {
    const blk = (sim.result as { calls?: { gasUsed?: string }[] }[] | undefined)?.[0]
    ep.simulateGasUsedIsLimit = blk?.calls?.[0]?.gasUsed === GAS
    const noEoa = await simulate(rpc, WMON)
    if (noEoa.error) ep.simulateSenderNotEoa = err(noEoa.error)
    const val = await simulate(rpc, EOA, { validation: false })
    if (val.error) ep.refusedParams.push({ method: 'eth_simulateV1', path: [0, 'validation'], equals: false, error: err(val.error) })
  }

  const from = head - 2000
  for (const span of SPANS) {
    const r = await rpc('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${(from + span).toString(16)}`, address: TO }])
    if (r.error) {
      ep.getLogs = { maxSpan: SPANS[SPANS.indexOf(span) - 1] ?? 0, error: err(r.error) }
      break
    }
  }

  const future = await rpc('eth_getCode', [WMON, `0x${(head + 5000).toString(16)}`])
  if (future.error) ep.unknownBlock = err(future.error)
  return ep
}

export async function probeChain(chain: string, endpoints: Record<string, string>, now = new Date()): Promise<ChainProfile> {
  const out: ChainProfile = { chain, recordedAt: now.toISOString().slice(0, 10), endpoints: {} }
  for (const [name, url] of Object.entries(endpoints)) {
    try {
      out.endpoints[name] = await probeEndpoint(rpcOf(url))
    } catch (e) {
      throw new Error(`probe ${name} failed, profile not written: ${e instanceof Error ? e.message : e}`)
    }
  }
  return out
}

if (import.meta.main) {
  const chain = Bun.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'monad'
  if (chain !== 'monad') throw new Error(`no endpoint list for ${chain}`)
  const profile = await probeChain(chain, MONAD_ENDPOINTS)
  const json = `${JSON.stringify(profile, null, 2)}\n`
  if (Bun.argv.includes('--dry')) console.log(json)
  else {
    writeFileSync(join(import.meta.dir, 'profiles', `${chain}.json`), json)
    console.log(`profile ${chain} recorded ${profile.recordedAt}: ${Object.keys(profile.endpoints).join(', ')}`)
  }
}
