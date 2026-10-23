import { describe, expect, test } from 'bun:test'
import { Toast, showToast } from '../../src/web/components/toast.tsx'
import { addCopy, toastConfirmed } from '../../src/web/routes/add-money.tsx'
import { render } from './render.ts'

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
    expect(render(<Toast />).html).toBe('')
  })
})
