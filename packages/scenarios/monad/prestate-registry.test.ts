// otto/mamoru#365: the committed MONAD-01 prestate carries the pinned code of every Monad registry entry, as the
// operator's boot check (assertCodeHashes) reads it. A contract added to the registry without re-pinning the prestate
// (bun run scenarios:monad pin && bun run scenarios:monad run) fails here, in the PR, not weeks later in a fork run.
import { describe, expect, test } from 'bun:test'
import { keccak256, type Hex } from 'viem'
import { EIP1967_IMPLEMENTATION_SLOT, monadRegistry } from '@mamoru/registry'
import { repoPath } from '../runner/manifest.ts'
import { loadMonadManifest, PINNED_PRESTATE } from './harness.ts'

type Account = { code?: Hex; storage?: Record<string, Hex> }
const raw = Buffer.from(await Bun.file(repoPath(PINNED_PRESTATE)).arrayBuffer())
const state = JSON.parse(Buffer.from(Bun.gunzipSync(raw)).toString('utf8')) as { block: number; blockHash: Hex; accounts: Record<string, Account> }
const account = (a: string): Account | undefined => state.accounts[a.toLowerCase()]
const codeHash = (a: string): Hex | null => {
  const c = account(a)?.code
  return c && c !== '0x' ? keccak256(c) : null
}
// anvil dumps storage slots as 32-byte keys; the value's last 20 bytes are the implementation.
const slotOf = (a: string, slot: Hex): Hex | undefined => {
  const s = account(a)?.storage ?? {}
  const want = BigInt(slot)
  return Object.entries(s).find(([k]) => BigInt(k) === want)?.[1]
}

describe('MONAD-01 prestate against the Monad registry (otto/mamoru#365)', () => {
  test('the prestate is of the pinned block', async () => {
    const m = await loadMonadManifest()
    expect({ block: state.block, blockHash: state.blockHash }).toEqual({ block: m.fork.block, blockHash: m.fork.blockHash })
  })

  test('every registry entry has its pinned code (and a proxy its pinned implementation)', () => {
    const bad: string[] = []
    for (const e of monadRegistry.entries) {
      if (e.codeHash === null || codeHash(e.address) !== e.codeHash) bad.push(`${e.name} ${e.address}`)
      if (e.implementation) {
        const v = slotOf(e.address, EIP1967_IMPLEMENTATION_SLOT)
        if (!v || `0x${v.slice(-40)}`.toLowerCase() !== e.implementation.address.toLowerCase() || codeHash(e.implementation.address) !== e.implementation.codeHash) bad.push(`${e.name} implementation`)
      }
    }
    expect(bad, `not in the prestate as pinned: re-pin with bun run scenarios:monad pin && bun run scenarios:monad run`).toEqual([])
  })
})
