import { createPublicClient, http, type PublicClient } from 'viem'
import { FORBIDDEN_LAB_CHAIN_IDS, ReasonError, type Hex } from '@mamoru/domain'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export type AnvilPin = { version: string; commit: string; slotsInAnEpoch: number }

export type AnvilOptions = {
  forkUrl: string
  forkBlock: number | undefined
  chainId: number
  slotsInAnEpoch: number
  logPath: string
  /** LAB-08 a: an EVM hardfork without the RIP-7212 precompile. Default: anvil's latest. */
  hardfork?: string
}

export type AnvilHandle = {
  url: string
  port: number
  pid: number
  argv: string[]
  client: PublicClient
  stop: () => Promise<void>
}

export function assertLabChainId(chainId: number): void {
  if (FORBIDDEN_LAB_CHAIN_IDS.includes(chainId)) {
    throw new ReasonError('LAB_CHAIN_ID_FORBIDDEN', `chain id ${chainId}`)
  }
}

export function assertForkBlock(block: number | undefined): asserts block is number {
  if (block === undefined || block === null || !Number.isInteger(block) || block <= 0) {
    throw new ReasonError('LAB_BLOCK_REQUIRED')
  }
}

/**
 * LAB-06 / FR-LAB-007: no argument may carry a keyed URL. Only loopback URLs
 * without credentials or query strings are accepted, and the value of every
 * secret environment variable is refused outright.
 */
export function assertNoKeyInArgv(argv: string[], secretEnvVars: string[] = ['RPC_URL']): void {
  const secrets = secretEnvVars.map((v) => process.env[v]).filter((v): v is string => !!v)
  for (const arg of argv) {
    for (const s of secrets) {
      if (arg.includes(s)) throw new ReasonError('LAB_KEY_IN_ARGV', 'argument carries a secret environment value')
    }
    const urls = arg.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi) ?? []
    for (const raw of urls) {
      let u: URL
      try {
        u = new URL(raw)
      } catch {
        throw new ReasonError('LAB_KEY_IN_ARGV', 'unparseable URL in argument')
      }
      if (!LOOPBACK_HOSTS.has(u.hostname) || u.username || u.password || u.search || u.pathname.length > 1) {
        throw new ReasonError('LAB_KEY_IN_ARGV', 'argument carries a non-loopback or keyed URL')
      }
    }
  }
}

export function anvilArgv(opts: AnvilOptions, port: number): string[] {
  assertForkBlock(opts.forkBlock)
  assertLabChainId(opts.chainId)
  const argv = [
    '--fork-url',
    opts.forkUrl,
    '--fork-block-number',
    String(opts.forkBlock),
    '--chain-id',
    String(opts.chainId),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--slots-in-an-epoch',
    String(opts.slotsInAnEpoch),
    '--no-request-size-limit',
    ...(opts.hardfork ? ['--hardfork', opts.hardfork] : []),
  ]
  assertNoKeyInArgv(argv)
  return argv
}

export function anvilBinary(): string {
  const bin = Bun.which('anvil')
  if (!bin) throw new Error('anvil is not on PATH')
  return bin
}

/** Reads `anvil --version` from the binary that the runner will start. */
export async function anvilBinaryVersion(): Promise<{ version: string; commit: string }> {
  const proc = Bun.spawn([anvilBinary(), '--version'], { stdout: 'pipe', stderr: 'pipe', env: sanitizedEnv() })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const version = out.match(/Version:\s*([^\s]+)/)?.[1] ?? out.match(/anvil\s+([0-9][^\s]*)/)?.[1]
  const commit = out.match(/Commit SHA:\s*([0-9a-f]+)/)?.[1] ?? ''
  if (!version) throw new Error('cannot read anvil version')
  return { version, commit }
}

export function assertAnvilVersion(pin: AnvilPin, actual: { version: string; commit: string }): void {
  if (actual.version !== pin.version || (pin.commit && actual.commit !== pin.commit)) {
    throw new ReasonError('LAB_ANVIL_VERSION_MISMATCH', `pinned ${pin.version} (${pin.commit}), found ${actual.version} (${actual.commit})`)
  }
}

/** The child environment never carries the upstream RPC URL. */
export function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR']) {
    const v = process.env[k]
    if (v) env[k] = v
  }
  return env
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const p = s.port as number
  s.stop(true)
  return p
}

export async function startAnvil(opts: AnvilOptions): Promise<AnvilHandle> {
  const port = await freePort()
  const argv = anvilArgv(opts, port)
  const log = Bun.file(opts.logPath)
  const proc = Bun.spawn([anvilBinary(), ...argv], { stdout: log, stderr: log, env: sanitizedEnv() })
  const url = `http://127.0.0.1:${port}/`
  const client = createPublicClient({ transport: http(url, { timeout: 120_000 }) })
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      await client.request({ method: 'eth_chainId' })
      break
    } catch {
      if (proc.exitCode !== null) throw new Error(`anvil exited early with code ${proc.exitCode}`)
      if (Date.now() > deadline) {
        proc.kill()
        throw new Error('anvil did not start in time')
      }
      await Bun.sleep(200)
    }
  }
  return {
    url,
    port,
    pid: proc.pid,
    argv,
    client,
    stop: async () => {
      proc.kill()
      await proc.exited
    },
  }
}

export type PostStartFacts = {
  chainId: number
  blockHash: Hex
  clientVersion: string
}

/** Checks right after start: chain id, fork block hash and anvil version as served over RPC. */
export async function postStartChecks(
  client: PublicClient,
  expected: { chainId: number; block: number; blockHash: Hex; anvil: AnvilPin },
): Promise<PostStartFacts> {
  const chainIdHex = (await client.request({ method: 'eth_chainId' })) as Hex
  const chainId = Number(BigInt(chainIdHex))
  if (FORBIDDEN_LAB_CHAIN_IDS.includes(chainId) || chainId !== expected.chainId) {
    throw new ReasonError('LAB_CHAIN_ID_FORBIDDEN', `rpc answered chain id ${chainId}, scenario expects ${expected.chainId}`)
  }
  const block = await client.getBlock({ blockNumber: BigInt(expected.block) })
  if (block.hash !== expected.blockHash) {
    throw new ReasonError('LAB_BLOCK_HASH_MISMATCH', `block ${expected.block}`)
  }
  const clientVersion = (await client.request({ method: 'web3_clientVersion' as never })) as string
  const served = clientVersion.match(/anvil\/v?([^\s/]+)/)?.[1]
  if (served !== expected.anvil.version) {
    throw new ReasonError('LAB_ANVIL_VERSION_MISMATCH', `rpc reports ${clientVersion}`)
  }
  const simulated = await (client.request({ method: 'eth_simulateV1' as never, params: [{ blockStateCalls: [{ calls: [] }] }, 'latest'] as never }) as Promise<unknown>).then(
    (r) => Array.isArray(r) && r.length === 1,
    () => false,
  )
  if (!simulated) throw new ReasonError('LAB_SIMULATE_UNAVAILABLE', 'eth_simulateV1 is not served')
  return { chainId, blockHash: block.hash, clientVersion }
}
