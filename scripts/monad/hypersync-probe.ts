// otto/mamoru#397: how fast HyperSync backfills a Monad Safe's history against eth_getLogs in pages, and whether its answer
// matches the chain. Reads only; no key is printed.
//
//   ENVIO_API_TOKEN=... bun scripts/monad/hypersync-probe.ts --safe 0x... [--blocks 1000000] [--rpc https://rpc.monad.xyz]
//
// 1. HyperSync: every USDC Transfer to or from the Safe and every position NFT Transfer to it, over the last --blocks
//    blocks, following next_block until the range is covered. Time, requests, logs.
// 2. Trust: for a few sampled 100-block ranges that hold HyperSync logs, the same filter through eth_getLogs on --rpc. Every
//    log must match (block, tx hash, log index) both ways; any difference is printed and the exit code is 1.
// 3. Baseline: eth_getLogs in 100-block pages (QuickNode's cap on Monad) over a 20-page sample, extrapolated to --blocks.

import monad from '../../packages/registry/monad.json'

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const HYPERSYNC = 'https://monad.hypersync.xyz'
const RPC = arg('rpc', 'https://rpc.monad.xyz')!
const BLOCKS = BigInt(arg('blocks', '1000000')!)
const SAFE = arg('safe')?.toLowerCase()
const TOKEN = process.env.ENVIO_API_TOKEN
if (!SAFE || !/^0x[0-9a-f]{40}$/.test(SAFE)) throw new Error('--safe 0x... is required')
if (!TOKEN) throw new Error('ENVIO_API_TOKEN is not set (a free token: https://app.envio.dev/api-tokens)')

// Monad registry (packages/registry/monad.json): the addresses are read from it, never typed here.
const at = (name: string) => (monad.entries as { name: string; address: string }[]).find((e) => e.name === name)!.address.toLowerCase()
const USDC = at('USDC')
const NPM = at('NonfungiblePositionManager')
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const word = (a: string) => `0x${a.slice(2).padStart(64, '0')}`
const filters = [
  { address: [USDC], topics: [[TRANSFER], [], [word(SAFE)]] },
  { address: [USDC], topics: [[TRANSFER], [word(SAFE)]] },
  { address: [NPM], topics: [[TRANSFER], [], [word(SAFE)]] },
]

type Log = { block: number; tx: string; index: number }
const key = (l: Log) => `${l.block}:${l.tx}:${l.index}`

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = (await r.json()) as { result?: unknown; error?: { message: string } }
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

async function hypersync(from: bigint, to: bigint): Promise<{ logs: Log[]; requests: number; ms: number }> {
  const logs: Log[] = []
  let next = from
  let requests = 0
  const t0 = performance.now()
  while (next < to) {
    requests++
    const r = await fetch(`${HYPERSYNC}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ from_block: Number(next), to_block: Number(to), logs: filters, field_selection: { log: ['block_number', 'transaction_hash', 'log_index'] } }),
    })
    if (!r.ok) throw new Error(`hypersync HTTP ${r.status}`)
    const j = (await r.json()) as { data?: unknown; next_block?: number }
    const batches = (Array.isArray(j.data) ? j.data : [j.data]) as { logs?: { block_number: number; transaction_hash: string; log_index: number }[] }[]
    for (const b of batches) for (const l of b?.logs ?? []) logs.push({ block: Number(l.block_number), tx: l.transaction_hash.toLowerCase(), index: Number(l.log_index) })
    if (j.next_block === undefined || BigInt(j.next_block) <= next) throw new Error('hypersync: no progress')
    next = BigInt(j.next_block)
  }
  return { logs, requests, ms: performance.now() - t0 }
}

async function getLogs(from: bigint, to: bigint): Promise<Log[]> {
  const out: Log[] = []
  for (const f of filters) {
    const topics = f.topics.map((t) => (t.length ? t : null))
    const res = (await rpc('eth_getLogs', [{ address: f.address[0], topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }])) as { blockNumber: string; transactionHash: string; logIndex: string }[]
    for (const l of res) out.push({ block: Number(BigInt(l.blockNumber)), tx: l.transactionHash.toLowerCase(), index: Number(BigInt(l.logIndex)) })
  }
  return out
}

const head = BigInt((await rpc('eth_blockNumber', [])) as string) - 10n
const from = head > BLOCKS ? head - BLOCKS : 0n

const hs = await hypersync(from, head + 1n)
console.log(JSON.stringify({ step: 'hypersync', blocks: Number(head + 1n - from), requests: hs.requests, ms: Math.round(hs.ms), logs: hs.logs.length }))

// Trust: up to 5 ranges of 100 blocks around HyperSync logs, plus one with none.
const sample = [...new Set(hs.logs.map((l) => BigInt(l.block) - (BigInt(l.block) % 100n)))].slice(0, 5)
sample.push(from + (head - from) / 2n - (((from + (head - from) / 2n)) % 100n))
let mismatches = 0
for (const start of sample) {
  const end = start + 99n
  const chain = new Set((await getLogs(start, end)).map(key))
  const theirs = new Set(hs.logs.filter((l) => BigInt(l.block) >= start && BigInt(l.block) <= end).map(key))
  for (const k of chain) if (!theirs.has(k)) { mismatches++; console.log(JSON.stringify({ step: 'trust', missingFromHypersync: k })) }
  for (const k of theirs) if (!chain.has(k)) { mismatches++; console.log(JSON.stringify({ step: 'trust', notOnChain: k })) }
}
console.log(JSON.stringify({ step: 'trust', ranges: sample.length, mismatches }))

// Baseline: 20 pages of 100 blocks, all three filters, extrapolated.
const t0 = performance.now()
for (let i = 0n; i < 20n; i++) await getLogs(head - (i + 1n) * 100n + 1n, head - i * 100n)
const msPerPage = (performance.now() - t0) / 20
console.log(JSON.stringify({ step: 'getLogs', page: 100, msPerPage: Math.round(msPerPage), extrapolatedMs: Math.round((msPerPage * Number(head + 1n - from)) / 100), requestsExtrapolated: Math.ceil(Number(head + 1n - from) / 100) * filters.length }))
process.exit(mismatches ? 1 : 0)
