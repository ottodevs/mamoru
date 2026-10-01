// The smoke test must not pass on the SPA fallback: a missing asset or API route answers 200 with HTML.
import { describe, expect, it } from 'bun:test'
import { smokeTest } from './smoke.ts'

const html = '<html><script src="/assets/index-abc.js"></script></html>'
const res = (body: string, type: string) => new Response(body, { status: 200, headers: { 'content-type': type } })

function site(asset: Response, config: Response) {
  return async (url: string) => (url.endsWith('.js') ? asset.clone() : url.endsWith('/api/config') ? config.clone() : res(html, 'text/html'))
}

describe('smokeTest', () => {
  it('passes when the asset is JavaScript and the config is JSON', async () => {
    const r = await smokeTest('https://x', { get: site(res('console.log(1)', 'text/javascript'), res('{"chainId":8453}', 'application/json')) })
    expect(r.ok).toBe(true)
  })
  it('fails when the asset is the HTML fallback', async () => {
    const r = await smokeTest('https://x', { get: site(res(html, 'text/html'), res('{}', 'application/json')) })
    expect(r.ok).toBe(false)
  })
  it('fails when the config route is the HTML fallback', async () => {
    const r = await smokeTest('https://x', { get: site(res('console.log(1)', 'text/javascript'), res(html, 'text/html')) })
    expect(r.ok).toBe(false)
  })
})
