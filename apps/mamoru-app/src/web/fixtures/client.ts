import { overCap, PRODUCTION_BANNER, type AppConfig, type BridgeOutView, type EthereumSiblingView, type FundingView, type Hex0x, type OpView, type OwnerResponse, type OwnerTxToSign, type PriceDivergenceWarning, type SessionView, type SleeveView, type TransferPlan, type WithdrawAsset } from '@mamoru/domain'
import { ApiRequestError, type ApiClient } from '../api/client.ts'
import { emptyAccount, FIXTURE_ACCOUNT_KEY, FIXTURE_ADDRESS } from './empty-account.ts'
import { poolsResponse } from './pools.ts'
import { braisFunding, braisToday, withMonadOnlyPositions, withMonadPosition, withoutMoney, withStaleMonad, withUnreadMonad, type BraisMoment } from './money.ts'

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
// ?placing (dev only): a running account in the middle of an entry. One position is open, a swap to USDT waits for
// its mint, the engine is on its way to the next step.
const placing = param('placing')
const midEntry = (): Partial<FundingView> => ({
  active: true,
  usdc: '1248000',
  cbbtc: '0',
  idle: [
    { token: 'USDC', amount: '1248000', decimals: 6, valueUsdc: '1248000' },
    { token: 'USDT', amount: '1253694', decimals: 6, valueUsdc: '1253694' },
  ],
  engine: { placing: true, nextReviewAt: new Date(Date.now() + 5_000).toISOString() },
  positions: [
    {
      tokenId: '4821',
      pool: 'pool:USDC/cbBTC/500',
      liquidity: '1',
      inRange: true,
      amountUsdc: '1010000',
      amountCbbtc: '881',
      valueUsdc: '2000000',
      amounts: [
        { token: 'USDC', amount: '1010000', decimals: 6, valueUsdc: '1010000' },
        { token: 'cbBTC', amount: '881', decimals: 8, valueUsdc: '990000' },
      ],
    },
  ],
})
// ?dashboard (dev only, otto/mamoru#193): a running account placed in three positions, the Growth one out of
// range, a few cents idle. The shape of the beta dashboard mockup; the rates come from the APY fixture below.
const dashboard = param('dashboard')
const dashboardV7 = dashboard && new URLSearchParams(location.search).get('dashboard') === 'v7'
const placedThree = (): Partial<FundingView> => ({
  deployed: true,
  active: true,
  usdc: '110000',
  cbbtc: '0',
  capUsdc: '100000000',
  idle: [{ token: 'USDC', amount: '110000', decimals: 6, valueUsdc: '110000' }],
  engine: { placing: false, nextReviewAt: null },
  positions: [
    {
      tokenId: '5101', range: { lower: -10, upper: 10, tick: 3 }, pool: 'pool:USDC/USDT/100', liquidity: '1', inRange: true, amountUsdc: '25100000', amountCbbtc: '0', valueUsdc: '50120000',
      amounts: [
        { token: 'USDC', amount: '25100000', decimals: 6, valueUsdc: '25100000' },
        { token: 'USDT', amount: '25020000', decimals: 6, valueUsdc: '25020000' },
      ],
    },
    {
      tokenId: '5102', range: { lower: -66000, upper: -64000, tick: -65400 }, pool: 'pool:USDC/cbBTC/500', liquidity: '1', inRange: true, amountUsdc: '19920000', amountCbbtc: '17000', valueUsdc: '39800000',
      amounts: [
        { token: 'USDC', amount: '19920000', decimals: 6, valueUsdc: '19920000' },
        { token: 'cbBTC', amount: '17000', decimals: 8, valueUsdc: '19880000' },
      ],
    },
    {
      tokenId: '5103', range: { lower: -199000, upper: -197000, tick: -196500 }, pool: 'pool:WETH/USDC/3000', liquidity: '1', inRange: false, amountUsdc: '0', amountCbbtc: '0', valueUsdc: '9970000',
      amounts: [
        { token: 'WETH', amount: '2600000000000000', decimals: 18, valueUsdc: '9970000' },
        { token: 'USDC', amount: '0', decimals: 6, valueUsdc: '0' },
      ],
    },
  ],
})
// ?dashboard=v7 (dev only, otto/mamoru#210): conservador-live-v7, the Stable half supplied to Morpho gtUSDCp, Balance in
// WETH/USDC, a few cents idle.
const placedV7 = (): Partial<FundingView> => ({
  ...placedThree(),
  positions: [
    {
      tokenId: 'vault:gtUSDCp', pool: 'vault:gtUSDCp', liquidity: '44750000000000000000', inRange: true, amountUsdc: '50020000', amountCbbtc: '0', valueUsdc: '50020000',
      amounts: [{ token: 'USDC', amount: '50020000', decimals: 6, valueUsdc: '50020000' }],
      vault: { name: 'vault:gtUSDCp', label: 'Morpho · Gauntlet USDC Prime', shares: '44750000000000000000', withdrawableUsdc: '50020000' },
    },
    {
      tokenId: '5203', pool: 'pool:WETH/USDC/3000', liquidity: '1', inRange: true, amountUsdc: '17400000', amountCbbtc: '0', valueUsdc: '34950000',
      amounts: [
        { token: 'WETH', amount: '4560000000000000', decimals: 18, valueUsdc: '17550000' },
        { token: 'USDC', amount: '17400000', decimals: 6, valueUsdc: '17400000' },
      ],
    },
  ],
})
// ?monad (dev only, otto/mamoru#67, #251): the owner also has their own Safe on Monad (its own address, created by the
// approval that moved the account to v6), running in WMON/USDC 0.30%.
export const MONAD_FIXTURE_KEY = `${FIXTURE_ACCOUNT_KEY}@143`
/** The owner's own Safe on Monad: another address than the Base Safe (its setup carries the Monad sessions). */
export const FIXTURE_MONAD_SAFE: Hex0x = '0x74d6086DbC072ff22774A2A8bE98324E1eaF084c'
const monadOn = param('monad')
// ?monadupgrade (dev only, otto/mamoru#216): a running v5 account offered the mix with Monad (v6), no Monad Safe yet.
const monadUpgrade = param('monadupgrade')
const sleeveOf = (accountKey: string, chainId: number): SleeveView => ({ accountKey, chainId, chain: chainId === 143 ? 'Monad' : 'Base', address: chainId === 143 ? FIXTURE_MONAD_SAFE : FIXTURE_ADDRESS })
const monadState = {
  funding: {
    ...structuredClone(fixtureFunding),
    deployed: true,
    active: true,
    block: 41_802_330,
    usdc: '420000',
    cbbtc: '0',
    capUsdc: '100000000',
    idle: [{ token: 'USDC', amount: '420000', decimals: 6, valueUsdc: '420000' }],
    engine: { placing: false, nextReviewAt: new Date(Date.now() + 4 * 60_000).toISOString() },
    positions: [
      {
        tokenId: '9001', pool: 'pool:WMON/USDC/3000', liquidity: '1', inRange: true, amountUsdc: '24050000', amountCbbtc: '0', valueUsdc: '48120000',
        amounts: [
          { token: 'WMON', amount: '682140000000000000000', decimals: 18, valueUsdc: '24070000' },
          { token: 'USDC', amount: '24050000', decimals: 6, valueUsdc: '24050000' },
        ],
      },
    ],
  } as FundingView,
  ops: [
    { opId: 'own-m1-activate', kind: 'activate', state: 'confirmed', txHash: `0x${'4'.repeat(64)}`, updatedAt: new Date(Date.now() - 50 * 60_000).toISOString() },
    { opId: 'eng-m1-enter_mint', kind: 'enter', state: 'confirmed', pool: 'pool:WMON/USDC/3000', txHash: `0x${'5'.repeat(64)}`, updatedAt: new Date(Date.now() - 48 * 60_000).toISOString() },
  ] as OpView[],
}
const sleeveState = { sleeves: monadOn ? [sleeveOf(FIXTURE_ACCOUNT_KEY, 8453), sleeveOf(MONAD_FIXTURE_KEY, 143)] : monadUpgrade ? [sleeveOf(FIXTURE_ACCOUNT_KEY, 8453)] : null }
const sessionNow = (): SessionView => (sleeveState.sleeves ? { ...fixtureSession, sleeves: sleeveState.sleeves } : fixtureSession)
const isMonad = (k: string | undefined) => k === MONAD_FIXTURE_KEY
// ?renewdue (dev only): a running account whose approval ends in 10 days. Home asks for the renewal on arrival (#148).
const renewdue = param('renewdue')
// ?divergence (dev only, otto/mamoru#155): every withdraw prepare returns a PriceDivergenceWarning.
const divergenceOn = param('divergence')
// ?operatordown (dev only, otto/mamoru#208): /funding answers OPERATOR_UNAVAILABLE; the last snapshot is 3 h old.
const operatorDown = param('operatordown')
// ?operatorlate (dev only, otto/mamoru#208 review): the first /funding read works, every later one fails.
const operatorLate = param('operatorlate')
// ?operatorchain / ?operatorchainidle (dev only, otto/mamoru#238): the operator is down and the Worker answers /funding from
// the chain. With three positions the engine had recorded 40 min ago; or, for `idle`, no snapshot: idle money only.
const operatorChain = param('operatorchain')
const operatorChainIdle = param('operatorchainidle')
const chainView = (): FundingView => {
  const listed = { ...structuredClone(fixtureFunding), ...(operatorChainIdle ? {} : placedThree()) } as FundingView
  delete listed.engine
  delete listed.approval
  delete listed.progress
  return { ...listed, active: false, overCap: null, source: 'chain', chainRead: operatorChainIdle ? { positions: 'unknown', listedAt: null } : { positions: 'listed', listedAt: new Date(Date.now() - 40 * 60_000).toISOString() } }
}
let fundingReads = 0
// ?braismoney=before|flight|arriving|minted|monadonly|mixed|today (dev only, otto/mamoru#269): Brais's account around the 2.075638 USDC that crossed Base to
// Monad. Add &stale, &unread or &old for a chain read late, never read, or an operator without the money map.
const brais = typeof location !== 'undefined' && liveGate ? new URLSearchParams(location.search).get('braismoney') : null
const braisView = (): FundingView | null => {
  if (!brais) return null
  const f = brais === 'monadonly' ? withMonadOnlyPositions() : brais === 'mixed' ? withMonadPosition(braisFunding('minted'), '2000000') : brais === 'today' ? braisToday() : braisFunding((['before', 'flight', 'minted', 'arriving'].includes(brais) ? brais : 'flight') as BraisMoment)
  return param('old') ? withoutMoney(f) : param('unread') ? withUnreadMonad(f) : param('stale') ? withStaleMonad(f) : f
}
const upgradeApproval = (): Partial<FundingView> => ({ active: true, approval: { validUntil: Math.floor(Date.now() / 1000) + 300 * 86_400, renewDue: false, expired: false, policyId: 'conservador-live-v5', upgrade: true, upgradePolicy: 'conservador-live-v6' } })
const dueApproval = (): Partial<FundingView> => ({ active: true, approval: { validUntil: Math.floor(Date.now() / 86_400_000) * 86_400 + 10 * 86_400, renewDue: true, expired: false } })
// ?history (dev only, otto/mamoru#235): a running account with events in each state, and one more landing 4 s in.
const historyOn = param('history')
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const historyOps = (): OpView[] => [
  { opId: 'h-activate', kind: 'activate', state: 'confirmed', txHash: `0x${'1'.repeat(64)}`, updatedAt: ago(180) },
  { opId: 'h-enter', kind: 'enter', state: 'confirmed', pool: 'pool:USDC/cbBTC/500', txHash: `0x${'2'.repeat(64)}`, updatedAt: ago(170) },
  { opId: 'h-transfer', kind: 'transfer', state: 'submitted', updatedAt: ago(1) },
] as OpView[]
// ?moves (dev only, otto/mamoru#219): the 26-oct USDC/USDT range move of c23e94e1 (close, swap, open) plus a harvest.
const movesOn = param('moves')
const movedRange = (): OpView[] => {
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  const pool = 'pool:USDC/USDT/100'
  return [
    { opId: 'own-1-activate', kind: 'activate', state: 'confirmed', txHash: `0x${'4'.repeat(64)}`, updatedAt: at(3000) },
    { opId: 'eng-1-1-h-harvest', kind: 'reduce', step: 'harvest', state: 'confirmed', pool: 'pool:USDC/cbBTC/500', txHash: `0x${'7'.repeat(64)}`, updatedAt: at(900), facts: { at: at(900), gasWei: '9000000000000', gasUsdc: '21000', fees: [] } },
    { opId: 'eng-1-1-a-rerange', kind: 'reduce', step: 'rerange', why: 'out', state: 'confirmed', pool, tokenId: '6291325', tickLower: -20, tickUpper: 20, txHash: '0x883bfeee77b6a34a1169a97d0a598a111e8292d974b67dcbc66c56d761d7e621', updatedAt: at(620), facts: { at: at(620), gasWei: '5686883820360', gasUsdc: '13125', fees: [{ tokenId: '6291325', pool, fee0: '14166', fee1: '14620', usdc: '28700' }] } },
    { opId: 'eng-1-1-b-enter_swap', kind: 'enter', step: 'enter_swap', state: 'confirmed', pool, tokenIn: 'USDT', tokenOut: 'USDC', amountIn: '5756781', amountOut: '5738297', txHash: '0xee6398156ac6bb56cc30c9aa428afbd5516443d33b2dad1ed5ddc1f6736ba5e7', updatedAt: at(604), facts: { at: at(604), gasWei: '5415984000000', gasUsdc: '12500', fees: [] } },
    { opId: 'eng-1-1-c-enter_mint', kind: 'enter', step: 'enter_mint', state: 'confirmed', pool, tokenId: '6358057', tickLower: 11, tickUpper: 52, txHash: '0xc1c079edf6d1c92509198cb2fb755d149dbd8dd23a02fff3d5e49f66c9541bea', updatedAt: at(603), facts: { at: at(603), gasWei: '7740558000000', gasUsdc: '17865', fees: [] } },
  ] as OpView[]
}
const liveState = {
  funding: { ...structuredClone(fixtureFunding), ...(fresh ? { usdc: '0' } : {}), ...(overcap ? capState(OVER_CAP_USDC) : {}), ...(placing ? midEntry() : {}), ...(renewdue ? dueApproval() : {}), ...(monadUpgrade ? upgradeApproval() : {}), ...(dashboard ? (dashboardV7 ? placedV7() : placedThree()) : {}) } as FundingView,
  ops: (overcap
    ? [{ opId: 'own-1-activate', kind: 'activate', state: 'failed', code: 'DEPOSIT_OVER_CAP', amountUsdc: OVER_CAP_USDC, capUsdc: fixtureFunding.capUsdc, updatedAt: new Date().toISOString() }]
    : historyOn
      ? historyOps()
    : movesOn
      ? movedRange()
      : []) as OpView[],
  n: 0,
  // ?wrongchain: the 150 USDC on Ethereum until the owner moves it (#133).
  ethereumUsdc: '150000000',
  // ?wrongchaineth (#211): 0.05537835 ETH on Ethereum until the owner converts it.
  ethereumEth: param('wrongchaineth') ? '55378350000000000' : '0',
  bridge: { route: null, enabled: true } as BridgeOutView,
  // ?sibling (dev only, #311): Mamoru can take over what is on Ethereum with one approval (with ?wrongchaineth for the ETH).
  sibling: { state: 'none', offered: param('sibling') } as EthereumSiblingView,
  owner: !fresh,
  transferUsdc: 0n,
}

