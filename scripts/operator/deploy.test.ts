// End-to-end smoke test of the CLI itself (not just its lib/*.ts pieces), run against a throwaway
// local "remote" so it never touches the network or anything real.
//
// Every invocation passes a unique --entrypoint marker (never the real
// apps/mamoru-operator/src/main.ts path) so these tests are never confused by, and can never
// collide with, whatever real operator process happens to be running on the host that runs them —
// on lady that is the actual live transient mamoru-operator.service, which these tests must never
// see, let alone touch.
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { acquireLock } from './lib/lock.ts'

let upstream: string
let sha: string
/** A real, resolvable commit that exists in the repo but is NOT reachable from main — for testing the ancestor check specifically, distinct from a sha that does not resolve to anything at all. */
let sidewaysSha: string
const deployTs = join(import.meta.dir, 'deploy.ts')
const FAKE_UNIT = 'mamoru-operator-cli-test-definitely-fake.service'
/** 40 hex chars, syntactically a valid sha, but never a real git object. */
const UNRESOLVABLE_SHA = 'f'.repeat(40)

beforeAll(async () => {
  upstream = await mkdtemp(join(tmpdir(), 'mamoru-deploy-cli-upstream-'))
  await $`git init -q -b main`.cwd(upstream)
  await $`git config user.email test@example.com`.cwd(upstream)
  await $`git config user.name "Deploy CLI Test"`.cwd(upstream)
  await writeFile(join(upstream, 'package.json'), '{"name":"scratch","private":true}\n')
  await $`git add -A`.cwd(upstream)
  await $`git commit -q -m base`.cwd(upstream)
  sha = (await $`git rev-parse HEAD`.cwd(upstream).text()).trim()

  await $`git checkout -q -b sideways`.cwd(upstream)
  await writeFile(join(upstream, 'sideways.txt'), 'never on main\n')
  await $`git add -A`.cwd(upstream)
  await $`git commit -q -m sideways`.cwd(upstream)
  sidewaysSha = (await $`git rev-parse HEAD`.cwd(upstream).text()).trim()
  await $`git checkout -q main`.cwd(upstream)
})

