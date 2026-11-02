// otto/mamoru#293 (review of #202 r3, r5): the OnFailure helper of the guardian unit. Review r5 (Sol 1): it pages through
// an INDEPENDENT channel. It reads only MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE from its own env file
// (~/.config/mamoru-guardian-alert/env), never the guardian's env file or MAMORU_GUARDIAN_WEBHOOK_FILE: a broken guardian
// webhook is exactly what lands the guardian in `failed`. A fixed line; never a log excerpt, never a webhook URL.
import { MattermostAlerter, webhookUrlFromFile, type Alerter } from './alerts.ts'

type Env = Record<string, string | undefined>

/** The unit name argument systemd passes (%N of mamoru-guardian or mamoru-guardian@x), or null when it is anything else. */
export function unitOf(arg: string | undefined): string | null {
  const unit = arg ?? 'mamoru-guardian'
  return /^mamoru-guardian(@[\w.-]+)?$/.test(unit) ? unit : null
}

/** The independent alert channel. Throws (without the URL) when it is not configured or unusable. */
export function unitAlerterFrom(env: Env, doFetch: typeof fetch = fetch): Alerter {
  const file = env.MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE
  if (!file) throw new Error('MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE is not set (its own env file: ~/.config/mamoru-guardian-alert/env)')
  if (env.MAMORU_GUARDIAN_WEBHOOK_FILE && env.MAMORU_GUARDIAN_WEBHOOK_FILE === file) throw new Error('MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE must not be the guardian webhook file')
  return new MattermostAlerter(webhookUrlFromFile(file, 'MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE'), doFetch)
}

export const unitFailedText = (unit: string) => `:warning: ${unit} failed. On the host: systemctl --user status ${unit}; journalctl --user -u ${unit} -n 30`

/** Pages one unit failure; returns the exit code (0 delivered, 1 not). */
export async function pageUnitFailure(env: Env, arg: string | undefined, doFetch: typeof fetch = fetch): Promise<number> {
  const unit = unitOf(arg)
  if (!unit) return 2
  try {
    const { delivered } = await unitAlerterFrom(env, doFetch).alert(unitFailedText(unit))
    return delivered ? 0 : 1
  } catch (e) {
    console.error(`mamoru-guardian-alert: ${(e as Error).message}`)
    return 1
  }
}

if (import.meta.main) process.exit(await pageUnitFailure(process.env, process.argv[2]))
