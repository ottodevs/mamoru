# Operator `GET /metrics`

Ops-dashboard phase 2 (otto/mamoru#2): RPC usage and engine health for `apps/mamoru-operator`, served
as JSON from the same process (`src/server.ts`), with its own auth scheme since it carries no account
context.

## Auth

`x-mamoru-sig` = hex `HMAC-SHA256(OPERATOR_SECRET, "GET /metrics <unix-minute>")`, where
`<unix-minute>` is `Math.floor(Date.now() / 60_000)`. The server accepts the current minute and the
previous one (clock skew / an in-flight request crossing a minute boundary), constant-time compare.
This is the **same** `OPERATOR_SECRET` as the per-account scheme, but a **different** message format
(no account header, no body — `/metrics` is a plain `GET` with nothing per-caller to sign over), so the
two schemes never collide and a per-account signature never verifies here.

The signing/verifying helper lives in `packages/operator-auth/src/index.ts`
(`metricsSignature`, `verifyMetricsSignature`), Web Crypto only (`crypto.subtle`, no `node:crypto`), so
the exact same code runs in the operator (Bun) and in the landing Worker (Cloudflare Workers) once it
grows a dashboard route that reads this endpoint — one implementation, not two independently-written
copies of the scheme (which is what happened with the per-account HMAC: see
`apps/mamoru-operator/src/server.ts#operatorSignature` vs.
`apps/mamoru-app/src/api/accounts/operator.ts#operatorSignature`).

Example (Bun or a Worker):

```ts
import { metricsSignature } from '@mamoru/operator-auth'

const minute = Math.floor(Date.now() / 60_000)
const sig = await metricsSignature(OPERATOR_SECRET, 'GET', '/metrics', minute)
const res = await fetch(`${OPERATOR_URL}/metrics`, { headers: { 'x-mamoru-sig': sig } })
```

## Payload

No secrets, no session keys, no full account keys, no RPC URLs — provider labels are a host only, and
account keys are shortened to 8 chars. Example (values illustrative):

```jsonc
{
  "generatedAt": "2026-10-02T09:15:00.000Z",
  "operator": {
    "uptimeSeconds": 123456,
    "gitSha": "5efba44",
    "chainId": 8453,
    "live": true,
    "policyId": "conservador-live-v2",
    "relayer": { "address": "0xRELAYER…", "balanceWei": "812345678901234567", "balanceCachedAgeMs": 12 },
    "accounts": { "known": 14, "active": 9, "armed": 1 },
    // Spec 006: null without MAMORU_SETTINGS_URL. Else the engine settings versions applied, their source
    // (d1, last-known-good, default), the last pull and error, and any env knob forced as an emergency override.
    "settings": { "url": "https://app.mamoru.lol", "source": "d1", "lastPullAt": "…", "lastError": null, "versions": [{ "id": 3, "env": "prod", "canary": false, "template": "…", "hash": "…" }], "override": [] },
    "gasReserveLow": 1
  },
  "rpc": {
    // provider host (never the path or an API key; "#1"/"#2" when two providers share a host) -> method -> counters,
    // cumulative since the state file was created (survives a restart, see below).
    "cumulative": {
      "base-mainnet.g.alchemy.com#1": {
        "eth_call": { "requests": 1820, "errors": { "rateCapacity": 3, "invalidParams": 0, "timeout": 1, "other": 0 }, "fallbacks": 2, "getLogsChunks": 0, "cuEstimate": 47320 },
        "eth_getLogs": { "requests": 210, "errors": { "rateCapacity": 0, "invalidParams": 0, "timeout": 0, "other": 0 }, "fallbacks": 0, "getLogsChunks": 640, "cuEstimate": 15750 }
      },
      "base-rpc.publicnode.com": {
        "eth_call": { "requests": 4, "errors": { "rateCapacity": 0, "invalidParams": 0, "timeout": 0, "other": 0 }, "fallbacks": 0, "getLogsChunks": 0, "cuEstimate": 0 }
      }
    },
    "cuEstimateTotal": 1452300,
    "last48h": [
      { "hourStart": "2026-09-30T10:00:00.000Z", "data": { "base-mainnet.g.alchemy.com#1": { "eth_call": { "...": "same shape as cumulative" } } } }
    ],
    "note": "cuEstimate is a static per-method estimate (see metrics.ts CU_TABLE), not Alchemy's billed figure"
  },
  "engines": [
    { "account": "3f9a7c21", "lastReviewAt": "2026-10-02T09:14:40.000Z", "lastDecisionCode": "DECIDE_HOLD", "consecutiveErrors": 0, "lastErrorClass": null, "lastErrorAt": null, "reviewsLastHour": 58, "errorsLastHour": 0 },
    { "account": "9b0e41aa", "lastReviewAt": "2026-10-02T09:14:55.000Z", "lastDecisionCode": null, "consecutiveErrors": 4, "lastErrorClass": "rpc_other", "lastErrorAt": "2026-10-02T09:14:55.000Z", "reviewsLastHour": 12, "errorsLastHour": 4 }
  ],
  // otto/mamoru#129: the newest 300 ops across every account, newest first (Operator.recentOps). Exactly these
  // five fields — never a grant, session key, signature, salt or userOp.
  "opsRecent": [
    { "accountKey": "3f9a7c21", "kind": "enter", "state": "confirmed", "at": "2026-10-02T09:14:41.000Z", "code": null },
    { "accountKey": "9b0e41aa", "kind": "activate", "state": "failed", "at": "2026-10-02T09:14:30.000Z", "code": "DEPOSIT_OVER_CAP" }
  ],
  "gasReserve": [
    { "account": "3f9a7c21", "nativeWei": "250000000000000", "thresholdWei": "500000000000000", "low": true, "lowSince": "2026-10-02T09:00:00.000Z" },
    { "account": "9b0e41aa", "nativeWei": "900000000000000", "thresholdWei": "500000000000000", "low": false, "lowSince": null }
  ]
}
```

## Notes

- **CU estimate**: a small static table (`apps/mamoru-operator/src/metrics.ts` `CU_TABLE`) of Alchemy's
  published per-method compute-unit cost, restricted to the methods this operator calls; unlisted
  methods default to 26. It is counted against every attempt sent to a provider whose host matches
  `/alchemy/i`, success or failure — an estimate, not Alchemy's billed figure (retries, errors, and
  Alchemy's own batching/caching all change the real number).
- **Errors by class**: `rateCapacity` (429 / `-32005` / rate-limit-shaped messages), `invalidParams`
  (`-32602` / "invalid params"), `timeout` (request timed out or aborted), `other`. Classification order
  is invalid-params, then timeout, then rate/capacity, since some provider messages use the word
  "timeout" inside an otherwise rate-limit-shaped sentence.
- **Fallbacks**: counted against the provider just abandoned, once per provider switch (a provider
  retried against itself across the two-pass retry loop does not count as a fallback).
- **getLogs chunks**: counted separately from `requests` (which already includes every chunk sub-call);
  it is how many of a provider+method's requests were chunk requests from a split `eth_getLogs` range
  (Alchemy's free tier caps a range at 10 blocks; see `MAMORU_LOG_RANGE`). An `eth_getLogs` goes to the
  provider that serves its range in the fewest requests (range per host: Alchemy 10, publicnode and
  mainnet.base.org 2000, drpc 10000; `MAMORU_LOG_RANGES="host=blocks,..."` overrides), so its requests
  and chunks are counted against that provider, and a provider tried and abandoned gets a fallback.
  After each range the provider that served it is asked for the range's last block (`eth_getBlockByNumber`),
  and so is an independent witness (the upstream for a fallback's range, a fallback for the upstream's).
- **Log ranges** (`rpc.logRanges`, per provider, since boot, in memory only): `accepted` (the witness has
  the range's last block with the same hash), `hash_mismatch` (it has another hash), `no_witness` (no other
  provider had the block, or none is configured), `provider_error` (the provider failed a chunk or does
  not have the block). A rejected range is read whole by the next provider; when none is accepted the
  review fails with `OBS_RPC_UNAVAILABLE`. A rising `no_witness` means reviews are failing for lack of a
  second provider that answers.
- **Persistence**: the cumulative counters and the 48h ring are both persisted to
  `stateDir/rpc-usage.json`, written atomically (tmp file + rename, 0600) at most once a minute and once
  more on a clean shutdown, so a restart does not lose history. The 48h ring is sparse (only hours with
  recorded traffic appear) rather than zero-filled.
- **Engine health** is in-memory only (reset on an operator restart) and only lists accounts with a
  running engine loop; it is a live-ops view, not the durable record (`accounts.json`'s per-account
  `ops` journal is).
- **`opsRecent`** (otto/mamoru#129) reads straight from that durable record (`accounts.json`'s per-account `ops`),
  across every account, newest `updatedAt` first, capped at 300. Mirrored into D1 (`operator_metrics_latest`,
  `migrations/d1/0013_operator_metrics.sql`) by `apps/mamoru-app/src/api/operator-metrics.ts`'s cron pull, for the
  `/ops` console (separate repo) to read without hitting the operator directly.
- **Gas reserve (otto/mamoru#8), detection + alert only, no automatic top-up**: the relayer funds a
  Safe's gas reserve exactly once, at activation (the activation top-up in `apps/mamoru-operator/src/operator.ts`
  to `policy.gasReserveWei + TOP_UP_MARGIN_WEI`, ~0.0005 ETH on the live policy, charged to the daily
  activation budget in `src/sponsorship.ts`). Every engine rebalance
  and fee collection since then spends from that same balance and nothing refills it, so an active
  account drifts toward the policy's own floor (`ehgPreliminary`'s `ACCT_GAS_RESERVE_LOW`,
  `packages/decide/src/gates/index.ts`), at which point the engine stops reviewing it entirely — no
  more rebalances, no more fee collection, with nothing louder than one decision line saying so.
  - **Detection, not a new RPC call**: every engine review already reads the Safe's native ETH
    balance in its own Multicall3 batch (`Observation.native`, `packages/rpc/src/index.ts`) to feed
    that same EHG gate. `GasReserveTracker` (`src/metrics.ts`) reuses that read — nothing extra is
    sent to a provider (RPC cost is a live concern, otto/mamoru#135).
  - **Threshold**: `gasReserveAlertWei` (`src/gas-reserve.ts`) defaults to `policy.gasReserveWei`
    (the hard floor itself) plus `ALERT_RUNWAY_ACTIONS` (3) times `ONE_ACTION_WEI`, an estimate of
    what one engine action (a rebalance or a fee collection) costs — the same gas-budget figure the
    engine itself prices a harvest's worth against (`opCostInSavings`, `packages/decide/src/value.ts`),
    evaluated at a representative (not worst-case) gas price. On the live policy that is
    `300_000_000_000_000 + 3 × 15_300_000_000_000 = 345_900_000_000_000` wei (~0.000346 ETH): a
    freshly activated account (funded to ~0.0005 ETH) can run roughly ten ordinary actions before
    ever crossing it, and then exactly 3 more (by construction) before it would actually reach the
    hard floor and freeze.
    An earlier version of this threshold used `policy.gasReserveWei + TOP_UP_MARGIN_WEI` — the
    *full* amount the relayer originally funded the Safe to. Independent review on this ticket
    (NO-GO) caught that this was wrong: that margin equals the Safe's *entire* funded balance, so
    every account that ran even one action went low immediately and stayed low forever, making the
    alert meaningless. The mistake was conflating two different things — `TOP_UP_MARGIN_WEI` in
    `operator.ts` is sized for the *first* userOp's worst-case prefund specifically (the one-time
    cost of seeding the account's EntryPoint deposit at activation), not an ongoing per-action cost.
    `ONE_ACTION_WEI` is sized instead, and is far smaller (see `gas-reserve.ts` for the exact figures
    and reasoning).
    Override with `MAMORU_GAS_RESERVE_ALERT_WEI` (absolute wei, applied to every account regardless
    of its own policy's `gasReserveWei`); unset, non-numeric or negative falls back to the default.
  - **What happens when low**: nothing is sent on chain. `gasReserve[].low` flips, `operator.gasReserveLow`
    counts how many accounts are below their threshold right now, and the journal gets one
    `[gas-reserve] <account> below its alert threshold: <native> of <threshold> wei` line the cycle it
    crosses (and one `back above` line if an owner tops it up manually) — never every cycle, so an
    account that stays low does not flood the log. A healthy account's very first observation (right
    after activation, or an operator restart) never logs a spurious `back above`: a transition is
    only reported when there is a prior reading to have moved from, or the first reading is itself low.
  - **Scoped to running accounts, not leaked across a stop**: both `gasReserve[]` and
    `operator.gasReserveLow` only ever include accounts with a running engine loop, derived from the
    same list. Stopping an account (or restarting it, which stops it first) evicts its gas-reserve
    state immediately, so a Safe that was low when it stopped does not keep counting towards
    `gasReserveLow` forever, and a re-armed account's first `/metrics` read never shows its stale
    pre-stop balance before its own first new review has run.
  - **Known gap**: `Observation.native` is the Safe's own address balance; it does not see ETH already
    sitting as an EntryPoint deposit credit from a prior userOp's unused prefund, so the true usable
    reserve can be slightly understated.
  - **Follow-up**: turning this alert into an automatic top-up means spending more relayer ETH on real
    funds, and must go through `src/sponsorship.ts`'s limits (per-account counts and the daily relayer
    budget, as the activation top-up already does) so a drained account cannot be cycled into repeated
    payouts. Until then, a low reserve is an operator-ops signal only: top up the Safe by hand, or ask
    the owner to. Activation-time refusals (`ACTIVATION_LIMIT`, `SPONSOR_*`) cover an account that
    cannot *start*; this alert is about an account already running, which that path does not cover.
- **Relayer balance** is cached 60s so a metrics poll never adds RPC load.
- **Bounded cardinality**: a method outside the fixed CU table (`eth_call`, `eth_getLogs`, ...) folds
  into an `"other"` method bucket instead of creating a new permanent one, and provider labels beyond
  16 distinct ones fold into an `"other"` provider bucket the same way — both counters and the
  persisted file stay a fixed size regardless of what methods or hosts happen to show up.
- **No free text in /metrics, by construction, not by heuristic**: `lastErrorFirstLine` does not
  exist. Heuristic redaction (`redactSecrets()`) cannot *guarantee* a secret-free payload, so
  `/metrics` never carries review/error free text at all — only `lastErrorClass`, a closed enum
  (`rpc_rate_limit`, `rpc_invalid_params`, `rpc_timeout`, `rpc_other`, `bundler_rejected`,
  `simulation_reverted`, `observation_inconsistent`, `internal`; see `classifyEngineError` in
  `metrics.ts`) plus `lastErrorAt`. The redacted free text still goes to the **journal only**, via
  `logErr(tag, e)` — every engine/review/armed/reconcile/owner/bundler/relayer log line that prints an
  error or a revert/review detail goes through it, so a keyed URL or similar never reaches the journal
  either, not just /metrics. `redactSecrets()` (used by `logErr`): a URL collapses to scheme+host
  (where an Alchemy key lives, in the path), a `key=`/`token=`/`secret=`-shaped fragment is redacted,
  any other long opaque run (24+ chars) is redacted too, and the result is capped to 160 chars. Every metrics-recording call
  on the request/review path is additionally wrapped so a throwing metrics call can never affect the
  RPC response or the engine loop it is measuring (`safeMetrics` in `metrics.ts`).