if (historyOn)
  setTimeout(() => {
    liveState.ops.push({ opId: 'h-enter-2', kind: 'enter', state: 'confirmed', pool: 'pool:USDC/USDT/100', txHash: `0x${'3'.repeat(64)}`, updatedAt: new Date().toISOString() } as OpView)
  }, 4000)

// ?deposit (dev only, otto/mamoru#340): 6 s in, 25 USDC lands from a wallet with nothing of the account moving. Home
// shows the new balance and the history row (arriving) within one funding poll, with no refresh; 40 s in, its block
// is final and the row reads as added.
if (param('deposit'))
  setTimeout(() => {
    liveState.funding = { ...liveState.funding, usdc: (BigInt(liveState.funding.usdc) + 25_000_000n).toString(), block: liveState.funding.block + 3 }
    liveState.ops.push({ opId: `dep-0x${'2'.repeat(64)}-0`, kind: 'deposit', state: 'submitted', amountUsdc: '25000000', asset: 'USDC', from: `0x${'ab'.repeat(20)}`, txHash: `0x${'2'.repeat(64)}`, block: liveState.funding.block, updatedAt: new Date().toISOString() })
    setTimeout(() => {
      const d = liveState.ops.find((o) => o.kind === 'deposit')
      if (d) d.state = 'confirmed'
    }, 34_000)
  }, 6000)

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

