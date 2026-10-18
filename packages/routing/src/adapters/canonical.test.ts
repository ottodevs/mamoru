import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, parseAbi } from 'viem'
import { BASE_DEPOSIT_ETA_SEC, BASE_L1_STANDARD_BRIDGE, BASE_L2_STANDARD_BRIDGE, BASE_WITHDRAWAL_ETA_SEC, canonicalBaseAdapter } from './canonical.ts'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const NOW = 1_792_325_000_000

const standardBridgeAbi = parseAbi(['function bridgeETHTo(address _to, uint32 _minGasLimit, bytes _extraData) payable'])

describe('canonicalBaseAdapter', () => {
  test('supports only ETH, only between Ethereum (1) and Base (8453)', () => {
    const base = { amountIn: 1n, account: ACCOUNT }
    expect(canonicalBaseAdapter.supports({ ...base, sourceChainId: 1, destChainId: 8453, asset: 'ETH' })).toBe(true)
    expect(canonicalBaseAdapter.supports({ ...base, sourceChainId: 8453, destChainId: 1, asset: 'ETH' })).toBe(true)
    expect(canonicalBaseAdapter.supports({ ...base, sourceChainId: 1, destChainId: 8453, asset: 'USDC' })).toBe(false) // Base USDC is native via CCTP
    expect(canonicalBaseAdapter.supports({ ...base, sourceChainId: 1, destChainId: 143, asset: 'ETH' })).toBe(false) // not a Base pair
  })

  test('deposit (Ethereum -> Base): targets L1StandardBridge, 1:1, no fee, fast ETA', async () => {
    const req = { sourceChainId: 1, destChainId: 8453, asset: 'ETH' as const, amountIn: 1_000_000_000_000_000_000n, account: ACCOUNT }
    const q = await canonicalBaseAdapter.quote(req, { now: () => NOW })
    expect(q.target).toBe(BASE_L1_STANDARD_BRIDGE)
    expect(q.amountOut).toBe(req.amountIn)
    expect(q.fee).toBe(0n)
    expect(q.value).toBe(req.amountIn)
    expect(q.etaSec).toBe(BASE_DEPOSIT_ETA_SEC)
    expect(q.mode).toBe('session-key')
    expect(q.recipientCheck).toBe('onchain-pinnable')

    const decoded = decodeFunctionData({ abi: standardBridgeAbi, data: q.calldata! })
    expect(decoded.functionName).toBe('bridgeETHTo')
    expect(decoded.args[0]).toBe(ACCOUNT)
  })

  test('withdrawal (Base -> Ethereum): targets the L2StandardBridge predeploy, multi-day ETA', async () => {
    const req = { sourceChainId: 8453, destChainId: 1, asset: 'ETH' as const, amountIn: 1_000_000_000_000_000_000n, account: ACCOUNT }
    const q = await canonicalBaseAdapter.quote(req, { now: () => NOW })
    expect(q.target).toBe(BASE_L2_STANDARD_BRIDGE)
    expect(q.etaSec).toBe(BASE_WITHDRAWAL_ETA_SEC)
    expect(q.etaSec).toBeGreaterThan(24 * 3600) // this is the whole point: never understate the withdrawal delay
  })

  test('refuses USDC and a non-positive amount', async () => {
    await expect(canonicalBaseAdapter.quote({ sourceChainId: 1, destChainId: 8453, asset: 'USDC', amountIn: 1n, account: ACCOUNT })).rejects.toThrow()
    await expect(canonicalBaseAdapter.quote({ sourceChainId: 1, destChainId: 8453, asset: 'ETH', amountIn: 0n, account: ACCOUNT })).rejects.toThrow()
  })
})
