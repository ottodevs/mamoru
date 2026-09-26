import { describe, expect, test } from 'bun:test'
import { BundlerClient, assertLabBundler, fromRpcUserOp, toRpcUserOp } from './index.ts'

const op = {
  sender: '0x00000000000000000000000000000000000000aa',
  nonce: 5n,
  callData: '0x1234',
  callGasLimit: 1n,
  verificationGasLimit: 2n,
  preVerificationGas: 3n,
  maxFeePerGas: 4n,
  maxPriorityFeePerGas: 5n,
  signature: '0xabcd',
} as const

describe('BundlerClient', () => {
  test('refuses a lab bundler off loopback', () => {
    expect(() => assertLabBundler('http://10.0.0.2:4337/')).toThrow('LAB_BUNDLER_NOT_LOCAL')
    expect(() => new BundlerClient({ url: 'https://bundler.example/', mode: 'lab', chainId: 31337, signingChainIds: [31337] })).toThrow('LAB_BUNDLER_NOT_LOCAL')
    expect(() => assertLabBundler('http://127.0.0.1:4337/')).not.toThrow()
  })

  test('production never sends', async () => {
    const c = new BundlerClient({ url: 'https://bundler.example/', mode: 'production', chainId: 8453, signingChainIds: [] })
    await expect(c.sendUserOperation(op)).rejects.toThrow('DRY_RUN_STOP')
  })

  test('Base is refused even when listed', async () => {
    const c = new BundlerClient({ url: 'http://127.0.0.1:1/', mode: 'lab', chainId: 8453, signingChainIds: [8453] })
    await expect(c.sendUserOperation(op)).rejects.toThrow('SIGN_CHAIN_NOT_ALLOWED')
  })

  test('the RPC shape round-trips', () => {
    expect(fromRpcUserOp(toRpcUserOp(op))).toEqual(op)
  })
})
