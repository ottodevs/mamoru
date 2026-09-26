import { describe, expect, test } from 'bun:test'
import { concat, decodeFunctionData, getAddress, keccak256, numberToHex, pad, slice, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, safe7579LaunchpadAbi, safeAbi, safeProxyFactoryAbi } from '@mamoru/registry'
import { createProxyCall, safeInitializer } from '../safe/index.ts'
import {
  SAFE_PROXY_141_CREATION_CODE,
  WALKAWAY_DOC,
  accountSetup,
  counterfactualAddress,
  deployCallFromKit,
  recoveryKit,
  type RecoveryKitInput,
} from './index.ts'

const BACKUP: Address = getAddress('0x00000000000000000000000000000000000000b1')
const OWNERS: Address[] = [address('SafeWebAuthnSharedSigner'), BACKUP]
const SALT_NONCE = 7n
const PIDS: Hex[] = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]

/** CREATE2 as SafeProxyFactory 1.4.1 computes it, written out byte by byte. */
function factoryCreate2(initializer: Hex, saltNonce: bigint): Address {
  const salt = keccak256(concat([keccak256(initializer), numberToHex(saltNonce, { size: 32 })]))
  const initCode = concat([SAFE_PROXY_141_CREATION_CODE, pad(address('SafeL2_141'), { size: 32 })])
  const hash = keccak256(concat(['0xff', address('SafeProxyFactory_141'), salt, keccak256(initCode)]))
  return getAddress(slice(hash, 12))
}

describe('counterfactual address', () => {
  const setup = accountSetup(OWNERS, SALT_NONCE)

  test('setup: the owners, threshold 1, Safe7579, Smart Sessions with no sessions', () => {
    const decoded = decodeFunctionData({ abi: safeAbi, data: safeInitializer(setup) })
    if (decoded.functionName !== 'setup') throw new Error('not Safe.setup')
    const [owners, threshold, to, data, fallbackHandler] = decoded.args
    expect(owners).toEqual(OWNERS)
    expect(threshold).toBe(1n)
    expect(to).toBe(address('Safe7579Launchpad'))
    expect(fallbackHandler).toBe(address('Safe7579'))
    const launch = decodeFunctionData({ abi: safe7579LaunchpadAbi, data })
    const [adapter, validators, executors, fallbacks, hooks, attesters, attesterThreshold] = launch.args
    expect(adapter).toBe(address('Safe7579'))
    expect(validators).toEqual([{ module: address('SmartSession'), initData: '0x' }])
    expect([executors, fallbacks, hooks]).toEqual([[], [], []])
    expect(attesters).toEqual([address('RhinestoneAttester')])
    expect(attesterThreshold).toBe(1)
  })

  test('matches the factory CREATE2 formula for the createProxyCall setup', () => {
    const call = createProxyCall(setup)
    expect(call.to).toBe(address('SafeProxyFactory_141'))
    const { args } = decodeFunctionData({ abi: safeProxyFactoryAbi, data: call.data })
    expect(args[0]).toBe(address('SafeL2_141'))
    expect(args[1]).toBe(safeInitializer(setup))
    expect(args[2]).toBe(SALT_NONCE)
    expect(counterfactualAddress(setup)).toBe(factoryCreate2(args[1], args[2]))
  })

  test('saltNonce and owner order change the address', () => {
    const a = counterfactualAddress(setup)
    expect(counterfactualAddress(accountSetup(OWNERS, SALT_NONCE + 1n))).not.toBe(a)
    expect(counterfactualAddress(accountSetup([...OWNERS].reverse(), SALT_NONCE))).not.toBe(a)
  })

  test('refuses an account with no owner', () => expect(() => accountSetup([], 0n)).toThrow())
})

describe('recovery kit', () => {
  const input: RecoveryKitInput = { chainId: 31337, owners: OWNERS, saltNonce: SALT_NONCE, permissionIds: PIDS, tokenIds: [42n, 43n] }
  const kit = recoveryKit(input)

  test('carries the FR-ONB-006 fields and nothing else', () => {
    expect(Object.keys(kit).sort()).toEqual(['address', 'chainId', 'modules', 'owners', 'permissionIds', 'setup', 'tokenIds', 'walkaway'])
    expect(kit.chainId).toBe(31337)
    expect(kit.address).toBe(counterfactualAddress(accountSetup(OWNERS, SALT_NONCE)))
    expect(kit.owners).toEqual(OWNERS)
    expect(kit.permissionIds).toEqual(PIDS)
    expect(kit.tokenIds).toEqual(['42', '43'])
    expect(kit.walkaway).toBe(WALKAWAY_DOC)
    expect(WALKAWAY_DOC).toBe('docs/walkaway.md')
    expect(kit.modules.adapter).toBe(address('Safe7579'))
    expect(kit.modules.validators).toEqual([{ module: address('SmartSession'), initData: '0x' }])
  })

  test('is plain JSON and round-trips', () => {
    expect(JSON.parse(JSON.stringify(kit))).toEqual(kit)
  })

  test('the kit alone rebuilds the deploy call and the address', () => {
    const fromJson = JSON.parse(JSON.stringify(kit))
    expect(deployCallFromKit(fromJson)).toEqual(createProxyCall(accountSetup(OWNERS, SALT_NONCE)))
    expect(factoryCreate2(fromJson.setup.initializer, BigInt(fromJson.setup.saltNonce))).toBe(kit.address)
  })

  test('has no secret-shaped fields, even when the input carries them', () => {
    const secrets = {
      sessionKeyPrivateKey: `0x${'ab'.repeat(32)}`,
      passkeyScalar: `0x${'cd'.repeat(32)}`,
      signature: `0x${'ef'.repeat(65)}`,
    }
    const leaky = { ...input, ...secrets, sessionKey: '0x00000000000000000000000000000000000000ee' }
    const json = JSON.stringify(recoveryKit(leaky))
    for (const v of [...Object.values(secrets), leaky.sessionKey]) expect(json.toLowerCase()).not.toContain(v.slice(2).toLowerCase())

    const keys: string[] = []
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x))
    }
    walk(JSON.parse(json))
    expect(keys.filter((k) => /secret|private|scalar|signature|session|passkey|mnemonic|seed|credential/i.test(k))).toEqual([])
  })
})
