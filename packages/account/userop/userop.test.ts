import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, keccak256, toEventSelector, type Log, type TransactionReceipt } from 'viem'
import type { Address, Hex } from '@mamoru/domain'
import { address, entryPointV07Abi } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '../recovery/index.ts'
import { webAuthnSigner } from '../safe/index.ts'
import { deployCall, type LiveAccount } from '../live/index.ts'
import { maxGasCostWei, ownerUserOp, ownerUserOpSignature, packedInitCode, packedPaymasterAndData, safeOpHash, userOpLogs } from './index.ts'

const owners = [address('SafeWebAuthnSharedSigner')]
const webauthn = webAuthnSigner(1n, 2n)
const live: LiveAccount = { safe: counterfactualAddress(accountSetup(owners, 7n, webauthn)), chainId: 1, owners, saltNonce: 7n, webauthn }
const gas = { verificationGasLimit: 700_000n, callGasLimit: 200_000n, preVerificationGas: 80_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n }
const call = { to: '0x00000000000000000000000000000000000000aa' as Address, value: 0n, data: '0x1234' as Hex }
const pm = { paymaster: '0x777777777777AeC03fd955926DbF81597e66834C' as Address, paymasterVerificationGasLimit: 60_000n, paymasterPostOpGasLimit: 70_000n, paymasterData: '0xabcd' as Hex }

describe('owner userOp (#180)', () => {
  test('an undeployed account carries its own deployment as initCode; a deployed one does not', () => {
    const op = ownerUserOp({ live, deployed: false, nonce: 0n, calls: [call], gas, paymaster: pm })
    const d = deployCall(live)
    expect(op.sender).toBe(live.safe)
    expect(op.factory).toBe(d.to)
    expect(op.factoryData).toBe(d.data)
    expect(packedInitCode(op)).toBe(`${d.to}${d.data.slice(2)}` as Hex)
    expect(packedPaymasterAndData(op).length).toBe(2 + 2 * (20 + 16 + 16 + 2))
    const deployed = ownerUserOp({ live, deployed: true, nonce: 3n, calls: [call], gas })
    expect(deployed.factory).toBeUndefined()
    expect(packedInitCode(deployed)).toBe('0x')
    expect(packedPaymasterAndData(deployed)).toBe('0x')
  })

  test('only nonce key 0 (no validator: the Safe owners decide)', () => {
    expect(() => ownerUserOp({ live, deployed: true, nonce: 1n << 64n, calls: [call], gas })).toThrow('nonce key 0')
    expect(() => ownerUserOp({ live, deployed: true, nonce: 0n, calls: [], gas })).toThrow('no calls')
  })

  test('the SafeOp hash covers initCode, callData, gas, fees, paymaster data and validity', () => {
    const op = ownerUserOp({ live, deployed: false, nonce: 0n, calls: [call], gas, paymaster: pm })
    const h = safeOpHash(op, 1, 0, 1_800_000_000)
    expect(safeOpHash(op, 1, 0, 1_800_000_000)).toBe(h)
    expect(safeOpHash({ ...op, factory: undefined, factoryData: undefined }, 1, 0, 1_800_000_000)).not.toBe(h)
    expect(safeOpHash({ ...op, paymasterData: '0xabce' }, 1, 0, 1_800_000_000)).not.toBe(h)
    expect(safeOpHash({ ...op, maxFeePerGas: op.maxFeePerGas + 1n }, 1, 0, 1_800_000_000)).not.toBe(h)
    expect(safeOpHash(op, 8453, 0, 1_800_000_000)).not.toBe(h)
    expect(safeOpHash(op, 1, 0, 1_800_000_001)).not.toBe(h)
    expect(safeOpHash({ ...op, signature: '0xff' }, 1, 0, 1_800_000_000)).toBe(h)
  })

  test('signature is validAfter(6) | validUntil(6) | Safe signatures; the prefund counts every gas limit', () => {
    expect(ownerUserOpSignature(1, 2, '0xaabb')).toBe('0x000000000001000000000002aabb')
    const op = ownerUserOp({ live, deployed: false, nonce: 0n, calls: [call], gas, paymaster: pm })
    expect(maxGasCostWei(op)).toBe((700_000n + 200_000n + 80_000n + 60_000n + 70_000n) * 2_000_000_000n)
  })
})

describe('userOpLogs (#180)', () => {
  const ep = address('EntryPointV07')
  const other = '0x00000000000000000000000000000000000000cc' as Address
  const before: Log = { address: ep, topics: [toEventSelector('BeforeExecution()')], data: '0x' } as unknown as Log
  const plain = (n: number): Log => ({ address: other, topics: [keccak256(`0x0${n}`)], data: '0x' }) as unknown as Log
  const opEvent = (hash: Hex, sender: Address, success = true): Log =>
    ({
      address: ep,
      topics: encodeEventTopics({ abi: entryPointV07Abi, eventName: 'UserOperationEvent', args: { userOpHash: hash, sender, paymaster: pm.paymaster } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [0n, success, 123n, 456n]),
    }) as unknown as Log
  const h1 = `0x${'11'.repeat(32)}` as Hex
  const h2 = `0x${'22'.repeat(32)}` as Hex
  const receipt = (logs: Log[]) => ({ logs }) as unknown as TransactionReceipt

  test('only the logs between the previous boundary and the userOp event', () => {
    const r = receipt([before, plain(1), opEvent(h1, other), plain(2), plain(3), opEvent(h2, live.safe, false)])
    const a = userOpLogs(r, h1)!
    expect(a.logs).toEqual([plain(1)])
    expect(a.success).toBe(true)
    expect(a.actualGasCost).toBe(123n)
    const b = userOpLogs(r, h2)!
    expect(b.logs).toEqual([plain(2), plain(3)])
    expect(b.success).toBe(false)
    expect(b.paymaster).toBe(pm.paymaster)
  })

  test('null without the userOp event or without BeforeExecution', () => {
    expect(userOpLogs(receipt([before, plain(1)]), h1)).toBeNull()
    expect(userOpLogs(receipt([plain(1), opEvent(h1, other)]), h1)).toBeNull()
  })
})
