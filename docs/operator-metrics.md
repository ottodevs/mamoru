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
    "accounts": { "known": 14, "active": 9, "armed": 1 }
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
  and so is the state provider: a provider that does not have that block with the same hash is abandoned.
- **Persistence**: the cumulative counters and the 48h ring are both persisted to
  `stateDir/rpc-usage.json`, written atomically (tmp file + rename, 0600) at most once a minute and once
  more on a clean shutdown, so a restart does not lose history. The 48h ring is sparse (only hours with
  recorded traffic appear) rather than zero-filled.
- **Engine health** is in-memory only (reset on an operator restart) and only lists accounts with a
  running engine loop; it is a live-ops view, not the durable record (`accounts.json`'s per-account
  `ops` journal is).
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
