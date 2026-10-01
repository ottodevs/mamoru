// Post-deploy smoke test: the deployed Worker serves its SPA shell, the asset it references actually
// resolves (catches a stale Worker-vs-assets mismatch), and the API responds.
export type SmokeCheck = { name: string; ok: boolean; detail: string }
export type SmokeResult = { ok: boolean; checks: SmokeCheck[] }

async function get(url: string): Promise<Response> {
  return fetch(url, { redirect: 'follow' })
}

export async function smokeTest(baseUrl: string, opts: { expectBetaBadge?: boolean } = {}): Promise<SmokeResult> {
  const checks: SmokeCheck[] = []
  const base = baseUrl.replace(/\/$/, '')

  const home = await get(`${base}/`)
  const html = await home.text()
  checks.push({ name: 'GET / is 200', ok: home.status === 200, detail: String(home.status) })

  const assetPath = html.match(/\/assets\/[^"']+?\.js/)?.[0]
  checks.push({ name: 'index.html references a built JS asset', ok: !!assetPath, detail: assetPath ?? 'none found in HTML' })
  if (assetPath) {
    const asset = await get(`${base}${assetPath}`)
    checks.push({ name: 'referenced asset resolves (hash matches deployed assets)', ok: asset.status === 200, detail: `${assetPath} -> ${asset.status}` })
    if (opts.expectBetaBadge) {
      const js = await asset.text()
      checks.push({ name: 'bundle contains the BETA badge', ok: js.includes('BETA'), detail: js.includes('BETA') ? 'present' : 'missing' })
    }
  }

  const api = await get(`${base}/api/config`)
  checks.push({ name: 'GET /api/config is 200 (health route)', ok: api.status === 200, detail: String(api.status) })

  return { ok: checks.every((c) => c.ok), checks }
}

export function printSmoke(result: SmokeResult): void {
  for (const c of result.checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name} (${c.detail})`)
}