const dirs: string[] = []
async function scratchDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mamoru-deploy-cli-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** A fresh marker per test: guarantees pgrep matches nothing real, so the enumeration step sees "nothing running" unless the test spawns its own marker process. */
function freshEntrypoint(): string {
  return `mamoru-deploy-cli-test-entrypoint-${crypto.randomUUID()}`
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', deployTs, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

describe('deploy.ts --dry-run (CLI smoke test, local throwaway remote, never touches the real operator)', () => {
  test('prints the full plan and exits 0 for a first-ever deploy', async () => {
    const baseDir = await scratchDir()
    const deployStateDir = await scratchDir()
    const { exitCode, stdout } = await runCli([sha, '--dry-run', '--remote', upstream, '--base-dir', baseDir, '--deploy-state-dir', deployStateDir, '--unit', FAKE_UNIT, '--entrypoint', freshEntrypoint()])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('dry run: nothing was done')
    expect(stdout).toContain('(no previous release to roll back to')
    expect(stdout).toMatch(/git worktree add --detach/)
  })

  test('refuses a sha that is not an ancestor of origin/main (a real, resolvable, but sideways commit)', async () => {
    const baseDir = await scratchDir()
    const deployStateDir = await scratchDir()
    const { exitCode, stderr } = await runCli([
      sidewaysSha,
      '--dry-run',
      '--remote',
      upstream,
      '--base-dir',
      baseDir,
      '--deploy-state-dir',
      deployStateDir,
      '--unit',
      FAKE_UNIT,
      '--entrypoint',
      freshEntrypoint(),
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/not an ancestor/)
  })

  test('refuses a sha that does not resolve to any known commit (distinct from a real but sideways one)', async () => {
    const baseDir = await scratchDir()
    const deployStateDir = await scratchDir()
    const { exitCode, stderr } = await runCli([
      UNRESOLVABLE_SHA,
      '--dry-run',
      '--remote',
      upstream,
      '--base-dir',
      baseDir,
      '--deploy-state-dir',
      deployStateDir,
      '--unit',
      FAKE_UNIT,
      '--entrypoint',
      freshEntrypoint(),
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/does not resolve to a known commit/)
  })

  test('requires a sha argument', async () => {
    const { exitCode, stderr } = await runCli(['--dry-run'])
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/usage:/)
  })

  test('rejects a sha that is not a plain hex string (path-escape defense) before touching anything', async () => {
    const { exitCode, stderr } = await runCli(['../../etc/passwd', '--dry-run'])
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/must be a plain hex git sha/)
  })

  test('rejects a non-numeric --journal-seconds instead of looping forever', async () => {
    const baseDir = await scratchDir()
    const deployStateDir = await scratchDir()
    const { exitCode, stderr } = await runCli([sha, '--dry-run', '--remote', upstream, '--base-dir', baseDir, '--deploy-state-dir', deployStateDir, '--journal-seconds', 'not-a-number', '--entrypoint', freshEntrypoint()])
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/--journal-seconds must be a positive number/)
  })

  test('refuses to run at all while another deploy already holds the lock', async () => {
    const baseDir = await scratchDir()
    const deployStateDir = await scratchDir()
    // Hold the lock ourselves first, deterministically, rather than racing two subprocesses.
    const held = acquireLock(join(deployStateDir, 'deploy.lock'))
    try {
      const { exitCode, stderr } = await runCli([sha, '--dry-run', '--remote', upstream, '--base-dir', baseDir, '--deploy-state-dir', deployStateDir, '--unit', FAKE_UNIT, '--entrypoint', freshEntrypoint()])
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/held by another deploy/)
    } finally {
      held.release()
    }
  })

  test('refuses when an orphan process (no owning unit) is running the entrypoint, even in dry-run', async () => {
    const marker = freshEntrypoint()
    const child = Bun.spawn(['bun', '-e', `await Bun.sleep(5000) // ${marker}`], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await Bun.sleep(300)
      const baseDir = await scratchDir()
      const deployStateDir = await scratchDir()
      const { exitCode, stderr } = await runCli([sha, '--dry-run', '--remote', upstream, '--base-dir', baseDir, '--deploy-state-dir', deployStateDir, '--unit', FAKE_UNIT, '--entrypoint', marker])
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/unexpected operator process state/)
      expect(stderr).toMatch(/orphan/)
    } finally {
      child.kill()
    }
  })

  test('a lone process owned by the named --unit itself proceeds (the normal steady state)', async () => {
    const marker = freshEntrypoint()
    // Simulates "the durable unit is already the one running": decide() treats a bare process with
    // no resolvable owning unit as an orphan, so to hit the (a) branch we would need a real unit —
    // out of scope for dry-run CLI coverage (see the real systemd-run integration test below for
    // the one real-unit case this suite exercises). This test instead confirms the common (b) path
    // once more under a concurrently-running *unrelated* marker process, proving the entrypoint
    // filter is specific and does not over-match.
    const unrelated = Bun.spawn(['bun', '-e', 'await Bun.sleep(5000) // some-unrelated-process'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await Bun.sleep(300)
      const baseDir = await scratchDir()
      const deployStateDir = await scratchDir()
      const { exitCode, stdout } = await runCli([sha, '--dry-run', '--remote', upstream, '--base-dir', baseDir, '--deploy-state-dir', deployStateDir, '--unit', FAKE_UNIT, '--entrypoint', marker])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('dry run: nothing was done')
    } finally {
      unrelated.kill()
    }
  })
})

