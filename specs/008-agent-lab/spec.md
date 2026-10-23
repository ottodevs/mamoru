# 008: Strategy Lab in /ops, a bench with an agent inside

Ticket: otto/mamoru#175. Status: spec. Research, thesis checks and both concept probes are done (links below);
nothing here is built yet.

## Problem

The Lab already answers the questions that change the product: the backtest replays history through the production
`decide` (`packages/backtest`), the sweep runs a policy over the 13 TRAIN/TEST windows and gates releases ("gate del
Lab 23/24", PR #67), and the fork harness holds 45 scenarios. But every study needs Ot at a shell: pick a dataset,
write CLI flags, read a text dump. Brais cannot run one. The public `/lab` replays three recorded tapes and is hard to
read for anyone who does not already know what a tick, a gate trail or a block is.

Ot (18-22 Oct): a new Lab, built from scratch, in the private `/ops`: a full lab dashboard (the strategy bench), with a
chat inside it as one panel, where you ask an agent for scenarios or tests; the agent designs them, runs them on the
real engine, and the bench shows the study. The layout comes from the Strategy Lab study of 31 Jul (experiment on the
left, the bench in the centre, "try a scenario" on the right, a timeline and Events / Compare / Diagnostics below),
redrawn in Mamoru's language. Built so that it can later
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
| The bench layout works with real data | Ot approved the bench prototype (22 Oct): 3 windows × 3 strategies from the production engine; it already shows that a 2× range cuts the Feb-2025 loss vs hold from 16.44 to 3.26 USDC and costs 1.85 in the Sep-2026 calm | Prototype artifact `VsgFUusHzAnzes1pHT6juU` |

## Scope

**Phase 1, the bench (ship first, Ot 23 Oct: "something working now"):** `/ops/lab`, Ot and Brais only (the existing
`/ops` Google allowlist). The bench of the prototype over every TRAIN window, with the strategies in the catalog
below; "Run scenario" queues a bench job that the lady runner computes with the production engine and the bench shows
when done. The chat panel is visible and says it arrives in phase 2. Requirements B-01…B-12.

**Phase 2, the agent:** the chat panel. Threads; the agent runs backtests, comparisons and sweeps through the same
job queue; answers render as verified blocks that open runs in the bench; every job records its cost. Requirements
AL-01…AL-70.

**Designed for, not built in v1:** x402 payment and an external endpoint; fork scenarios (anvil) as a tool; Monad
datasets; a public or premium surface; exporting a study as an engine-settings draft template (006 phase 2 already
names the Lab as a source).

**Never:** the agent does not write engine settings or touch the operator, a session key, an account, or any D1
table outside the Lab tables. The Lab's numbers never appear in the production views (Constitution XVI).

## Phase 1: the bench (B-01…B-12)

- **B-01 Strategy spec.** A run is `{windowId, base: 'live' | 'guard', widthTicks, deposit}`: `live` is
  `conservador-live-v2`, `guard` is `conservador-lab-guards-v1`; `widthTicks` overrides `range.widthTicks` of the
  volatile pools (500…8000, step 500; the stables pool keeps its own width); `deposit` is whole USDC (100…10000).
  The runner validates the bounds again and refuses anything else (`LAB_SPEC_INVALID`). `windowId` must be a TRAIN
  window of the dataset manifest (`LAB_HOLDOUT_DENIED` otherwise, AL-12a).
- **B-02 Run result.** One JSON per run: spec, `policyId`, `resultHash`, `simVersion`, window `{id, label, regime,
  from, to, market}`, `pools`, `metrics` (end, net, hodl, vsHodl, fees, gas, timeInRangeBps, maxDrawdownBps,
  returnBps, operations, days), `reasons` (decide reason counts), `ops` (executed: t, kind, pool, gas, fees, code,
  reason) and `series` (≤ 400 points: t, v, h, price per pool, active band per pool). Amounts in USDC as numbers
  rounded to 4 decimals. The band comes from an `onSample` hook in `runBacktest` that does not change `resultHash`.
- **B-03 Seed.** `mamoru-lab-runner seed` computes the catalog matrix (every TRAIN window × {live 2000, live 4000,
  guard 2000} × 1000 USDC) and publishes it, so the bench opens full. Re-seeding the same spec is a no-op (same hash).
  A window whose dataset lacks a pool a base needs (today `aug2024`: no cbBTC on Base yet) is skipped for that base
  with `LAB_DATASET_MISSING`, as the sweep already does; the catalog lists, per window, the bases it can run, the
  screen offers only those, and `POST /ops/lab/api/jobs` refuses the others with the same code.
- **B-04 Jobs.** "Run scenario" writes a `lab_jobs` row `{id, requester, kind: 'bench', spec, status: queued}`;
  the runner claims, heartbeats and finishes it with the lease and fencing rules of AL-02/AL-02a; a spec whose run
  already exists finishes at once with that run. Limit: 20 jobs per requester per day, 3 queued at a time.
- **B-05 Runner API** on the landing Worker (it already serves `/ops` and binds D1 `mamoru` as `MAMORU_DB`):
  `POST /ops/lab/runner/claim`, `/heartbeat`, `/result`, `/publish` (seed results without a job). Signed with HMAC as in
  Architecture (method, path, timestamp, nonce, body hash), secret `LAB_RUNNER_SECRET`, never reachable with a session
  cookie and never without the signature.
- **B-06 Screen API** behind the `/ops` session: `GET /ops/lab/api/catalog` (windows and strategies present),
  `GET /ops/lab/api/runs?window=` (summaries), `GET /ops/lab/api/run/:hash` (full run), `POST /ops/lab/api/jobs`
  (CSRF as the rest of `/ops`), `GET /ops/lab/api/jobs/:id`.
- **B-07 Bench screen.** The prototype, wired to B-06: window segment; experiment column (capital at the cursor,
  strategies of the window with their result vs hold, assumptions); centre (verdict sentence written from the runs,
  Strategy / Hold / USDC tiles, price and active band per pool with the live policy's band as a ghost when another
  strategy is selected, "your money" sharing the cursor, the sentence for the moment, playback with event jumps);
  Events / Compare (strategies × this window, strategies × all windows) / Diagnostics; right panel "Try" (window,
  base, width, deposit, Run) and "Ask the Lab" (phase 2 notice).
- **B-08 Job feedback.** A queued or running job shows in the experiment column with its state and elapsed time;
  done adds the strategy to the list and selects it; failed shows the reason code in words.
- **B-09 Verdict sentences** on the bench are written by code from two runs that pass AL-20c (same window, deposit,
  `simVersion`); they never come from free text.
- **B-10 Labels.** Every screen says it is a simulation over Base history with the window and `simVersion`; no Lab
  number enters a production view.
- **B-11 Responsive.** Desktop three columns, ≤ 1180 px two, ≤ 820 px one (experiment, bench, panel), light and dark;
  screenshots at desktop and 390 px against the prototype before merge.
- **B-12 Runner unit.** `mamoru-lab-runner` runs on lady as its own systemd user unit with `CPUQuota=50%` and
  `Nice=10`, one job at a time, datasets from `~/.local/share/mamoru-lab/datasets`; env file holds only the landing
  URL and `LAB_RUNNER_SECRET`.

## Phase 2 requirements (the agent)

### Jobs and threads

- **AL-01** A thread is a list of turns. A user turn creates one job: `{id, threadId, origin: 'ops', requester (ops
  email), question, status, createdAt}`. Status moves `queued → running → done | failed | refused`, only forward.
- **AL-02** One runner claims a job with a lease: a new `leaseId` and an expiry 120 s ahead. The runner renews it
  every 30 s with an atomic update that matches `leaseId` and an unexpired `leaseUntil`; a renewal that matches no
  row means the lease is lost and the runner stops the job at once. An expired lease returns the job to `queued`
  with a new `leaseId` on the next claim, once; a second expiry marks it `failed` with `LAB_JOB_LEASE_LOST`.
- **AL-02a** Every status, run and answer write carries the current `leaseId` and is applied only if it still
  matches (fencing). A write from a stale runner is refused with `LAB_JOB_LEASE_LOST` and changes nothing, so one job
  never gets two answers.
- **AL-03** A job carries the thread's earlier turns (questions and verified answers, never raw tool output) so a
  follow-up ("and with the range twice as wide?") works.
- **AL-04** Each job has a wall-clock budget (120 s for chat tools, 15 min when it starts a sweep) and stops with
  `LAB_JOB_TIMEOUT` past it, keeping any finished runs.

### Tools the agent can call

- **AL-10** `run_backtest({window | datasetId, policyId, deposit, overrides?})` → `{runId: resultHash, metrics,
  window, opsCount}`. Pure, in-process, < 5 s on the largest window.
- **AL-11** `compare({runs: RunSpec[]})` → the same per run, max 8 runs per call.
- **AL-12** `sweep({policyId, overrides[], windows?})` → async: returns `{sweepId}` and the job waits for it inside its
  budget; result is the per-window table, each row with its `runId`. `windows` may name TRAIN windows only.
- **AL-12a** The agent never reaches a TEST window in v1. They are the release gate's holdout (run by the
  coordinator, `docs/process/releasing.md`), and every look at them from a chat would spend that holdout. The
  catalog lists TRAIN windows only; the tools resolve a window name or a `datasetId` against that TRAIN list and refuse
  anything else with `LAB_HOLDOUT_DENIED`, before loading data. A question about a TEST window gets a caveat saying it
  is the release holdout. Reaching TEST from the Lab (a rationed, audited holdout check) is a later ticket that must
  define a holdout budget across all requesters and time.
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
  `text {md}`, `claim {metric, runId, value}`, `verdict {runId, against: 'hold' | 'usdc' | runId}`,
  `chart {kind: 'equity' | 'decomposition' | 'pool_range', runIds, pool?}`, `caveat {md}`. Text and caveat carry no
  figures: they reference claims as `{{c0}}` and verdicts as `{{v0}}`. Allowed digits in text: years, window ids,
  dataset and policy ids.
