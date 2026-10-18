// Spec 007 T7: the live (v2/v3 and earlier) policies stay byte-identical. Captured at 15033b6 (before the T7 changes to
// toSmartSession, activationCall and activationBatch): each policy's hash and the keccak of the enableSessions
// calldata of its full grant set with fixed salts, key and validity. A change here changes what live owners sign.
import { describe, expect, test } from 'bun:test'
import { keccak256 } from 'viem'
import { POLICIES, computeCaps, grantKey, instantiateGrant, policyHash } from '@mamoru/policy'
import { activationCall } from './index.ts'

const CAPTURED: Record<string, string> = {
  'hash:conservador-lab-geometry-v1': '0x80523980a91354ff4593b109e62d2168d2a9525ae6e1d37d9fdc7299b4d83162',
  'enable:conservador-lab-geometry-v1': '0x6c1ed24bbcc90c8fcbb19dde3ae22565176c993417dcc8b30abefb918324eb4d',
  'hash:conservador-lab-guards-v1': '0x5a1e148c145901727b6848f9188c5a2c7bc362e4ea36fb5bf2a93e7ad9331ed2',
  'enable:conservador-lab-guards-v1': '0x6c1ed24bbcc90c8fcbb19dde3ae22565176c993417dcc8b30abefb918324eb4d',
  'hash:conservador-lab-v1': '0xcceafbb24a2e9ef40e496a756f97d338eec76a08f4a2e4a3eb9185240339b3c2',
  'enable:conservador-lab-v1': '0x4b46ef19e0fac51a2dd8ed29564ab7e5ac1641db8f28faf8ff7131346bdd0fac',
  'hash:conservador-live-v1': '0xa8973212b542a232f25e09b73ef39c8496c5b5f599667f2a9236109fc6660376',
  'enable:conservador-live-v1': '0xef69e0633e664abecdd1e58271bf2dfdfb05fd14774ab0ef260f0aae27620ded',
  'hash:conservador-live-v2': '0x3b4759978007f38513d67d64d09b65957e90f9ab4d0c75afa22a1d016d939cf0',
  'enable:conservador-live-v2': '0x6c1ed24bbcc90c8fcbb19dde3ae22565176c993417dcc8b30abefb918324eb4d',
  'hash:conservador-v1': '0xb98c8b55215256eb21ba107ed84e8ee54cfe4658422528cebcdb91e5c9345d18',
  'enable:conservador-v1': '0x4b46ef19e0fac51a2dd8ed29564ab7e5ac1641db8f28faf8ff7131346bdd0fac',
  'hash:lab-weth-usdc-v1': '0x7eb02363bcc36716f3558bded564e9a84ea7ee1866ed7c06ecb408f8eba5405b',
  'enable:lab-weth-usdc-v1': '0xe7cd64b0264b3faf8383982f786ace071e16934b521769eee37c1809047ebb8a',
}

describe('live policies are byte-identical after T7', () => {
  test('policy hashes and enableSessions calldata', () => {
    const out: Record<string, string> = {}
    for (const id of Object.keys(POLICIES).sort()) {
      const p = POLICIES[id]!
      out[`hash:${id}`] = policyHash(p)
      const prices = { cbBTC: { num: 1n, den: 100_000n }, USDT: { num: 1n, den: 1n }, WETH: { num: 1n, den: 3_000n } }
      const caps = computeCaps(p, 1_000_000_000n, prices)
      const grants = p.session.grants
        .filter((g) => !g.perPosition)
        .map((t, i) => instantiateGrant(p, grantKey(t), { account: '0x00000000000000000000000000000000000000aa', sessionKey: '0x00000000000000000000000000000000000000bb', chainId: p.chain === 'base' ? 8453 : 31337, salt: `0x${(i + 1).toString(16).padStart(64, '0')}`, validAfter: 100, validUntil: 200, caps, capUsdc: 1_000_000_000n }))
      out[`enable:${id}`] = keccak256(activationCall(grants, []).data)
    }
    expect(out).toEqual(CAPTURED)
  })
})
