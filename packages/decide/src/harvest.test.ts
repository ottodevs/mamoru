// otto/mamoru#107 (spec 012 HRV-R11, unit part of HRV-S13): the harvest sale on every live policy. Each one, holding
// harvested volatile worth well above its sale cost, proposes the sale of exactly that amount under the pool's
// manage-any grant (named here, not read back from decide), and it passes the preliminary gate; without that one
// session it proposes no sale. The fork run (HT10) executes each sale on chain against the signed sessions.
// one-auth-v4's grant keys come from its pool table (`withRegistryPools`, as the operator builds it); the deployment
// addresses below are placeholders that do not enter any key.
import { describe, expect, test } from 'bun:test'
import { conservadorLiveV6, conservadorLiveV7, grantKey, liveWmonUsdcMonadV6, oneAuthV4Live, staticPool, withRegistryPools, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry, monadRegistry, type Registry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, inSavings, type Observation, type PoolObs } from './index.ts'
import { opCostInSavings } from './value.ts'

function pool(name: string, tick: number, registry: Registry): PoolObs {
  const e = entry(name, registry)
  return { name, address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!, tickSpacing: e.tickSpacing!, sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick, identity: { factoryPool: e.address, token0: address(e.token0!, registry), token1: address(e.token1!, registry), fee: e.fee!, tickSpacing: e.tickSpacing! } }
}

const D = { policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3' } as const
const v4 = withRegistryPools(oneAuthV4Live, D, ['pool:USDC/USDT/100', 'pool:WETH/USDC/3000'].map((n) => ({ ...staticPool(n, baseRegistry), entry: { twapWindow: 600, twapShortWindow: 60, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 10_000, active: true } })), baseRegistry).policy

const BASE_POOLS = [pool('pool:USDC/USDT/100', 1, baseRegistry), pool('pool:USDC/cbBTC/500', -69_080, baseRegistry), pool('pool:WETH/USDC/3000', -193_380, baseRegistry)]
const MONAD = pool('pool:WMON/USDC/3000', -260_000, monadRegistry)

const LIVE: { name: string; policy: PolicyVersion; registry: Registry; pools: PoolObs[]; token: string; grant: string; ethPrice: Observation['ethPrice'] }[] = [
  { name: 'conservador-live-v6 (cbBTC)', grant: 'manage-any:pool:USDC/cbBTC/500', policy: conservadorLiveV6, registry: baseRegistry, pools: BASE_POOLS, token: 'cbBTC', ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' } },
  { name: 'conservador-live-v6 (WETH)', grant: 'manage-any:pool:WETH/USDC/3000', policy: conservadorLiveV6, registry: baseRegistry, pools: BASE_POOLS, token: 'WETH', ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' } },
  { name: 'conservador-live-v7 (cbBTC)', grant: 'manage-any:pool:USDC/cbBTC/500', policy: conservadorLiveV7, registry: baseRegistry, pools: BASE_POOLS, token: 'cbBTC', ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' } },
  { name: 'conservador-live-v7 (WETH)', grant: 'manage-any:pool:WETH/USDC/3000', policy: conservadorLiveV7, registry: baseRegistry, pools: BASE_POOLS, token: 'WETH', ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' } },
  { name: 'live-wmon-usdc-monad-v6 (WMON)', grant: 'manage-any:pool:WMON/USDC/3000', policy: liveWmonUsdcMonadV6, registry: monadRegistry, pools: [MONAD], token: 'WMON', ethPrice: { pool: MONAD.name, sqrtPriceX96: MONAD.sqrtPriceX96, token0: 'WMON' } },
  { name: 'one-auth-v4 live (WETH)', grant: 'manage-any:pool:WETH/USDC/3000', policy: v4, registry: baseRegistry, pools: BASE_POOLS, token: 'WETH', ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' } },
]

const NOW = 2_000_000n

describe('the harvest sale on every live policy (HRV-R11)', () => {
  for (const c of LIVE) {
    test(c.name, () => {
      const base: Observation = {
        chainId: c.registry === monadRegistry ? 143 : 8453,
        registry: c.registry,
        block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: NOW },
        safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
        account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
        sessions: c.policy.session.grants.map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 2 ** 32 - 1, active: true })),
        native: 3n * 10n ** 18n,
        balances: { USDC: 0n },
        positions: [],
        pools: c.pools,
        vaults: [],
        ethPrice: c.ethPrice,
        gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
        deposits: [],
        intents: { paused: false, exitRequested: false },
        slot: null,
      }
      const p = c.pools.find((x) => x.token0 === c.token || x.token1 === c.token)!
      const cost = opCostInSavings(base, 'USDC')
      const unit = inSavings(p, c.token, 10n ** 18n, 'USDC')
      expect(unit > 0n).toBe(true)
      const amount = ((cost * 50n) * 10n ** 18n) / unit + 1n
      const d = decide({ ...base, balances: { USDC: 0n, [c.token]: amount }, harvested: { [c.token]: { amount, since: Number(NOW) - 60 } } }, c.policy)
      expect(d.proposal).toMatchObject({ kind: 'enter_swap', tokenIn: c.token, tokenOut: 'USDC', amountIn: amount, harvestSale: true })
      expect((d.proposal as { grant: string }).grant).toBe(c.grant)
      expect(d.trail.filter((t) => t.gate === 'ehg')).toEqual([{ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' }])
      // Without that session, no sale.
      const without = decide({ ...base, sessions: base.sessions.filter((x) => x.grant !== c.grant), balances: { USDC: 0n, [c.token]: amount }, harvested: { [c.token]: { amount, since: Number(NOW) - 60 } } }, c.policy)
      expect(without.proposal?.kind === 'enter_swap' && without.proposal.harvestSale).toBeFalsy()
    })
  }
})
