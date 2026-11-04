import type { FundingView, Hex0x, MoneyChain, OpView } from '@mamoru/domain'
import { braisFlight, BRAIS_BURN_TX, BRAIS_MINT_TX, BRAIS_MONAD_RECIPIENT } from './transfer.ts'

// otto/mamoru#263: Brais's move from v5 to v6 on 1 Nov (1-projects/mamoru/operations/brais-v6-beta-2026-11-01.md, b), at
// five moments: signing, Base being rebalanced, the share on its way, the USDC waiting in his Monad Safe, done. The ops are
// the operator's OpView rows with the real transactions; times are relative to `now` (minutes after the first approval
// as on the day). Dev (?upgrade=<moment>) and tests.

export type UpgradeMoment = 'signing' | 'rebalancing' | 'bridging' | 'waiting' | 'done'

const TX = {
  renew1: '0xb94175f234bd3503f4d594977e7929914a6876231c39b5db9175c901f297ac8b',
  renew2: '0xce556be2fc80b67c0202bb66eebf2066027bd1b021b56d75b56e431a28539189',
  reduce: '0x222e72dab1b3429b47a249eb5ac8c92cc76b56c87aef6eb9c014794e8410b741',
  swap: '0x127fd5c348c7dc03ad5ef5a441727bb8587e9b0e5f3b1cc4cc59f1b5555a8009',
  swapWeth: '0xc01fe55484262bfd06c947dc7fa1accb6c832493b1fd2853954e3fd4f16695e9',
  mintWeth: '0x51136724eb5698a743f92e9c9d2308e44e7580668590dc375f560472b195209f',
} satisfies Record<string, Hex0x>

/** Minutes after the first approval (10:19:39) of each step on the day. */
const MIN = { renew1: 0, renew2: 0.6, reduce: 0.8, swap: 2, burn: 3.2, swapWeth: 4.5, mintWeth: 5.6, mint: 18.9, lp: 22 }

/** How far into the move each moment is, in minutes. */
const AT: Record<UpgradeMoment, number> = { signing: 0.3, rebalancing: 1.5, bridging: 9, waiting: 25, done: 40 }

