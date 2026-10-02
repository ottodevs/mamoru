# ops/systemd

Two independent, unrelated proposals live in this directory. Neither installs anything by itself —
a human (or the coordinator) applies each one explicitly.

1. [Beta auto-deploy watcher](#beta-auto-deploy-watcher-proposed) (`mamoru-beta-deploy.*`,
   `beta-watch.sh`) — proposed, not installed.
2. [Durable operator unit](#durable-operator-unit-mamoru-operatordservice) (`mamoru-operatord.service`)
   — the unit file only (otto/mamoru#7). The deploy tooling that creates its `current` release
   symlink and drives it (fetch/checkout, the transient-to-durable migration, health/journal
   verification) is a separate, not-yet-merged change; this unit is complete and installable on its
   own, but nothing yet repoints `current` or restarts it for you.

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

**This is the unit file only.** It is complete and installable on its own, but by itself it does
nothing useful yet: `WorkingDirectory`/`ExecStart` point at `~/.local/share/mamoru-operator/current`,
a symlink this unit expects to already exist and point at a working checkout of the operator — and
nothing in this change creates that checkout, populates the symlink, migrates the transient unit's
accounts/session state across, or restarts anything. That tooling (fetch/checkout, the
transient-to-durable migration, post-restart health/journal verification) is deliberately a separate
change, reviewed and shipped on its own; do not install this unit expecting it to start anything
until that tooling (or an equivalent manual setup of `current`) exists.

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

### Install (does not start anything by itself; see the caveat above)

```sh
mkdir -p ~/.config/systemd/user
cp ops/systemd/mamoru-operatord.service ~/.config/systemd/user/mamoru-operatord.service
systemctl --user daemon-reload
```

### Verify, once `current` points somewhere real and the unit has been started

```sh
systemctl --user status mamoru-operatord.service                             # active (running)
systemctl --user is-enabled mamoru-operatord.service                          # enabled -> survives a reboot
systemctl --user show mamoru-operatord.service -p Transient -p FragmentPath   # Transient=no, a real file path
curl -s http://127.0.0.1:8787/health                                          # {"ok":true,"chainId":8453,"live":true,...}
```
