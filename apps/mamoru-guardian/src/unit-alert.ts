// otto/mamoru#293 (review of #202 r3, r5, r6): the OnFailure helper of the guardian unit. It pages through an INDEPENDENT
// channel: MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE from its own env file (~/.config/mamoru-guardian-alert/env). The unit also
// loads the guardian's env file (optional) only to learn MAMORU_GUARDIAN_WEBHOOK_FILE, and refuses when both name the same
// webhook (same realpath, same device+inode, or the same URL): a broken guardian webhook is what lands the guardian in
// `failed`. It never posts through the guardian's webhook and never reads the guardian key. A fixed line; never a log
// excerpt, never a webhook URL. Any failure to post exits non-zero, so this unit lands in `failed` too.
import { readFileSync, realpathSync, statSync } from 'node:fs'
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
  const url = webhookUrlFromFile(file, 'MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE')
  const guardian = env.MAMORU_GUARDIAN_WEBHOOK_FILE
  if (guardian && sameWebhook(file, url, guardian)) throw new Error('MAMORU_GUARDIAN_ALERT_WEBHOOK_FILE must not be the guardian webhook (same file or same URL)')
  return new MattermostAlerter(url, doFetch)
}

/**
 * Whether the guardian's webhook file is the alert one: the same path, realpath or device+inode (a symlink, a hard link),
 * or the same URL in another file. A guardian file that does not exist or cannot be read shares nothing.
 */
export function sameWebhook(alertFile: string, alertUrl: string, guardianFile: string): boolean {
  if (alertFile === guardianFile) return true
  let g: ReturnType<typeof statSync>
  try {
    g = statSync(guardianFile)
  } catch {
    return false
  }
  const a = statSync(alertFile)
  if (a.dev === g.dev && a.ino === g.ino) return true
  try {
    if (realpathSync(alertFile) === realpathSync(guardianFile)) return true
  } catch {}
  try {
    return readFileSync(guardianFile, 'utf8').trim() === alertUrl
  } catch {
    return false
  }
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
