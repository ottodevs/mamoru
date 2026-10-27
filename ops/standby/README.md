# ops/standby — cold standby operator on the edge VPS

otto/mamoru#237, after incident #205. lady is the only host of both operators. This keeps an encrypted copy of
everything they need on the edge VPS (`23.94.151.198`), at most 5 minutes old, and a fenced, manual failover to it.
It is a bridge: the way out of a single operator host is #239 (no privileged key to guard).

## What protects what

- **Keys at rest.** The bundles hold the session keys and the relayer key, encrypted with age to a key used for
  this only (`~/.config/mamoru-standby/identity` on lady and ghost3, never on the VPS). The VPS stores ciphertext.
  Plain state exists there only while a drill runs or while a failover runs; it is shredded afterwards, which on a
  virtual disk is best effort.
- **Upload path.** lady's key `~/.ssh/mamoru-standby` can only run `receive.sh` on the VPS (`put` with a sha256 that
  must match, `status`). It cannot read bundles back, run a shell, replace a code archive, or change the fence (root's
  `/var/lib/mamoru-failover`).
- **Who made a bundle.** age does not say who encrypted, so every file is also signed by a second lady key
  (`~/.config/mamoru-standby/sign`); the VPS ignores anything that key did not sign. Holding the upload key or the
  `mamoru-standby` account is not enough to make the VPS run other code or other state.
- **Old state.** activate refuses a bundle older than 1 h unless `--accept-old`. A failing push or fence watch posts
  to `ops-mamoru` (`mamoru-standby-alert@`), and `drill` / `status` print the bundle's age.
- **Never two operators.**
  - lady up: `fence-watch.sh standdown` on lady stops its operators, keeps a local fence naming them and pushes a last
    bundle. `activate` refuses while the newest bundle says any operator runs, and starts exactly the units lady named.
  - lady silent for 10 min: `activate` needs `--confirm-lady-down`, Ot's word that lady's operators are not running,
    and starts the units that were running in the last bundle.
  - lady fails closed: its operator units start only on an exact `fence none` from the VPS and no local fence. While
    the VPS is unreachable they refuse (the fence watch starts them when it answers again; the coordinator's one-time
    override is `touch ~/.local/state/mamoru-standby/allow-unreachable`, consumed by the next start). When the watch sees the fence it stops
    them and keeps a local fence, so a reboot cannot bring them back.
  - the VPS units are never enabled: a VPS reboot does not bring them back.
- **Residual risk.** `--confirm-lady-down` while lady is in fact running and reaching the chain, but neither the VPS
  nor the Worker: two operators until lady can reach the VPS again (its watch then stops them within a minute). Confirm
  only what you have checked.

## Install

lady (as otto):

```sh
install -Dm755 ops/standby/push-bundle.sh ops/standby/fence-watch.sh ops/standby/lady/mamoru-standby-alert.sh -t ~/.local/share/mamoru-standby/
install -Dm644 ops/standby/lady/mamoru-standby-{push,fence}.{service,timer} ops/standby/lady/mamoru-standby-alert@.service -t ~/.config/systemd/user/
ssh-keygen -t ed25519 -N '' -C mamoru-standby-upload -f ~/.ssh/mamoru-standby                 # once
ssh-keygen -t ed25519 -N '' -C mamoru-standby-sign -f ~/.config/mamoru-standby/sign           # once
echo <ops-mamoru channel id> > ~/.config/mamoru-standby/alert-channel
age-keygen -o ~/.config/mamoru-standby/identity && age-keygen -y ~/.config/mamoru-standby/identity > ~/.config/mamoru-standby/recipient   # once
scp ~/.config/mamoru-standby/identity ghost3.local:.config/mamoru-standby/identity            # 0600 there
systemctl --user daemon-reload && systemctl --user enable --now mamoru-standby-push.timer
```

VPS (as root, from a copy of `ops/standby`): `./vps/install.sh mamoru-standby.pub recipient sign.pub`.

After the first drill, the coordinator arms the fence on lady (logged on #83):

```sh
for u in mamoru-operator mamoru-operator-monad; do install -Dm644 ops/standby/lady/fence.conf ~/.config/systemd/user/$u.service.d/fence.conf; done
systemctl --user daemon-reload && systemctl --user enable --now mamoru-standby-fence.timer
```

The drop-in takes effect at the operators' next start; it does not restart them.

## Drill (monthly, and after an install)

From ghost3: `ssh root@23.94.151.198 mamoru-failover drill < ~/.config/mamoru-standby/identity`

It decrypts the newest bundle, checks every unit has env, a non-empty state and parseable JSON, installs the code of
each sha (`bun install --frozen-lockfile`, cached per sha), starts nothing and shreds the decrypted state.

## Failover

1. Look first: the link alert (#207, Telegram and `ops-mamoru`), `ssh root@23.94.151.198 mamoru-failover status`.
   If only the tunnel is down and lady is fine, fix the tunnel on lady instead.
2. lady reachable: on lady `~/.local/share/mamoru-standby/fence-watch.sh standdown` (it also covers an operator
   that is crash-looping: it stands down every enabled unit).
   lady unreachable: make sure its operators are not running (power, console, the host is down).
3. From ghost3: `ssh root@23.94.151.198 mamoru-failover activate < ~/.config/mamoru-standby/identity`
   (add `--confirm-lady-down` only in the second case of step 2).
4. It prints each operator's health and quick tunnel URL. Point the Worker at them from a machine with wrangler:
   `OPERATOR_URL` on prod and beta, `OPERATOR_URL_143` on beta. With the named tunnel (#206) this step changes;
   update this README when #206 lands.
5. Log it on otto/mamoru#83: it is an operator move.

## Hand back

1. VPS: `ssh root@23.94.151.198 mamoru-failover handback` stops the operators there and seals their state for lady.
2. lady (its operators stay down: local fence):
   ```sh
   scp root@23.94.151.198:"$(ssh root@23.94.151.198 cat /var/lib/mamoru-failover/handback/LATEST)" /tmp/handback.age
   mkdir -m 700 /tmp/handback && age -d -i ~/.config/mamoru-standby/identity /tmp/handback.age | zstd -d | tar -x -C /tmp/handback
   for u in mamoru-operator mamoru-operator-monad; do        # each unit's MAMORU_OPERATOR_STATE_DIR
     d=~/.local/state/$u; [ -d /tmp/handback/$u/state ] || continue
     mv "$d" "$d.pre-handback-$(date +%s)" && cp -a /tmp/handback/$u/state "$d"
   done
   ```
   The state dir is replaced, not merged: files the VPS operator removed must not come back.
3. `ssh root@23.94.151.198 mamoru-failover clear`, then on lady `~/.local/share/mamoru-standby/fence-watch.sh resume`
   (it first pushes a bundle saying lady runs again, so an old "stood down" bundle can never start the VPS).
   Put lady's tunnel URLs back in the Worker. Shred `/tmp/handback*`.
4. Log it on #83.
