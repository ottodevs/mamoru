import { describe, expect, test } from 'bun:test'
import { concat, decodeFunctionData, getAddress, keccak256, numberToHex, pad, slice, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, multiSendCallOnlyAbi, safe7579LaunchpadAbi, safeAbi, safeProxyFactoryAbi, safeWebAuthnSharedSignerAbi } from '@mamoru/registry'
import { OPERATION_DELEGATECALL, createProxyCall, packVerifiers, safeInitializer, webAuthnSigner, type WebAuthnSigner } from '../safe/index.ts'
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
// Public key of the software passkey a1 (packages/scenarios/webauthn); test material only.
const PASSKEY: WebAuthnSigner = webAuthnSigner(
  0x984225585d2285c138033d6140e3cef8b91859704e53c313f8b636ba4f967649n,
  0x9734144f46fd19a767a545287c4396b97b69dd38faaea8981adc1a4fed9b401en,
)

/** Unpacks MultiSend transactions: uint8 op, address to, uint256 value, uint256 len, bytes data. */
function unpackMultiSend(packed: Hex): { operation: number; to: Address; value: bigint; data: Hex }[] {
  const out: { operation: number; to: Address; value: bigint; data: Hex }[] = []
  const hex = packed.slice(2)
  for (let o = 0; o < hex.length; ) {
    const operation = parseInt(hex.slice(o, o + 2), 16)
    const to = getAddress(`0x${hex.slice(o + 2, o + 42)}`)
    const value = BigInt(`0x${hex.slice(o + 42, o + 106)}`)
    const len = Number(BigInt(`0x${hex.slice(o + 106, o + 170)}`))
    const data = `0x${hex.slice(o + 170, o + 170 + len * 2)}` as Hex
    out.push({ operation, to, value, data })
    o += 170 + len * 2
  }
  return out
}
const PIDS: Hex[] = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]

/** CREATE2 as SafeProxyFactory 1.4.1 computes it, written out byte by byte. */
function factoryCreate2(initializer: Hex, saltNonce: bigint): Address {
  const salt = keccak256(concat([keccak256(initializer), numberToHex(saltNonce, { size: 32 })]))
  const initCode = concat([SAFE_PROXY_141_CREATION_CODE, pad(address('SafeL2_141'), { size: 32 })])
  const hash = keccak256(concat(['0xff', address('SafeProxyFactory_141'), salt, keccak256(initCode)]))
  return getAddress(slice(hash, 12))
}

describe('counterfactual address', () => {
  const setup = accountSetup(OWNERS, SALT_NONCE, PASSKEY)

  test('setup: the owners, threshold 1, Safe7579, Smart Sessions with no sessions, passkey configured in the same setup', () => {
    const decoded = decodeFunctionData({ abi: safeAbi, data: safeInitializer(setup) })
    if (decoded.functionName !== 'setup') throw new Error('not Safe.setup')
    const [owners, threshold, to, data, fallbackHandler] = decoded.args
    expect(owners).toEqual(OWNERS)
    expect(threshold).toBe(1n)
    expect(to).toBe(address('MultiSend_141'))
    expect(fallbackHandler).toBe(address('Safe7579'))
    const batch = decodeFunctionData({ abi: multiSendCallOnlyAbi, data })
    const [launchCall, configureCall] = unpackMultiSend(batch.args[0])
    expect(unpackMultiSend(batch.args[0])).toHaveLength(2)
    expect([launchCall!.operation, launchCall!.to, launchCall!.value]).toEqual([OPERATION_DELEGATECALL, address('Safe7579Launchpad'), 0n])
    expect([configureCall!.operation, configureCall!.to, configureCall!.value]).toEqual([OPERATION_DELEGATECALL, address('SafeWebAuthnSharedSigner'), 0n])
    const cfg = decodeFunctionData({ abi: safeWebAuthnSharedSignerAbi, data: configureCall!.data })
    expect(cfg.args[0]).toEqual({ x: PASSKEY.x, y: PASSKEY.y, verifiers: packVerifiers(0x100, address('P256Verifier')) })
    const launch = decodeFunctionData({ abi: safe7579LaunchpadAbi, data: launchCall!.data })
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
    expect(counterfactualAddress(accountSetup(OWNERS, SALT_NONCE + 1n, PASSKEY))).not.toBe(a)
    expect(counterfactualAddress(accountSetup([...OWNERS].reverse(), SALT_NONCE, PASSKEY))).not.toBe(a)
  })

  test('the address commits to the passkey: another key or verifier gives another address', () => {
    const a = counterfactualAddress(setup)
    expect(counterfactualAddress(accountSetup(OWNERS, SALT_NONCE, { ...PASSKEY, x: PASSKEY.x + 1n }))).not.toBe(a)
    expect(counterfactualAddress(accountSetup(OWNERS, SALT_NONCE, { ...PASSKEY, verifiers: packVerifiers(0x100, BACKUP) }))).not.toBe(a)
  })

  test('refuses a shared-signer owner without its passkey, and a passkey without the shared-signer owner', () => {
    expect(() => accountSetup(OWNERS, SALT_NONCE, null)).toThrow()
    expect(() => accountSetup([BACKUP], SALT_NONCE, PASSKEY)).toThrow()
  })

  test('without a passkey owner the setup delegatecalls the launchpad directly', () => {
    const decoded = decodeFunctionData({ abi: safeAbi, data: safeInitializer(accountSetup([BACKUP], SALT_NONCE, null)) })
    expect(decoded.args[2]).toBe(address('Safe7579Launchpad'))
  })

  test('refuses an account with no owner', () => expect(() => accountSetup([], 0n, null)).toThrow())
})

describe('recovery kit', () => {
  const input: RecoveryKitInput = { chainId: 31337, owners: OWNERS, saltNonce: SALT_NONCE, webauthn: PASSKEY, permissionIds: PIDS, tokenIds: [42n, 43n] }
  const kit = recoveryKit(input)

  test('carries the FR-ONB-006 fields and nothing else', () => {
    expect(Object.keys(kit).sort()).toEqual(['address', 'chainId', 'modules', 'owners', 'permissionIds', 'setup', 'tokenIds', 'walkaway', 'webauthn'])
    expect(kit.chainId).toBe(31337)
    expect(kit.address).toBe(counterfactualAddress(accountSetup(OWNERS, SALT_NONCE, PASSKEY)))
    expect(kit.webauthn).toEqual({ signer: address('SafeWebAuthnSharedSigner'), x: PASSKEY.x.toString(), y: PASSKEY.y.toString(), verifiers: PASSKEY.verifiers.toString() })
    const [, , to, data] = decodeFunctionData({ abi: safeAbi, data: kit.setup.initializer }).args as unknown as [unknown, unknown, Address, Hex]
    expect([kit.setup.to, kit.setup.data]).toEqual([to, data])
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
    expect(deployCallFromKit(fromJson)).toEqual(createProxyCall(accountSetup(OWNERS, SALT_NONCE, PASSKEY)))
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
