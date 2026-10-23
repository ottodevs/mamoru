import { createContext, useContext, type ReactNode } from 'react'
import base from '@mamoru/registry/base.json'
import monad from '@mamoru/registry/monad.json'

/**
 * otto/mamoru#67: the chain of the sleeve on screen. Every chain-specific word, link and contract in the SPA reads it
 * from here: the explorer of a tx or a pool, the network a deposit must use, the USDC contract of that network. The
 * default is Base, so a screen rendered outside any provider (and every Base sleeve) is exactly what it was before.
 */
export type SleeveChain = {
  chainId: number
  name: string
  /** Explorer host and its display name. */
  explorer: { host: string; name: string }
  /** The USDC contract a deposit must send, from the chain's pinned registry. */
  usdc: string
  /** Native gas token. */
  native: string
}

const usdcOf = (r: { entries: { name: string; address: string }[] }) => r.entries.find((e) => e.name === 'USDC')!.address

export const BASE_SLEEVE: SleeveChain = { chainId: 8453, name: 'Base', explorer: { host: 'basescan.org', name: 'Basescan' }, usdc: usdcOf(base), native: 'ETH' }
export const MONAD_SLEEVE: SleeveChain = { chainId: 143, name: 'Monad', explorer: { host: 'monadscan.com', name: 'Monadscan' }, usdc: usdcOf(monad), native: 'MON' }

const CHAINS: readonly SleeveChain[] = [BASE_SLEEVE, MONAD_SLEEVE]

/** The chain of `chainId`; Base for an id this SPA does not know (the API only sends the two). */
export function sleeveChain(chainId: number | undefined): SleeveChain {
  return CHAINS.find((c) => c.chainId === chainId) ?? BASE_SLEEVE
}

const ChainContext = createContext<SleeveChain>(BASE_SLEEVE)

export function ChainProvider({ chainId, children }: { chainId: number | undefined; children: ReactNode }) {
  return <ChainContext.Provider value={sleeveChain(chainId)}>{children}</ChainContext.Provider>
}

export function useChain(): SleeveChain {
  return useContext(ChainContext)
}

export const explorerTx = (c: SleeveChain, tx: string) => `https://${c.explorer.host}/tx/${tx}`
export const explorerAddress = (c: SleeveChain, address: string) => `https://${c.explorer.host}/address/${address}`
