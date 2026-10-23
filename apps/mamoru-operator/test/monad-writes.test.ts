// otto/mamoru#61: writing to Monad is an explicit opt-in (MAMORU_CHAIN_WRITES=143). Off by default: an operator on
// chain 143 signs nothing. On: only on chain 143 itself, only with a Monad policy, only once the session policies are
// on the chain with Base's code; every Base-bound builder reads the chain's registry, and Base's output is unchanged.
import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData, toHex } from 'viem'
import { chainWritesOptIn, liveChainAllowed, ReasonError } from '@mamoru/domain'
import { address, baseRegistry, erc20Abi, monadRegistry } from '@mamoru/registry'
import { assertPolicyChain, labWmonUsdcMonadV1, liveWmonUsdcMonadV1, POLICIES, instantiateGrant } from '@mamoru/policy'
import { activationBatch, liveAccountFromContext, stopBatch, transferBatch } from '@mamoru/account/live'
import { toSmartSession } from '@mamoru/account/sessions'
import { liveSigningAllowed } from '@mamoru/journal'
import { LAB_GAS_LIMITS, TIGHT_CALL_GAS, tightUserOpGas } from '@mamoru/scenarios/driver/engine.ts'
import { assertWritePolicy, bootOperator, chainWritesFor, resolveNamedPolicy } from '../src/boot.ts'
import { nativePricePool, writeRefusal } from '../src/chain.ts'
import { relayerGasProfile } from '../src/relayer.ts'
import { MONAD_SPONSOR, monadSponsor, type SponsorPolicy } from '../src/sponsorship.ts'
import { operatorSignature } from '../src/server.ts'
import { ctx } from './owner-world.ts'

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    return e instanceof ReasonError ? e.code : (e as Error).message
  }
  return undefined
}

describe('MAMORU_CHAIN_WRITES', () => {
  test('unset or empty: no chain; 143: Monad; anything else refused, never ignored', () => {
    expect(chainWritesOptIn({})).toEqual([])
    expect(chainWritesOptIn({ MAMORU_CHAIN_WRITES: '' })).toEqual([])
    expect(chainWritesOptIn({ MAMORU_CHAIN_WRITES: '143' })).toEqual([143])
    expect(chainWritesOptIn({ MAMORU_CHAIN_WRITES: ' 143,143 ' })).toEqual([143])
    for (const bad of ['8453', '10143', '314143', 'monad', '143,8453']) expect(code(() => chainWritesOptIn({ MAMORU_CHAIN_WRITES: bad }))).toBe('CONFIG_MODE_INVALID')
  })

  test('live signing on 143 needs MAMORU_LIVE=1 and the opt-in; Base needs MAMORU_LIVE=1 as always', () => {
    expect(liveChainAllowed(143, { MAMORU_LIVE: '1' })).toBe(false)
    expect(liveChainAllowed(143, { MAMORU_CHAIN_WRITES: '143' })).toBe(false)
    expect(liveChainAllowed(143, { MAMORU_LIVE: '1', MAMORU_CHAIN_WRITES: '143' })).toBe(true)
    expect(liveChainAllowed(143, { MAMORU_LIVE: '1', MAMORU_CHAIN_WRITES: 'bogus' })).toBe(false)
    expect(liveChainAllowed(10143, { MAMORU_LIVE: '1', MAMORU_CHAIN_WRITES: '143' })).toBe(false)
    expect(liveChainAllowed(8453, { MAMORU_LIVE: '1' })).toBe(true)
    expect(liveChainAllowed(8453, {})).toBe(false)
    const env = { ...process.env }
    try {
      process.env.MAMORU_LIVE = '1'
      delete process.env.MAMORU_CHAIN_WRITES
      expect(liveSigningAllowed(143)).toBe(false)
      expect(liveSigningAllowed(8453)).toBe(true)
      process.env.MAMORU_CHAIN_WRITES = '143'
      expect(liveSigningAllowed(143)).toBe(true)
    } finally {
      process.env = env
    }
  })

  test('writeRefusal lifts only for the opted-in chain on its own chain id, never a lab fork id of it', () => {
    expect(writeRefusal(baseRegistry)).toBeNull()
    expect(writeRefusal(monadRegistry)).toContain('read only on monad')
    expect(writeRefusal(monadRegistry, { chainId: 143, optIn: [143] })).toBeNull()
    expect(writeRefusal(monadRegistry, { chainId: 314143, optIn: [143] })).toContain('read only')
    expect(writeRefusal(monadRegistry, { chainId: 143, optIn: [] })).toContain('read only')
  })

  test('chainWritesFor: off without the flag; with it, only on the chain it names', () => {
    expect(chainWritesFor(8453, baseRegistry, {})).toEqual({ on: false, optIn: [] })
    expect(chainWritesFor(143, monadRegistry, {})).toEqual({ on: false, optIn: [] })
    expect(chainWritesFor(143, monadRegistry, { MAMORU_CHAIN_WRITES: '143' })).toEqual({ on: true, optIn: [143] })
    expect(() => chainWritesFor(8453, baseRegistry, { MAMORU_CHAIN_WRITES: '143' })).toThrow('MAMORU_CHAIN_WRITES')
    expect(() => chainWritesFor(314143, monadRegistry, { MAMORU_CHAIN_WRITES: '143' })).toThrow('MAMORU_CHAIN_WRITES')
  })
})

