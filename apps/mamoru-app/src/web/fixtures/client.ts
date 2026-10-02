import { overCap, PRODUCTION_BANNER, type AppConfig, type FundingView, type OpView, type OwnerResponse, type OwnerTxToSign, type SessionView, type TransferPlan, type WithdrawAsset } from '@mamoru/domain'
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
  deployMinUsdc: '1000000',
  cbbtc: '0',
  gasReserveWei: '300000000000000',
  active: false,
  positions: [],
}

// ?fresh (dev only): no account yet, 0 USDC. The approval arms; a deposit lands a few seconds later.
const param = (name: string) => liveGate && typeof location !== 'undefined' && new URLSearchParams(location.search).has(name)
const fresh = param('fresh')
// ?overcap (dev only): the armed approval met a 26.92 USDC deposit, over the 25 USDC cap. Nothing started.
const overcap = param('overcap')
const OVER_CAP_USDC = '26920000'
const capState = (usdc: string) => ({ usdc, overCap: overCap(BigInt(usdc), BigInt(fixtureFunding.capUsdc)) })
const liveState = {
  funding: { ...structuredClone(fixtureFunding), ...(fresh ? { usdc: '0' } : {}), ...(overcap ? capState(OVER_CAP_USDC) : {}) } as FundingView,
  ops: (overcap
    ? [{ opId: 'own-1-activate', kind: 'activate', state: 'failed', code: 'DEPOSIT_OVER_CAP', amountUsdc: OVER_CAP_USDC, capUsdc: fixtureFunding.capUsdc, updatedAt: new Date().toISOString() }]
    : []) as OpView[],
  n: 0,
  owner: !fresh,
  transferUsdc: 0n,
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

// Fixed quotes per 1 USDC (base units of the output asset), 0.5% slippage floor.
const FIXTURE_QUOTE: Record<Exclude<WithdrawAsset, 'USDC'>, { perUsdc: bigint; decimals: number; route: string }> = {
  EURC: { perUsdc: 921_000n, decimals: 6, route: 'Uniswap v3 · USDC → EURC 0.05% · Base' },
  ETH: { perUsdc: 384_615_384_615_384n, decimals: 18, route: 'Uniswap v3 · USDC → WETH 0.05% · unwrapped to ETH · Base' },
  JPYC: { perUsdc: 161_600_000n, decimals: 6, route: 'Uniswap v3 · USDC → JPYT 0.30% · Base' },
}

export function fixtureReceive(asset: Exclude<WithdrawAsset, 'USDC'>, amountUsdc: bigint): NonNullable<TransferPlan['receive']> {
  const q = FIXTURE_QUOTE[asset]
  const quoted = (amountUsdc * q.perUsdc) / 1_000_000n
  return { asset, quoted: String(quoted), minimum: String((quoted * 995n) / 1000n), decimals: q.decimals, route: q.route }
}

export const fixtureClient: ApiClient = {
  config: () => delay(liveGate ? { ...fixtureConfig, fundsGate: 'live', dryRun: false, capUsdc: '25000000' } : fixtureConfig),
  session: () => delay(liveState.owner ? fixtureSession : null),
  dashboard: () => delay(emptyAccount),
  pools: () => delay(poolsResponse),
  apy: () =>
    delay({
      pool: 'conservador-live-v2',
      currentPct: 6.4,
      currentWindow: '24h' as const,
      currentSource: 'Plan pools, fee APR · GeckoTerminal/DefiLlama',
      monthlyPct: 5.9,
      monthlySource: 'Plan pools, 30-day mean · DefiLlama',
      asOf: new Date().toISOString(),
    }),
  registrationChallenge: () => delay({ challenge: 'Zml4dHVyZS1jaGFsbGVuZ2UtMzItYnl0ZXMtbG9uZy0wMDI', token: 'fixture', rpId: 'localhost', expiresAt: new Date(Date.now() + 300_000).toISOString() }),
  createOwner: () => {
    liveState.owner = true
    return delay(fixtureOwner)
  },
  signInChallenge: () => delay({ challenge: 'Zml4dHVyZS1jaGFsbGVuZ2UtMzItYnl0ZXMtbG9uZy0wMDE', token: 'fixture', rpId: 'localhost', expiresAt: new Date(Date.now() + 300_000).toISOString() }),
  signIn: () => {
    liveState.owner = true
    return delay(fixtureSession)
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
  withdrawAssets: () =>
    delay({
      assets: [
        { asset: 'USDC' as const, available: true },
        { asset: 'EURC' as const, available: true },
        { asset: 'ETH' as const, available: true },
        { asset: 'JPYC' as const, available: true, reason: 'Dephaser JPYT, backed by USDC. Not a regulated issuer.' },
      ],
    }),
  transferPrepare: (_k, body) => {
    liveState.transferUsdc = BigInt(body.amountUsdc)
    return delay({
      reduce: BigInt(body.amountUsdc) > BigInt(liveState.funding.usdc) ? [{ tokenId: '4242', liquidityBps: 5000 }] : [],
      ...(body.asset && body.asset !== 'USDC' ? { receive: fixtureReceive(body.asset, BigInt(body.amountUsdc)) } : {}),
      ownerTx: fixtureTx([
        ...(liveState.funding.deployed ? [] : ['Create your Safe on Base']),
        `Transfer ${Number(body.amountUsdc) / 1e6} USDC to ${body.to}${body.asset && body.asset !== 'USDC' ? ` as ${body.asset}` : ''}`,
      ]),
    })
  },
  transfer: () =>
    delay(
      fixtureOp('transfer', () => {
        const f = liveState.funding
        const left = BigInt(f.usdc) - liveState.transferUsdc
        Object.assign(f, { deployed: true }, f.active ? { usdc: String(left > 0n ? left : 0n) } : capState(String(left > 0n ? left : 0n)))
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
