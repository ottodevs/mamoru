# 008: Agent Lab, a chat that designs and runs Lab studies

Ticket: otto/mamoru#175. Status: spec. Research, thesis checks and both concept probes are done (links below);
nothing here is built yet.

## Problem

The Lab already answers the questions that change the product: the backtest replays history through the production
`decide` (`packages/backtest`), the sweep runs a policy over the 13 TRAIN/TEST windows and gates releases ("gate del
Lab 23/24", PR #67), and the fork harness holds 45 scenarios. But every study needs Ot at a shell: pick a dataset,
write CLI flags, read a text dump. Brais cannot run one. The public `/lab` replays three recorded tapes and is hard to
read for anyone who does not already know what a tick, a gate trail or a block is.

Ot (18-20 Oct): a new Lab, built from scratch, in the private `/ops`. A chat where you ask an agent for scenarios or
tests; the agent designs them, runs them on the real engine, and shows the study visually. Built so that it can later
be sold as an agentic service over x402 and as part of a Mamoru premium tier, multichain, with a cost model we can
quantify to set prices. The public `/lab` stays as it is.

## Evidence this rests on

| Thesis | Result | Source (Noema, `1-projects/mamoru/research/agent-lab/`) |
|---|---|---|
| The engine already covers the real questions; the gap is interface | Yes: backtest, sweep, windows, calibration, case studies, 45 fork scenarios, CPPI/depeg already in `PolicyVersion` | `inventory-2026-10-18` |
| An LLM can map questions to correct simulator calls | Only large models: 100% / 94% / 78% tool-call accuracy across three free models, 54 jobs | `probe-agent-tools-2026-10-18` |
| Numbers in answers can come only from tool output | Yes: 0 invented numbers in 54 + 18 jobs; a deterministic verifier is still required (it caught format and schema faults) | `probe-agent-tools-2026-10-18`, `poc-chat-2026-10-20` |
| Free model pools are a usable base | No: the primary free model was down for a whole run (404), first-pass schema validity 0/18 on the fallback, p50 71 s | `poc-chat-2026-10-20` |
| A job is cheap enough to charge per job | Compute + data + infra < 0.01 USD per job (backtest ≈ 64 ms + 0.297 ms per sample); the floor is LLM tokens plus the x402 facilitator fee (0.001 USD per settlement past 1,000/month) | `cost-model-2026-10-18` |
| Nobody offers this | No LP product has a chat-driven scenario simulator; Almanak is the nearest architecture; no published async x402 job pattern | `sota-2026-10-18` |
| "Your money vs doing nothing" reads without LP vocabulary | Ot picked view A of the visual PoC (verdict sentence, Mamoru vs hold vs stay in USDC, fees/gas/price split, range band per pool) | PoC-1, artifact `Uh77nzDhLzTa4LbeZUThST` |

## Scope

**v1 (this spec):** `/ops/lab`, Ot and Brais only (the existing `/ops` Google allowlist). Chat threads; the agent runs
backtests, comparisons and sweeps over the dataset catalog with the policies in `POLICIES` and the overrides
`PolicyVersion` already accepts; answers render as verified blocks and view-A charts; every job records its cost.

**Designed for, not built in v1:** x402 payment and an external endpoint; fork scenarios (anvil) as a tool; Monad
datasets; a public or premium surface; exporting a study as an engine-settings draft template (006 phase 2 already
names the Lab as a source).

**Never:** the agent writes engine settings, touches the operator, a session key, an account or D1 outside the two
Lab tables; the Lab's numbers enter the production views (Constitution XVI).

## Requirements

### Jobs and threads

- **AL-01** A thread is a list of turns. A user turn creates one job: `{id, threadId, origin: 'ops', requester (ops
  email), question, status, createdAt}`. Status moves `queued → running → done | failed | refused`, only forward.
- **AL-02** One runner claims a job with a lease (claim id + expiry, 10 min); an expired lease returns the job to
  `queued` once; a second expiry marks it `failed` with `LAB_JOB_LEASE_LOST`.
- **AL-03** A job carries the thread's earlier turns (questions and verified answers, never raw tool output) so a
  follow-up ("and with the range twice as wide?") works.
- **AL-04** Each job has a wall-clock budget (120 s for chat tools, 15 min when it starts a sweep) and stops with
  `LAB_JOB_TIMEOUT` past it, keeping any finished runs.

### Tools the agent can call

- **AL-10** `run_backtest({window | datasetId, policyId, deposit, overrides?})` → `{runId: resultHash, metrics,
  window, opsCount}`. Pure, in-process, < 5 s on the largest window.
- **AL-11** `compare({runs: RunSpec[]})` → the same per run, max 8 runs per call.
- **AL-12** `sweep({policyId, overrides[], windows?})` → async: returns `{sweepId}` and the job waits for it inside its
  budget; result is the per-window table the release gate reads, each row with its `runId`.
- **AL-13** Overrides are validated against the `PolicyVersion` schema and bounds in code before a run. An unknown
  key is a tool error (`LAB_OVERRIDE_UNKNOWN`), never ignored. The agent must report it, not try another policy.
- **AL-14** The catalog (windows with regime, dates, chain, pools, market moves; policies with a one-line
  description; override keys with bounds) is in the system prompt, regenerated from code and the dataset manifest
  per job. There are no `list_*` tools.
- **AL-15** Max 4 tool rounds per job; then the agent must answer with what it has.
- **AL-16** Every run is stored by `resultHash` with its spec (dataset id, policy hash, overrides, deposit,
  `SIM_VERSION`): the same spec gives the same hash, so any answer can be re-run.

### Answer contract and verifier

- **AL-20** The agent's final action is a `submit_answer` call with `{blocks: Block[]}`:
  `text {md}`, `claim {label, value, unit: 'USDC'|'%'|'ops'|'days', runId, path}`, `chart {kind: 'equity' |
  'decomposition' | 'pool_range', runIds, pool?}`, `caveat {md}`. Text and caveat carry no figures: they reference
  claims as `{{c0}}`. Allowed digits in text: years, window ids, dataset and policy ids.
- **AL-21** A deterministic verifier checks: schema; each claim's value equals the stored run at `path` (tolerance
  0.005 absolute or 0.1% relative; `%` may be bps/100); text has no untraceable digits; each chart's run ids exist
  and the kind fits the runs.