// ?divergence (dev only, otto/mamoru#155): the withdrawal's swap-back (selling cbBTC into USDC) would floor
// 2.5% below a made-up "fair" amount, regardless of the asset picked. A fresh quoteId every call, as a real
// operator must mint (never reused across two prepares) — enough to exercise the warning's rendering without
// modeling a real TWAP in a fixture.
let fixtureDivergenceCalls = 0
export function fixtureDivergence(amountUsdc: bigint): PriceDivergenceWarning {
  fixtureDivergenceCalls += 1
  const fairAmount = amountUsdc
  const minAmount = (amountUsdc * 975n) / 1000n // the router floor this leg's signed calldata carries
  const quotedAmount = (amountUsdc * 985n) / 1000n // the live quote, between minAmount and fairAmount; informational only
  const shortfall = fairAmount - minAmount
  return {
    code: 'PRICE_DIVERGENCE',
    legs: [
      {
        kind: 'swap-back',
        token: 'USDC',
        sellToken: 'cbBTC',
        decimals: 6,
        fairAmount: String(fairAmount),
        quotedAmount: String(quotedAmount),
        minAmount: String(minAmount),
        shortfall: String(shortfall),
        shortfallBps: 250,
      },
    ],
    shortfallUsdc: String(shortfall),
    quoteId: `qd_fixture_${Date.now()}_${fixtureDivergenceCalls}`,
  }
}

