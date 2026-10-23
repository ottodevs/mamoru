import { describe, expect, test } from 'bun:test'
import { Toast, showToast, toastConfirmed } from '../../src/web/components/toast.tsx'
import { addCopy } from '../../src/web/routes/add-money.tsx'
import { encodeAbiParameters, pad, toEventSelector, type Hex, type Log } from 'viem'
import { movedUsdc, USDC_BASE } from '../../src/web/lib/wallet-client.ts'
import { render } from './render.ts'

const FROM: Hex = '0x1111111111111111111111111111111111111111'
const TO: Hex = '0x2222222222222222222222222222222222222222'
const transfer = (token: Hex, from: Hex, to: Hex, value: bigint): Log =>
  ({
    address: token,
    topics: [toEventSelector('Transfer(address,address,uint256)'), pad(from), pad(to)],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
  }) as unknown as Log

describe('Add capital, after the send (otto/mamoru#191)', () => {
  test('the Base-only notice is one sentence in the agreed words', () => {
    expect(addCopy.baseOnly).toBe("Only USDC on Base. Any other token or network won't reach your account.")
    expect(`${addCopy.baseOnlyLead} ${addCopy.baseOnlyRest}`).toBe(addCopy.baseOnly)
  })

  test('a confirmed transfer says the amount and links the transaction on Basescan, then goes', async () => {
    const tx = `0x${'ab'.repeat(32)}`
    toastConfirmed(tx, 13_970_000n)
    const shown = render(<Toast />)
    expect(shown.text).toContain('Confirmed on Base. 13.97 USDC added.')
    expect(shown.html).toContain(`https://basescan.org/tx/${tx}`)
    expect(shown.text).toContain('View on Basescan')
    showToast({ text: 'gone soon' }, 5)
    await Bun.sleep(20)
    // The live region stays in the page, empty, for the next message to be read out.
    expect(render(<Toast />).html).toBe('<div role="status" aria-live="polite" data-testid="toast"></div>')
  })

  test('only a receipt that moves exactly that USDC to the account counts: a cancel or another token does not', () => {
    expect(movedUsdc([transfer(USDC_BASE, FROM, TO, 5_000_000n)], FROM, TO, 5_000_000n)).toBe(true)
    // A replacement that cancels (self-transfer of ETH): no logs.
    expect(movedUsdc([], FROM, TO, 5_000_000n)).toBe(false)
    expect(movedUsdc([transfer(USDC_BASE, FROM, TO, 4_000_000n)], FROM, TO, 5_000_000n)).toBe(false)
    expect(movedUsdc([transfer(USDC_BASE, FROM, FROM, 5_000_000n)], FROM, TO, 5_000_000n)).toBe(false)
    expect(movedUsdc([transfer('0x3333333333333333333333333333333333333333', FROM, TO, 5_000_000n)], FROM, TO, 5_000_000n)).toBe(false)
  })
})