- **AL-22** On a failed check the errors go back to the model once (repair turn). If it still fails, the answer
  shows its verified claims and charts only, flagged `LAB_ANSWER_PARTIAL`. A refusal or a "the data does not exist"
  answer with no claims is valid and is never emptied (fixes the PoC-2 fallback bug).
- **AL-23** Nothing reaches the screen that did not pass AL-21. The screen labels every answer as a simulation over
  history, with the window and `SIM_VERSION` (Constitution XVI).
- **AL-24** The question is data, never instructions to the runner: it cannot change tools, budgets, model route or
  the catalog. A question asking for future prices, live funds or actions outside the tools gets a caveat block.

### Model

- **AL-30** The runner calls the model through one model-plane route, `agent-lab`, with an ordered list of included
  resources treated as peers (the route config names them; the spec does not). A dead resource is skipped for that
  job and reported to model-plane, not dropped from the list.
- **AL-31** The model must support tool calling and finish with `submit_answer`. A resource whose first-pass
  schema validity falls under 80% over its last 20 jobs is marked degraded on `/ops/lab` (from AL-41 data).
- **AL-32** No paid API. Included subscription credits count at their shadow price (AL-40).

### Cost meter (input to pricing)

- **AL-40** Each job records: model resource and tokens in/out per call, tool rounds, runs and their CPU ms, sweep
  CPU ms, wall time, repair used, verifier outcome. Shadow prices per resource live in one config table with a date.
- **AL-41** `/ops/lab` shows per job and per month: count, shadow cost split into LLM / compute / data / settlement
  (0 in v1), p50/p95 wall time, verifier pass rate per model resource.
- **AL-42** Three archetypes are reported apart: quick question (≤ 2 runs), study (sweep), scenario (fork, later).
  Their measured cost is what x402 and premium prices are set from; no price is set in v1.

