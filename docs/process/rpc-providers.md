# RPC providers

Which process reads which chain through which provider, and how the secrets are set. No key or URL with a
token is ever written in this repository, in a ticket or in a log.

| Process | Chain | Variable | Order |
|---|---|---|---|
| Operator | Base (8453) | `RPC_URL`, `MAMORU_RPC_FALLBACKS`, `MAMORU_RPC_TRUSTED` in the operator env file | Alchemy, then QuickNode, then public nodes (never for decision reads) |
| App Worker (`mamoru-app`, `mamoru-app-beta`) | Ethereum (1), read-only, wrong-network notice | secret `ETHEREUM_RPC_URLS` | Alchemy, then QuickNode |

## App Worker: `ETHEREUM_RPC_URLS`

- A list of `https` URLs separated by commas, tried in the order written. At most three are used; anything
  that is not `https` is dropped.
- Keyed providers only. A public node can show an owner a notice that is not true.
- Each answer is checked on its own: the chain id, the block and both balances come out of one call to
  Multicall3, so a provider on another chain is refused and the next one is asked.
- Unset, the route answers "not observed" and the app shows nothing.
- The Worker has its own provider key. It does not share the operator's: the operator's hourly budget and
  ledger count only its own traffic, and a Worker secret is a different trust boundary.

Cost: one `eth_call` per account every 30 seconds at most while that owner has the app open, bounded per
account by the `OTHER_CHAINS_LIMIT` rate limiter in `wrangler.jsonc` (6 reads a minute).

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