describe('the Monad mainnet policy', () => {
  test('resolves only for an operator writing to Monad', () => {
    expect(resolveNamedPolicy('live-wmon-usdc-monad-v1', {})).toBeUndefined()
    expect(resolveNamedPolicy('live-wmon-usdc-monad-v1', {}, { chainWrites: true })).toBe(liveWmonUsdcMonadV1)
    expect(Object.keys(POLICIES)).not.toContain(liveWmonUsdcMonadV1.policyId)
  })

  test('signs on chain 143 only; the lab policy never does', () => {
    expect(() => assertPolicyChain(liveWmonUsdcMonadV1, 143)).not.toThrow()
    for (const id of [8453, 10143, 314143, 31337]) expect(code(() => assertPolicyChain(liveWmonUsdcMonadV1, id))).toBe('SIGN_CHAIN_NOT_ALLOWED')
    expect(code(() => assertPolicyChain(labWmonUsdcMonadV1, 143))).toBe('SIGN_CHAIN_NOT_ALLOWED')
    expect(() => assertWritePolicy(liveWmonUsdcMonadV1, monadRegistry, 143)).not.toThrow()
    expect(() => assertWritePolicy(labWmonUsdcMonadV1, monadRegistry, 143)).toThrow()
    expect(() => assertWritePolicy(POLICIES['conservador-live-v2']!, monadRegistry, 143)).toThrow('not monad')
  })

  test('its gas reserve is in MON and its native price pool is WMON/USDC', () => {
    expect(liveWmonUsdcMonadV1.gasReserveWei).toBe(2n * 10n ** 18n)
    expect(nativePricePool(monadRegistry)).toBe('pool:WMON/USDC/3000')
    expect(nativePricePool(baseRegistry)).toBe('pool:WETH/USDC/3000')
  })
})

describe('gas on a chain that charges the gas limit', () => {
  test('the relayer: Monad gets 10%, its 30M cap and no L1 fee; Base and Ethereum keep 30%, 2^24 and the oracle', () => {
    expect(relayerGasProfile(143)).toEqual({ cap: 30_000_000n, margin: { num: 11n, den: 10n }, l1Fee: false, native: 'MON' })
    for (const id of [8453, 1, 314143]) expect(relayerGasProfile(id)).toEqual({ cap: 16_777_216n, margin: { num: 13n, den: 10n }, l1Fee: true, native: 'ETH' })
  })

  test('engine userOps: the call limit is the simulated gas x 5/4 + 30k; refused above the fixed limits', () => {
    const op = { sender: ctx.address as `0x${string}`, nonce: 1n, callData: `0x${'ab'.repeat(900)}` as `0x${string}`, ...LAB_GAS_LIMITS, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }
    const t = tightUserOpGas(op, 400_000n)!
    expect(t.callGasLimit).toBe((400_000n * TIGHT_CALL_GAS.num) / TIGHT_CALL_GAS.den + TIGHT_CALL_GAS.plus)
    expect(t.verificationGasLimit).toBeLessThan(LAB_GAS_LIMITS.verificationGasLimit)
    expect(t.preVerificationGas).toBeGreaterThan(21_000n + 900n * 16n)
    expect(t.preVerificationGas).toBeLessThan(LAB_GAS_LIMITS.preVerificationGas)
    expect(t.verificationGasLimit + t.callGasLimit + t.preVerificationGas).toBeLessThan(1_200_000n)
    expect(tightUserOpGas(op, 0n)).toBeNull()
    expect(tightUserOpGas(op, 1_700_000n)).toBeNull()
  })
})

