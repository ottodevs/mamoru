import { parseArgs } from 'node:util'
import { createPublicClient, http, isHash, parseAbi, type Address, type PublicClient } from 'viem'
import { address, readCodeHash, type Registry, type RegistryEntry } from '../src/index.ts'

/**
 * Pins or verifies a chain registry against a public RPC. Read-only: no key, no signing.
 *
 *   bun packages/registry/scripts/pin.ts monad --rpc https://rpc.monad.xyz          verify
 *   bun packages/registry/scripts/pin.ts monad --rpc https://rpc.monad.xyz --pin    re-pin block, blockHash and codeHash
 *
 * Verify reads every entry's code at the pinned block and compares it with the stored codeHash.
 * Pin picks a block (--block N, else latest - 64), reads every code hash there and rewrites the file.
 * Both modes refuse a RPC on another chain id and run the shape checks: symbol()/decimals() on tokens,
 * factory()/WETH9() on the Uniswap periphery, token0/token1/fee/tickSpacing and factory.getPool on pools.
 * No address enters a registry without these reads.
 */

const abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function factory() view returns (address)',
  'function WETH9() view returns (address)',
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
])

type Problem = { name: string; check: string; expected: string; actual: string }

async function read<T>(client: PublicClient, addr: Address, functionName: string, blockNumber: bigint, args: unknown[] = []): Promise<T> {
  return (await client.readContract({ address: addr, abi, functionName: functionName as never, args: args as never, blockNumber })) as T
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

async function checkShape(client: PublicClient, registry: Registry, e: RegistryEntry, block: bigint, problems: Problem[]): Promise<void> {
  const expect = (check: string, expected: string | number, actual: string | number) => {
    const ok = typeof expected === 'string' && typeof actual === 'string' ? same(expected, actual) : expected === actual
    if (!ok) problems.push({ name: e.name, check, expected: String(expected), actual: String(actual) })
  }
  if (e.kind === 'token') {
    expect('symbol()', e.name, await read<string>(client, e.address, 'symbol', block))
    expect('decimals()', e.decimals ?? NaN, await read<number>(client, e.address, 'decimals', block))
  }
  if (e.kind === 'uniswap' && e.name !== 'UniswapV3Factory') {
    expect('factory()', address('UniswapV3Factory', registry), await read<Address>(client, e.address, 'factory', block))
    const weth9 = await read<Address>(client, e.address, 'WETH9', block)
    const wrapped = registry.entries.find((t) => t.kind === 'token' && t.decimals === 18 && same(t.address, weth9))
    if (!wrapped) problems.push({ name: e.name, check: 'WETH9()', expected: 'a wrapped-native token entry with 18 decimals', actual: weth9 })
  }
  if (e.kind === 'pool') {
    const token0 = address(e.token0 ?? '', registry)
    const token1 = address(e.token1 ?? '', registry)
    expect('token0()', token0, await read<Address>(client, e.address, 'token0', block))
    expect('token1()', token1, await read<Address>(client, e.address, 'token1', block))
    expect('fee()', e.fee ?? NaN, await read<number>(client, e.address, 'fee', block))
    expect('tickSpacing()', e.tickSpacing ?? NaN, await read<number>(client, e.address, 'tickSpacing', block))
    const factory = address('UniswapV3Factory', registry)
    expect('factory.getPool()', e.address, await read<Address>(client, factory, 'getPool', block, [token0, token1, e.fee]))
  }
}

export async function pinOrVerify(input: { path: string; rpc: string; pin: boolean; block?: bigint }): Promise<void> {
  const json = (await Bun.file(input.path).json()) as Registry
  const client = createPublicClient({ transport: http(input.rpc) })
  const chainId = await client.getChainId()
  if (chainId !== json.chainId) throw new Error(`rpc answered chain id ${chainId}, ${json.chain}.json is ${json.chainId}`)

  let block = BigInt(json.block)
  if (input.pin) block = input.block ?? (await client.getBlockNumber()) - 64n
  const header = await client.getBlock({ blockNumber: block })
  if (header.number !== block) throw new Error(`asked for block ${block}, rpc answered block ${header.number}, ${json.chain}.json not written`)
  if (!header.hash || !isHash(header.hash)) throw new Error(`block ${block} has no valid hash (${header.hash}), ${json.chain}.json not written`)
  if (!input.pin && header.hash !== json.blockHash) {
    throw new Error(`block ${block} hash is ${header.hash}, ${json.chain}.json pins ${json.blockHash}`)
  }

  const problems: Problem[] = []
  const registry: Registry = { ...json, block: Number(block), blockHash: header.hash }
  for (const e of registry.entries) {
    const hash = await readCodeHash(client, e.address, block)
    if (!hash) {
      problems.push({ name: e.name, check: 'code', expected: 'code at ' + block, actual: 'none' })
      continue
    }
    if (input.pin) e.codeHash = hash
    else if (hash !== e.codeHash) problems.push({ name: e.name, check: 'codeHash', expected: e.codeHash ?? 'null', actual: hash })
    await checkShape(client, registry, e, block, problems)
    console.log(`${input.pin ? 'pinned' : 'ok'} ${e.name} ${e.address} ${hash}`)
  }
  for (const p of problems) console.error(`FAIL ${p.name} ${p.check}: expected ${p.expected}, got ${p.actual}`)
  if (problems.length > 0) throw new Error(`${problems.length} check(s) failed, ${json.chain}.json not written`)

  if (input.pin) {
    await Bun.write(input.path, JSON.stringify(registry, null, 2) + '\n')
    console.log(`pinned ${registry.entries.length} entries at block ${block} ${header.hash} (${registry.chain}, chain id ${registry.chainId})`)
  } else {
    console.log(`verified ${registry.entries.length} entries at block ${block} (${registry.chain}, chain id ${registry.chainId})`)
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: { rpc: { type: 'string' }, pin: { type: 'boolean', default: false }, block: { type: 'string' } },
  })
  const chain = positionals[0]
  if (!chain || !values.rpc) {
    console.error('usage: bun packages/registry/scripts/pin.ts <chain> --rpc <url> [--pin] [--block N]')
    process.exit(2)
  }
  const path = new URL(`../${chain}.json`, import.meta.url).pathname
  if (!(await Bun.file(path).exists())) {
    console.error(`no registry at ${path}`)
    process.exit(2)
  }
  await pinOrVerify({ path, rpc: values.rpc, pin: values.pin, block: values.block === undefined ? undefined : BigInt(values.block) })
}
