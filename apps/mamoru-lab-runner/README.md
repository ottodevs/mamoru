# @mamoru/lab-runner

Agent Lab bench + agent runner (spec 008 phase 1 + 2, otto/mamoru#199, #204). Claims jobs from the landing
Worker's signed `/ops/lab/runner/*` API: bench jobs are computed with the production engine (`@mamoru/lab-bench`,
over local dataset files); agent jobs run the Agent Lab agent (`@mamoru/lab-agent`) over a model-plane chat
client (`model-plane-client.ts`). Holds no wallet key, no RPC key and no D1 credential — only `LAB_RUNNER_SECRET`,
the dataset files on disk, and a loopback call to model-plane (no auth needed there).

## Commands

```sh
bun src/cli.ts once feb2025 live 4000 1000   # compute locally, print the B-02 result's summary, no network
bun src/cli.ts once 'feb2025|live|4000|1000' # same, as one specKey (quote it: the shell reads | as a pipe)
bun src/cli.ts seed                          # the B-03 catalog matrix, published without a job
bun src/cli.ts run                           # claim / heartbeat / result loop (what the systemd unit runs; bench + agent jobs)
bun src/cli.ts ask "¿qué pasó en feb2025?" --window feb2025
                                              # the agent loop, locally, against the REAL model-plane client and
                                              # REAL datasets — prints the answer blocks + cost, no network to
                                              # the landing at all (no claim/heartbeat/publish/result)
```

## Env

| Var | Required by | Default |
|---|---|---|
| `LAB_RUNNER_URL` | `run`, `seed` | none (e.g. `https://mamoru.lol`) |
| `LAB_RUNNER_SECRET` | `run`, `seed` | none — never logged |
| `LAB_DATASETS` | all | `~/.local/share/mamoru-lab/datasets` |
| `MODEL_PLANE_URL` | `run` (agent jobs), `ask` | `http://127.0.0.1:3500` |
| `LAB_AGENT_MODELS` | `run` (agent jobs), `ask` | `llama-3.3-70b-versatile,llama-3.1-8b-instant` (AL-30's ordered peer list — model-plane *alias* names, tried in order; see "Agent jobs and the model-plane client" below — **neither has an alias yet**, see the blocker) |
| `LAB_AGENT_DAILY_BUDGET` | `run` (agent jobs) | `30` (contract: max agent jobs/day across requesters, enforced here) |
| `LAB_AGENT_BUDGET_STATE` | `run` (agent jobs), tests | `${XDG_STATE_HOME:-~/.local/state}/mamoru-lab-runner/agent-budget.json` |
| `LAB_HEARTBEAT_INTERVAL_MS` | tests only | `30000` (AL-02's cadence — never override this for a real run) |

## Agent jobs and the model-plane client (task 5, otto/mamoru#204)

`model-plane-client.ts` is a `ModelClient` (packages/lab-agent) over model-plane's `POST /v1/chat/completions`
(OpenAI-compatible, no auth — model-plane trusts loopback). AL-30: `LAB_AGENT_MODELS` is an ordered list of
model-plane **alias names**, tried in order; a model that errors, times out (45s) or has no tool support is
skipped for the rest of that job (never retried until the next job). AL-04's wall-clock budget (120s, extended to
15 min once a `sweep` tool call starts) and the lease heartbeat both run on the **worker thread** that executes
the whole agent job (`run-agent-worker.ts`) — same reasoning as the bench job's own worker (`run-worker.ts`): a
tool call is long and synchronous, and must never starve the heartbeat.

**Known blocker, found while wiring this (verified live, 2026-10-23):** model-plane's three currently-working
aliases (`vertex-flash`, `vertex-argon`, `vertex-pro`) all explicitly refuse a request carrying `tools`
(`{"error":"vertex-dev-credits does not support tools"}` — a deliberate guard in model-plane's own
`vertex-guarded-call.ts`, not a transient fault). The two Groq models this default list names
(`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`) ARE already registered in model-plane with
`capabilities: ["text","code","tools"]`, on the `groq-api` connection ("Groq API (from OmniRoute Groq free)",
included quota, active) — the right target, proxied through model-plane's plain `OpenAICompatibleAdapter` with no
translation layer to drop `tools`. But **neither has a model-plane alias yet**, and creating one
(`POST /v1/aliases`) currently 500s on live model-plane with `null value in column "model_id" of relation
"model_aliases" violates not-null constraint` — a pre-existing schema-drift bug (the live Postgres table still
carries a legacy `model_id NOT NULL` column the current Drizzle schema no longer declares), filed as
`otto/model-plane#93`. Until that's fixed and the two aliases below are created, every call through this
default list ends in `LAB_MODEL_UNAVAILABLE` (reproduced by `ask`, see the PR body's smoke-test output) — this
package's own code is correct and needs no change once model-plane is: `POST /v1/aliases {"alias":
"llama-3.3-70b-versatile"}` then `POST /v1/routes {"aliasId": "<id>", "connectionId":
"127c37c7-49fd-4992-9186-514c4e3eb235", "modelId": "47b2c42f-2e23-4518-a91e-1ce2c453c0ab"}`, same for
`llama-3.1-8b-instant` / model `b4dd81e5-3e65-45ee-85e7-35e9316d750c`.

**AL-03/history gap:** the claim response's `history` carries only `{question, answer}` per prior turn (CONTRACT,
shared with the landing session building task 6) — no run records. `packages/lab-agent`'s
`renderAnswerForHistory` needs each cited run to render a claim/verdict block's concrete number into history
text; without it, those lines are dropped (never a crash — the package already treats a missing run as "drop
this line"). A follow-up question still sees the prior question and any run-free prose, but loses the prior
turn's numbers. Closing this needs either the claim response to also carry each cited run, or a landing endpoint
to fetch a run by hash on demand — both out of scope for this runner change; flagged here for whoever picks up
the next slice.

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
   # otto/mamoru#204 (task 5, agent jobs) — all optional, default to the values below if omitted:
   # MODEL_PLANE_URL=http://127.0.0.1:3500
   # LAB_AGENT_MODELS=llama-3.3-70b-versatile,llama-3.1-8b-instant
   # LAB_AGENT_DAILY_BUDGET=30
   EOF
   chmod 600 ~/.config/mamoru-lab-runner/env
   systemctl --user daemon-reload
   systemctl --user enable --now mamoru-lab-runner.service
   ```

   The unit file now carries `StateDirectory=mamoru-lab-runner` (the agent-job daily budget counter,
   otto/mamoru#204): systemd creates `~/.local/state/mamoru-lab-runner` and keeps it writable under the otherwise
   read-only `$HOME`; `systemctl --user daemon-reload` picks it up from the copied unit file.
3. Verify: `systemctl --user status mamoru-lab-runner.service` (active), `journalctl --user -u mamoru-lab-runner -f`
   while triggering a "Run scenario" in `/ops/lab`, or run `bun src/cli.ts seed` once by hand (with the same env) to
   populate the bench's catalog before anyone opens it.

See `ops/systemd/README.md` for the equivalent walkthrough already used for the operator and the beta watcher —
same pattern (`systemctl --user`, lingering already on for `otto`), different unit.