export const fixtureClient: ApiClient = {
  config: () => delay(liveGate ? { ...fixtureConfig, fundsGate: 'live', dryRun: false, capUsdc: '25000000' } : fixtureConfig),
  session: () => delay(liveState.owner ? sessionNow() : null),
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
      byPool: [
        { pool: 'pool:USDC/USDT/100', weight: 5000, currentPct: 3.1, monthlyPct: 2.8 },
        { pool: 'pool:USDC/cbBTC/500', weight: 4000, currentPct: 9.2, monthlyPct: 8.1 },
        { pool: 'pool:WETH/USDC/3000', weight: 1000, currentPct: 14.6, monthlyPct: 12.9 },
        { pool: 'vault:gtUSDCp', weight: 0, currentPct: 4.84, monthlyPct: 4.61 },
      ],
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
  funding: (k) =>
    operatorDown || (operatorLate && fundingReads++ > 0)
      ? new Promise((_, reject) => setTimeout(() => reject(new ApiRequestError(503, { error: 'The operator is not reachable. Nothing was sent. Try again.', code: 'OPERATOR_UNAVAILABLE' })), 150))
      : operatorChain || operatorChainIdle
        ? delay(chainView())
        : delay(isMonad(k) ? monadState.funding : (braisView() ?? liveState.funding)),
  // ?wrongchain (dev only): 150 USDC was sent on Ethereum to the Base address.
  otherChains: () =>
    delay({
      address: FIXTURE_ADDRESS,
      accountChainId: 8453,
      chains: param('wrongchain') || param('wrongchaineth')
        ? [{ chainId: 1, name: 'Ethereum', status: 'observed' as const, block: 21_000_000, usdc: param('wrongchain') ? liveState.ethereumUsdc : liveState.ethereumUsdc === '150000000' ? '0' : liveState.ethereumUsdc, eth: liveState.ethereumEth, observedAt: new Date().toISOString() }]
        : [{ chainId: 1, name: 'Ethereum', status: 'not_observed' as const, observedAt: new Date().toISOString() }],
    }),
  // otto/mamoru#129: a few cents of uncollected fees, nothing collected yet (true of every live account on 15 Oct).
  yieldLedger: () =>
    delay({
      asOf: new Date().toISOString(),
      accruedUsd: '42000',
      collectedUsd: null,
      earnedSoFarUsd: '42000',
      gasPaidWei: null,
      valueVsHoldUsd: '15000',
      feeAccruedUsd: null,
      // otto/mamoru#234: two weeks of closes, rising with a flat weekend, for the line by "earned so far".
      earnedDaily: Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.now() - (14 - i) * 86_400_000).toISOString().slice(0, 10), earnedUsd: String(Math.round(2800 * i + (i > 6 && i < 9 ? -1200 : 0) + 300 * Math.sin(i))) })),
      lastBalance: { totalUsd: '24873120', readAt: new Date(Date.now() - (operatorDown ? 3 * 60 : 1) * 60_000).toISOString() },
    }),
  ops: (k) => delay({ ops: isMonad(k) ? monadState.ops : liveState.ops }),
  activatePrepare: (k) =>
    delay(
      fixtureTx(
        ['Deploy your Safe on Base', 'Enable the engine session for up to 20 USDC', 'Top up gas reserve to 0.0003 ETH'],
      ),
    ),
  activate: (k) => {
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
      ...(divergenceOn ? { divergence: fixtureDivergence(BigInt(body.amountUsdc)) } : {}),
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
  bridgeOutPrepare: () =>
    delay({ ...fixtureTx(['Move 150.00 USDC from Ethereum to this same account on Base', 'You receive 149.98 USDC on Base, in about 2 s', 'Bridge: Across, fee 0.02 USDC. Mamoru pays the Ethereum gas']), chainId: 1, route: { outputUsdc: '149980000', feeUsdc: '20000', fillSec: 2 } }),
  bridgeOut: () => {
    liveState.ethereumUsdc = '0'
    liveState.bridge = { enabled: true, route: { state: 'deposited', amountUsdc: '150000000', outputUsdc: '149980000', at: new Date().toISOString(), l1Tx: `0x${'1'.repeat(64)}`, depositId: '1' } }
    setTimeout(() => {
      liveState.bridge = { enabled: true, route: { ...liveState.bridge.route!, state: 'filled', fillTx: `0x${'2'.repeat(64)}`, at: new Date().toISOString() } }
      liveState.funding = { ...liveState.funding, usdc: (BigInt(liveState.funding.usdc) + 149_980_000n).toString() }
    }, 4_000)
    return delay(liveState.bridge)
  },
  bridgeOutStatus: () => delay(liveState.bridge),
  ethConvertPrepare: () =>
    delay({
      ...fixtureTx(['Convert 0.05537835 ETH to USDC, in this same account on Ethereum', 'You get about 128.14 USDC, at least 127.50 or nothing changes', 'Swap: Uniswap, ETH/USDC 0.05% pool. Mamoru pays the Ethereum gas. Then Move to Base takes the USDC']),
      chainId: 1,
      convert: { ethWei: '55378350000000000', quotedUsdc: '128145513', minUsdc: '127504785' },
    }),
  ethConvert: () => {
    liveState.ethereumEth = '0'
    liveState.ethereumUsdc = '128145513'
    liveState.bridge = { ...liveState.bridge, convert: { state: 'done', ethWei: '55378350000000000', minUsdc: '127504785', usdcOut: '128145513', l1Tx: `0x${'3'.repeat(64)}`, at: new Date().toISOString() } }
    return delay(liveState.bridge)
  },
  ethereumSiblingStatus: () => delay(liveState.sibling),
  // The operator's lines (bridge-out.ts siblingStepLines) for the ETH of ?wrongchaineth and a 125 USDC limit.
  ethereumSiblingPrepare: () =>
    liveState.sibling.offered
      ? delay({
          ...fixtureTx([
            `Lets Mamoru move what your Safe on Ethereum holds (${Number(liveState.ethereumEth) / 1e18} ETH) to your own Safe on Base, the same address, with no further signature`,
            'Mamoru may only turn ETH into USDC there (Uniswap, under the same price limits as on Base) and send the USDC to your Safe on Base. It can send it nowhere else',
            "At most 125 USDC of value a day, and nothing leaves until Mamoru's guardian has checked your Safe on Base",
            'Mamoru pays the Ethereum gas to set this up; the moves after it are paid from the ETH in this Safe',
          ]),
          chainId: 1,
          built: { input: {} as never, safeTxHash: `0x${'e'.repeat(64)}` as const },
        })
      : Promise.reject(new ApiRequestError(404, { error: 'Mamoru on Ethereum is not available for this account yet', code: 'SIBLING_NOT_OFFERED' })),
  ethereumSibling: () => {
    liveState.sibling = { state: 'sending', offered: false, safe: FIXTURE_ADDRESS }
    setTimeout(() => {
      liveState.sibling = { ...liveState.sibling, state: 'done', l1Tx: `0x${'4'.repeat(64)}` }
    }, 4_000)
    return delay(liveState.sibling)
  },
  // The real lines of a v6 renewal and a v5 -> v6 move (operator planRenew on main, #225), so the dialog is reviewed on the text it gets.
  renewPrepare: () =>
    delay(
      monadUpgrade
        ? {
            // The shape of a real v5 -> v6 move (operator planRenew with remoteLines, #251): one approval, one transaction.
            ...fixtureTx([
              `Renew Mamoru's approval on your Safe ${FIXTURE_ADDRESS} and move it to on-chain limits`,
              `Mamoru can now trade only near the market price, and only the positions it opened`,
              `15% of your savings (Growth) goes to your own Safe on Monad, ${FIXTURE_MONAD_SAFE}: same owner (your passkey), created by Mamoru with no other signature`,
              `On Monad Mamoru may only swap and provide liquidity in WMON/USDC 0.30%, near the market price, paid only to that Safe, until 2027-09-21`,
              `USDC crosses only to that Safe, through Circle's bridge (CCTP), at no fee`,
              `USDC/cbBTC is only wound down, nothing new goes into it`,
              `Engine key 0x7d3E1bA2c4F5a6B7c8D9e0F1a2B3c4D5e6F7a8B9 may keep doing the same kinds of actions for 365 more days, within new limits counted from zero, sized for deposits up to 100.00 USDC (your cap):`,
              `In USDC/USDT 0.01%: swaps, new positions and withdrawals only within 0.10% of the 30- and 5-minute average price and within 0.40% of 1:1; swaps and new positions worth at most 250.00 USDC a day and 500.00 USDC in total on this approval`,
              `In WETH/USDC 0.30%: swaps, new positions and withdrawals only within 1.00% of the 30- and 5-minute average price; swaps and new positions worth at most 70.00 USDC a day and 350.00 USDC in total on this approval`,
              `In USDC/cbBTC 0.05%: swaps, new positions and withdrawals only within 1.00% of the 30- and 5-minute average price; swaps and new positions worth at most 80.00 USDC a day and 400.00 USDC in total on this approval`,
              `Bridge: it may burn USDC with Circle's CCTP only to your own address on Monad (never to another address, never any fee), at most 20.00 USDC a time and 50.00 USDC in total on this approval; a guardian pause stops it`,
              `Each engine transaction pays at most 0.00052 ETH of network fee (at most 0.1 gwei per gas), from your Safe's ETH; these grants allow 104,064 transactions in all`,
              `The approval it replaces is revoked in the same transaction`,
              `Nothing is moved: your positions stay as they are`,
              `Whatever it collects, mints or swaps is paid to your Safe, never to anyone else`,
            ]),
            policyId: 'conservador-live-v6',
            move: true,
            remote: { chainId: 143, address: FIXTURE_MONAD_SAFE, spec: { chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: '0x00000000000000000000000000000000005e5510', validAfter: 1_790_000_000, validUntil: 1_821_536_000, capUsdc: '500000000' } },
          }
        : fixtureTx([
          `Renew Mamoru's approval on your Safe ${FIXTURE_ADDRESS}`,
          `15% of your savings (Growth) goes to your own Safe on Monad, ${FIXTURE_MONAD_SAFE}: same owner (your passkey), created by Mamoru with no other signature`,
          `On Monad Mamoru may only swap and provide liquidity in WMON/USDC 0.30%, near the market price, paid only to that Safe, until 2027-09-21`,
          `USDC crosses only to that Safe, through Circle's bridge (CCTP), at no fee`,
          `Engine key 0x7d3E1bA2c4F5a6B7c8D9e0F1a2B3c4D5e6F7a8B9 may keep doing the same kinds of actions for 365 more days, within new limits counted from zero, sized for deposits up to 100.00 USDC (your cap):`,
          `In USDC/USDT 0.01%: swaps, new positions and withdrawals only within 0.10% of the 30- and 5-minute average price and within 0.40% of 1:1; swaps and new positions worth at most 250.00 USDC a day and 500.00 USDC in total on this approval`,
          `In WETH/USDC 0.30%: swaps, new positions and withdrawals only within 1.00% of the 30- and 5-minute average price; swaps and new positions worth at most 70.00 USDC a day and 350.00 USDC in total on this approval`,
          `In USDC/cbBTC 0.05%: swaps, new positions and withdrawals only within 1.00% of the 30- and 5-minute average price; swaps and new positions worth at most 80.00 USDC a day and 400.00 USDC in total on this approval`,
          `Bridge: it may burn USDC with Circle's CCTP only to your own address on Monad (never to another address, never any fee), at most 20.00 USDC a time and 50.00 USDC in total on this approval; a guardian pause stops it`,
          `Each engine transaction pays at most 0.00052 ETH of network fee (at most 0.1 gwei per gas), from your Safe's ETH; these grants allow 104,064 transactions in all`,
          `The approval it replaces is revoked in the same transaction`,
          `Nothing is moved: your positions stay as they are`,
          `Whatever it collects, mints or swaps is paid to your Safe, never to anyone else`,
      ]),
    ),
  renew: () =>
    delay(
      fixtureOp('renew', () => {
        liveState.funding.approval = { validUntil: Math.floor(Date.now() / 1000) + 365 * 86_400, renewDue: false, expired: false }
      }),
    ),
  feedback: () => delay({ id: `fixture_fb_${liveState.n++}`, received: true as const }),

}
