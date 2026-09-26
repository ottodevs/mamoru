import { pinRegistry } from './pin-registry.ts'
import { runCatalog } from './run.ts'

const [command = 'run', ...rest] = process.argv.slice(2)

if (command === 'pin-registry') {
  await pinRegistry()
} else if (command === 'run') {
  const onlyIdx = rest.indexOf('--only')
  const only = onlyIdx >= 0 ? rest[onlyIdx + 1]?.split(',') : undefined
  const { runId, results, reportPath } = await runCatalog({ only })
  const failed = results.filter((r) => r.status === 'fail')
  const kt1 = results.filter((r) => r.kt1)
  console.log(`\nrun ${runId}: ${results.length - failed.length}/${results.length} pass`)
  if (kt1.length) console.log(`KT-1: an attack passed in ${kt1.map((r) => r.id).join(', ')}. Stop.`)
  console.log(`report: ${reportPath.replace(`${process.cwd()}/`, '')}`)
  process.exit(failed.length === 0 ? 0 : 1)
} else {
  console.error('usage: bun run scenarios [run [--only ID,ID]] | pin-registry')
  process.exit(2)
}