export function braisUpgrade(moment: UpgradeMoment, now: number = Date.now()): { funding: FundingView; ops: OpView[] } {
  const start = now - AT[moment] * 60_000
  const at = (m: number) => new Date(start + m * 60_000).toISOString()
  const reached = (m: number) => AT[moment] >= m
  const ops: OpView[] = [
    { opId: 'own-13-renew', kind: 'renew', state: reached(0.2) ? 'confirmed' : 'submitted', txHash: TX.renew1, updatedAt: at(MIN.renew1) },
    ...(reached(0.3) ? [{ opId: 'own-14-renew', kind: 'renew', state: moment === 'signing' ? 'submitted' : 'confirmed', ...(moment === 'signing' ? {} : { txHash: TX.renew2 }), updatedAt: at(MIN.renew2) } as OpView] : []),
    ...(reached(MIN.reduce) ? [{ opId: 'eng-3-1-a-reduce', kind: 'reduce', step: 'reduce', state: 'confirmed', pool: 'pool:USDC/cbBTC/500', tokenId: '6296541', txHash: TX.reduce, updatedAt: at(MIN.reduce) } as OpView] : []),
    ...(reached(1.4) ? [{ opId: 'eng-3-1-b-enter_swap', kind: 'enter', step: 'enter_swap', state: reached(MIN.swap) ? 'confirmed' : 'submitted', pool: 'pool:USDC/cbBTC/500', tokenIn: 'cbBTC', tokenOut: 'USDC', amountIn: '5162', ...(reached(MIN.swap) ? { txHash: TX.swap } : {}), updatedAt: at(Math.min(AT[moment], MIN.swap)) } as OpView] : []),
    ...(reached(MIN.burn) ? [{ opId: 'eng-3-2-a-bridge_out', kind: 'enter', step: 'bridge_out', state: 'confirmed', pool: 'pool:WMON/USDC/3000', amountIn: '2075638', bridge: { chainId: 143, amountUsdc: '2075638', state: reached(MIN.mint) ? 'minted' : 'burned', burnTx: BRAIS_BURN_TX, burnedAt: at(MIN.burn), recipient: BRAIS_MONAD_RECIPIENT, ...(reached(MIN.mint) ? { mintTx: BRAIS_MINT_TX, mintedAt: at(MIN.mint) } : {}) }, txHash: BRAIS_BURN_TX, updatedAt: at(MIN.burn) } as OpView] : []),
    ...(reached(MIN.swapWeth) ? [{ opId: 'eng-3-3-a-enter_swap', kind: 'enter', step: 'enter_swap', state: 'confirmed', pool: 'pool:WETH/USDC/3000', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '1729513', txHash: TX.swapWeth, updatedAt: at(MIN.swapWeth) } as OpView] : []),
    ...(reached(MIN.mintWeth) ? [{ opId: 'eng-3-3-b-enter_mint', kind: 'enter', step: 'enter_mint', state: 'confirmed', pool: 'pool:WETH/USDC/3000', tokenId: '6436365', txHash: TX.mintWeth, updatedAt: at(MIN.mintWeth) } as OpView] : []),
  ]
  // The funding view: the move's approval is offered until it lands; the Monad Safe exists once the approval is in.
  const base = braisFlight(reached(MIN.mint) ? 'minted' : reached(MIN.burn) ? 'burned' : 'sending', now)
  const f: FundingView = structuredClone(base)
  const signing = moment === 'signing'
  f.approval = signing ? { validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v5', upgrade: true, upgradePolicy: 'conservador-live-v6' } : { validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v6' }
  if (!signing) f.remote = { chainId: 143, address: BRAIS_MONAD_RECIPIENT, ready: true, spec: { chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: '0x0000000000000000000000000000000000000143', validAfter: 0, validUntil: 2_000_000_000, capUsdc: '100000000' } }
  f.progress = moment === 'rebalancing' ? { step: 'swapping', pool: 'pool:USDC/cbBTC/500', since: at(1.4) } : null
  const m = f.money!
  if (!reached(MIN.burn)) m.inFlight = []
  else if (reached(MIN.mint)) {
    // Minted and read on Monad: the money is in the Monad chain's read, no longer in flight.
    m.inFlight = []
    const monad = m.chains.find((c) => c.chainId === 143) ?? ({ chainId: 143, safe: BRAIS_MONAD_RECIPIENT, explorerUrl: '', read: { block: 41_806_100, at: at(AT[moment]), stale: false }, idle: [], positions: [], gas: { symbol: 'MON', amount: '3040400000000000000' }, totalUsdc: '0' } as MoneyChain)
    monad.safe = BRAIS_MONAD_RECIPIENT
    if (moment === 'done') {
      monad.idle = []
      monad.positions = [{ tokenId: '49233', chainId: 143, pool: 'pool:WMON/USDC/3000', liquidity: '1', inRange: true, amountUsdc: '1037819', amountCbbtc: '0', valueUsdc: '2075000', amounts: [{ token: 'WMON', amount: '60000000000000000000', decimals: 18, valueUsdc: '1037181' }, { token: 'USDC', amount: '1037819', decimals: 6, valueUsdc: '1037819' }] }]
      monad.totalUsdc = '2075000'
    } else {
      monad.idle = [{ token: 'USDC', amount: '2075638', decimals: 6, valueUsdc: '2075638', why: { code: 'EHG_SIM_UNAVAILABLE' } }]
      monad.positions = []
      monad.totalUsdc = '2075638'
    }
    if (!m.chains.includes(monad)) m.chains.push(monad)
    m.totalUsdc = (m.chains.reduce((a, c) => a + BigInt(c.totalUsdc), 0n)).toString()
  }
  return { funding: f, ops }
}
