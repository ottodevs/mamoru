// Records Lab tapes on the pinned Base fork. RPC_URL comes from the environment only.
// Usage: bun run packages/scenarios/tape/record.ts [harvest|out-of-range|pool-shock ...]
import { repoPath } from '../runner/manifest.ts'
import { TapeSession } from './recorder.ts'
import { TAPES } from './scripts.ts'

const OUT_DIR = repoPath('apps/mamoru-app/src/web/lab/tapes')

const names = process.argv.slice(2)
const pick = names.length ? names : Object.keys(TAPES)
for (const n of pick) {
  if (!TAPES[n]) {
    console.error(`unknown tape ${n}; one of ${Object.keys(TAPES).join(', ')}`)
    process.exit(2)
  }
}
let failed = 0
for (const n of pick) {
  const t = TAPES[n]!
  console.log(`${t.id}:`)
  const s = await TapeSession.start(n)
  try {
    const tape = await t.run(s)
    await Bun.write(`${OUT_DIR}/${t.file}`, `${JSON.stringify(tape, null, 2)}\n`)
    console.log(`${t.id}: ${tape.frames.length} frames -> ${t.file}`)
  } catch (e) {
    failed++
    console.error(`${t.id} not written: ${(e as Error).message}`)
  } finally {
    await s.stop()
  }
}
process.exit(failed ? 1 : 0)