describe('the builders read the chain registry; Base output is unchanged', () => {
  const live = liveAccountFromContext(ctx)
  const onMonad = liveAccountFromContext({ ...ctx, chainId: 143 }, monadRegistry)

  test('the Safe is the same counterfactual address on Monad (same CREATE2 stack)', () => {
    expect(onMonad.safe).toBe(live.safe)
    expect(onMonad.registry).toBe(monadRegistry)
    expect(live.registry).toBeUndefined()
  })

  test('a transfer pays Monad USDC; a stop closes on the Monad position manager', () => {
    const to = '0x000000000000000000000000000000000000dEaD' as const
    const m = transferBatch({ account: live.safe, to, amountUsdc: 5n, reduce: [{ tokenId: 7n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n }], deadline: 1n, registry: monadRegistry })
    expect(m.at(-1)!.to).toBe(address('USDC', monadRegistry))
    expect(decodeFunctionData({ abi: erc20Abi, data: m.at(-1)!.data }).args).toEqual([to, 5n])
    expect(m[0]!.to).toBe(address('NonfungiblePositionManager', monadRegistry))
    const b = transferBatch({ account: live.safe, to, amountUsdc: 5n, reduce: [], deadline: 1n })
    expect(b).toEqual(transferBatch({ account: live.safe, to, amountUsdc: 5n, reduce: [], deadline: 1n, registry: baseRegistry }))
    expect(b.at(-1)!.to).toBe(address('USDC', baseRegistry))
    const s = stopBatch({ account: live.safe, permissionIds: [], positions: [{ tokenId: 7n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n }], deadline: 1n, registry: monadRegistry })
    expect(s.every((c) => c.to === address('NonfungiblePositionManager', monadRegistry))).toBe(true)
    // cbBTC is not a Monad token: a cbBTC swap on Monad is refused, never encoded at a Base address.
    expect(code(() => stopBatch({ account: live.safe, permissionIds: [], positions: [], swapCbbtc: { amountIn: 1n, amountOutMinimum: 1n }, deadline: 1n, registry: monadRegistry }))).toBe('POLICY_TARGET_NOT_IN_REGISTRY')
  })

  test('sessions on Monad need TimeFramePolicy in the registry: refused on monad.json as pinned', () => {
    const g = instantiateGrant(liveWmonUsdcMonadV1, 'enter-swap', { account: live.safe, sessionKey: live.safe, chainId: 143, salt: toHex(1n, { size: 32 }), validAfter: 1, validUntil: 2, caps: { usdcSwapPerCall: 1n, usdcSwapTotal: 2n } })
    expect(code(() => toSmartSession(g, undefined, monadRegistry))).toBe('POLICY_TARGET_NOT_IN_REGISTRY')
    const withPolicies = { ...monadRegistry, entries: [...monadRegistry.entries, ...baseRegistry.entries.filter((e) => e.name === 'TimeFramePolicy' || e.name === 'UsageLimitPolicy')] }
    expect(toSmartSession(g, undefined, withPolicies)).toEqual(toSmartSession(g))
    expect(activationBatch({ ...onMonad, registry: withPolicies }, [g], []).calls).toEqual(activationBatch(live, [g], []).calls)
  })
})

