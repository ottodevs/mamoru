import { PRODUCTION_BANNER, type AppConfig, type FundingView, type OpView, type OwnerResponse, type OwnerTxToSign, type SessionView } from '@mamoru/domain'
import type { ApiClient } from '../api/client.ts'
import { emptyAccount, FIXTURE_ACCOUNT_KEY, FIXTURE_ADDRESS } from './empty-account.ts'
import { poolsResponse } from './pools.ts'

// Dev (VITE_FIXTURES=1) and tests only. Never imported by the production build.
export const fixtureConfig: AppConfig = {
  mode: 'production',
  chainId: 8453,
  banner: { kind: 'simulation', text: PRODUCTION_BANNER },
  fundsGate: 'closed',
  dryRun: true,
}

export const fixtureSession: SessionView = { userId: 'user_fixture_01', accountKey: FIXTURE_ACCOUNT_KEY }

export const fixtureOwner: OwnerResponse = {
  accountKey: FIXTURE_ACCOUNT_KEY,
  chainId: 8453,
  address: FIXTURE_ADDRESS,
  owners: ['0x0000000000000000000000000000000000000100'],
  deployed: false,
}

const delay = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), 150))

// VITE_FIXTURE_GATE=live walks the live happy path against an in-memory Safe (dev only).
const liveGate = import.meta.env?.VITE_FIXTURE_GATE === 'live'

export const fixtureFunding: FundingView = {
  address: FIXTURE_ADDRESS,
  deployed: false,
  block: 36_000_000,
  usdc: '20000000',
  eth: '0',
  capUsdc: '25000000',
  cbbtc: '0',
  gasReserveWei: '300000000000000',
  active: false,
  positions: [],
}

// ?fresh (dev only): no account yet, 0 USDC. The approval arms; a deposit lands a few seconds later.
const fresh = liveGate && typeof location !== 'undefined' && new URLSearchParams(location.search).has('fresh')
const liveState = {
  funding: { ...structuredClone(fixtureFunding), ...(fresh ? { usdc: '0' } : {}) },
  ops: [] as OpView[],
  n: 0,
  owner: !fresh,
}

function fixtureTx(summary: string[]): OwnerTxToSign {
  liveState.n += 1
  return {
    safe: FIXTURE_ADDRESS,
    chainId: 8453,
    safeTxHash: `0x${String(liveState.n).padStart(64, 'a')}`,
    summary,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    prepareId: `prep_fixture_${liveState.n}`,
  }
}

function fixtureOp(kind: OpView['kind'], after: () => void): OpView {
  liveState.n += 1
  const op: OpView = { opId: `op_fixture_${liveState.n}`, kind, state: 'submitted', updatedAt: new Date().toISOString() }
  liveState.ops.push(op)
  setTimeout(() => {
    op.state = 'confirmed'
    op.block = (liveState.funding.block += 3)
    op.txHash = `0x${String(liveState.n).padStart(64, 'b')}`
    op.updatedAt = new Date().toISOString()
    after()
  }, 5000)
  return op
}

export const fixtureClient: ApiClient = {
  config: () => delay(liveGate ? { ...fixtureConfig, fundsGate: 'live', dryRun: false, capUsdc: '25000000' } : fixtureConfig),
  session: () => delay(liveState.owner ? fixtureSession : null),
  dashboard: () => delay(emptyAccount),
  pools: () => delay(poolsResponse),
  apy: () =>
    delay({
      pool: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef',
      currentPct: 11.4,
      currentWindow: '1h' as const,
      currentSource: 'Pool fees, last hour · GeckoTerminal',
      monthlyPct: 22.6,
      monthlySource: '30-day mean · DefiLlama',
      asOf: new Date().toISOString(),
    }),
  createOwner: () => {
    liveState.owner = true
    return delay(fixtureOwner)
  },
  recoveryKit: () => delay({ chainId: 8453, address: FIXTURE_ADDRESS, fixture: true }),
  ackRecovery: () => delay({ ok: true as const }),
  funding: () => delay(liveState.funding),
  ops: () => delay({ ops: liveState.ops }),
  activatePrepare: () => delay(fixtureTx(['Deploy your Safe on Base', 'Enable the engine session for up to 20 USDC', 'Top up gas reserve to 0.0003 ETH'])),
  activate: () => {
    if (fresh && BigInt(liveState.funding.usdc) === 0n) {
      liveState.n += 1
      const op: OpView = { opId: `op_fixture_${liveState.n}`, kind: 'activate', state: 'proposed', code: 'ARMED', updatedAt: new Date().toISOString() }
      liveState.ops.push(op)
      setTimeout(() => {
        liveState.funding.usdc = '20000000'
        setTimeout(() => {
          op.state = 'confirmed'
          op.txHash = `0x${'c'.repeat(64)}`
          op.updatedAt = new Date().toISOString()
          Object.assign(liveState.funding, { deployed: true, active: true, usdc: '10000000' })
          liveState.funding.positions = [{ tokenId: '4242', pool: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef', liquidity: '1000', inRange: true, amountUsdc: '5000000', amountCbbtc: '7641' }]
          liveState.ops.push({ opId: 'op_enter', kind: 'enter', state: 'confirmed', txHash: `0x${'d'.repeat(64)}`, updatedAt: new Date().toISOString() })
        }, 6000)
      }, 8000)
      return delay(op)
    }
    return delay(
      fixtureOp('activate', () => {
        const f = liveState.funding
        f.deployed = true
        f.active = true
        f.usdc = '10000000'
        f.positions = [{ tokenId: '4242', pool: '0x0000000000000000000000000000000000000abc', liquidity: '1000', inRange: true, amountUsdc: '5000000', amountCbbtc: '5000' }]
      }),
    )
  },
  transferPrepare: (_k, body) =>
    delay({
      reduce: BigInt(body.amountUsdc) > BigInt(liveState.funding.usdc) ? [{ tokenId: '4242', liquidityBps: 5000 }] : [],
      ownerTx: fixtureTx([`Transfer ${Number(body.amountUsdc) / 1e6} USDC to ${body.to}`]),
    }),
  transfer: () =>
    delay(
      fixtureOp('transfer', () => {
        liveState.funding.usdc = '0'
      }),
    ),
  stopPrepare: () => delay(fixtureTx(['Revoke every engine grant', 'Close every position', 'Swap cbBTC to USDC. USDC stays in the Safe'])),
  stop: () =>
    delay(
      fixtureOp('exit', () => {
        const f = liveState.funding
        f.active = false
        f.positions = []
        f.usdc = '19900000'
      }),
    ),
}
