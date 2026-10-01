# Proposed: beta auto-deploy watcher

Mirrors the pattern already running for mamoru.lol (`mamoru-github-deploy.timer` +
`mamoru-github-deploy.service`, polling `git ls-remote` every 60s, see
`systemctl --user cat mamoru-github-deploy.service`). This is the equivalent for
`apps/mamoru-app`'s beta environment.

**Not installed.** These files are proposed only; nothing in this PR touches the host's
systemd state. Ot decides if and when to wire it up.

## What it does

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

## Install (run manually, this agent does not do this)

```sh
mkdir -p ~/.config/systemd/user
ln -s /home/otto/box/src/mamoru.workspace/mamoru/ops/systemd/mamoru-beta-deploy.service ~/.config/systemd/user/
ln -s /home/otto/box/src/mamoru.workspace/mamoru/ops/systemd/mamoru-beta-deploy.timer ~/.config/systemd/user/
chmod +x /home/otto/box/src/mamoru.workspace/mamoru/ops/systemd/beta-watch.sh
systemctl --user daemon-reload
systemctl --user enable --now mamoru-beta-deploy.timer
```

## Requirements before enabling

- Beta Worker secrets already set (one time, already done for the current beta Worker):
  `wrangler secret put SESSION_SECRET --env beta`, `OPERATOR_URL --env beta`,
  `OPERATOR_SECRET --env beta` from `apps/mamoru-app/`.
- SSH access to `git@github.com:ottodevs/mamoru.git` for the user running the timer (same
  as the landing watcher already uses).
- `bun` on `PATH` for the systemd user session (the unit sets a minimal `PATH`; adjust if
  `bun` lives elsewhere on the host that runs this).

## Uninstall

```sh
systemctl --user disable --now mamoru-beta-deploy.timer
rm ~/.config/systemd/user/mamoru-beta-deploy.service ~/.config/systemd/user/mamoru-beta-deploy.timer
systemctl --user daemon-reload
```
