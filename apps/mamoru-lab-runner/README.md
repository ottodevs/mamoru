# @mamoru/lab-runner

Agent Lab bench runner (spec 008 phase 1, otto/mamoru#199). Claims bench jobs from the landing Worker's signed
`/ops/lab/runner/*` API, computes them with the production engine (`@mamoru/lab-bench`, over local dataset files),
and posts results back. Holds no wallet key, no RPC key and no D1 credential — only `LAB_RUNNER_SECRET` and the
dataset files on disk.

## Commands

```sh
bun src/cli.ts once feb2025 live 4000 1000   # compute locally, print the B-02 result's summary, no network
bun src/cli.ts once 'feb2025|live|4000|1000' # same, as one specKey (quote it: the shell reads | as a pipe)
bun src/cli.ts seed                          # the B-03 catalog matrix, published without a job
bun src/cli.ts run                           # claim / heartbeat / result loop (what the systemd unit runs)
```

## Env

| Var | Required by | Default |
|---|---|---|
| `LAB_RUNNER_URL` | `run`, `seed` | none (e.g. `https://mamoru.lol`) |
| `LAB_RUNNER_SECRET` | `run`, `seed` | none — never logged |
| `LAB_DATASETS` | all | `~/.local/share/mamoru-lab/datasets` |

## Installing the systemd unit (not done by this change)

`systemd/mamoru-lab-runner.service` is the unit file only. Nothing in this pull request installs or starts it (the
author role never touches lady's live systemd state or secrets). To install it, once the landing has
`LAB_RUNNER_SECRET` set and deployed:

1. Put a durable checkout of `ottodevs/mamoru` on `main` somewhere outside any Cursor worktree (worktrees get
   removed; this unit must survive that) — e.g. `~/.local/share/mamoru-lab-runner/checkout`, kept up to date with
   `git pull` on the sha the coordinator wants running. Run `bun install` there.
2. Replace `REPLACE_WITH_MAMORU_CHECKOUT` in `systemd/mamoru-lab-runner.service` with that absolute path (relative
   to `%h`, i.e. without the leading `$HOME/`), then:

   ```sh
   mkdir -p ~/.config/systemd/user ~/.config/mamoru-lab-runner
   cp apps/mamoru-lab-runner/systemd/mamoru-lab-runner.service ~/.config/systemd/user/
   cat > ~/.config/mamoru-lab-runner/env <<'EOF'
   LAB_RUNNER_URL=https://mamoru.lol
   LAB_RUNNER_SECRET=<the Worker secret LAB_RUNNER_SECRET>
   EOF
   chmod 600 ~/.config/mamoru-lab-runner/env
   systemctl --user daemon-reload
   systemctl --user enable --now mamoru-lab-runner.service
   ```
3. Verify: `systemctl --user status mamoru-lab-runner.service` (active), `journalctl --user -u mamoru-lab-runner -f`
   while triggering a "Run scenario" in `/ops/lab`, or run `bun src/cli.ts seed` once by hand (with the same env) to
   populate the bench's catalog before anyone opens it.

See `ops/systemd/README.md` for the equivalent walkthrough already used for the operator and the beta watcher —
same pattern (`systemctl --user`, lingering already on for `otto`), different unit.
