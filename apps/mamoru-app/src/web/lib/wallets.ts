import { useEffect, useState } from 'react'
import type { EIP1193Provider } from 'viem'

// EIP-6963 discovery of injected wallets, with window.ethereum as the fallback. No viem at runtime here.
export type InjectedWallet = {
  id: string
  name: string
  icon: string
  provider: EIP1193Provider
}

type Announce = CustomEvent<{
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: EIP1193Provider
}>

export function useInjectedWallets(): InjectedWallet[] {
  const [wallets, setWallets] = useState<InjectedWallet[]>([])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const found = new Map<string, InjectedWallet>()
    const onAnnounce = (e: Event) => {
      const d = (e as Announce).detail
      if (!d?.info || !d.provider) return
      found.set(d.info.rdns || d.info.uuid, {
        id: d.info.rdns || d.info.uuid,
        name: d.info.name,
        icon: d.info.icon,
        provider: d.provider,
      })
      setWallets([...found.values()])
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    const t = setTimeout(() => {
      const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum
      if (found.size === 0 && eth) setWallets([{ id: 'injected', name: 'Browser wallet', icon: '', provider: eth }])
    }, 400)
    return () => {
      clearTimeout(t)
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
    }
  }, [])
  return wallets
}
