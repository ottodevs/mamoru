import type { Hex0x } from '@mamoru/domain'
import { useEffect, useState } from 'react'

// Withdraw destinations: a 0x address (checksum-validated) or an ENS name (name.eth, name.base.eth),
// resolved in the browser on Ethereum mainnet. viem loads only when the withdraw form is used.
const load = () => import('./ens-client.ts')

export type Destination =
  | { state: 'empty' }
  | { state: 'resolving'; input: string }
  | { state: 'ok'; input: string; address: Hex0x; name?: string }
  | { state: 'invalid'; input: string; message: string }

export function looksLikeName(s: string): boolean {
  return /^[^\s.]+(\.[^\s.]+)+$/.test(s) && !s.startsWith('0x')
}

export async function checksum(s: string): Promise<Hex0x | null> {
  const { getAddress, isAddress } = await load()
  return isAddress(s, { strict: false }) ? (getAddress(s) as Hex0x) : null
}

// Resolved by the app API (mainnet RPC pool with fallback), so no browser-side RPC or CORS is involved.
export async function resolveName(name: string): Promise<Hex0x | null> {
  const res = await fetch(`/api/ens?name=${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`ens ${res.status}`)
  return ((await res.json()) as { address: Hex0x | null }).address
}

/** Debounced destination resolution for the withdraw form. */
export function useDestination(text: string): Destination {
  const input = text.trim()
  const [dest, setDest] = useState<Destination>({ state: 'empty' })
  useEffect(() => {
    if (!input) return setDest({ state: 'empty' })
    let live = true
    if (/^0x/i.test(input)) {
      checksum(input).then((a) => {
        if (!live) return
        setDest(a ? { state: 'ok', input, address: a } : { state: 'invalid', input, message: 'Not a valid address.' })
      })
      return () => {
        live = false
      }
    }
    if (!looksLikeName(input)) {
      setDest({ state: 'invalid', input, message: 'Enter a 0x address or a name like alice.eth.' })
      return
    }
    setDest({ state: 'resolving', input })
    const t = setTimeout(() => {
      resolveName(input)
        .then((a) => {
          if (!live) return
          setDest(a ? { state: 'ok', input, address: a, name: input } : { state: 'invalid', input, message: 'This name has no address.' })
        })
        .catch(() => live && setDest({ state: 'invalid', input, message: 'Could not resolve this name.' }))
    }, 400)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [input])
  return dest
}
