// MB-01/MB-02 style evidence, read only: deployment status, contract indexing status, one contrasted pool range,
// MBQ-07 aggregates and the events of one transaction. Prints JSON without URLs or keys.
// Run: set -a; . ~/.config/mamoru/multibaas.env; . ~/.config/mamoru/alchemy.env; set +a; bun run --cwd apps/mamoru-engine mb:probe [blocks]
import { LINKED, MultiBaasClient, MultiBaasError, mbq07SwapAggregates, poolActivity } from '@mamoru/multibaas'
import { address } from '@mamoru/registry'
import { makeClient, publicTransport } from '../src/sync/client.ts'
import { readPoolEvents } from '../src/sync/logs.ts'
import { mbKey, rpcKey } from '../src/sync/multibaas-index.ts'

const { MULTIBAAS_URL, MULTIBAAS_API_KEY } = process.env
if (!MULTIBAAS_URL || !MULTIBAAS_API_KEY) throw new Error('MULTIBAAS_URL and MULTIBAAS_API_KEY are required')
const span = Number(process.argv[2] ?? 300)
const mb = new MultiBaasClient({ url: MULTIBAAS_URL, apiKey: MULTIBAAS_API_KEY })
const rpc = makeClient(publicTransport({ BASE_RPC_PUBLIC: 'https://mainnet.base.org' }))
const failed = (e: unknown) => (e instanceof MultiBaasError ? { code: e.code, httpStatus: e.httpStatus } : { code: 'MB_QUERY_FAILED' })

const evidence: Record<string, unknown> = { at: new Date().toISOString() }
const chain = await mb.chainStatus()
evidence.deployment = { chainID: chain.chainID, blockNumber: chain.blockNumber, base: chain.chainID === 8453 ? 'MB_BASE_INDEXING_OK' : 'MB_BASE_INDEXING_ABSENT' }

const contracts: Record<string, unknown> = {}
for (const [name, link] of Object.entries(LINKED)) {
  contracts[link.alias] = await mb.contractStatus(link.alias, link.label).then((s) => ({ name, label: link.label, ...s }), (e) => ({ name, label: link.label, ...failed(e) }))
}
evidence.contracts = contracts

const pool = address('pool:USDC/cbBTC/500')
const safe = Number((await rpc.getBlock({ blockTag: 'safe' })).number)
const from = safe - span + 1
const rows = await mb.query(poolActivity(pool, from, safe))
const { events } = await readPoolEvents(rpc, pool, from, safe)
const first = rows.length ? Math.min(...rows.map((r) => Number(r.block))) : null
const counts = new Map<string, number>()
for (const r of rows) {
  const k = mbKey(r)
  if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
}
let reconciled = 0
let rpcOnly = 0
let beforeFirst = 0
for (const e of events) {
  const k = rpcKey(e)
  const n = counts.get(k) ?? 0
  if (n > 0) {
    counts.set(k, n - 1)
    reconciled++
  } else if (first === null || e.block < first) beforeFirst++
  else rpcOnly++
}
const mbOnly = [...counts.values()].reduce((a, b) => a + b, 0)
evidence.poolRange = {
  pool: 'pool:USDC/cbBTC/500', from, to: safe, mbRows: rows.length, rpcRows: events.length, firstIndexedBlock: first,
  reconciled, rpcOnlyAfterFirstIndexed: rpcOnly, rpcBeforeFirstIndexed: beforeFirst, mbOnly,
  code: rpcOnly === 0 && mbOnly === 0 ? 'PROJ_RECONCILED' : 'MB_QUERY_MISMATCH',
}

const swaps = events.filter((e) => e.kind === 'swap')
const aggFrom = first ?? from
const inAgg = swaps.filter((s) => s.block >= aggFrom)
const computed = {
  tickMin: inAgg.length ? Math.min(...inAgg.map((s) => s.tick)) : null,
  tickMax: inAgg.length ? Math.max(...inAgg.map((s) => s.tick)) : null,
  volume0: inAgg.reduce((a, s) => (s.amount0 > 0n ? a + s.amount0 : a), 0n).toString(),
  volume1: inAgg.reduce((a, s) => (s.amount1 > 0n ? a + s.amount1 : a), 0n).toString(),
}
try {
  const agg = await Promise.all(mbq07SwapAggregates(pool, aggFrom, safe).map((q) => mb.query(q)))
  evidence.mbq07 = { from: aggFrom, to: safe, multibaas: Object.assign({}, ...agg.map((r) => r[0] ?? {})), computed }
} catch (e) {
  evidence.mbq07 = { from: aggFrom, to: safe, ...failed(e), computed }
}

const tx = swaps.at(-1)?.txHash
if (tx) {
  evidence.mbq06 = await mb.txEvents(tx).then(
    (evs) => ({ txHash: tx, events: evs.map((e) => ({ name: e.event.name, indexInLog: e.event.indexInLog, contract: e.event.contract.alias ?? e.event.contract.label })) }),
    (e) => ({ txHash: tx, ...failed(e) }),
  )
}
evidence.multibaasCalls = mb.requests
console.log(JSON.stringify(evidence, null, 2))
