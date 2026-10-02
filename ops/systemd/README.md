# ops/systemd

Two independent, unrelated proposals live in this directory. Neither installs anything by itself —
a human (or the coordinator) applies each one explicitly.

1. [Beta auto-deploy watcher](#beta-auto-deploy-watcher-proposed) (`mamoru-beta-deploy.*`,
   `beta-watch.sh`) — proposed, not installed.
2. [Durable operator unit](#durable-operator-unit-mamoru-operatordservice) (`mamoru-operatord.service`)
   and [its deploy tooling](#operator-deploy-tooling-scriptsoperatordeployts) (`scripts/operator/`)
   — otto/mamoru#7.

## Beta auto-deploy watcher (proposed)

Mirrors the pattern already running for mamoru.lol (`mamoru-github-deploy.timer` +
`mamoru-github-deploy.service`, polling `git ls-remote` every 60s, see
`systemctl --user cat mamoru-github-deploy.service`). This is the equivalent for
`apps/mamoru-app`'s beta environment.

**Not installed.** These files are proposed only; nothing in this PR touches the host's
systemd state. Ot decides if and when to wire it up.

### What it does

`mamoru-beta-deploy.timer` fires `mamoru-beta-deploy.service` every 60s. The service runs
`beta-watch.sh`, which:

1. Checks `origin/beta`'s HEAD sha via `git ls-remote` (no local fetch if nothing changed), and
   skips a sha that already failed until `origin/beta` moves again (or `MAMORU_BETA_FORCE_RETRY=1`).
2. If it's new, clones/updates a dedicated worktree at `~/.local/state/mamoru-beta-deploy/worktree`
   and checks it out, purely so there is somewhere to run the script and something to inspect.
3. Runs `bun install --frozen-lockfile && bun run deploy:beta`. `deploy:beta` itself re-resolves
   `origin/beta`'s tip and builds an immutable detached-worktree snapshot of that exact sha (never
   the live working tree), then does typecheck + test + build + `wrangler deploy --env beta` + a
   smoke test, printing a rollback command if the smoke test fails.
4. Records the deployed (or failed) sha and a one-line log entry.

`main` is never touched by this watcher. Prod deploys stay manual via `bun run promote`
(fast-forward main to beta, then `deploy:prod`) or a direct `bun run deploy:prod`. Beta is a
separate account from prod for every tester (separate session cookie, separate passkey, same D1
and operator) — see `AGENTS.md`.

### Install (run manually, this agent does not do this)

```sh
mkdir -p ~/.config/systemd/user
ln -s /home/otto/box/src/mamoru.workspace/mamoru/ops/systemd/mamoru-beta-deploy.service ~/.config/systemd/user/
ln -s /home/otto/box/src/mamoru.workspace/mamoru/ops/systemd/mamoru-beta-deploy.timer ~/.config/systemd/user/
chmod +x /home/otto/box/src/mamoru.workspace/mamoru/ops/systemd/beta-watch.sh
systemctl --user daemon-reload
systemctl --user enable --now mamoru-beta-deploy.timer
```

### Requirements before enabling

- Beta Worker secrets already set (one time, already done for the current beta Worker):
  `wrangler secret put SESSION_SECRET --env beta`, `OPERATOR_URL --env beta`,
  `OPERATOR_SECRET --env beta` from `apps/mamoru-app/`.
- SSH access to `git@github.com:ottodevs/mamoru.git` for the user running the timer (same
  as the landing watcher already uses).
- `bun` on `PATH` for the systemd user session (the unit sets a minimal `PATH`; adjust if
  `bun` lives elsewhere on the host that runs this).

### Uninstall

```sh
systemctl --user disable --now mamoru-beta-deploy.timer
rm ~/.config/systemd/user/mamoru-beta-deploy.service ~/.config/systemd/user/mamoru-beta-deploy.timer
systemctl --user daemon-reload
```

## Durable operator unit (`mamoru-operatord.service`)

`mamoru-operator.service` currently runs as a **transient** unit (`systemd-run --user --unit=...`),
started from a Cursor worktree. It disappears on `systemctl --user stop` and does not survive a
reboot. `mamoru-operatord.service` is a durable, file-based replacement — deliberately a **different
unit name**, not a reuse of `mamoru-operator.service`: two units cannot be loaded under the same name
at once, so sharing it would leave no clean way to tell "the thing currently answering to this name"
apart from the transient one without first guessing. This file only prepares the unit; a human or
the coordinator installs it, and the live transient unit is not touched by this change.

`WorkingDirectory`/`ExecStart` point at `~/.local/share/mamoru-operator/current`, a symlink
`scripts/operator/deploy.ts` (below) creates and repoints — install this unit file, then use
`deploy.ts` to populate `current` and start it; see
[Operator deploy tooling](#operator-deploy-tooling-scriptsoperatordeployts) for the one-time
migration from the transient unit.

### What it does, once wired up

- `WorkingDirectory`/`ExecStart` run `apps/mamoru-operator/src/main.ts` directly (not via a `bun run`
  package script) from whatever `current` resolves to, so the unit's own file never needs editing
  across a release: only the symlink's target changes.
- `UMask=0077`, so anything this process creates (the env file's generated `OPERATOR_SECRET`, state
  files) is never group/other-readable even under a loose ambient umask.
- Hardening that does not break it: `NoNewPrivileges`, a private `/tmp`, and the rest of the home
  directory read-only (`ProtectHome=read-only`) except the two paths this process actually writes —
  `~/.config/mamoru-operator` (the env file) and `~/.local/state/mamoru-operator` (accounts.json,
  relayer.key, rpc-usage.json). The release tree under `~/.local/share/mamoru-operator/` is
  deliberately **not** writable by this unit: it must never write its own code.
- `StartLimitIntervalSec=300` / `StartLimitBurst=5`: 5 restarts inside 5 minutes and systemd stops
  trying instead of crash-looping forever against real funds; `systemctl --user reset-failed
  mamoru-operatord` clears the counter once the underlying problem is fixed.
- `WantedBy=default.target`, so `systemctl --user enable` is enough to start it at boot — lingering is
  already on for `otto` (`loginctl show-user otto -p Linger` -> `Linger=yes`), so no active login
  session is needed either.

### Install the unit file (does not start anything by itself)

```sh
mkdir -p ~/.config/systemd/user
cp ops/systemd/mamoru-operatord.service ~/.config/systemd/user/mamoru-operatord.service
systemctl --user daemon-reload
```

## Operator deploy tooling (`scripts/operator/deploy.ts`)

`bun run operator:deploy -- <sha>` deploys a reviewed sha to the durable operator: creates (or
reuses, after verifying it) an immutable release, repoints `current`, and restarts
`mamoru-operatord.service`. `--dry-run` prints the full plan and runs every read-only check without
acting.

### Deploy layout

Under `~/.local/share/mamoru-operator/` (all created/managed by `deploy.ts`, never by hand):

```
repo/                        a normal git clone, fetched into only — never run, never the unit's cwd
releases/<full-40-char-sha>/ one immutable `git worktree` per deployed sha, installed once and never mutated again
current -> releases/<sha>    symlink the unit's WorkingDirectory/ExecStart point at; deploy.ts repoints it atomically
```

A release directory is never mutated in place (`git checkout --detach` on a live, already-running
directory would keep whatever local edits happened to be compatible with the new sha — deleted/
renamed files survive a checkout that does not touch them, and an untracked file is never touched by
checkout at all — so unreviewed code could run without anyone noticing). `<sha>` is always resolved
to the full 40-char commit sha once, right after fetching (`git rev-parse --verify <x>^{commit}`),
and used everywhere after that — an abbreviated sha would never equal `git rev-parse HEAD`'s always-
full output, so comparing the two without resolving first would make a correct, reused release look
like a mismatch every time.

### Trusting a release, new or reused

Before trusting ANY release (new or reused, including for a rollback), `deploy.ts` always: (1)
verifies `git -C <release> rev-parse HEAD` is exactly the resolved sha — a reused release whose HEAD
drifted (hand-edited, corrupted, tampered with) is removed and recreated, never trusted as-is; (2)
runs `git status --porcelain --ignored=matching` and refuses any ignored file other than a
`node_modules` directory (a stray `.env`, a build artifact, or anything else ignored fails the
deploy) — checked **before** `bun install` ever runs, not after; (3) for a reused release, compares a
recorded manifest (the `bun.lock` hash plus a `node_modules` fingerprint — each top-level package's
name and total size on disk) against what is currently on disk; a mismatch means node_modules is
never reused blindly — the release is removed and rebuilt from scratch rather than trusted; (4)
re-runs `bun install --frozen-lockfile` — idempotent, so this is a real verification even for an
already-installed release, not an assumption — and fails if it changes `bun.lock` (a frozen-lockfile
install is documented to error rather than rewrite the lockfile, so any change means something is
wrong). The verified manifest is recorded in `~/.local/state/mamoru-operator-deploy/release-meta/<sha>.json`
— the deploy tool's own state, never inside the release tree (a metadata file there would itself be
an untracked/ignored stray file and trip the ignored-file check on the next deploy).

### Process safety: before, immediately before, and after

`deploy.ts` takes an exclusive, non-blocking lock (`flock(2)`, via `bun:ffi`) on
`~/.local/state/mamoru-operator-deploy/deploy.lock` for its entire run — **not** anything under the
operator's own state dir — so a second concurrent deploy exits non-zero immediately instead of
racing the first one.

It enumerates every process whose command line runs the operator entrypoint (any cwd) and every
systemd user unit (durable or transient) that owns one of those processes
(`scripts/operator/lib/enumerate.ts`) at three points, using the same decision function every time:

1. **At the start**, before any network/git/install work. Exactly one state is allowed to proceed
   without `--migrate-from-transient`: (a) only the durable unit is running, alone, or (b) nothing is
   running at all. Anything else — an orphan process, the transient unit, more than one process —
   refuses with instructions. `--migrate-from-transient <unit>` is only accepted when that exact unit
   is the one (and only) thing found running, **and** systemd itself reports it as transient
   (`Transient=yes`) — naming the durable unit, or any other non-transient unit, by this flag refuses
   outright, never migrates.
2. **Immediately before the stop/start window** — after fetching, resolving the release, verifying
   its integrity, and repointing `current` (all of which can take a while, and none of which is
   destructive). This re-check catches anything that changed in the meantime; aborting here is always
   safe, since nothing has been stopped yet.
3. **Immediately after starting** — exactly one process, owned by the durable unit alone, or the
   start is treated as a failure (see below), not just a difference worth noting.

Only at checkpoint 2, once it is confirmed safe, does `--migrate-from-transient` actually stop the
named unit: it waits (polling) for its process(es) to actually exit, and never force-kills anything
unless `--force-kill` is also given explicitly, and even then only after the plain stop-and-wait did
not clear it within 15s.

### Order of operations and automatic rollback

**Every validation and preparation step — fetch, the ancestor check, release creation/reuse,
integrity, install, the accounts.json backup, repointing `current` — happens before anything is
stopped.** None of that can fail for an avoidable reason once it has succeeded, so the stop→start
window right after it is as short, and as unlikely to fail, as this tool can make it.

If starting still fails — the restart command itself errors, health never comes up within 30s, or
checkpoint 3 above is not the expected single-process state — `deploy.ts` automatically rolls back:
repoints `current` back to the previous release and tries starting that again. If the rollback also
fails (or there was no previous release to roll back to), it prints a loud final banner and exits
**2** (every other failure exits 1):

```
################################################################
##                                                            ##
##               NO OPERATOR IS RUNNING                       ##
##                                                            ##
################################################################
```

with the exact manual command to try. A post-start journal-watch finding a review-error-shaped line,
or the unit restarting again on its own / going non-active during that window, is reported and exits
1 but does **not** trigger the automatic rollback above — the unit is up and alone at that point, and
flipping back to an older sha on its own in response to a review-error pattern (which may be
transient or unrelated to the deploy) is a judgment call left to a human, with the exact rollback
command printed either way.

### One-time migration from the transient unit

The transient and durable units **must never run at once**: both hold `accounts.json` (session
keys) open and drive the same relayer nonce on chain. One command does the whole migration,
verifying the transient unit's process is actually gone before doing anything else:

```sh
mkdir -p ~/.config/systemd/user
cp ops/systemd/mamoru-operatord.service ~/.config/systemd/user/mamoru-operatord.service
systemctl --user daemon-reload

RUNNING_SHA=$(git -C /home/otto/.cursor/worktrees/mamoru/op rev-parse HEAD)
bun run operator:deploy -- "$RUNNING_SHA" --migrate-from-transient mamoru-operator.service
# or, to see the plan first without acting:
bun run operator:deploy -- "$RUNNING_SHA" --dry-run --migrate-from-transient mamoru-operator.service
```

This creates `releases/$RUNNING_SHA` from the current `origin/main` history (a pure infra move — no
app code change in the same step; upgrade afterward with a normal
`bun run operator:deploy -- <new-sha>`), stops `mamoru-operator.service`, confirms its process is
gone, repoints `current`, enables and starts `mamoru-operatord.service`, and runs the full
post-restart verification (health, cwd/sha, re-enumeration, journal watch).

### Verify

```sh
systemctl --user status mamoru-operatord.service                             # active (running)
systemctl --user is-enabled mamoru-operatord.service                          # enabled -> survives a reboot
systemctl --user show mamoru-operatord.service -p Transient -p FragmentPath   # Transient=no, a real file path
curl -s http://127.0.0.1:8787/health                                          # {"ok":true,"chainId":8453,"live":true,...}
journalctl --user -u mamoru-operatord.service -n 50                          # "[armed] N armed activation(s) reloaded" /
                                                                               # "[engine ...] loop started" once per active account
lsof ~/.local/state/mamoru-operator/accounts.json                            # exactly one bun process holds it open
readlink -f ~/.local/share/mamoru-operator/current                           # the release the unit should be running from
pgrep -af apps/mamoru-operator/src/main.ts                                   # exactly one match
```

Lingering is already on for `otto` (`loginctl show-user otto -p Linger` -> `Linger=yes`), so
`WantedBy=default.target` is enough to start this at boot with no active login session. If it were
ever `no`, the unit would need `loginctl enable-linger otto` first.

### Everyday deploys (after the migration)

```sh
bun run operator:deploy -- <sha> --dry-run   # prints the plan and runs every read-only check; touches nothing
bun run operator:deploy -- <sha>             # backs up accounts.json, creates/reuses (and verifies) the release, repoints current, restarts, verifies
```

`<sha>` must be a plain hex git sha (7-40 hex chars; refuses a ref, a branch name, or anything else
outright — defense against a path escaping the releases root once joined into a path) **and** an
ancestor-or-equal of `origin/main` after resolving to the full 40 chars (refuses otherwise: no
deploying an unreviewed/unknown commit). It prunes old releases beyond `--keep-releases` (default 5)
on success, never the one `current` points at, and prints the exact rollback command on every run.

### This repo is not yet deployed with this tooling

Nothing in this PR has been run against the live operator — see the report for what remains
unverified. The first real use of `deploy.ts` against the actual live transient unit is a deliberate,
separate, manual step the coordinator takes.

### The tunnel is a reboot hazard too (proposal, not applied)

`mamoru-op-tunnel.service` is also transient (`cloudflared tunnel --url http://127.0.0.1:8787`), a
Cloudflare **quick tunnel**: it gets a new random `*.trycloudflare.com` hostname every time it
starts (current one is in `~/.config/mamoru-operator/tunnel-url`). The landing Worker holds that
hostname in its `OPERATOR_URL` secret. A reboot (or anyone restarting the tunnel) breaks `OPERATOR_URL`
silently until someone notices and re-pastes the new hostname — functionally the same hazard this
tooling fixes for the operator itself, just one layer up. **Not changed here** (explicitly out of
scope); below is the fix to apply later.

**Proposal: a named tunnel with a stable hostname.**

1. In the Cloudflare dashboard: Zero Trust -> Networks -> Tunnels -> Create a tunnel (e.g. named
   `mamoru-operator`). (Equivalently from the CLI: `cloudflared tunnel login` then
   `cloudflared tunnel create mamoru-operator` — avoids downloading credentials through the browser.)
2. Add a Public Hostname on that tunnel, e.g. `operator.mamoru.lol`, pointing at the service
   `http://127.0.0.1:8787`. This hostname is permanent: it does not change on restart or reboot.
3. Set `OPERATOR_URL` to `https://operator.mamoru.lol` once (`wrangler secret put OPERATOR_URL --env beta`
   and the prod equivalent) — never needs updating again.
4. Swap `cloudflared tunnel --url http://127.0.0.1:8787` for
   `cloudflared tunnel run mamoru-operator` (reads the named tunnel's credentials file, normally
   `~/.cloudflared/<tunnel-id>.json`), and give it the same durable-unit treatment as
   `mamoru-operatord.service` above, so the tunnel also survives a reboot.
5. A stable hostname is slightly worse for security-through-obscurity than a random one (anyone who
   learns it has it forever), so consider a Cloudflare Access policy on the hostname. Either way the
   real authorization boundary is the per-account HMAC (`server.ts`) and the operator-level HMAC on
   `/metrics` (`packages/operator-auth`, see `docs/operator-metrics.md`) — the tunnel is transport,
   not auth.
