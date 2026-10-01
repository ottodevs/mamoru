import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import { pinOrVerify } from './pin.ts'

const CHAIN_ID = 143
const CODE = '0x6001600155'
const HASH_100 = `0x${'a1'.repeat(32)}`
const OLD_HASH = `0x${'0f'.repeat(32)}`
const OLD_CODE_HASH = `0x${'0e'.repeat(32)}`

type Rpc = { chainId?: number; header?: (asked: number) => { number: string | null; hash: string | null }; code?: string }

/** A JSON-RPC endpoint on loopback that answers only what pin.ts reads. */
function serve(rpc: Rpc) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const { id, method, params } = (await req.json()) as { id: number; method: string; params: unknown[] }
      const answer = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result })
      if (method === 'eth_chainId') return answer(`0x${(rpc.chainId ?? CHAIN_ID).toString(16)}`)
      if (method === 'eth_blockNumber') return answer('0x400')
      if (method === 'eth_getBlockByNumber') {
        const asked = Number(BigInt(params[0] as string))
        const header = rpc.header?.(asked) ?? { number: `0x${asked.toString(16)}`, hash: HASH_100 }
        return answer({ ...header, transactions: [] })
      }
      if (method === 'eth_getCode') return answer(rpc.code ?? CODE)
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } })
    },
  })
}

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

async function setup(rpc: Rpc): Promise<{ path: string; url: string; before: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'registry-pin-'))
  const path = join(dir, 'test.json')
  const before =
    JSON.stringify(
      {
        chain: 'test',
        chainId: CHAIN_ID,
        block: 7,
        blockHash: OLD_HASH,
        entries: [{ name: 'Multicall3', kind: 'read', role: 'reads', address: '0xcA11bde05977b3631167028862bE2a173976CA11', codeHash: OLD_CODE_HASH }],
      },
      null,
      2,
    ) + '\n'
  await Bun.write(path, before)
  const server = serve(rpc)
  cleanup.push(() => server.stop(true), () => rm(dir, { recursive: true, force: true }))
  return { path, url: `http://127.0.0.1:${server.port}`, before }
}

describe('pin mode never writes from a bad read', () => {
  test('a good read pins block, block hash and code hash', async () => {
    const { path, url } = await setup({})
    await pinOrVerify({ path, rpc: url, pin: true, block: 100n })
    const after = await Bun.file(path).json()
    expect(after.block).toBe(100)
    expect(after.blockHash).toBe(HASH_100)
    expect(after.entries[0].codeHash).toBe(keccak256(CODE))
  })

  test('a header for another block leaves the file untouched', async () => {
    const { path, url, before } = await setup({ header: () => ({ number: '0x65', hash: HASH_100 }) })
    await expect(pinOrVerify({ path, rpc: url, pin: true, block: 100n })).rejects.toThrow('rpc answered block 101')
    expect(await Bun.file(path).text()).toBe(before)
  })

  test('a header without a hash leaves the file untouched', async () => {
    const { path, url, before } = await setup({ header: (n) => ({ number: `0x${n.toString(16)}`, hash: null }) })
    await expect(pinOrVerify({ path, rpc: url, pin: true, block: 100n })).rejects.toThrow('no valid hash')
    expect(await Bun.file(path).text()).toBe(before)
  })

  test('a malformed hash leaves the file untouched', async () => {
    const { path, url, before } = await setup({ header: (n) => ({ number: `0x${n.toString(16)}`, hash: '0x1234' }) })
    await expect(pinOrVerify({ path, rpc: url, pin: true, block: 100n })).rejects.toThrow('no valid hash')
    expect(await Bun.file(path).text()).toBe(before)
  })

  test('a rpc on another chain id leaves the file untouched', async () => {
    const { path, url, before } = await setup({ chainId: 8453 })
    await expect(pinOrVerify({ path, rpc: url, pin: true, block: 100n })).rejects.toThrow('rpc answered chain id 8453')
    expect(await Bun.file(path).text()).toBe(before)
  })

  test('an address without code leaves the file untouched', async () => {
    const { path, url, before } = await setup({ code: '0x' })
    await expect(pinOrVerify({ path, rpc: url, pin: true, block: 100n })).rejects.toThrow('not written')
    expect(await Bun.file(path).text()).toBe(before)
  })
})
