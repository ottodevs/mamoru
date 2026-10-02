// Thin, read-mostly wrapper over `systemctl --user` for the operator deploy tool. The one mutating
// call is `restartUnit`; everything else only inspects state.
import { $ } from 'bun'

export type UnitSnapshot = { activeState: string; subState: string; nRestarts: number; mainPid: number | null; transient: boolean; fragmentPath: string }

function parseShowOutput(out: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of out.trim().split('\n')) {
    const i = line.indexOf('=')
    if (i >= 0) fields[line.slice(0, i)] = line.slice(i + 1)
  }
  return fields
}

/**
 * `systemctl --user show <unit> -p ActiveState -p SubState -p NRestarts -p MainPID -p Transient -p
 * FragmentPath`. Read-only. `transient` (systemd's own `Transient=` property) is the authoritative
 * way to tell a `systemd-run --unit=...` unit apart from a file-based one — NOT the unit name, which
 * the transient and durable operator units may share during a migration (see enumerate.ts). An
 * empty `FragmentPath` is the secondary/display signal for the same fact (a transient unit has none).
 */
export async function unitSnapshot(unit: string): Promise<UnitSnapshot> {
  const out = await $`systemctl --user show ${unit} -p ActiveState -p SubState -p NRestarts -p MainPID -p Transient -p FragmentPath`.quiet().text()
  const fields = parseShowOutput(out)
  const mainPid = Number(fields.MainPID ?? '0')
  const nRestarts = Number(fields.NRestarts ?? '0')
  return {
    activeState: fields.ActiveState ?? 'unknown',
    subState: fields.SubState ?? 'unknown',
    nRestarts: Number.isFinite(nRestarts) ? nRestarts : 0,
    mainPid: Number.isFinite(mainPid) && mainPid > 0 ? mainPid : null,
    transient: fields.Transient === 'yes',
    fragmentPath: fields.FragmentPath ?? '',
  }
}

/** Every loaded `*.service` unit name (`systemctl --user list-units --all --type=service --no-legend --plain`). Read-only. */
export async function listServiceUnits(): Promise<string[]> {
  const out = await $`systemctl --user list-units --all --type=service --no-legend --plain`.quiet().text()
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/)[0]!)
}

/** `systemctl --user enable <unit>`. Idempotent (a no-op if already enabled); run before every restart so the unit survives a reboot from the very first deploy, not only after a human remembers a separate manual step. */
export async function enableUnit(unit: string): Promise<void> {
  await $`systemctl --user enable ${unit}`.quiet()
}

/** `systemctl --user restart <unit>`. The one call in this module that starts/changes anything (besides `stopUnit`/`enableUnit`). */
export async function restartUnit(unit: string): Promise<void> {
  await $`systemctl --user restart ${unit}`.quiet()
}

/** `systemctl --user stop <unit>`. Used only for the explicit `--migrate-from-transient` path, and
 * to stop the durable unit itself if a post-restart re-check finds more than one operator process. */
export async function stopUnit(unit: string): Promise<void> {
  await $`systemctl --user stop ${unit}`.quiet()
}

/**
 * Whether anything beyond our own single deliberate restart happened during the observation
 * window: the unit crash-looped (NRestarts increased past `baseline`, taken right after our
 * restart) or ended up not active. `baseline` should be a snapshot taken right after our restart
 * returns, not before it, so this comparison is correct regardless of whether a manual
 * `systemctl restart` itself increments NRestarts on a given systemd version.
 */
export function unitRegressedSince(baseline: UnitSnapshot, after: UnitSnapshot): string | null {
  if (after.nRestarts > baseline.nRestarts) return `the unit restarted again on its own during the observation window (NRestarts ${baseline.nRestarts} -> ${after.nRestarts})`
  if (after.activeState !== 'active') return `the unit is not active (ActiveState=${after.activeState}, SubState=${after.subState})`
  return null
}
