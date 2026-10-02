// Polls GET /health after a restart. Injectable `get` so tests never touch the network.
export type Get = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>

export async function waitForHealth(baseUrl: string, timeoutMs: number, get: Get = fetch, pollMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await get(`${baseUrl.replace(/\/+$/, '')}/health`)
      if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
        if (body?.ok) return true
      }
    } catch {
      // not up yet, or the unit has not bound the port yet
    }
    if (Date.now() >= deadline) return false
    await Bun.sleep(pollMs)
  }
}
