import { describe, expect, test } from 'bun:test'
import type { OpView, OwnerTxToSign } from '@mamoru/domain'
import { fixtureFunding } from '../../src/web/fixtures/client.ts'
import { base64url } from '../../src/web/lib/passkey.ts'
import { base64urlDecode, hexToBytes } from '../../src/web/lib/passkey-sign.ts'
import { ActivityList, FundingBlock, isAddress, parseUsdc, PositionsList, ReviewCard } from '../../src/web/panels/live.tsx'
import { render } from './render.ts'

describe('live panel helpers', () => {
  test('parseUsdc converts to base units and refuses bad input', () => {
    expect(parseUsdc('12.5')).toBe('12500000')
    expect(parseUsdc('0.000001')).toBe('1')
    expect(parseUsdc('25')).toBe('25000000')
    expect(parseUsdc('0')).toBeNull()
    expect(parseUsdc('1.0000001')).toBeNull()
    expect(parseUsdc('-1')).toBeNull()
  })
  test('isAddress', () => {
    expect(isAddress(`0x${'a'.repeat(40)}`)).toBe(true)
    expect(isAddress('0x123')).toBe(false)
  })
  test('safeTxHash hex becomes the 32 challenge bytes; base64url round-trips', () => {
    const bytes = hexToBytes(`0x${'0f'.repeat(32)}`)
    expect(bytes.length).toBe(32)
    expect(bytes[0]).toBe(15)
    expect(Array.from(base64urlDecode(base64url(bytes)))).toEqual(Array.from(bytes))
  })
})

describe('live panel views', () => {
  test('funding shows the Safe, the cap, balances at a block and the flags', () => {
    const { text } = render(<FundingBlock f={fixtureFunding} />)
    expect(text).toContain('Send USDC on Base to this address. Cap 25 USDC.')
    expect(text).toContain('20 USDC')
    expect(text).toContain('Base · block 36000000')
    expect(text).toContain('View on Basescan')
    expect(text).toContain('Safe deployed No')
    expect(text).toContain('Engine active No')
  })
  test('positions link to Uniswap', () => {
    const { html, text } = render(
      <PositionsList positions={[{ tokenId: '7', pool: `0x${'1'.repeat(40)}`, liquidity: '1', inRange: false, amountUsdc: '1000000', amountCbbtc: '100' }]} />,
    )
    expect(html).toContain('https://app.uniswap.org/positions/v3/base/7')
    expect(text).toContain('Out of range')
  })
  test('activity shows kind, state, code and the tx link', () => {
    const ops: OpView[] = [
      { opId: 'a', kind: 'activate', state: 'confirmed', txHash: `0x${'b'.repeat(64)}`, block: 9, updatedAt: '2026-09-26T20:00:00Z' },
      { opId: 'b', kind: 'transfer', state: 'failed', code: 'RELAY_REVERTED', updatedAt: '2026-09-26T20:05:00Z' },
    ]
    const { html, text } = render(<ActivityList ops={ops} />)
    expect(text).toContain('Start allocation')
    expect(text).toContain('Confirmed')
    expect(text).toContain('RELAY_REVERTED')
    expect(html).toContain(`https://basescan.org/tx/0x${'b'.repeat(64)}`)
  })
  test('review lists the reduce plan and summary before signing', () => {
    const tx: OwnerTxToSign = {
      safe: fixtureFunding.address,
      chainId: 8453,
      safeTxHash: `0x${'c'.repeat(64)}`,
      summary: ['Transfer 10 USDC'],
      expiresAt: '2026-09-26T21:00:00Z',
      prepareId: 'p1',
    }
    const { text } = render(
      <ReviewCard title="Transfer out" tx={tx} reduce={[{ tokenId: '7', liquidityBps: 5000 }]} busy={false} error={null} onApprove={() => {}} onCancel={() => {}} />,
    )
    expect(text).toContain('Reduce position #7 by 50%')
    expect(text).toContain('Transfer 10 USDC')
    expect(text).toContain('Approve with passkey')
  })
})
