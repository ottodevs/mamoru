/** otto/mamoru#181. One error type for every adapter: which provider, a short machine code, and why. Adapters throw
 * this instead of returning a quote they are not sure of — a caller quoting several providers catches it per
 * adapter and moves on (see selector.ts `quoteAll`). */
export class RouteError extends Error {
  readonly provider: string
  readonly code: string

  constructor(provider: string, code: string, detail: string) {
    super(`${provider} ${code}: ${detail}`)
    this.provider = provider
    this.code = code
  }
}
