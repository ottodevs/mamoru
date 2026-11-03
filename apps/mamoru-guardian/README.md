# @mamoru/guardian

The guardian watcher of spec 010 (otto/mamoru#293, items I4 and I7). A small standalone polling process with its own
key. It has no import of, and no code path into, `apps/mamoru-operator`.

## What it does

Each pass (interval from env, idempotent, all state in one 0600 JSON file):

1. Reads V4 `RemoteRegistered` logs on the home chain (Base) in bounded block pages, with a checkpoint.
2. For each registration that is not ready, reads the remote Safe back on the remote chain and calls
   `V4.setReady(account, domain, remote)` only if all of these match: code at the remote; owners (same order) and
   threshold equal to the home account's; the shared-signer passkey (x, y, verifiers) equal when it is an owner; the
   home owners hash now equals the event's and the hash of what was read; SmartSession installed on the Safe7579 of the
   remote, Safe7579 enabled as module and as fallback handler; the recomputed canonical remote (`v4Remote`) equals the
   registered one, its permission is enabled and is the only one SmartSession lists for the remote. Any mismatch is an
   alert naming the failed check, retried next pass. A superseded registration is dropped.
3. Alerts on every `MamoruRegistry.Queued` (kind, key, params, eta) on each watched chain.
4. Alerts on any `ExecutionSuccess` of a registered remote Safe whose safeTxHash is not in the allowlist file.
5. V4 siblings (#307, #310): reads V4 `PolicySet` logs on its chain. An account whose Init names itself as home (an
   account's own address on Ethereum, the home on Base) is tracked. When it is not ready, the guardian reads the same
   address back on the home chain and calls `V4.setReady(account, homeDomain, account)` only if:
   - it is deployed there, a Safe of the pinned SafeL2 singleton, and a V4 home there (`configOf`: set, no home);
   - V4's owners hash (owners, threshold, passkey) is equal on both chains.
   An undeployed home is not marked ready: the app deploys it at Start, in the same approval. This runs on the Ethereum
   instance (`MAMORU_GUARDIAN_HOME_CHAIN_ID=1`, `MAMORU_GUARDIAN_RPC_URL_8453`; unit
   `ops/systemd/mamoru-guardian-ethereum.service`).

Alerts go to a Mattermost incoming webhook (and always to the journal) and are deduplicated in the state file.

## Key and authority

The guardian key can `pause` / `unpause` / `review` / `setReady` / `clearReady` and `cancel` registry entries. It can
never move funds, and a compromised guardian alone moves none. The operator never holds this key; do not put it in the
operator's env or state dir. It is read from one of two sources, never both:

- **Encrypted keystore (production, #338):** `MAMORU_GUARDIAN_KEYSTORE` (a v3 keystore, as `cast wallet new` or
  `~/.local/bin/mamoru-guardian-keygen` writes it) and `MAMORU_GUARDIAN_KEYSTORE_PASSWORD_FILE`, both regular files of
  mode 0600 or stricter. The key is decrypted in memory at start and never written out in plaintext.
- **Plain key file:** `MAMORU_GUARDIAN_KEY_FILE`, a regular file of mode 0600 or stricter containing `0x` + 64 hex.

The key is never logged, never in argv, never in the env file. At start the process refuses a key that is not
`V4.GUARDIAN()`.

On lady the guardian key is the keystore that `mamoru-guardian-keygen` created (address in
`~/.config/mamoru-operator/guardian.address`):

```sh
MAMORU_GUARDIAN_KEYSTORE=/home/otto/.config/mamoru-operator/keystores/mamoru-guardian
MAMORU_GUARDIAN_KEYSTORE_PASSWORD_FILE=/home/otto/.config/mamoru-operator/guardian.pass
```

A plain key file instead:

```sh
umask 077
mkdir -p ~/.config/mamoru-guardian
# paste the key from your password manager, do not type it into a shared shell history
${EDITOR:-nano} ~/.config/mamoru-guardian/key
chmod 600 ~/.config/mamoru-guardian/key
```

## Environment (names only; values are yours)

| Name | Meaning |
| --- | --- |
| `MAMORU_GUARDIAN_HOME_RPC_URL` | Home chain (Base) RPC, its own provider. Required. |
| `MAMORU_GUARDIAN_RPC_URL_143` | Remote chain RPC per chain id (`_143` Monad). A registration whose chain has none alerts. |
| `MAMORU_GUARDIAN_HOME_CHAIN_ID` | Default `8453`. |
| `MAMORU_GUARDIAN_V4_ADDRESS`, `MAMORU_GUARDIAN_GAS_POLICY_ADDRESS` | Else taken from the pinned deployment (`oneAuthV4Deployment`); the process refuses to start if neither gives an address. |
| `MAMORU_GUARDIAN_REGISTRY_ADDRESS` | MamoruRegistry, else the pinned deployment. |
| `MAMORU_GUARDIAN_FROM_BLOCK_8453`, `_143` | First block to scan per chain; required on first start. |
| `MAMORU_GUARDIAN_STATE_DIR` | Directory of `state.json` (0600). Required. |
| `MAMORU_GUARDIAN_KEYSTORE`, `MAMORU_GUARDIAN_KEYSTORE_PASSWORD_FILE` | Encrypted keystore and its password file (above). |
| `MAMORU_GUARDIAN_KEY_FILE` | Path of a plain key file (above). One key source is required unless dry-run. |
| `MAMORU_GUARDIAN_WEBHOOK_FILE` | Path of a file holding the Mattermost incoming-webhook URL (optional, console only without it). |
| `MAMORU_GUARDIAN_ALLOWLIST_FILE` | JSON array of safeTxHashes Mamoru prepared; absent file = empty. |
| `MAMORU_GUARDIAN_INTERVAL_SECONDS` | Poll interval, default 30. |
| `MAMORU_GUARDIAN_LOG_PAGE`, `MAMORU_GUARDIAN_MAX_PAGES` | Blocks per `getLogs` page (2000) and pages per stream per pass (50). |
| `MAMORU_GUARDIAN_REALERT_SECONDS` | Repeat a persisting failed-check alert after this long (default 21600). |
| `MAMORU_GUARDIAN_DRY_RUN` | `1`, or pass `--dry-run`: reads and alerts, never sends. The key file is then optional. |

`--once` runs a single pass and exits.

## Run and test

```sh
bun apps/mamoru-guardian/src/main.ts --dry-run --once   # reads, alerts, sends nothing
bun test apps/mamoru-guardian
bunx tsc -p apps/mamoru-guardian/tsconfig.json --noEmit
```

The systemd template is `ops/systemd/mamoru-guardian.service` (not installed by anything in the repo).

**Paging (review of #202 r4, r5).** With `MAMORU_GUARDIAN_WEBHOOK_FILE` set, the guardian refuses to start unless the
file holds an http(s) URL: it exits 78 (EX_CONFIG), the unit stops restarting and enters `failed`, and
`mamoru-guardian-alert@` pages through `OnFailure=` on its own channel (`MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE` from
`~/.config/mamoru-guardian-alert/env`; it never posts through the guardian's webhook and refuses when both name the
same file, inode or URL; if it cannot post it exits non-zero and lands in `failed` itself). Every other configuration error
exits 78 too; a transient one (an RPC down) exits 1 and restarts with backoff. It never runs console-only when paging is
configured. Without the variable (dev) it says `NO PAGING CONFIGURED` at start and writes alerts to the journal only.

Only a delivered webhook post counts as delivered. `alert()` returns `{ delivered }`; the journal sink never delivers.
An alert that only reached the journal is not recorded as alerted, and the log cursor of its stream does not move past
its page: the next pass raises it again, and once a webhook is configured it is delivered (then recorded). Startup
stamps follow the same rule. Which unit reads which secret file: `ops/systemd/README.md`.
