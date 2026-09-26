import type { OpView } from '@mamoru/domain'

/** One plain line per operation. OpView carries no amounts, so the line says what happened, not how much. */
export function opLine(op: OpView): string {
  const failed = op.state === 'failed'
  switch (op.kind) {
    case 'activate':
      if (failed) return 'Start did not go through'
      if (op.state === 'confirmed') return 'Mamoru started'
      return op.code === 'ARMED' || op.state === 'proposed' ? 'Approved. Starts when USDC lands' : 'Starting Mamoru'
    case 'enter':
      if (failed) return 'Could not open the USDC/cbBTC position'
      return op.state === 'confirmed' ? 'Opened USDC/cbBTC position' : 'Opening USDC/cbBTC position'
    case 'reduce':
      if (failed) return 'Could not reduce the position'
      return op.state === 'confirmed' ? 'Reduced USDC/cbBTC position' : 'Reducing USDC/cbBTC position'
    case 'transfer':
      if (failed) return 'Withdrawal did not go through'
      return op.state === 'confirmed' ? 'Withdrew USDC' : 'Withdrawing USDC'
    case 'exit':
      if (failed) return 'Stop did not go through'
      return op.state === 'confirmed' ? 'Stopped. Everything is back in USDC' : 'Stopping allocation'
  }
}

export function opTone(op: OpView): 'done' | 'pending' | 'failed' {
  return op.state === 'failed' ? 'failed' : op.state === 'confirmed' ? 'done' : 'pending'
}

export const TERMINAL = new Set<OpView['state']>(['confirmed', 'failed'])

/** True when the latest activation is armed or running (not failed). */
export function activationLive(ops: OpView[]): boolean {
  const last = [...ops].filter((o) => o.kind === 'activate').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return last !== undefined && last.state !== 'failed'
}
