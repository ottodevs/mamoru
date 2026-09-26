import { createPublicClient, fallback, getAddress, http, isAddress } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'

// Loaded on demand by ens.ts, so viem stays out of the first paint.
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com']

export const client = createPublicClient({ chain: mainnet, transport: fallback(RPCS.map((u) => http(u))) })
export { getAddress, isAddress, normalize }
