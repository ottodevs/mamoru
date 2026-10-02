import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem'
import { multicall3Abi } from '@mamoru/rpc'

/** Answers a Multicall3.aggregate3 eth_call from single reads, as the contract does: a read that throws fails only itself. */
export function answerAggregate3(data: Hex, read: (target: string, callData: Hex) => Hex): Hex {
  const { args } = decodeFunctionData({ abi: multicall3Abi, data })
  const calls = args[0] as readonly { target: string; callData: Hex }[]
  const result = calls.map((c) => {
    try {
      return { success: true, returnData: read(c.target, c.callData) }
    } catch {
      return { success: false, returnData: '0x' as Hex }
    }
  })
  return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result })
}