### Screen (`/ops/lab`)

- **AL-50** Thread list and a chat column. A turn shows its status live (queued, running with the tool in flight,
  done) and then the answer blocks.
- **AL-51** Blocks render with the view-A components of PoC-1: verdict sentence from claims, equity chart (Mamoru,
  hold the mix, stay in USDC), decomposition (fees, gas, price move, net), range band per pool with re-range and
  harvest marks. A claim chip shows its run on hover; a run opens a side panel with spec, metrics and "run again".
- **AL-52** The run store keeps the visual series per run (value, hodl, per-pool price and active band, ops),
  downsampled to ≤ 400 points; the band comes from an `onSample` hook in `runBacktest` (built in the PoC worktree
  `poc/175-agent-lab`, read-only for the run).
- **AL-53** Desktop and 390 px, light and dark, Mamoru's tokens (paper, ink, emerald) and the validated chart pair
  (light `#13805a` / `#b8792a`, dark `#2fa77c` / `#bf8033`); stay-in-USDC is a dashed reference rule, not a series.
  The PoC-1 page is the visual reference for the implementing session; screenshots at both widths before merge.

### Ready for x402 (shape only in v1)

- **AL-60** A job has `origin: 'ops' | 'x402'` and, for x402, `payer`, `quote {maxAmount, asset, network, deadline}`
  and `paymentId = jobId`. v1 writes `ops` only.
- **AL-61** The future paid endpoint quotes from AL-42 archetype costs, takes an `upto` authorization bound to the
  quote's deadline, enqueues the same job, and settles only the measured cost on `done`; on `failed`, `refused` or
  timeout it never settles and the authorization lapses. Payer screening reuses Mamoru San's Intercepta flow.
- **AL-62** The endpoint is a separate Worker route, never `/ops`, with its own rate limits; it reads only verified
  answers.

### Multichain

- **AL-70** The catalog keys datasets by `chainId`. v1 serves Base windows. Ethereum windows are a backfill (same
  pipeline, ≈ 0.21 USD per 30 days at 5 min on QuickNode). Monad has no archive depth for a backfill; it needs a
  forward collector (ticket apart), and the agent says so when asked.

## Architecture

```
/ops/lab (landing Worker, Google allowlist)
  │ write turn → D1 lab_jobs (queued)            read jobs, runs, answers ← D1
  ▼
mamoru-app Worker  /api/lab/runner/{claim, heartbeat, runs, answer}   signed, same scheme as engine-settings pull
  ▲
lab runner on lady (systemd unit, bun)  ── model-plane route agent-lab ──► included models
  ├─ packages/lab-agent: loop, tools, catalog prompt, contract, verifier, cost meter
  └─ packages/backtest (+ onSample) over ~/.local/share/mamoru-lab/datasets
```

- The runner holds no wallet key, no RPC key and no D1 credential: only the runner signing secret and the model-plane
  route. Datasets are local files; a missing dataset is a tool error.
- D1 is a projection for the screen (Constitution VII): the runner's run store is the record; D1 holds job rows,
  verified answers and run summaries + visual series.
- Why the runner on lady and not a Worker: the models are reached through model-plane on lady, the 103 MB dataset
  set is already there, and fork scenarios (later) need anvil, which never runs on Cloudflare (Constitution XIII).
  A Worker or Container runner is the step when x402 traffic needs it.

## Data (D1, `XXXX_agent_lab.sql`, additive)

- `lab_threads (id, owner, title, created_at)`
- `lab_jobs (id, thread_id, origin, requester, question, status, lease_id, lease_until, attempts, answer_json,
  verifier_json, cost_json, error_code, quote_json, payer, created_at, updated_at)`
- `lab_runs (result_hash PK, spec_json, metrics_json, series_json, sim_version, created_at)`
- `lab_prices (resource, unit, usd, valid_from)` — shadow prices for AL-40.

## Threats and answers

