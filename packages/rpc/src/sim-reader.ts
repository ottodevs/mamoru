import { decodeFunctionResult, encodeFunctionData, type Hex, type PublicClient } from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'

/**
 * otto/mamoru#429: runtime code of contracts/sim-reader/src/SimReader.sol (solc 0.8.28, paris, optimizer 200 runs, no
 * metadata). Reproduce: `cd contracts/sim-reader && ~/.foundry/bin/forge build` then
 * `jq -r .deployedBytecode.object out/SimReader.sol/SimReader.json`. Never deployed: an eth_call gives it to the
 * EntryPoint's address by a state override.
 */
export const SIM_READER_CODE: Hex = '0x608060405234801561001057600080fd5b506004361061002b5760003560e01c806322ff343014610030575b600080fd5b61004361003e36600461030a565b61005d565b604051610054959493929190610425565b60405180910390f35b6000606060006060806100718a8a8a610102565b915060005a90508a6001600160a01b03168888604051610092929190610495565b6000604051808303816000865af19150503d80600081146100cf576040519150601f19603f3d011682016040523d82523d6000602084013e6100d4565b606091505b5090965094505a6100e590826104a5565b93506100f28b8b8b610102565b9150509550955095509550959050565b60608167ffffffffffffffff81111561011d5761011d6104cc565b604051908082528060200260200182016040528015610146578160200160208202803683370190505b50905060005b8281101561029d57600080858584818110610169576101696104e2565b905060200201602081019061017e91906104f8565b604080516001600160a01b038a811660248084019190915283518084039091018152604490920183526020820180516001600160e01b03166370a0823160e01b179052915192909116916101d2919061051a565b600060405180830381855afa9150503d806000811461020d576040519150601f19603f3d011682016040523d82523d6000602084013e610212565b606091505b509150915081801561022657506020815110155b6102625760405162461bcd60e51b81526020600482015260096024820152683130b630b731b2a7b360b91b604482015260640160405180910390fd5b808060200190518101906102769190610536565b848481518110610288576102886104e2565b6020908102919091010152505060010161014c565b509392505050565b80356001600160a01b03811681146102bc57600080fd5b919050565b60008083601f8401126102d357600080fd5b50813567ffffffffffffffff8111156102eb57600080fd5b60208301915083602082850101111561030357600080fd5b9250929050565b60008060008060006060868803121561032257600080fd5b61032b866102a5565b9450602086013567ffffffffffffffff81111561034757600080fd5b8601601f8101881361035857600080fd5b803567ffffffffffffffff81111561036f57600080fd5b8860208260051b840101111561038457600080fd5b60209190910194509250604086013567ffffffffffffffff8111156103a857600080fd5b6103b4888289016102c1565b969995985093965092949392505050565b60005b838110156103e05781810151838201526020016103c8565b50506000910152565b600081518084526020840193506020830160005b8281101561041b5781518652602095860195909101906001016103fd565b5093949350505050565b851515815260a06020820152600085518060a084015261044c8160c0850160208a016103c5565b60408301869052601f01601f1916820182810360c09081016060850152610475908201866103e9565b9050828103608084015261048981856103e9565b98975050505050505050565b8183823760009101908152919050565b818103818111156104c657634e487b7160e01b600052601160045260246000fd5b92915050565b634e487b7160e01b600052604160045260246000fd5b634e487b7160e01b600052603260045260246000fd5b60006020828403121561050a57600080fd5b610513826102a5565b9392505050565b6000825161052c8184602087016103c5565b9190910192915050565b60006020828403121561054857600080fd5b505191905056'

export const simReaderAbi = [
  {
    type: 'function',
    name: 'run',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'tokens', type: 'address[]' },
      { name: 'callData', type: 'bytes' },
    ],
    outputs: [
      { name: 'ok', type: 'bool' },
      { name: 'ret', type: 'bytes' },
      { name: 'gasUsed', type: 'uint256' },
      { name: 'before', type: 'uint256[]' },
      { name: 'afterwards', type: 'uint256[]' },
    ],
  },
] as const

export type ReaderRun = { ok: boolean; ret: Hex; gasUsed: bigint; before: readonly bigint[]; after: readonly bigint[] }

/**
 * eth_simulateV1 not served at all by the provider that answered (as opposed to a revert, which is the method's real
 * answer): method not found, a plan or chain that leaves it out, or a capacity cap that a retry within the minute
 * does not lift. Seen on Monad, 20-21 Nov 2026: -32601 from the public endpoints, -32604 "this request method is not
 * supported", "eth_simulateV1 is not available on the MONAD_MAINNET", "Monthly capacity limit exceeded", "available
 * for paid plans only".
 */
export function simulateUnserved(e: unknown): boolean {
  if (!(e instanceof ReasonError) || e.code !== 'EHG_SIM_UNAVAILABLE') return false
  const text = `${e.message} ${e.detail ?? ''}`
  if (/sender not eoa/i.test(text)) return false
  return /method not found|does not exist|not supported|is not available|not available on|paid plan|monthly capacity|capacity limit exceeded/i.test(text)
}

/**
 * One eth_call to the EntryPoint's address, its code replaced by SimReader for this call only: balanceOf(account) for
 * every token, the account called with `callData` (msg.sender = EntryPoint, as in a real userOp), the balances again.
 * The account and the tokens are the chain's own state at `blockNumber`; nothing else is overridden.
 */
export async function runSimReader(client: PublicClient, entryPoint: Address, account: Address, tokens: readonly Address[], callData: Hex, blockNumber: bigint, gas: bigint): Promise<ReaderRun> {
  let raw: Hex | undefined
  try {
    const res = await client.call({
      to: entryPoint,
      data: encodeFunctionData({ abi: simReaderAbi, functionName: 'run', args: [account, [...tokens], callData] }),
      blockNumber,
      gas,
      stateOverride: [{ address: entryPoint, code: SIM_READER_CODE }],
    })
    raw = res.data
  } catch (e) {
    const { details } = e as { details?: string }
    const first = (e as Error).message.split('\n')[0] ?? ''
    throw new ReasonError('EHG_SIM_UNAVAILABLE', `reader: ${details && !first.includes(details) ? `${first} (${details})` : first}`)
  }
  return decodeReaderRun(raw ?? '0x', tokens.length)
}

/** The reader's answer, refused unless it carries one balance per token on both sides. */
export function decodeReaderRun(raw: Hex, tokens: number): ReaderRun {
  let out: readonly [boolean, Hex, bigint, readonly bigint[], readonly bigint[]]
  try {
    out = decodeFunctionResult({ abi: simReaderAbi, functionName: 'run', data: raw })
  } catch (e) {
    throw new ReasonError('EHG_SIM_UNAVAILABLE', `reader: undecodable answer (${(e as Error).message.split('\n')[0]})`)
  }
  const [ok, ret, gasUsed, before, after] = out
  if (before.length !== tokens || after.length !== tokens) throw new ReasonError('EHG_SIM_UNAVAILABLE', `reader: ${before.length}/${after.length} balances for ${tokens} tokens`)
  return { ok, ret, gasUsed, before, after }
}
