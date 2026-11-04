// USDC funding on an anvil fork by storage write, so no e2e depends on a whale that Circle may blacklist
// (Binance 0x28C6c062 is, on mainnet since Oct 2026; e2e audit 4 Nov).
import { encodeAbiParameters, keccak256, pad, toHex, type Address } from 'viem'
import { erc20Abi } from '@mamoru/registry'
import type { Lab } from '../../../packages/scenarios/fixtures/lab.ts'

/** FiatTokenV2: `balanceAndBlacklistStates` (address => uint256, bit 255 = blacklisted, the rest the balance) sits at slot 9. */
const BALANCE_SLOT = 9n

/** Adds `amount` to `to`'s USDC balance on the fork and checks the token reports it. Throws when the slot is wrong. */
export async function fundUsdc(lab: Lab, token: Address, to: Address, amount: bigint): Promise<void> {
  const balanceOf = () => lab.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [to] }) as Promise<bigint>
  const before = await balanceOf()
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to, BALANCE_SLOT]))
  await lab.rpc('anvil_setStorageAt', [token, slot, pad(toHex(before + amount), { size: 32 })])
  const after = await balanceOf()
  if (after !== before + amount) throw new Error(`USDC storage write did not take: ${before} -> ${after}, wanted +${amount} (slot ${BALANCE_SLOT} wrong?)`)
}

/** Anvil's `finalized` tag trails the head by 2 epochs (64 blocks at the default 32 slots) and moves only as blocks are mined.
 *  The operator decides terminal convert/bridge answers at `finalized` (otto/mamoru#285), so an e2e that needs one mines past it. */
export async function advanceFinality(lab: Lab, blocks = 70): Promise<void> {
  const sent = (await lab.client.getBlockNumber({ cacheTime: 0 })) as bigint
  await lab.rpc('anvil_mine', [`0x${blocks.toString(16)}`])
  const fin = (await lab.client.getBlock({ blockTag: 'finalized' })).number as bigint
  if (fin < sent) throw new Error(`finalized ${fin} did not pass block ${sent} after mining ${blocks}`)
}
