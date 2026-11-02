// otto/mamoru#293 (spec 010 I4, I7): where the guardian's alerts go. A webhook URL is a secret (anyone holding it can
// post as the bot), so it is read from a file and never printed, not even in an error.
import { readFileSync } from 'node:fs'

export interface Alerter {
  alert(text: string): Promise<void>
}

/** Fallback when no webhook is configured; also the local record of every alert. */
export class ConsoleAlerter implements Alerter {
  async alert(text: string): Promise<void> {
    console.warn(`[guardian alert] ${text}`)
  }
}

/** Mattermost incoming webhook: POST { text }. Throws (without the URL) on a failed delivery so the caller retries. */
export class MattermostAlerter implements Alerter {
  constructor(
    private readonly url: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async alert(text: string): Promise<void> {
    let status: number
    try {
      const res = await this.doFetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      status = res.status
    } catch {
      throw new Error('mattermost webhook: request failed')
    }
    if (status < 200 || status >= 300) throw new Error(`mattermost webhook: HTTP ${status}`)
  }
}

/** Console always, then the webhook: a webhook outage still leaves the line in the journal. */
export class TeeAlerter implements Alerter {
  constructor(private readonly sinks: readonly Alerter[]) {}
  async alert(text: string): Promise<void> {
    for (const s of this.sinks) await s.alert(text)
  }
}

export function webhookUrlFromFile(path: string): string {
  const url = readFileSync(path, 'utf8').trim()
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error('MAMORU_GUARDIAN_WEBHOOK_FILE: not an http(s) URL')
  return url
}