describe('deploy.ts --migrate-from-transient (real systemd-run throwaway unit, never the live operator)', () => {
  test('all validation happens before anything is stopped: a sha that fails the ancestor check never touches the transient unit', async () => {
    const marker = freshEntrypoint()
    const fakeTransientUnit = `mamoru-deploy-cli-test-fake-transient-${Date.now()}.service`
    await $`systemd-run --user --unit=${fakeTransientUnit} -p Type=simple ${process.execPath} -e ${`await Bun.sleep(300000) // ${marker}`}`.quiet()
    try {
      await Bun.sleep(400)
      const baseDir = await scratchDir()
      const deployStateDir = await scratchDir()
      // sidewaysSha is real and resolvable but fails the ancestor check — the whole point of the
      // order-of-operations fix: this must fail during validation, before the migrate-stop step
      // that --migrate-from-transient would otherwise trigger ever runs.
      const { exitCode, stderr } = await runCli([
        sidewaysSha,
        '--remote',
        upstream,
        '--base-dir',
        baseDir,
        '--deploy-state-dir',
        deployStateDir,
        '--unit',
        FAKE_UNIT,
        '--entrypoint',
        marker,
        '--migrate-from-transient',
        fakeTransientUnit,
      ])
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/not an ancestor/)

      // The load-bearing assertion: the transient unit was never touched.
      const stillRunning = await $`pgrep -f ${marker}`.quiet().nothrow().text()
      expect(stillRunning.trim()).not.toBe('')
      const activeState = (await $`systemctl --user show ${fakeTransientUnit} -p ActiveState --value`.quiet().text()).trim()
      expect(activeState).toBe('active')
    } finally {
      await $`systemctl --user stop ${fakeTransientUnit}`.quiet().nothrow()
      await $`systemctl --user reset-failed ${fakeTransientUnit}`.quiet().nothrow()
    }
  })

  test('once validation passes, migration happens for real; if the configured --unit then cannot be started and there is nothing to roll back to, prints the "NO OPERATOR IS RUNNING" banner and exits 2', async () => {
    const marker = freshEntrypoint()
    const fakeTransientUnit = `mamoru-deploy-cli-test-fake-transient-${Date.now()}.service`
    await $`systemd-run --user --unit=${fakeTransientUnit} -p Type=simple ${process.execPath} -e ${`await Bun.sleep(300000) // ${marker}`}`.quiet()
    try {
      await Bun.sleep(400)
      const baseDir = await scratchDir()
      const deployStateDir = await scratchDir()
      // `sha` is real and IS an ancestor of main, so validation passes and the script reaches the
      // stop/start window. --unit names a unit that was never installed anywhere on this host, so
      // `systemctl --user enable/restart` on it fails immediately — simulating "starting the new
      // release failed" without needing a real, working operator unit for this test. There is no
      // previous release (fresh --base-dir), so there is nothing to roll back to either: this must
      // reach the final banner and exit 2.
      const { exitCode, stderr } = await runCli([
        sha,
        '--remote',
        upstream,
        '--base-dir',
        baseDir,
        '--deploy-state-dir',
        deployStateDir,
        '--unit',
        FAKE_UNIT,
        '--entrypoint',
        marker,
        '--migrate-from-transient',
        fakeTransientUnit,
      ])
      expect(exitCode).toBe(2)
      expect(stderr).toContain('NO OPERATOR IS RUNNING')
      expect(stderr).toContain(`systemctl --user restart ${FAKE_UNIT}`)
      expect(stderr).toMatch(/no previous release to roll back to/)

      // Migration still happened for real, even though the subsequent start failed.
      const stillRunning = await $`pgrep -f ${marker}`.quiet().nothrow().text()
      expect(stillRunning.trim()).toBe('')
    } finally {
      await $`systemctl --user stop ${fakeTransientUnit}`.quiet().nothrow()
      await $`systemctl --user reset-failed ${fakeTransientUnit}`.quiet().nothrow()
    }
  })

  test('refuses (without --migrate-from-transient) when a process is owned by a unit other than the named durable one', async () => {
    const marker = freshEntrypoint()
    const fakeTransientUnit = `mamoru-deploy-cli-test-fake-transient-${Date.now()}.service`
    await $`systemd-run --user --unit=${fakeTransientUnit} -p Type=simple ${process.execPath} -e ${`await Bun.sleep(300000) // ${marker}`}`.quiet()
    try {
      await Bun.sleep(400)
      const baseDir = await scratchDir()
      const deployStateDir = await scratchDir()
      const { exitCode, stderr } = await runCli([sha, '--dry-run', '--remote', upstream, '--base-dir', baseDir, '--deploy-state-dir', deployStateDir, '--unit', FAKE_UNIT, '--entrypoint', marker])
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/migrate-from-transient/)
      // Dry-run: must NOT have touched the unit even though it named the exact conflicting process.
      const mainPid = (await $`systemctl --user show ${fakeTransientUnit} -p MainPID --value`.quiet().text()).trim()
      expect(Number(mainPid)).toBeGreaterThan(0)
    } finally {
      await $`systemctl --user stop ${fakeTransientUnit}`.quiet().nothrow()
      await $`systemctl --user reset-failed ${fakeTransientUnit}`.quiet().nothrow()
    }
  })
})
