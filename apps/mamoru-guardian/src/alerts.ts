// otto/mamoru#293 (spec 010 I4, I7): where the guardian's alerts go. A webhook URL is a secret (anyone holding it can
// post as the bot), so it is read from a file and never printed, not even in an error.
import { readFileSync } from 'node:fs'

/**
 * Review of #202 r5 (Sol 2): the result of one alert. `delivered` is true only when a paging sink (the webhook) took it; a
 * line written to the journal is never "delivered", so the caller does not record it as alerted and replays it later.
 */
export type Delivery = { delivered: boolean }

export interface Alerter {
  /** Resolves with the delivery; a paging sink that fails throws (the caller retries). */
  alert(text: string): Promise<Delivery>
}

/** Fallback when no webhook is configured; also the local record of every alert. Never delivers. */
export class ConsoleAlerter implements Alerter {
  async alert(text: string): Promise<Delivery> {
    console.warn(`[guardian alert] ${text}`)
    return { delivered: false }
  }
}

/** Mattermost incoming webhook: POST { text }. Throws (without the URL) on a failed delivery so the caller retries. */
export class MattermostAlerter implements Alerter {
  constructor(
    private readonly url: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async alert(text: string): Promise<Delivery> {
    let status: number
    try {
      const res = await this.doFetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      status = res.status
    } catch {
      throw new Error('mattermost webhook: request failed')
    }
    if (status < 200 || status >= 300) throw new Error(`mattermost webhook: HTTP ${status}`)
    return { delivered: true }
  }
}

/** Console always, then the webhook: a webhook outage still leaves the line in the journal. Delivered if any sink delivered. */
export class TeeAlerter implements Alerter {
  constructor(private readonly sinks: readonly Alerter[]) {}
  async alert(text: string): Promise<Delivery> {
    let delivered = false
    for (const s of this.sinks) if ((await s.alert(text)).delivered) delivered = true
    return { delivered }
  }
}

/** Reads a webhook URL file. `name` is the env variable that named it (for the error; never the URL). */
export function webhookUrlFromFile(path: string, name = 'MAMORU_GUARDIAN_WEBHOOK_FILE'): string {
  const url = readFileSync(path, 'utf8').trim()
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`${name}: not an http(s) URL`)
  return url
}