// --- boot on chain 143 ------------------------------------------------------------------------------------------
const methods: string[] = []
const rpc = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { id: number; method: string } | { id: number; method: string }[]
    const one = (r: { id: number; method: string }) => {
      methods.push(r.method)
      if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0x8f' }
      if (r.method === 'eth_getBalance') return { jsonrpc: '2.0', id: r.id, result: '0x0' }
      if (r.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: r.id, result: '0x1' }
      // No contract anywhere: the session policies are not on this "Monad".
      if (r.method === 'eth_getCode') return { jsonrpc: '2.0', id: r.id, result: '0x' }
      return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'stub' } }
    }
    return Response.json(Array.isArray(body) ? body.map(one) : one(body))
  },
})
const rpcUrl = `http://127.0.0.1:${rpc.port}/`
const secret = randomBytes(32).toString('hex')
const env = { ...process.env }
process.env.MAMORU_LIVE = '1'
delete process.env.MAMORU_CHAIN_WRITES
const off = await bootOperator({ rpcUrl, secret, stateDir: mkdtempSync(join(tmpdir(), 'mamoru-143-off-')), port: 0, policyId: 'lab-wmon-usdc-monad-v1' })
process.env = env
afterAll(() => {
  off.stop()
  rpc.stop(true)
})

