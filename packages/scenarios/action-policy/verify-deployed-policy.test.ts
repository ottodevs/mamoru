// Spec 007 (otto/mamoru#151), task T7(a). Unit tests for verify-deployed-policy.ts's bytecode/immutable check, with
// a fake client (no RPC, no fork): exercises the masking logic and every refusal path deterministically. A live
// end-to-end run (real `forge script` deploy against a local anvil Base fork, then this check against it) was done
// by hand while writing this file — real deploy 0x07DaFe0fF1e3d5c1cfFbeE2655fd9568Ccc1dC74 verified OK, a
// mismatched address and a too-short address both refused cleanly (exit 1, no uncaught throw).
import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import { baseRegistry, address } from '@mamoru/registry'
import { verifyDeployedPolicy } from './verify-deployed-policy.ts'

const SMART_SESSION = address('SmartSession', baseRegistry)
const NPM = address('NonfungiblePositionManager', baseRegistry)
const ROUTER = address('SwapRouter02', baseRegistry)
const FACTORY = address('UniswapV3Factory', baseRegistry)

// A tiny synthetic "deployedBytecode": 4 words (32 bytes each) of logic, then 4 immutable words (one per
// constructor arg, in SMART_SESSION/NPM/ROUTER/FACTORY order — order does not matter to the check, only that each
// immutable's own byte range is masked before the rest is compared).
const LOGIC = '11'.repeat(64) // 2 logic words, arbitrary
const addrWord = (a: Address): string => a.slice(2).toLowerCase().padStart(64, '0')
const IMMUTABLE_START = 64 // bytes into the object where the 4 immutable words begin (after LOGIC's 64 bytes)

function buildArtifact(values: { smartSession: Address; npm: Address; router: Address; factory: Address }) {
  const object = (`0x${LOGIC}${addrWord(values.smartSession)}${addrWord(values.npm)}${addrWord(values.router)}${addrWord(values.factory)}`) as Hex
  const immutableReferences = {
    '1': [{ start: IMMUTABLE_START, length: 32 }],
    '2': [{ start: IMMUTABLE_START + 32, length: 32 }],
    '3': [{ start: IMMUTABLE_START + 64, length: 32 }],
    '4': [{ start: IMMUTABLE_START + 96, length: 32 }],
  }
  return { deployedBytecode: { object, immutableReferences } }
}

const GOOD_ARTIFACT = buildArtifact({ smartSession: SMART_SESSION, npm: NPM, router: ROUTER, factory: FACTORY })

function fakeClient(opts: { code?: Hex | undefined; reads?: Partial<Record<'SMART_SESSION' | 'NPM' | 'ROUTER' | 'FACTORY' | 'GUARDIAN', Address>>; throwOnRead?: boolean; throwOnCode?: boolean }) {
  const reads: Partial<Record<string, Address>> = { SMART_SESSION, NPM, ROUTER, FACTORY, ...opts.reads }
  return {
    getCode: async () => {
      if (opts.throwOnCode) throw new Error('rpc down')
      return opts.code
    },
    readContract: async ({ functionName }: { functionName: string }): Promise<Address> => {
      if (opts.throwOnRead) throw new Error('execution reverted')
      const r = reads[functionName]
      if (!r) throw new Error('execution reverted')
      return r
    },
  }
}

describe('verifyDeployedPolicy (otto/mamoru#151 T7a)', () => {
  test('matching immutables and matching masked bytecode: ok', async () => {
    const client = fakeClient({ code: GOOD_ARTIFACT.deployedBytecode.object })
    const result = await verifyDeployedPolicy(client, '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT)
    expect(result).toEqual({ ok: true })
  })

  test('no code at the address: refused, not an address mismatch', async () => {
    const client = fakeClient({ code: '0x' })
    const result = await verifyDeployedPolicy(client, '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('no code')
  })

  test('eth_getCode fails (RPC down): a clean refusal, never an uncaught throw', async () => {
    const client = fakeClient({ throwOnCode: true })
    const result = await verifyDeployedPolicy(client, '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('eth_getCode')
  })

  test('the address has code but does not implement SMART_SESSION()/NPM()/ROUTER()/FACTORY() (e.g. a different contract): a clean refusal', async () => {
    const client = fakeClient({ code: GOOD_ARTIFACT.deployedBytecode.object, throwOnRead: true })
    const result = await verifyDeployedPolicy(client, '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('does not answer')
  })

  test('ROUTER immutable points at an attacker-controlled address: refused, names the mismatched field', async () => {
    const attacker = '0x000000000000000000000000000000000000Ad' as Address
    const client = fakeClient({ code: GOOD_ARTIFACT.deployedBytecode.object, reads: { ROUTER: attacker } })
    const result = await verifyDeployedPolicy(client, '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('ROUTER')
  })

  test('the immutables read correctly but the REST of the deployed bytecode differs (swapped-logic contract behind the same getters): refused', async () => {
    const tamperedObject = `0x${'22'.repeat(64)}${GOOD_ARTIFACT.deployedBytecode.object.slice(2 + 128)}` as Hex // same immutables, different logic words
    const client = fakeClient({ code: tamperedObject })
    const result = await verifyDeployedPolicy(client, '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('does not match')
  })

  test('deployed bytecode is a different length entirely (not even the same shape of contract): refused', async () => {
    const client = fakeClient({ code: `${GOOD_ARTIFACT.deployedBytecode.object}00` as Hex })
    const result = await verifyDeployedPolicy(client, '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('length')
  })
})

describe('verifyDeployedPolicy, MamoruActionPolicyV2 (otto/mamoru#151): the GUARDIAN immutable is checked by value', () => {
  const G = '0x00000000000000000000000000000000000006a2' as Address
  const code = GOOD_ARTIFACT.deployedBytecode.object

  test('the guardian the coordinator names: ok', async () => {
    expect(await verifyDeployedPolicy(fakeClient({ code, reads: { GUARDIAN: G } }), '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT, { guardian: G })).toEqual({ ok: true })
  })

  test('another guardian, or none answered (a V1): refused', async () => {
    const other = await verifyDeployedPolicy(fakeClient({ code, reads: { GUARDIAN: '0x0000000000000000000000000000000000000bad' } }), '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT, { guardian: G })
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.reason).toContain('GUARDIAN')
    const none = await verifyDeployedPolicy(fakeClient({ code }), '0x1234567890123456789012345678901234567890', GOOD_ARTIFACT, { guardian: G })
    expect(none.ok).toBe(false)
  })
})
