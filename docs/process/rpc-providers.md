# RPC providers

Which process reads which chain through which provider, and how the secrets are set. No key or URL with a
token is ever written in this repository, in a ticket or in a log.

| Process | Chain | Variable | Order |
|---|---|---|---|
| Operator | Base (8453) | `RPC_URL`, `MAMORU_RPC_FALLBACKS`, `MAMORU_RPC_TRUSTED` in the operator env file | Alchemy, then QuickNode, then public nodes (never for decision reads) |
| App Worker (`mamoru-app`, `mamoru-app-beta`) | Ethereum (1), read-only, wrong-network notice | secret `ETHEREUM_RPC_URLS` | Alchemy, then QuickNode |

## Operator: quotas, budgets and the read spread

Set in the operator env file, read at boot. Labels are host-free: the provider's registrable domain
(`alchemy.com`, `quiknode.pro`), with `#1`, `#2` when one proxy has several keys of it.

| Variable | Default | What it does |
|---|---|---|
| `MAMORU_RPC_WEIGHTS` | 1 each | `quiknode.pro=3,alchemy.com=1`: the share of pinned reads (and heads) each trusted provider starts, by label or domain. 0 keeps a provider out of the spread; it stays a fallback. |
| `MAMORU_RPC_MONTHLY_BUDGET` | `alchemy.com=30000000,quiknode.pro=80000000` | Units per quota cycle by domain: Alchemy CU, QuickNode credits, requests for any other. Merged over the defaults; 0 turns one off. |
| `MAMORU_RPC_QUOTA_RESET_DAY` | 1 | `quiknode.pro=14`: the day of the month (UTC, 1 to 28) a provider's quota resets on, its billing cycle. |

- **Spent quota.** An answer that says the plan is spent (Alchemy's 429 "Monthly capacity limit exceeded", a 402,
  "insufficient credits", "quota exceeded") parks that provider until its reset: the time the answer gives (a
  `Retry-After` header, a date after "reset" in the message, within 40 days), else the next reset day at 00:00 UTC.
  One request a day asks it again, and a good answer clears the mark. The mark is kept in `stateDir/rpc-quota.json`
  by a hash of the URL. One `[alert]` line on the first refusal. When every provider a call may use is parked, one
  request a minute asks one of them; every other request fails at once with "every provider for this call is out of
  quota until ...", without a request.
- **Burst limit or failure.** An ordinary 429 keeps the provider out of the read spread for 10 s, a 5xx or a timeout
  for 30 s; it is still asked after the others. A method the provider does not serve, or a range it refuses, is not a
  failure.
- **Budget.** Each provider's use in its cycle is counted (`stateDir/rpc-usage.json`, `budget`). One `[alert]` line at
  70% and one at 90% per cycle, with the forecast date at the cycle's average rate. Only the Base proxy is counted;
  the Monad and Ethereum proxies of the operator are not.
- **Spread.** A read pinned to a block, and `eth_blockNumber`, start at a trusted provider drawn by weight among those
  not cooling. A read pinned to block N starts only at a provider that has shown block N (its head, or a block it
  returned), so a read and the simulation of the same decision see a block every provider asked has. For 30 s the
  served head does not step back when a provider behind the last one answers. Reads by tag or hash (nonces,
  receipts), sends and `eth_getLogs` keep the order they had. Public fallbacks never serve a decision read.
- `/metrics` `rpc.providers`: each provider of each proxy (`chain`, `monad`, `l1`) as `ok`, `burst_limited`,
  `failing` or `exhausted`, with `until`. `rpc.budget`: use, budget, percentage, cycle, reset and forecast by domain.

## App Worker: `ETHEREUM_RPC_URLS`

- A list of `https` URLs separated by commas, tried in the order written. At most three are used; anything
  that is not `https` is dropped.
- Keyed providers only. A public node can show an owner a notice that is not true.
- Each answer is checked on its own: the chain id, the block and both balances come out of one call to
  Multicall3, so a provider on another chain is refused and the next one is asked.
- Unset, the route answers "not observed" and the app shows nothing.
- The Worker has its own provider key. It does not share the operator's: the operator's hourly budget and
  ledger count only its own traffic, and a Worker secret is a different trust boundary.

Cost, and what bounds it:

- Normally one `eth_call` per account every 30 seconds at most, while that owner has the app open: each
  Worker isolate caches a good answer for 30 seconds and a failure for 10.
- One read is up to three `eth_call`s, one per provider, when the first ones fail.
- `OTHER_CHAINS_LIMIT` in `wrangler.jsonc` admits 6 reads a minute per account. Cloudflare counts this per
  location and approximately, so it is a brake, not an exact quota: an account reaching several locations
  can pass 6 a minute in total. When an isolate's table of 500 accounts is full, an admitted read is not
  cached, so the limiter is then the only bound for that account.
- Configured rate for one account in one location: 6 reads a minute, 18 `eth_call`s if two providers are
  down. This is the nominal rate, not a ceiling: the limiter's counters are eventually consistent and can
  let a few more through.
- The provider's own quota alert is the last line: keep it on for the key this Worker uses.

### Setting it (coordinator only)

The value is typed or piped into the prompt, never passed as an argument:

```sh
cd apps/mamoru-app
bunx wrangler secret put ETHEREUM_RPC_URLS --env beta   # beta first
bunx wrangler secret put ETHEREUM_RPC_URLS              # production
```

Check without printing it: `bunx wrangler secret list --env beta` shows the name. Then sign in on beta with
an account whose address holds USDC on Ethereum, or read Workers logs for `other chain not observed`: a
failing provider is named by its place in the list and a fixed reason, never by its URL.

### Rotating or removing a provider

Put the new list with the same command. A provider whose plan ends (QuickNode's free period ends on
1 January 2027) is removed from the list before that date; the notice keeps working on the other one.