- **AL-20a** `metric` is a closed enum defined in code (`end`, `net`, `vsHodl`, `vsUsdc`, `fees`, `gas`,
  `priceMove`, `timeInRange`, `maxDrawdown`, `return`, `operations.<kind>`, `days`). The code maps each metric to
  its path in the run, its unit and its label in each language. The model never writes a label, a unit or a path, so
  a number cannot be shown under the wrong meaning.
- **AL-20b** A `verdict` is a sentence the server writes from the stored runs ("ended 16.44 USDC below holding the
  mix"); its direction (better, worse, equal within 0.01) comes from the sign of the run difference. The model chooses
  which comparison to show, never its direction.
- **AL-20c** A verdict between two runs is allowed only when they share dataset id, window bounds, deposit, savings
  asset and `SIM_VERSION`; they may differ only in policy and overrides. Otherwise the verifier refuses it with
  `LAB_VERDICT_INCOMPARABLE`. A verdict against `hold` or `usdc` compares a run with its own baselines, which share
  all of these by construction.
- **AL-21** A deterministic verifier checks: schema; each claim's `value` equals the code-mapped metric of the stored
  run rounded to its display precision (USDC to 2 decimals, percentages to 1 decimal: the claim must equal that
  rounded value exactly; the screen always shows the stored value, never the model's); every run a claim, verdict or chart cites is in the job's own
  run list (the runs its tool calls produced or fetched from the store in this job, recorded server-side as the calls
  happen; a follow-up turn re-fetches earlier runs through a tool to cite them); text has no untraceable digits; each
  chart's kind fits its runs. A run that merely exists in the store is not citable.
- **AL-21a** Only `claim` and `verdict` blocks are verified results. The screen draws them apart from prose: the
  answer's headline is always the first verdict (or, with none, the first claim), never a text block, and text and
  caveat blocks render under a "the agent's explanation, not verified" label. A reader can always tell a checked
  figure or conclusion from the agent's words.
- **AL-21b** As a second guard, any text or caveat block containing a performance judgement term from a closed list
  per language (better, worse, beats, loses, gains, outperforms, protects, mejor, peor, gana, pierde, supera,
  protege…) fails the check, whether or not it references a run, and the repair turn asks for a `verdict` block. A
  closed list misses synonyms; AL-21a, not this list, is what keeps an unverified conclusion from passing as verified.
- **AL-22** On a failed check the errors go back to the model once (repair turn). If it still fails, the answer
  shows its verified claims and charts only, flagged `LAB_ANSWER_PARTIAL`. A refusal or a "the data does not exist"
  answer with no claims is valid and is never emptied (fixes the PoC-2 fallback bug).
- **AL-23** Nothing reaches the screen that did not pass AL-21, AL-20c and AL-21b, and it is laid out per AL-21a. The screen labels every answer as a simulation over
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
  │ write job → D1 lab_jobs (queued)             read jobs, runs, answers ← D1
  ▼
landing Worker (mamoru-lol)  /ops/lab/runner/{claim, heartbeat, result, publish}   signed (body-bound HMAC)
  ▲
lab runner on lady (systemd unit, bun)  ── model-plane route agent-lab ──► included models
  ├─ packages/lab-agent: loop, tools, catalog prompt, contract, verifier, cost meter
  └─ packages/backtest (+ onSample) over ~/.local/share/mamoru-lab/datasets
```

- The runner holds no wallet key, no RPC key and no D1 credential: only the runner signing secret and the model-plane
  route. Datasets are local files; a missing dataset is a tool error.
- The runner API lives on the landing Worker, next to `/ops`, so the Lab ships on the landing's release path and not
  on the app's 24 h beta soak. Runner requests are signed differently from the engine-settings pull (which signs
  method, path and minute and is a read): the HMAC covers method, path, timestamp, a random nonce and the SHA-256 of the body. The Worker refuses a
  timestamp older than 60 s, a nonce it has seen in the last 10 min (`lab_nonces`, pruned), and a body whose hash
  does not match. A captured request cannot be replayed or carry another body.
- D1 is a projection for the screen (Constitution VII): the runner's run store is the record; D1 holds job rows,
  verified answers and run summaries + visual series.
- Why the runner on lady and not a Worker: the models are reached through model-plane on lady, the 103 MB dataset
  set is already there, and fork scenarios (later) need anvil, which never runs on Cloudflare (Constitution XIII).
  A Worker or Container runner is the step when x402 traffic needs it.

## Data (D1, additive)

Phase 1, `XXXX_lab_bench.sql` (in `ottodevs/mamoru` `migrations/d1/`, the owner of D1 `mamoru`):

- `lab_runs (result_hash PK, window_id, spec_json, summary_json, run_json, sim_version, created_at)` — `summary_json`
  holds spec + metrics for lists; `run_json` the full B-02 result (< 400 KB).
- `lab_jobs (id PK, kind, origin, requester, spec_json, status, lease_id, lease_until, attempts, result_hash,
  error_code, created_at, updated_at)` — phase 2 adds `thread_id, question, answer_json, verifier_json, cost_json,
  quote_json, payer`.
- `lab_nonces (nonce PK, seen_at)` — replay guard, rows older than 10 min pruned.

Phase 2 adds `lab_threads`, `lab_job_runs (job_id, result_hash)` (AL-21) and `lab_prices` (AL-40).

## Threats and answers

| Threat | Answer |
|---|---|
| Prompt injection in a question makes the agent act | Tools are pure simulation; no tool writes outside the run store; AL-24 |
| The model invents or rounds a number into a claim | AL-21 verifier against the stored run; AL-23 nothing unverified on screen |
| A Lab result is read as a promise | Every answer labeled simulation over history with window and `SIM_VERSION`; never in production views |
| A runner secret leaks | It only reads/writes Lab rows; rotate via Worker secret |
| A captured runner request is replayed or its body swapped | Body hash + nonce + 60 s timestamp in the HMAC (Architecture) |
| Two runners answer the same job | Lease renewal + fencing on every write (AL-02, AL-02a) |
| Chat studies overfit the release gate's TEST windows | The agent cannot reach TEST in v1, by name or dataset id (AL-12a) |
| A number is shown under the wrong meaning, or a verdict points the wrong way | Closed metric enum mapped in code; server-written verdicts on comparable runs only; prose labeled not verified (AL-20a…c, AL-21a, AL-21b) |
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
- **LAB-AL-07** Sweep of one override over the TRAIN windows → per-window table with run ids within 15 min; the same
  sweep naming a TEST window, or a TEST `datasetId` → `LAB_HOLDOUT_DENIED` before any data loads. (AL-12, AL-12a, AL-04)
- **LAB-AL-11** A claim whose value is `metrics.gas` submitted as `net` → rejected; a standalone text block saying
  "Mamoru gana" → rejected and asked for a verdict block; an accepted text block renders under the not-verified
  label, below the verdict headline. (AL-20a, AL-21a, AL-21b)
- **LAB-AL-15** A verdict between a 100,000 USDC run and a 1,000 USDC run, or between two windows →
  `LAB_VERDICT_INCOMPARABLE`. (AL-20c)
- **LAB-AL-16** `run_backtest` of any policy on a TEST window or TEST `datasetId` → `LAB_HOLDOUT_DENIED`; the
  catalog in the prompt lists no TEST window. (AL-12a, AL-14)
- **LAB-AL-12** A stale runner (lease expired, job re-claimed) posts an answer → refused, the new runner's answer
  stands. (AL-02a)
- **LAB-AL-13** A captured signed `answer` request replayed with another body, or replayed as is → both refused.
  (signing)
- **LAB-AL-14** An answer citing a stored run its job did not produce or fetch → rejected. (AL-21)
- **LAB-AL-08** Every job row has tokens, CPU ms, wall time, shadow cost; `/ops/lab` totals match the rows. (AL-40, AL-41)
- **LAB-AL-09** Same spec twice → same `resultHash`, second served from the store. (AL-16)
- **LAB-AL-10** Monad question → caveat naming the missing data, no run. (AL-70)

## New reason codes

`LAB_JOB_LEASE_LOST`, `LAB_JOB_TIMEOUT`, `LAB_OVERRIDE_UNKNOWN`, `LAB_VERDICT_INCOMPARABLE`, `LAB_HOLDOUT_DENIED`, `LAB_DATASET_MISSING`, `LAB_ANSWER_PARTIAL`,
`LAB_MODEL_UNAVAILABLE`.

## Tasks (in order)

Phase 1, the bench:

1. `ottodevs/mamoru`: `onSample` hook in `packages/backtest` (hash unchanged with or without it), `packages/lab-bench`
   (B-01 spec validation, B-02 result builder, TRAIN-only window resolution), `apps/mamoru-lab-runner` (claim /
   heartbeat / result / publish client with the signing scheme, `seed`, `run`, systemd unit file) and migration
   `XXXX_lab_bench.sql`. (B-01…B-04, B-12) Not: wallet keys, RPC keys, any network beyond the landing URL.
2. `ottodevs/mamoru-landing`: runner API (signing, nonces, lease and fencing) and screen API, `/ops/lab` bench from
   the prototype; screenshots desktop and 390, light and dark. (B-04…B-11; LAB-AL-12, LAB-AL-13) Not: any runner route
   reachable without the signature; any Lab number in another `/ops` page.
3. Release: migration, landing secret `LAB_RUNNER_SECRET`, landing deploy, runner unit on lady, `seed`; check a
   "Run scenario" end to end in `/ops/lab`.

Phase 2, the agent:

4. `packages/lab-agent`: catalog prompt builder, tools over `packages/lab-bench` (TRAIN only), contract + metric enum
   + verdict writer + verifier with LAB-AL-05, 11, 14 and 15 fixtures, agent loop with round limit and repair, cost
   meter. Offline against recorded model replies. (AL-10…AL-24, AL-40)
5. Runner: agent jobs through the model-plane route `agent-lab`. (AL-30…AL-32, AL-04)
6. Landing: the "Ask the Lab" panel, threads, block renderer that opens runs in the bench, cost page. (AL-41, AL-50…AL-53)
7. Scenarios LAB-AL-01…16 green; a week of use; cost per archetype reported for pricing. (AL-42)

Later tickets: x402 endpoint (AL-60…62), a budgeted holdout check, fork scenarios as a tool, Ethereum windows backfill, Monad forward
collector, export a study as a 006 draft template.

## Decisions for Ot

None open. Approved 20-23 Oct: the bench prototype as the visual base, with the chat as one panel inside it; first
version in `/ops` only; the bench ships first; model via model-plane included resources (free pools are not a base).
