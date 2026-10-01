// Appends one JSON line per `deploy:prod` run, outside the repo checkout so a deploy never dirties
// the tree (a snapshot deploy has no working tree to dirty anyway, but the log must outlive any
// single checkout). Override the path with MAMORU_RELEASE_LOG, e.g. for tests.
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

export type ReleaseRecord = {
  env: 'prod'
  sha: string
  versionId: string
  previousVersionId: string
  smokeOk: boolean
  at: string
}

export function releaseLogPath(): string {
  return process.env.MAMORU_RELEASE_LOG ?? `${homedir()}/.local/state/mamoru-app/releases.jsonl`
}

export async function appendReleaseLog(r: ReleaseRecord): Promise<string> {
  const path = releaseLogPath()
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(r)}\n`)
  return path
}
