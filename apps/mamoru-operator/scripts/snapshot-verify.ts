// Read-only check of the snapshot's fee math against the chain (otto/mamoru#136).
// Reads one snapshot of the operator's active and armed Safes, then simulates collect(max) from each Safe for every
// position at the same block and prints both numbers. Nothing is sent. Uses a public Base RPC by default so it
// spends none of the keyed providers' budget.
//
//   bun apps/mamoru-operator/scripts/snapshot-verify.ts [--rpc <url>] [--state <accounts.json>] [--json <out>]

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { address, baseRegistry, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import { MULTICALL3 } from '@mamoru/rpc'
import { readSnapshot, type SnapshotTarget } from '../src/snapshot.ts'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const rpc = arg('--rpc') ?? 'https://mainnet.base.org'
const statePath = arg('--state') ?? join(homedir(), '.local/state/mamoru-operator/accounts.json')
const out = arg('--json')

const raw = JSON.parse(readFileSync(statePath, 'utf8'))
const accounts: any[] = Array.isArray(raw) ? raw : Object.values(raw.accounts ?? raw)
const targets: SnapshotTarget[] = accounts.filter((a) => a.active || a.armed).map((a) => ({ accountKey: a.accountKey, safe: a.ctx.address, active: !!a.active, armed: !!a.armed }))

const client = createPublicClient({ chain: base, transport: http(rpc, { timeout: 60_000 }) })
if (!MULTICALL3) throw new Error('no Multicall3 in the registry')
const t0 = Date.now()
const snap = await readSnapshot(client, MULTICALL3, base.id, targets)
console.log(`snapshot block ${snap.block}: ${snap.safes.length} Safes, ${snap.safes.reduce((n, s) => n + s.positions.length, 0)} positions, ${snap.calls} requests, ${Date.now() - t0} ms`)

const MAX = (1n << 128n) - 1n
const rows: { account: string; tokenId: string; pool: string; collectable0: string; collectable1: string; accrued0: string; accrued1: string; sim0: string; sim1: string; match: boolean }[] = []
for (const s of snap.safes) {
  for (const p of s.positions) {
    const { result } = await client.simulateContract({
      address: address('NonfungiblePositionManager', baseRegistry),
      abi: nonfungiblePositionManagerAbi,
      functionName: 'collect',
      args: [{ tokenId: p.tokenId, recipient: s.safe, amount0Max: MAX, amount1Max: MAX }],
      account: s.safe,
      blockNumber: snap.block,
    })
    const [sim0, sim1] = result as readonly [bigint, bigint]
    const match = sim0 === p.collectable0 && sim1 === p.collectable1
    rows.push({ account: s.accountKey.slice(0, 8), tokenId: p.tokenId.toString(), pool: p.pool, collectable0: p.collectable0.toString(), collectable1: p.collectable1.toString(), accrued0: p.accrued0.toString(), accrued1: p.accrued1.toString(), sim0: sim0.toString(), sim1: sim1.toString(), match })
    console.log(`${match ? 'OK  ' : 'DIFF'} ${s.accountKey.slice(0, 8)} #${p.tokenId} ${p.pool} ours ${p.collectable0}/${p.collectable1} (accrued ${p.accrued0}/${p.accrued1}) collect ${sim0}/${sim1}`)
  }
  console.log(`     ${s.accountKey.slice(0, 8)} deployed=${s.deployed} idle ${s.idleUsdc} lp ${s.lpUsdc} fees ${s.feesUsdc} owed ${s.owedUsdc} total ${s.totalUsdc} (raw USDC, 6 decimals)`)
}
const bad = rows.filter((r) => !r.match).length
console.log(`${rows.length - bad}/${rows.length} positions match collect exactly`)
if (out) writeFileSync(out, JSON.stringify({ block: snap.block.toString(), rpc: new URL(rpc).host, rows }, null, 2))
process.exit(bad ? 1 : 0)
