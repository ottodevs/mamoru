// Appends one JSON line per `deploy:prod` and `deploy:beta` run, outside the repo checkout so a deploy never dirties
// the tree (a snapshot deploy has no working tree to dirty anyway, but the log must outlive any
// single checkout). Override the path with MAMORU_RELEASE_LOG, e.g. for tests.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

export type ReleaseRecord = {
  env: 'prod' | 'beta'
  sha: string
  versionId: string
  /** What to roll back to. 'none' when the environment had never been deployed. */
  previousVersionId: string
  smokeOk: boolean
  at: string
  /** prod only: how long the sha had been on beta, and the reason when the soak was cut short. */
  soakHours?: number
  hotfix?: string
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

/** Every record of the log, oldest first. A missing file is an empty log; a line that is not a record is skipped. */
export async function readReleaseLog(): Promise<ReleaseRecord[]> {
  let raw: string
  try {
    raw = await readFile(releaseLogPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const records: ReleaseRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as Partial<ReleaseRecord>
      if ((r.env === 'prod' || r.env === 'beta') && typeof r.sha === 'string' && typeof r.at === 'string' && typeof r.smokeOk === 'boolean') records.push(r as ReleaseRecord)
    } catch {
      // not a record
    }
  }
  return records
}
