import { keccak256, parseEventLogs, stringToHex, type Hex, type TransactionReceipt } from 'viem'
import type { Address } from '@mamoru/domain'
import {
  address,
  baseRegistry,
  entryPointV07Abi,
  erc20Abi,
  nameOf,
  nonfungiblePositionManagerAbi,
  safe7579Abi,
  safeAbi,
  smartSessionAbi,
} from '@mamoru/registry'
import { sessionNonceKey } from '@mamoru/account/sessions'
import type { Execution } from '@mamoru/account/safe'
import type { AccountFixture, World } from '../fixtures/world.ts'
import { PERMIT2 } from './attacks.ts'

const FALLBACK_HANDLER_SLOT = keccak256(stringToHex('fallback_manager.handler.address'))
const GUARD_SLOT = keccak256(stringToHex('guard_manager.guard.address'))
const SENTINEL: Address = '0x0000000000000000000000000000000000000001'

export type Digest = Record<string, string>

async function accountDigest(w: World, a: AccountFixture, out: Digest): Promise<void> {
  const c = w.lab.client
  const p = `${a.label}.`
  out[`${p}eth`] = String(await c.getBalance({ address: a.safe }))
  out[`${p}entryPointDeposit`] = String(await c.readContract({ address: address('EntryPointV07'), abi: entryPointV07Abi, functionName: 'balanceOf', args: [a.safe] }))
  const spenders: Record<string, Address> = { router: address('SwapRouter02'), npm: address('NonfungiblePositionManager'), attacker: w.attacker.address, permit2: PERMIT2 }
  for (const t of ['USDC', 'cbBTC', 'WETH']) {
    out[`${p}${t}`] = String(await w.lab.balanceOf(t, a.safe))
    for (const [sn, s] of Object.entries(spenders)) {
      out[`${p}${t}.allowance.${sn}`] = String(await c.readContract({ address: address(t), abi: erc20Abi, functionName: 'allowance', args: [a.safe, s] }))
    }
  }
  out[`${p}owners`] = (await c.readContract({ address: a.safe, abi: safeAbi, functionName: 'getOwners' })).join(',')
  out[`${p}threshold`] = String(await c.readContract({ address: a.safe, abi: safeAbi, functionName: 'getThreshold' }))
  out[`${p}safeNonce`] = String(await c.readContract({ address: a.safe, abi: safeAbi, functionName: 'nonce' }))
  const [modules] = await c.readContract({ address: a.safe, abi: safeAbi, functionName: 'getModulesPaginated', args: [SENTINEL, 16n] })
  out[`${p}modules`] = modules.join(',')
  out[`${p}fallbackHandler`] = (await c.getStorageAt({ address: a.safe, slot: FALLBACK_HANDLER_SLOT })) ?? '0x'
  out[`${p}guard`] = (await c.getStorageAt({ address: a.safe, slot: GUARD_SLOT })) ?? '0x'
  out[`${p}smartSessionInstalled`] = String(await c.readContract({ address: a.safe, abi: safe7579Abi, functionName: 'isModuleInstalled', args: [1n, address('SmartSession'), '0x'] }))
  for (const g of a.grants) {
    out[`${p}session.${g.name}.${g.permissionId.slice(0, 10)}`] = String(
      await c.readContract({ address: address('SmartSession'), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [g.permissionId, a.safe] }),
    )
  }
  out[`${p}entryPointNonce`] = String(await w.lab.entryPointNonce(a.safe, sessionNonceKey(0)))
  out[`${p}nftBalance`] = String(await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [a.safe] }))
  for (const id of [...a.managedTokenIds, ...a.ownerTokenIds]) {
    const owner = await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', args: [id] }).catch(() => 'burned')
    const pos = await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [id] }).catch(() => null)
    const approved = await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'getApproved', args: [id] }).catch(() => 'none')
    out[`${p}nft.${id}`] = `${owner}|${pos ? `${pos[7]}|${pos[10]}|${pos[11]}` : 'none'}|${approved}`
  }
  out[`${p}nftApprovedForAll.attacker`] = String(
    await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'isApprovedForAll', args: [a.safe, w.attacker.address] }),
  )
}

/** Everything a session attack could move: balances, allowances, NFTs, owners, modules, sessions and nonces. */
export async function stateDigest(w: World): Promise<Digest> {
  const out: Digest = {}
  await accountDigest(w, w.a1, out)
  if (w.a2) await accountDigest(w, w.a2, out)
  out['attacker.eth'] = String(await w.lab.client.getBalance({ address: w.attacker.address }))
  for (const t of ['USDC', 'cbBTC', 'WETH']) out[`attacker.${t}`] = String(await w.lab.balanceOf(t, w.attacker.address))
  out['attacker.nftBalance'] = String(
    await w.lab.client.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [w.attacker.address] }),
  )
  return out
}

export function diffDigest(a: Digest, b: Digest): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} -> ${b[k]}`)
}

export function digestHash(d: Digest): Hex {
  const sorted = Object.fromEntries(Object.keys(d).sort().map((k) => [k, d[k]]))
  return keccak256(stringToHex(JSON.stringify(sorted)))
}

const RECIPIENT_WORD: Record<string, number> = {
  '0x04e45aaf': 3, // exactInputSingle
  '0x88316456': 9, // mint
  '0xfc6f7865': 1, // collect
}

/**
 * INV-RECIPIENT on an included session userOp: every Transfer out of the
 * account goes to a registry pool, every Transfer out of a pool or the
 * NonfungiblePositionManager goes to the account, and every recipient field
 * the session signed is the account.
 */
export function checkRecipient(account: Address, calls: Execution[], receipt: TransactionReceipt): string[] {
  const errors: string[] = []
  const pools = new Set(baseRegistry.entries.filter((e) => e.kind === 'pool').map((e) => e.address.toLowerCase()))
  const npm = address('NonfungiblePositionManager').toLowerCase()
  const acct = account.toLowerCase()
  for (const c of calls) {
    const sel = c.callData.slice(0, 10).toLowerCase()
    const w = RECIPIENT_WORD[sel]
    if (w === undefined) continue
    const word = c.callData.slice(10 + w * 64, 10 + (w + 1) * 64)
    if (`0x${word.slice(24)}`.toLowerCase() !== acct) errors.push(`recipient field of ${sel} is not the account`)
  }
  const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: 'Transfer', strict: false })
  for (const t of transfers) {
    const from = String(t.args.from ?? '').toLowerCase()
    const to = String(t.args.to ?? '').toLowerCase()
    if (from === acct && !pools.has(to)) errors.push(`Transfer from the account to ${to}`)
    if ((pools.has(from) || from === npm) && to !== acct && !pools.has(to) && to !== npm) {
      if (t.address.toLowerCase() !== npm) errors.push(`Transfer from ${nameOf(from as Address) ?? from} to ${to}`)
    }
  }
  return errors
}

/** INV-TARGETS on an included session userOp: every call goes to a target of the policy's grants. */
export function checkTargets(calls: Execution[]): string[] {
  const allowed = new Set(['USDC', 'cbBTC', 'NonfungiblePositionManager', 'SwapRouter02'].map((n) => address(n).toLowerCase()))
  return calls.filter((c) => !allowed.has(c.target.toLowerCase())).map((c) => `call to ${c.target}`)
}
