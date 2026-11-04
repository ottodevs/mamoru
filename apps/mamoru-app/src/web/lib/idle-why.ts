import type { MoneyWhy } from '@mamoru/domain'
import { chainLabel } from './positions.ts'
import { clockTime } from './time.ts'

// otto/mamoru#265: why money sits idle on a chain, in words. The operator sends the engine's last reason code with the
// chain's idle USDC (`MoneyChain.idle[].why`); the owner never sees the code itself. A code this app does not know says
// only that the money waits: an operator newer than the app never shows an error or a raw code.

export const idleWhyCopy = {
  waiting: 'Waiting to be invested',
  checked: (time: string) => `Checked at ${time}.`,
  retrying: 'Mamoru tries again on its own.',
}

/** The sentence for a reason code, on the chain the money waits on; null for a code this app does not know. */
function sentence(code: string, chain: string): { text: string; transient: boolean } | null {
  switch (code) {
    case 'DECIDE_WAIT_DEPTH':
      return { text: 'the pool cannot take more right now without moving its price', transient: false }
    case 'DECIDE_ENTRY_PAUSED_FALL':
      return { text: 'its market is falling fast, so Mamoru adds nothing until it settles', transient: false }
    case 'DECIDE_WAIT_GAS':
      return { text: 'it is still too small to place at a profit', transient: false }
    case 'DECIDE_NO_CAPITAL':
      return { text: 'it is under the smallest amount Mamoru places', transient: false }
    case 'DECIDE_WAIT_BRIDGE':
      return { text: `a transfer to your ${chain} Safe is still on its way`, transient: false }
    case 'DECIDE_WAIT_VAULT_LIQUIDITY':
      return { text: 'the lending vault is busy right now', transient: true }
    case 'EHG_SIM_UNAVAILABLE':
      return { text: `Mamoru cannot check the swap on ${chain} before sending it, so it sends nothing yet`, transient: true }
    case 'EHG_QUOTE_UNAVAILABLE':
    case 'EHG_TWAP_UNAVAILABLE':
      return { text: `there is no reliable price on ${chain} right now`, transient: true }
    case 'OBS_RPC_UNAVAILABLE':
      return { text: `${chain} cannot be read right now`, transient: true }
    case 'GAS_PRICE_OVER_CAP':
      return { text: `network fees on ${chain} are above Mamoru's limit right now`, transient: true }
    default:
      return null
  }
}

/**
 * "Waiting to be invested: the pool cannot take more right now without moving its price. Checked at 10:40." A reason
 * that clears by itself adds that Mamoru retries. Without a reason (or one this app does not know): the first words only.
 */
export function idleWhyLine(why: MoneyWhy | undefined, chainId: number): string {
  const s = why ? sentence(why.code, chainLabel(chainId)) : null
  if (!s) return `${idleWhyCopy.waiting}.`
  const at = why?.since ? clockTime(why.since) : ''
  return [`${idleWhyCopy.waiting}: ${s.text}.`, s.transient ? idleWhyCopy.retrying : null, at ? idleWhyCopy.checked(at) : null].filter(Boolean).join(' ')
}

/** Whether this app has words for a reason code (tests, and the fixtures that mirror the operator). */
export function knownIdleWhy(code: string): boolean {
  return sentence(code, '') !== null
}
