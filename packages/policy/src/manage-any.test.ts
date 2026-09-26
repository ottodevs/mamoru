import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, conservadorLiveV1, conservadorV1, hasManageAny, instantiateGrant, withTestOverrides } from './index.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const
const ctx = {
  account: ACCOUNT,
  sessionKey: '0x00000000000000000000000000000000000000bb' as const,
  chainId: 8453,
  salt: `0x${'00'.repeat(32)}` as const,
  validAfter: 0,
  validUntil: 1,
  caps: { usdcSwapPerCall: 1n, usdcSwapTotal: 1n, usdcMint: 1n, cbbtcMint: 1n, cbbtcConvertPerCall: 1n, cbbtcConvertTotal: 1n },
}

describe('manage-any grants', () => {
  test('only the live policy carries them; lab and spec policies keep per-tokenId manage', () => {
    expect(hasManageAny(conservadorLiveV1)).toBe(true)
    expect(hasManageAny(conservadorV1)).toBe(false)
    expect(hasManageAny(conservadorLabV1)).toBe(false)
  })

  test('every collect, mint and swap pins its recipient to the account; no transfer selector exists', () => {
    for (const name of ['manage-any', 'convert-any'] as const) {
      const g = instantiateGrant(conservadorLiveV1, name, ctx)
      expect(g.tokenId).toBeUndefined()
      for (const a of g.actions) {
        expect(a.signature).not.toMatch(/^(transfer|transferFrom|safeTransferFrom|setApprovalForAll)\(/)
        if (/^(collect|mint|exactInputSingle)\(/.test(a.signature)) {
          const r = a.params.find((p) => p.field === 'recipient')
          expect(r).toMatchObject({ condition: 'EQUAL', ref: BigInt(ACCOUNT) })
        }
        if (a.signature.startsWith('approve(')) expect(a.params[0]!.field).toBe('spender')
      }
    }
  })

  test('the cooldown override needs MAMORU_TEST_OVERRIDES=1', () => {
    expect(withTestOverrides(conservadorLiveV1, { MAMORU_TEST_RERANGE_COOLDOWN_S: '0' }).range.cooldownSeconds).toBe(900)
    expect(withTestOverrides(conservadorLiveV1, { MAMORU_TEST_OVERRIDES: '1', MAMORU_TEST_RERANGE_COOLDOWN_S: '0' }).range.cooldownSeconds).toBe(0)
  })
})
