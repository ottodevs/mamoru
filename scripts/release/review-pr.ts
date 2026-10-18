#!/usr/bin/env bun
// `bun run review:pr <number> [--model auto|gpt-6-sol|gpt-6-astra] [--focus "<what to look at>"]`
// The independent review of a pull request on the Codex seat, one at a time across every session on lady. Waits its
// turn on a lock (and for any other `codex exec` already running), takes the diff from GitHub (`gh pr diff`, so it is
// the PR and nothing else, whatever the local refs say), checks out the PR head read-only for the reviewer, picks the
// model by the seat's quota (model-plane) alternating Sol and Astra, posts the verdict on the PR and exits 0 on APTO,
// 2 on NO-GO, 1 when no review ran. Any session may run it: it needs no coordinator lease.
import { $ } from 'bun'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
// Files this script writes go to a private directory of its own (mkdtemp, mode 0700), created exclusively: never
// inside the PR checkout, whose contents the PR author controls, and never at a guessable /tmp path.
const EXCL = { flag: 'wx', mode: 0o600 } as const
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalMessage, parseVerdict, pickModel, reviewPrompt } from './lib/review.ts'

const HOME = process.env.HOME!
const root = new URL('../../', import.meta.url).pathname
const REPO = 'ottodevs/mamoru'
const state = `${HOME}/.local/state/mamoru-review`
const lockDir = `${state}/codex.lock`
const argv = process.argv.slice(2)
const number = Number(argv.find((a) => /^\d+$/.test(a)))
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? dflt) : dflt
}
function stop(why: string): never {
  console.error(`review:pr: ${why}`)
  process.exit(1)
}
if (!Number.isInteger(number) || number <= 0) stop('usage: bun run review:pr <number> [--model auto|gpt-6-sol|gpt-6-astra] [--focus "..."]')
mkdirSync(state, { recursive: true })

async function codexRunning(): Promise<boolean> {
  return (await $`pgrep -f ${'^(timeout [0-9]+ )?codex exec'}`.quiet().nothrow()).exitCode === 0
}

/** One review at a time: a directory lock whose owner pid is written inside; a lock of a dead pid is broken. */
async function takeTurn(): Promise<() => void> {
  for (let announced = false; ; ) {
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), `${process.pid} ${number}`)
      if (!(await codexRunning())) break
      await $`rm -rf ${lockDir}`.quiet().nothrow()
    } catch {
      const owner = Number((() => {
        try {
          return readFileSync(join(lockDir, 'pid'), 'utf8').split(' ')[0]
        } catch {
          return '0'
        }
      })())
      if (owner && (await $`kill -0 ${owner}`.quiet().nothrow()).exitCode !== 0) await $`rm -rf ${lockDir}`.quiet().nothrow()
    }
    if (!announced) console.log('waiting for the Codex seat (another review is running)…')
    announced = true
    await Bun.sleep(20_000)
  }
  const release = () => void Bun.spawnSync(['rm', '-rf', lockDir])
  process.on('exit', release)
  return release
}

async function seatRemaining(): Promise<number | null> {
  try {
    const r = await fetch('http://127.0.0.1:3500/v1/quotas', { signal: AbortSignal.timeout(5_000) })
    const rows = (await r.json()) as { connectionName?: string; latestQuota?: { remaining?: number } }[]
    const seat = rows.find((x) => x.connectionName === (process.env.MAMORU_CODEX_CONNECTION ?? 'chatgpt-ottodevs'))
    return typeof seat?.latestQuota?.remaining === 'number' ? seat.latestQuota.remaining : null
  } catch {
    return null
  }
}

const release = await takeTurn()
const lastFile = `${state}/last-model`
const last = (() => {
  try {
    return readFileSync(lastFile, 'utf8').trim()
  } catch {
    return null
  }
})()
const picked = pickModel(opt('model', 'auto'), last, await seatRemaining())
if ('error' in picked) stop(picked.error)
const model = picked.model

const pr = JSON.parse(await $`gh pr view ${number} -R ${REPO} --json title,body,headRefOid,state,comments`.text()) as {
  title: string
  body: string
  headRefOid: string
  state: string
  comments: { body: string }[]
}
if (pr.state !== 'OPEN') stop(`PR #${number} is ${pr.state}`)
const diff = await $`gh pr diff ${number} -R ${REPO}`.text()
const previous = pr.comments.map((c) => c.body).filter((b) => /independent review|VERDICT|APTO|NO-GO/i.test(b)).slice(-3).map((b) => b.slice(0, 600).replace(/\s+/g, ' '))

const work = mkdtempSync(join(tmpdir(), `review-${number}-`))
const dir = join(work, 'checkout')
await $`git -C ${root} fetch -q origin ${pr.headRefOid}`.quiet().nothrow()
await $`git -C ${root} worktree add -q --detach ${dir} ${pr.headRefOid}`
const promptFile = join(work, 'prompt.txt')
writeFileSync(promptFile, reviewPrompt({ number, title: pr.title, body: pr.body, diff, focus: opt('focus', ''), previous }), EXCL)
writeFileSync(lastFile, model)

console.log(`== review:pr #${number} at ${pr.headRefOid.slice(0, 7)} with ${model} ==`)
const run = await $`timeout 1800 codex exec -m ${model} -c model_reasoning_effort=high -s read-only -C ${dir} - < ${promptFile}`.quiet().nothrow()
const out = `${run.stdout.toString()}\n${run.stderr.toString()}`
await $`git -C ${root} worktree remove --force ${dir}`.quiet().nothrow()
release()

const message = finalMessage(run.stdout.toString() || out)
const verdict = parseVerdict(message)
writeFileSync(join(work, 'codex-output.txt'), out, EXCL)
if (!verdict) stop(`no verdict line from ${model} (exit ${run.exitCode}): nothing posted; output kept in ${join(work, 'codex-output.txt')}`)

const comment = `**Independent review: ${verdict}** (Codex \`${model}\`, at \`${pr.headRefOid.slice(0, 7)}\`, via \`bun run review:pr\`). Advisory: the coordinator reads the findings and decides the merge.\n\n${message.slice(0, 60_000)}`
const file = join(work, 'comment.md')
writeFileSync(file, comment, EXCL)
await $`gh pr comment ${number} -R ${REPO} -F ${file}`.quiet()
console.log(`${verdict}: posted on #${number}`)
process.exit(verdict === 'APTO' ? 0 : 2)
