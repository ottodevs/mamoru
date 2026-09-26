import { createContext, useContext } from 'react'
import type { ViewScope } from '../lib/provenance.ts'

export const ScopeContext = createContext<ViewScope>({ mode: 'production', chains: [] })

export function useScope(): ViewScope {
  return useContext(ScopeContext)
}
