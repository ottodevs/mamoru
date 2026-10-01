// Appends one row per deploy:prod run to docs/releases.md. The file is created on first use.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export type ReleaseRecord = {
  env: 'prod'
  sha: string
  versionId: string
  previousVersionId: string
  smokeOk: boolean
  at: string
}

const HEADER =
  '# Release log\n\n' +
  'One row per `bun run deploy:prod`. To roll back a bad release:\n' +
  '`cd apps/mamoru-app && bunx wrangler rollback <Previous version>`.\n\n' +
  '| Date | Git SHA | Version ID | Previous version | Smoke test |\n' +
  '|---|---|---|---|---|\n'

export async function appendReleaseLog(root: string, r: ReleaseRecord): Promise<string> {
  const path = join(root, 'docs', 'releases.md')
  const exists = await Bun.file(path).exists()
  if (!exists) {
    await mkdir(join(root, 'docs'), { recursive: true })
    await Bun.write(path, HEADER)
  }
  const row = `| ${r.at} | ${r.sha.slice(0, 7)} | ${r.versionId} | ${r.previousVersionId} | ${r.smokeOk ? 'pass' : 'FAIL'} |\n`
  await appendFile(path, row)
  return path
}
