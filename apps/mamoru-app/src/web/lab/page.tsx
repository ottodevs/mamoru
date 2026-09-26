import { Lab } from './lab.tsx'
import { loadTapes } from './tape.ts'

// Tapes are committed JSON under ./tapes; Vite inlines them at build time. None yet means the empty state.
const tapes = loadTapes(import.meta.glob('./tapes/*.json', { eager: true }))

export function LabPage() {
  return <Lab tapes={tapes} />
}
