import type { DashboardPayload, IndexHealth, ReasonCode } from '@mamoru/domain'

// Exact copy from dashboard.md §7 and §8. English, no em dash, no emoji.
export const NOT_OBSERVED = 'Not observed'
export const TRY_AGAIN = 'Try again'
export const DEPOSITS_CLOSED_NOTHING = 'Nothing to manage. Deposits are closed.'
export const INTENTS_UNAVAILABLE = "Mamoru's API does not accept intents in this build."
export const GUIDE_URL = 'https://github.com/ottodevs/mamoru/blob/main/docs/walkaway.md'

export const errors = {
  header: "Can't load your account. Mamoru's API did not respond. Try again.",
  actions: "Can't load actions. Mamoru's API did not respond. Try again.",
  currentAction: "Can't load Mamoru's decisions. Try again.",
  portfolio: "Can't load your portfolio. Try again.",
  treasury: "Can't load your treasury. Try again.",
  positions: "Can't load your positions. Try again.",
  pools: "Can't load pool data. Try again.",
  savings: "Can't load your savings. Try again.",
  savingsLog: "Can't load the savings log. Try again.",
  kit: "Can't load your recovery kit. Try again. The procedure in the guide works without it if you kept the file you downloaded.",
} as const

export const header = {
  otherChains: 'Other chains: not observed in v1.',
  rpcDown: 'Base RPC not responding',
  indexUnknown: 'Index status unknown',
  notDeployed: 'Not deployed',
  deployed: 'Deployed',
}

export function indexStatusText(index: IndexHealth, mode: DashboardPayload['mode']): string {
  const block = index.indexedBlock
  if (mode === 'lab') return block === undefined ? 'Fork index · Base fork' : `Fork index · Base fork · indexed to block ${block}`
  switch (index.status) {
    case 'indexing':
      return block === undefined ? 'MultiBaas · Base' : `MultiBaas · Base · indexed to block ${block}`
    case 'behind':
      return 'MultiBaas is behind. Newer history comes from Base RPC logs.'
    case 'not_indexing_base':
      return 'MultiBaas is not indexing Base. History comes from Base RPC logs.'
    case 'failing':
      return 'MultiBaas queries are failing. History comes from Base RPC logs.'
    case 'not_configured':
      return 'History comes from Base RPC logs.'
  }
}

export const actions = {
  empty: 'Nothing needs your decision.',
  incomplete: 'Mamoru could not check everything. Not observed: ',
}

export const opStates: Readonly<Record<string, string>> = {
  proposed: 'Proposed',
  discarded: 'Discarded',
  prepared: 'Prepared',
  simulated: 'Simulated',
  signed: 'Signed',
  submitted: 'Sent',
  included: 'Included',
  confirmed: 'Confirmed',
  failed: 'Failed',
  pending_reconciliation: 'Checking the network',
}

export function opStateText(state: string, code: ReasonCode): string {
  if (state === 'discarded' && code === 'DRY_RUN_STOP') return 'Simulated, not sent'
  return opStates[state] ?? state
}

export const opNotes: Partial<Record<ReasonCode, string>> = {
  BUNDLER_UNAVAILABLE: 'Waiting to send.',
  RECON_TIMEOUT: 'Waiting for the network.',
  FUNDS_GATE_CLOSED: 'Deposits are closed.',
}

export const currentAction = {
  noDecision: 'Mamoru has not reviewed your account yet. The first review runs within five minutes.',
  noChainOps: 'No operations on Base yet. In simulation mode Mamoru sends nothing.',
  shadow: 'Shadow, not used to decide',
  recentDecisions: 'Recent decisions',
  chainOps: 'Operations on Base',
  paused: 'Paused',
  notPaused: 'Not paused',
  exitInProgress: 'Exit in progress',
  exitPending: 'Exit pending: ',
  exitCompleted: 'Exit completed',
}

export function sessionText(state: DashboardPayload['currentAction']['session']['value'], validUntil?: string): string | null {
  switch (state) {
    case 'active':
      return validUntil ? `Active until ${validUntil}` : 'Active'
    case 'renewal_due':
      return 'Renewal due'
    case 'expired':
      return 'Expired'
    case 'revoked':
      return 'Revoked'
    case 'missing':
      return 'No session. Deposits are closed.'
    case null:
      return null
  }
}

export const portfolio = {
  roles: { plan: 'In your plan', gas: 'Gas only, not invested', outside_plan: 'Not managed by Mamoru' },
  idleNoPool: 'Idle, no executable pool in v1',
  registryOnly: "Only tokens in Mamoru's registry are observed: USDC, cbBTC, WETH and ETH.",
  noPositions: 'No positions. Deposits are closed.',
  noBalances: 'Token balances not observed.',
}

export const treasury = {
  empty: 'Nothing in your treasury yet. Deposits are closed.',
  noSwaps: 'No swaps from your account yet.',
  route: 'Uniswap V3 · USDC/cbBTC 0.05% · SwapRouter02 exactInputSingle · quote from QuoterV2',
  feesNote: 'Fees in cbBTC are converted to USDC inside each harvest.',
  outsideNote: 'Mamoru does not convert tokens outside your plan.',
  convert: {
    nothing_to_convert: 'Nothing to convert.',
    held_for_entry: 'Held for the next entry.',
    converting: 'Converting to USDC.',
    held: 'Waiting for a healthy market',
  },
}

export function convertText(convert: Pick<DashboardPayload['treasury']['convert'], 'state' | 'cause' | 'code'>): string {
  const text = treasury.convert[convert.state]
  if (convert.state !== 'held') return text
  if (convert.cause) return `${text}: `
  // Held by a gate, not by the market: say the gate.
  const gate = convert.code ? opNotes[convert.code] : undefined
  return gate ?? `${text}.`
}

export const positions = {
  empty: 'No positions. Deposits are closed.',
  emptyLab: 'No positions yet.',
  managed: 'Managed by Mamoru',
  unmanaged: 'Not managed by Mamoru',
  inRange: 'In range',
  outOfRange: 'Out of range',
  beforeRetention: 'Out of range for more than 7 days',
  historyIncomplete: 'History incomplete',
  mamoru: 'Mamoru',
  notMamoru: 'Not from Mamoru',
}

export const pools = {
  noSwaps: 'No swaps in the last 24 hours.',
  noLiquidity: 'No liquidity changes in the last 24 hours.',
  added: 'Added',
  removed: 'Removed',
  notSynced: 'Not observed yet. Mamoru has not read the pools in your plan on Base.',
  syncedAt: (at: string) => `Pool data synced ${at}.`,
}

export const savings = {
  empty: 'No savings yet. Deposits are closed.',
  pending: 'Pending, not credited',
  noHarvests: 'No harvests yet.',
}

export const savingsLog = {
  emptyProduction: 'No harvests yet. In simulation mode Mamoru collects nothing.',
  empty: 'No harvests yet.',
  kinds: { harvest: 'Harvest', convert: 'Conversion', withdraw: 'Close' },
}

export const leave = {
  body: 'You can revoke Mamoru and withdraw with your own owner, without Mamoru, its login or MultiBaas. Keep the recovery kit you downloaded during onboarding.',
  walk04: 'If funds reach your account before it is deployed, the guide shows how to deploy it and withdraw with your owner.',
  download: 'Download recovery kit',
  guide: 'Open the guide',
}