describe('boot on chain 143', () => {
  test('flag off (the default): read only, nothing signed or sent, over HTTP too', async () => {
    expect(off.operator.cfg.live).toBe(false)
    expect(off.operator.cfg.chainWrites).toBeUndefined()
    expect(off.operator.cfg.bundlerUrl).toBe('')
    const e = (await off.operator.relayer.send({ to: off.operator.relayer.address, value: 1n }).catch((x: unknown) => x)) as { code?: string }
    expect(e.code).toBe('CHAIN_UNSUPPORTED')
    const c = { ...ctx, chainId: 143 }
    const header = Buffer.from(JSON.stringify(c)).toString('base64url')
    for (const path of ['activate/prepare', 'stop/prepare']) {
      const p = `/api/accounts/${c.accountKey}/${path}`
      const ts = Math.floor(Date.now() / 1000).toString()
      const res = await fetch(off.url + p, { method: 'POST', headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts, 'x-mamoru-sig': operatorSignature(secret, 'POST', p, header, '{}', ts), 'content-type': 'application/json' }, body: '{}' })
      expect({ path, status: res.status, code: ((await res.json()) as { code?: string }).code }).toEqual({ path, status: 503, code: 'CHAIN_READ_ONLY' })
    }
    expect(off.operator.engineHealthSnapshot()).toEqual([])
    expect(methods).not.toContain('eth_sendRawTransaction')
    expect(methods).not.toContain('eth_estimateGas')
  })

  test('the Monad mainnet policy is unknown without the flag', async () => {
    const saved = { ...process.env }
    delete process.env.MAMORU_CHAIN_WRITES
    try {
      await expect(bootOperator({ rpcUrl, secret, stateDir: mkdtempSync(join(tmpdir(), 'mamoru-143-nopolicy-')), port: 0, policyId: 'live-wmon-usdc-monad-v1' })).rejects.toThrow('unknown policy')
    } finally {
      process.env = saved
    }
  })

  test('flag on but MAMORU_LIVE off (review of #116, P1-1): read only exactly as without the flag, nothing signed', async () => {
    const saved = { ...process.env }
    delete process.env.MAMORU_LIVE
    process.env.MAMORU_CHAIN_WRITES = '143'
    const before = methods.length
    let op: Awaited<ReturnType<typeof bootOperator>> | null = null
    try {
      // The Monad mainnet policy does not resolve: writes are not on.
      await expect(bootOperator({ rpcUrl, secret, stateDir: mkdtempSync(join(tmpdir(), 'mamoru-143-flag-nolive-p-')), port: 0, policyId: 'live-wmon-usdc-monad-v1' })).rejects.toThrow('unknown policy')
      op = await bootOperator({ rpcUrl, secret, stateDir: mkdtempSync(join(tmpdir(), 'mamoru-143-flag-nolive-')), port: 0, policyId: 'lab-wmon-usdc-monad-v1' })
    } finally {
      process.env = saved
    }
    try {
      expect(op.operator.cfg.live).toBe(false)
      expect(op.operator.cfg.chainWrites).toBeUndefined()
      expect(op.operator.cfg.bundlerUrl).toBe('')
      // The registry is monad.json as pinned: no write registry was built (no getCode of the session policies).
      expect(op.operator.cfg.registry).toBe(monadRegistry)
      const e = (await op.operator.relayer.send({ to: op.operator.relayer.address, value: 1n }).catch((x: unknown) => x)) as { code?: string }
      expect(e.code).toBe('CHAIN_UNSUPPORTED')
      const c = { ...ctx, chainId: 143 }
      const header = Buffer.from(JSON.stringify(c)).toString('base64url')
      const p = `/api/accounts/${c.accountKey}/activate/prepare`
      const ts = Math.floor(Date.now() / 1000).toString()
      const res = await fetch(op.url + p, { method: 'POST', headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts, 'x-mamoru-sig': operatorSignature(secret, 'POST', p, header, '{}', ts), 'content-type': 'application/json' }, body: '{}' })
      expect({ status: res.status, code: ((await res.json()) as { code?: string }).code }).toEqual({ status: 503, code: 'CHAIN_READ_ONLY' })
      expect(op.operator.engineHealthSnapshot()).toEqual([])
      expect(methods.slice(before).filter((m) => m === 'eth_sendRawTransaction' || m === 'eth_estimateGas' || m === 'eth_getCode')).toEqual([])
    } finally {
      op.stop()
    }
  })

  test('sponsorship off Base: a configured policy is never loosened by the Monad default (review of #116, P1-2)', () => {
    const policyOf = (o: typeof off.operator) => (o as unknown as { sponsorPolicy(): SponsorPolicy }).sponsorPolicy()
    expect(policyOf(off.operator)).toEqual(MONAD_SPONSOR)
    const small: SponsorPolicy = { perAccount: 1, stopsPerAccount: 1, weiPerDay: 1_000n, reserveBps: 5_000, activationWeiPerDay: 2_000n }
    ;(off.operator.cfg as { sponsor?: SponsorPolicy }).sponsor = small
    try {
      expect(policyOf(off.operator)).toEqual(small)
    } finally {
      delete (off.operator.cfg as { sponsor?: SponsorPolicy }).sponsor
    }
    // Field by field, the stricter: a configured value above Monad's default is capped, a broken one takes the default.
    const big = monadSponsor({ perAccount: 50, stopsPerAccount: 2, weiPerDay: 10n ** 30n, reserveBps: 0, activationWeiPerDay: undefined })
    expect(big).toEqual({ perAccount: MONAD_SPONSOR.perAccount, stopsPerAccount: 2, weiPerDay: MONAD_SPONSOR.weiPerDay, reserveBps: MONAD_SPONSOR.reserveBps, activationWeiPerDay: MONAD_SPONSOR.activationWeiPerDay })
    expect(monadSponsor({ perAccount: -1, stopsPerAccount: 1.5, weiPerDay: -1n, reserveBps: 20_000 }).perAccount).toBe(MONAD_SPONSOR.perAccount)
  })

  test('flag on, but the session policies are not on the chain: the boot is refused, nothing sent', async () => {
    const saved = { ...process.env }
    process.env.MAMORU_LIVE = '1'
    process.env.MAMORU_CHAIN_WRITES = '143'
    try {
      const e = (await bootOperator({ rpcUrl, secret, stateDir: mkdtempSync(join(tmpdir(), 'mamoru-143-on-')), port: 0, policyId: 'live-wmon-usdc-monad-v1' }).catch((x: unknown) => x)) as { code?: string }
      expect(e.code).toBe('SESSION_POLICY_UNAVAILABLE_ON_CHAIN')
    } finally {
      process.env = saved
    }
    expect(methods).not.toContain('eth_sendRawTransaction')
  })
})
