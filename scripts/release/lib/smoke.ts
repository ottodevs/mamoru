// Post-deploy smoke test: the deployed Worker serves its SPA shell, the asset it references actually
// resolves (catches a stale Worker-vs-assets mismatch), and the API responds.
export type SmokeCheck = { name: string; ok: boolean; detail: string }
export type SmokeResult = { ok: boolean; checks: SmokeCheck[] }

/** Only what the checks read, so a test can serve its own responses. */
type Page = { status: number; headers: { get(name: string): string | null }; text(): Promise<string>; json(): Promise<unknown> }
type Get = (url: string) => Promise<Page>
const httpGet: Get = (url) => fetch(url, { redirect: 'follow' })

export async function smokeTest(baseUrl: string, opts: { expectBetaBadge?: boolean; get?: Get } = {}): Promise<SmokeResult> {
  const get = opts.get ?? httpGet
  const checks: SmokeCheck[] = []
  const base = baseUrl.replace(/\/$/, '')

  const home = await get(`${base}/`)
  const html = await home.text()
  checks.push({ name: 'GET / is 200', ok: home.status === 200, detail: String(home.status) })

  const assetPath = html.match(/\/assets\/[^"']+?\.js/)?.[0]
  checks.push({ name: 'index.html references a built JS asset', ok: !!assetPath, detail: assetPath ?? 'none found in HTML' })
  if (assetPath) {
    const asset = await get(`${base}${assetPath}`)
    // The SPA fallback answers a missing asset with 200 and the HTML shell: the content type tells them apart.
    const type = asset.headers.get('content-type') ?? ''
    checks.push({ name: 'referenced asset resolves as JavaScript (hash matches deployed assets)', ok: asset.status === 200 && /javascript/i.test(type), detail: `${assetPath} -> ${asset.status} ${type}` })
    if (opts.expectBetaBadge) {
      const js = await asset.text()
      checks.push({ name: 'bundle contains the BETA badge', ok: js.includes('BETA'), detail: js.includes('BETA') ? 'present' : 'missing' })
    }
  }

  const api = await get(`${base}/api/config`)
  const config = /json/i.test(api.headers.get('content-type') ?? '') ? await api.json().catch(() => null) : null
  checks.push({ name: 'GET /api/config is 200 JSON (health route)', ok: api.status === 200 && !!config && typeof config === 'object', detail: `${api.status} ${api.headers.get('content-type') ?? ''}` })

  return { ok: checks.every((c) => c.ok), checks }
}

export function printSmoke(result: SmokeResult): void {
  for (const c of result.checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name} (${c.detail})`)
}
