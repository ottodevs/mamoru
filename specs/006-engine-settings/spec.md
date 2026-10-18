# 006: Engine settings as versioned templates, edited from /ops

Ticket: otto/mamoru#147. Status: phase 1 built; migration `0011_engine_settings.sql` not applied; operator pull off
until `MAMORU_SETTINGS_URL` is set.

## Problem

The knobs that decide how the engine treats real money live in the operator's `.env`: `MAMORU_DEPTH`,
`MAMORU_CAP_USDC` (#127), `MAMORU_KEYED_CU_PER_HOUR`, `MAMORU_REVIEW_MS`, `MAMORU_SNAPSHOT`, `MAMORU_YIELD_LEDGER`,
and the subsidy limits of PR #38. Changing one means a shell on lady, an edit nobody else sees, and a restart.
There is no history, no review of the change, no way to try a setting on a few accounts first, and no link from a
Lab result to what runs live.

Ot (16 Oct): settings must be adjustable from the private /ops, from the Lab, and through named templates; `.env`
is not the place.

## What this builds (interpretation)

**Versioned engine settings with named templates.**

- A **template** is a named preset: a base policy id plus overrides (the knobs below). Templates are seeded from
  code (`conservador-live-v2 (today)`, `conservador + depth 30/500/5, cap 1000`, `lab guards`) and can be added from
  the Lab (a sweep result exported as a draft template).
- A **version** is what runs: a template's settings, possibly edited, written as a new append-only row with who,
  when, the previous version, the new one, and a reason. The active version of an environment is its latest row.
  Rollback writes a new row that copies an older one: the version number only goes up.
- **Scope**: each version names its environment (`prod` or `beta`, the `accounts.env` of #130) and may name an
  account allowlist (a canary). One canary at most is live per environment: the newest, if it is newer than the
  newest environment-wide version. An account it names runs it; every other account runs the environment-wide
  version. Writing a new canary retires the previous one for every account. Account keys compare lowercased.
- **Bounds stay in code** (`packages/policy/src/engine-settings.ts`, `ENGINE_SETTINGS_BOUNDS`). The writer
  (/ops) validates against a copy of them for the form; the operator validates again against the code and refuses
  anything out of bounds. Code is the authority: a version the operator refuses never runs.
- **Risky changes need a confirm step**: raising the cap, turning the guard off, loosening a guard threshold,
  turning depth sizing off while the cap is above the default, or loosening depth limits, turning the lazy re-range
  on or making it lazier (larger buffer, longer dwell, shorter horizon, more LVR weight; back to eager is not risky).
  /ops shows the diff and asks again.

## Knobs

| Knob | Phase 1 | Today | Bounds (code) |
|---|---|---|---|
| Depth sizing: impact bps, liquidity share bps, stables impact bps, or off | yes | `MAMORU_DEPTH` | impact 1-500, share 1-5000, stables 1-500 |
| Cap per account, whole USDC | yes | `MAMORU_CAP_USDC` | 1-1,000,000; above 100 needs depth sizing |
| Fall-freeze guard (#101): on/off, fall and vol thresholds per volatile bucket | yes | lab policy only | fall 100-3000 bps, vol 1000-50000 bps |
| Re-range (#172): `rerange { mode: eager \| lazy, edgeBufferTicks, minDwellSeconds, horizonSeconds, lvrWeightBps }`, absent = eager | yes | eager trigger in code | buffer 0-1000 ticks, dwell 0-86400 s, horizon 3600-604800 s, LVR weight 0-20000 bps |
| Widths, bucket weights | phase 2 | code | per policy |
| Review cadence | phase 2 | `MAMORU_REVIEW_MS` | 60-3600 s |
| RPC budget brake | phase 2 | `MAMORU_KEYED_CU_PER_HOUR` | 5k-500k CU/h |
| Snapshot loop, yield ledger | phase 2 | `MAMORU_SNAPSHOT`, `MAMORU_YIELD_LEDGER` | on/off |
| Relayer subsidy limits (#38) | phase 2 | PR #38 constants | per #38 |

Settings never change a grant an account already holds: grants are built from the account's policy, as before. The
cap also sizes the session limits of approvals signed after it changes, exactly as `LIVE_CAP_USDC` did; the owner
sees that cap in the summary they sign, and an activation never takes in more than the cap its signature named,
even if the cap is raised while it waits armed. Depth sizing and the guard change how much an entry places and which
entries pause; the re-range setting changes when a position is re-ranged (it sets `range.lazy` on the policy the
engine decides with, never on the one grants and policy hashes are built from). Lazy needs history: each position's
out-of-range clock (per engine, in memory, from its first review) and the pools' fee growth and volatility (read once
per pool per minute for the whole operator process, `SharedGuardReads`; the fee history is saved to
`stateDir/fee-history.json` and restored at boot). Live lazy fails closed: without a cost estimate (less than 12 h of
fee history, or no volatility) the position holds with `DECIDE_RANGE_NO_FEE_HISTORY`, never re-ranges untested.

## Transport

```
/ops (mamoru-astro, Google allowlist + CSRF) --writes--> D1 engine_settings_versions (append-only)
operator (lady) --signed GET every 60 s--> app Worker /internal/engine-settings --reads--> D1
```

- **Request**: the operator signs `GET /internal/engine-settings` with the operator-level scheme of
  `@mamoru/operator-auth` (`metricsSignature`: method, path, unix minute; current and previous minute accepted).
- **Response**: the Worker signs the exact body with `settingsResponseSignature` (HMAC over a fixed label, the unix
  minute and the body). The operator refuses an unsigned, mis-signed or older-than-two-minutes response.
- **Monotonic**: the operator refuses a version number lower than the one it applied for the same environment, and a
  body served before the one it applied (a replayed or stale response cannot roll it back; a rollback is always a new,
  higher version).
- **Integrity**: each version's hash must be the sha256 of its canonical settings JSON; one mismatch refuses the pull.
- **Last-known-good**: every applied set is written to `stateDir/engine-settings.json` (0600, tmp + rename). On
  boot, or when the endpoint is down, the operator runs the last-known-good. With neither, it runs the code defaults
  (today's behaviour).
- **Apply**: a new version reaches running engines at the start of their next review (`Engine.retune`, never in the
  middle of one, and only for the same policy id, buckets and session templates); nothing restarts. Cap changes apply
  at the next Start. At boot the operator pulls once before any engine resumes.
- **Visible**: the applied version per scope is in the operator's `/metrics` (`settings`) and on /ops.
- **Push hint** (phase 2): /ops pings the operator through the app Worker so a change applies in seconds instead of
  within a minute.

## Emergency and staleness

- **Local emergency file**: `stateDir/engine-settings.local.json` (0600, written by hand on lady). A valid settings
  object there wins over D1 and the last-known-good for every account; it is re-read on every poll (no restart) and
  deleting it hands control back. An invalid file is ignored and reported. This is the path for an urgent change
  while the Worker or D1 is down.
- **Staleness**: with no successful pull for 15 minutes `/metrics` reports `settings.stale: true` and the operator
  logs one `[alert]` line (forwarded to #mamoru-ops by `mamoru-ops-report` alert-forward).
- **Cap rule on pulled settings**: a version with a cap above 100 is refused at pull time when the operator policy is
  not target-weights (same rule as the boot check on `MAMORU_CAP_USDC`), and per account the operator keeps the
  default cap for an account whose own policy cannot size entries to depth (`settings.capRefused`).
- **One cap per prepare**: an activation reads the cap once; the deposit check, the grant sizes, the summary and the
  stored ceiling all use that value.
- **Renewals and extensions keep the signed cap**: their grants are sized for the cap the account last signed
  (`signedCapUsdc`, from its confirmed activation or renewal; the default for older accounts), the summary names it,
  and when the plan now allows a different cap the summary says so. A raised cap reaches an existing account only
  through an approval that names the new cap (phase 2).
- **Legacy approvals**: an approval prepared or armed before this change carries no cap; it is bounded by the default
  cap (100 USDC), never by the current one.
- **Confirm step**: a risky change is written only with a server-issued token bound to the session, the exact change
  and the versions in effect when it was shown (10 minutes). A canary is compared with what each of its accounts runs
  now, and accounts leaving the previous canary are counted.

## Env after this

`.env` keeps secrets (RPC URLs, `OPERATOR_SECRET`) and bootstrap (`MAMORU_SETTINGS_URL`, `MAMORU_LIVE`).
`MAMORU_DEPTH` (or `MAMORU_DEPTH=off`) and `MAMORU_CAP_USDC` stay readable as an **emergency override**: when set,
they win over D1 for those knobs, the operator logs it at boot and `/metrics` reports it in `settings.override`, so it
cannot be left on unseen. If the override and a D1 version combine into something out of bounds, the code defaults
run (without the override) and the status says why.

## Lab

A sweep (the harness of the Lab-sweep PR) can write its best variant as a draft template
(`engine_settings_templates`, `source = 'lab'`, with the sweep id and the TRAIN/TEST numbers in `note`). Drafts are
never active: someone applies one from /ops, first to `beta` or to a canary allowlist.

## Data (D1, `0011_engine_settings.sql`)

- `engine_settings_templates(name PK, settings_json, source 'seed'|'lab'|'ops', note, created_at, author)`.
- `engine_settings_versions(id PK autoincrement, env, account_keys_json NULL, template, settings_json,
  settings_hash, author, reason, created_at, rollback_of NULL)`; append-only: no UPDATE or DELETE path exists in
  code.

## Threats and answers

| Threat | Answer |
|---|---|
| Someone outside the allowlist changes settings | /ops writes only behind the Google allowlist session and a CSRF token; the Worker endpoint is read-only |
| A forged or tampered response | response HMAC under `OPERATOR_SECRET`; TLS |
| Replay of an old response (rollback by replay) | two-minute window and monotonic version |
| A valid but dangerous version (compromised /ops session) | code bounds in the operator; risky-change confirm; every change is a row with author; a cap above 100 needs depth sizing |
| The endpoint is down | last-known-good, then code defaults; the engine keeps running |
| A version applies to the wrong accounts | scope resolved in the operator from the Worker's per-account env map; canaries name accounts explicitly |

## Phases

1. (this PR) Model, bounds, templates, migration, Worker endpoint, operator pull/validate/last-known-good/apply for
   depth, cap and guard, `/metrics`; /ops page in mamoru-landing (view, template, edit, confirm, history, rollback).
2. The other knobs; push hint; Lab export; per-account overrides beyond canaries.
