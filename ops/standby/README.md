# ops/standby — cold standby operator on the edge VPS

otto/mamoru#237, after incident #205. lady is the only host of both operators. This keeps an encrypted, at most
5-minute-old copy of everything they need on the edge VPS (`23.94.151.198`), and a fenced, manual failover to it.
It is a bridge: the way out of a single operator host is #239 (no privileged key to guard).

## What protects what

- **Keys at rest.** The bundles hold the session keys and the relayer key. They are encrypted with age to Ot's key;
  the identity is on lady and ghost3 only. The VPS stores ciphertext. Plain state exists on the VPS only while a
  drill runs (then shredded) or while a failover runs.
- **Upload path.** lady's key `~/.ssh/mamoru-standby` can only run `receive.sh` on the VPS (`put`, `status`, `ack`).
  It cannot read bundles back, run a shell, or change the fence (root-owned `/var/lib/mamoru-failover`).
- **Never two operators.** The VPS starts operators only through `mamoru-failover activate`:
  - lady alive (bundle under 10 min old): the VPS sets a *pending* fence; lady's `fence-watch` (every minute) stops
    lady's operators, pushes a last bundle and acknowledges; only then the VPS starts. No answer in 4 min: nothing starts.
  - lady silent: needs `--confirm-lady-down`, Ot's word that lady's operators are not running.
  - while the fence is set, lady's operator units refuse to start (`ExecStartPre=fence-watch.sh pre`) and the watch
    stops them if they were started by hand.
  - the VPS units are never enabled: a VPS reboot does not bring them back.
- **Fail-open on lady's side.** If lady cannot reach the VPS, its operators start as usual. The only way the VPS runs
  without lady's acknowledgement is `--confirm-lady-down`; before lady comes back from such an outage, stop its
  operators there (step 1 of "Hand back").

## Install

lady (as otto):

```sh
install -Dm755 ops/standby/push-bundle.sh ops/standby/fence-watch.sh -t ~/.local/share/mamoru-standby/
install -Dm644 ops/standby/lady/mamoru-standby-{push,fence}.{service,timer} -t ~/.config/systemd/user/
for u in mamoru-operator mamoru-operator-monad; do install -Dm644 ops/standby/lady/fence.conf ~/.config/systemd/user/$u.service.d/fence.conf; done
ssh-keygen -t ed25519 -N '' -C mamoru-standby-upload -f ~/.ssh/mamoru-standby     # once
age-keygen -y ~/.config/sops/age/keys.txt > ~/.config/mamoru-standby/recipient     # public part only
systemctl --user daemon-reload && systemctl --user enable --now mamoru-standby-push.timer mamoru-standby-fence.timer
```

The drop-in takes effect at the operators' next start; it does not restart them.

VPS (as root, from a copy of `ops/standby`): `./vps/install.sh mamoru-standby.pub recipient`.

## Drill (monthly, and after an install)

From ghost3: `ssh root@23.94.151.198 mamoru-failover drill < ~/.config/sops/age/keys.txt`

It decrypts the newest bundle, checks every unit has env, state and parseable JSON, installs the code of each sha
(`bun install --frozen-lockfile`, cached per sha), starts nothing and shreds the decrypted state.

## Failover

1. Look first: Telegram / `ops-mamoru` link alert (#207), `ssh root@23.94.151.198 mamoru-failover status`.
   If only the tunnel is down and lady is fine, fix the tunnel on lady instead.
2. From ghost3: `ssh root@23.94.151.198 mamoru-failover activate < ~/.config/sops/age/keys.txt`
   (add `--confirm-lady-down` only when lady is unreachable and you know its operators are not running).
3. It prints the health of each operator and its quick tunnel URL. Point the Worker at them from a machine with
   wrangler: `OPERATOR_URL` on prod and beta, `OPERATOR_URL_143` on beta. With the named tunnel (#206) this step
   changes; update this README when #206 lands.
4. Log it on otto/mamoru#83 (it is an operator move).

## Hand back

1. If lady came back from `--confirm-lady-down`: before anything else, on lady
   `systemctl --user stop mamoru-operator mamoru-operator-monad` (the fence also blocks a start).
2. VPS: `ssh root@23.94.151.198 mamoru-failover handback` stops the operators there and seals their state.
3. lady: `scp root@23.94.151.198:/var/lib/mamoru-failover/handback/handback-<ts>.tar.zst.age .`, decrypt with
   `age -d -i ~/.config/sops/age/keys.txt … | zstd -d | tar -x -C <dir>`, back up the current state dirs, copy
   `<dir>/<unit>/state/*` into `~/.local/state/<unit>/`.
4. `ssh root@23.94.151.198 mamoru-failover clear`, then on lady
   `systemctl --user start mamoru-operator mamoru-operator-monad` and put the lady tunnel URLs back in the Worker.
5. Log it on #83.