| Threat | Answer |
|---|---|
| Prompt injection in a question makes the agent act | Tools are pure simulation; no tool writes outside the run store; AL-24 |
| The model invents or rounds a number into a claim | AL-21 verifier against the stored run; AL-23 nothing unverified on screen |
| A Lab result is read as a promise | Every answer labeled simulation over history with window and `SIM_VERSION`; never in production views |
| A runner secret leaks | Signed requests expire; the secret only reads/writes Lab rows; rotate via Worker secret |
| A heavy sweep starves the operator on lady | Runner is its own unit with `CPUQuota` and `Nice`; one sweep at a time |
| Cost runs away on included quota | Per-day job cap per requester; AL-41 shows the burn |
| Model resource dies mid-job | AL-30 next peer; job keeps finished runs |

## Scenarios (accept the tasks)

- **LAB-AL-01** "¿Qué habría pasado con 1.000 USDC en la caída de febrero 2025?" → one `run_backtest` on `feb2025`,
  `conservador-live-v2`, deposit 1000; claims for end, vsHodl, fees, gas match the run; equity + decomposition charts.
  (AL-10, AL-20, AL-21, AL-51)
- **LAB-AL-02** "Compara las tres caídas con la política actual" → one `compare` round with 3+ runs, no `list_*`.
  (AL-11, AL-14)
- **LAB-AL-03** An override key that does not exist → tool error reported in a caveat, no other policy tried.
  (AL-13, AL-15)
- **LAB-AL-04** "¿Cuánto rendirá el mes que viene?" → caveat only, valid answer, not emptied. (AL-22, AL-24)
- **LAB-AL-05** A forged answer whose claim is off by 1% → verifier rejects; repair; partial render flagged. (AL-21, AL-22)
- **LAB-AL-06** Runner killed mid-job → lease expires, job re-queued once, then `LAB_JOB_LEASE_LOST`. (AL-02)
- **LAB-AL-07** Sweep of one override over all windows → per-window table with run ids within 15 min. (AL-12, AL-04)
- **LAB-AL-08** Every job row has tokens, CPU ms, wall time, shadow cost; `/ops/lab` totals match the rows. (AL-40, AL-41)
- **LAB-AL-09** Same spec twice → same `resultHash`, second served from the store. (AL-16)
- **LAB-AL-10** Monad question → caveat naming the missing data, no run. (AL-70)

## New reason codes

`LAB_JOB_LEASE_LOST`, `LAB_JOB_TIMEOUT`, `LAB_OVERRIDE_UNKNOWN`, `LAB_DATASET_MISSING`, `LAB_ANSWER_PARTIAL`,
`LAB_MODEL_UNAVAILABLE`.

## Tasks (next sessions, in order)

1. `packages/backtest`: `onSample` hook + visual-series extractor; tests that a run's hash does not change with or
   without the hook. (AL-52, AL-16) Not: change `decide` or metrics.
2. `packages/lab-agent`: catalog prompt builder, tools over `packages/backtest`, contract + verifier with LAB-AL-05
   fixtures, agent loop with round limit and repair, cost meter. Runs offline against recorded model replies.
   (AL-10…AL-24, AL-40) Not: network beyond the model route.
3. Migration `XXXX_agent_lab.sql` + `/api/lab/runner/*` in mamoru-app with signed requests. (AL-01, AL-02, data)
   Not: any route reachable without the runner signature.
4. Lab runner unit on lady (`apps/mamoru-lab-runner`), systemd with CPU quota, model-plane route `agent-lab`.
   (AL-30…AL-32, AL-04) Not: wallet keys, RPC keys.
5. `/ops/lab` in `ottodevs/mamoru-landing`: threads, chat, block renderer with view-A components, run panel, cost
   page; screenshots desktop + 390 light/dark against PoC-1 before merge. (AL-50…AL-53, AL-41)
6. Scenarios LAB-AL-01…10 green; Ot and Brais use it for a week; cost per archetype reported for pricing. (AL-42)

Later tickets: x402 endpoint (AL-60…62), fork scenarios as a tool, Ethereum windows backfill, Monad forward
collector, export a study as a 006 draft template.

## Decisions for Ot

None open. Approved 20-22 Oct: view A as the visual base; first version in `/ops` only; model via
model-plane included resources (free pools are not a base).
