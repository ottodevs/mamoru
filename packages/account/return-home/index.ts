// otto/mamoru#428 (spec 014), step 1 of leaving Monad: the owner's Safe transaction on a design-C Safe on Monad that ends
// Mamoru's access there and sends its USDC home. The one builder the operator prepares with and the Worker rebuilds with:
// explicit inputs, the same bytes and hash on any machine.
//
//   removeSession(id) for every session still enabled on the Safe (the same set as Stop)
//   USDC.approve(TokenMessengerV2, amount)                                                      } only when amount > 0
//   TokenMessengerV2.depositForBurn(amount, Base, mintRecipient = home, USDC, destinationCaller 0, maxFee 0, Standard) }
//
// No position may be open and no WMON held beyond dust when it is built (#427 winds them down first): a burn of a fixed
// amount is then the whole Safe, with nothing priced at signing time.
import { encodeFunctionData, getAddress, hashTypedData, isAddressEqual, pad, type Hex } from 'viem'
import type { Address, ReturnHomeInput } from '@mamoru/domain'
import { address, erc20Abi, tokenMessengerV2Abi, type Registry } from '@mamoru/registry'
import { ownerSafeTx } from '../live/index.ts'
import { safeTxTypedData } from '../safe/index.ts'
import { revocationCalls } from '../sessions/index.ts'
import type { WireSafeTx } from '../one-auth/index.ts'

/** Circle's TokenMessengerV2: the same address on Ethereum, Base and Monad (registry abis note). */
export const TOKEN_MESSENGER_V2: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
/** CCTP domain of Base, the only home a return goes to. */
export const RETURN_HOME_DOMAIN = 6
/** Standard finality: no fee today; maxFee 0 never pays Circle anything. */
export const RETURN_HOME_FINALITY = 2000
const BASE_CHAIN_ID = 8453

export type { ReturnHomeInput } from '@mamoru/domain'

const ZERO: Address = '0x0000000000000000000000000000000000000000'
const dec = (s: string, what: string): bigint => {
  if (!/^[0-9]+$/.test(s)) throw new Error(`buildReturnHome: ${what} is not a decimal integer`)
  return BigInt(s)
}

/**
 * The release id of an owner-signed return, derived from its burn transaction's hash: the Monad operator records it under
 * this id and the home accepts an owner report only under the id it derives itself from the attested tx.
 */
export function returnReleaseId(txHash: Hex): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('returnReleaseId: not a transaction hash')
  return `home-${txHash.slice(2, 26).toLowerCase()}`
}

/** The calls of `input`, in order. Throws on any input the operator would not prepare. */
export function returnHomeCalls(input: ReturnHomeInput, registry: Registry): { to: Address; value: bigint; data: Hex }[] {
  if (registry.chainId !== input.chainId) throw new Error(`buildReturnHome: registry of chain ${registry.chainId}, input on ${input.chainId}`)
  if (input.chainId === BASE_CHAIN_ID) throw new Error('buildReturnHome: a return leaves a remote chain, never Base')
  const amount = dec(input.amountUsdc, 'amountUsdc')
  if (amount === 0n && !input.removeIds.length) throw new Error('buildReturnHome: nothing to send home and nothing to revoke')
  const home = getAddress(input.home)
  const safe = getAddress(input.safe)
  if (BigInt(home) === 0n || isAddressEqual(home, safe)) throw new Error('buildReturnHome: home is the Base Safe, neither zero nor this Safe')
  if (new Set(input.removeIds.map((id) => id.toLowerCase())).size !== input.removeIds.length) throw new Error('buildReturnHome: duplicate session id')
  const usdc = address('USDC', registry)
  if (amount === 0n) return revocationCalls(input.removeIds, registry)
  return [
    ...revocationCalls(input.removeIds, registry),
    { to: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TOKEN_MESSENGER_V2, amount] }) },
    {
      to: TOKEN_MESSENGER_V2,
      value: 0n,
      data: encodeFunctionData({ abi: tokenMessengerV2Abi, functionName: 'depositForBurn', args: [amount, RETURN_HOME_DOMAIN, pad(home, { size: 32 }), usdc, `0x${'00'.repeat(32)}`, 0n, RETURN_HOME_FINALITY] }),
    },
  ]
}

/** The return-home Safe transaction of `input` and its hash (the passkey's challenge). No refund: Mamoru pays. */
export function buildReturnHome(input: ReturnHomeInput, registry: Registry): { safeTx: WireSafeTx; safeTxHash: Hex; calls: { to: Address; value: bigint; data: Hex }[] } {
  const calls = returnHomeCalls(input, registry)
  const nonce = dec(input.safeNonce, 'safeNonce')
  const tx = ownerSafeTx(calls, nonce, registry)
  const safeTx: WireSafeTx = { to: tx.to, value: '0', data: tx.data, operation: tx.operation as 0 | 1, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: nonce.toString() }
  const safeTxHash = hashTypedData(safeTxTypedData(getAddress(input.safe), input.chainId, tx))
  return { safeTx, safeTxHash, calls }
}
