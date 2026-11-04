// The e2e rule of merge-pr.sh (otto/mamoru#366, e2e postmortem of 4 Nov): a change to operator auth, policy ids,
// finality or a public route runs `bun run e2e:all` and pastes its table in the pull request. The auth cutoff (#140),
// the v1 policy removal (#251) and the convert finality (#285/#309) were each reviewed and each broke e2e nobody ran.

/** Files whose every change is one of those: operator routes and auth, the app's signed client, policy ids. */
const FILES: RegExp[] = [
  /^apps\/mamoru-operator\/src\/(server|one-auth|admission|remote-peer)\.ts$/,
  /^apps\/mamoru-app\/src\/api\/accounts\/operator\.ts$/,
  /^packages\/policy\/src\/policies(-[a-z0-9]+)?\.ts$/,
  /^packages\/registry\/[^/]+\.json$/,
]
/** Changed lines anywhere else in shipped code that touch the same things. */
const LINES = /finali[sz]ed|finality|confirmations|blockTag|operatorSignature|x-mamoru-|policy_?id/i
const isTest = (path: string) => /(^|\/)test\/|\.test\.ts$/.test(path)
const shipped = (path: string) => /^(apps|packages)\//.test(path) && !isTest(path)

/** Why a unified diff (`git diff --src-prefix=a/ --dst-prefix=b/`) needs the e2e table: one reason per file, empty
 * when it does not. Throws on a non-empty diff it cannot read, so an unexpected format refuses instead of passing. */
export function e2eReasons(diff: string): string[] {
  const reasons = new Map<string, string>()
  let file = ''
  let headers = 0
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line)
    if (header) {
      headers++
      file = header[2]!
      if (!isTest(file) && FILES.some((re) => re.test(file))) reasons.set(file, `${file} (operator auth, routes or policy ids)`)
      continue
    }
    if (!shipped(file) || reasons.has(file) || line.startsWith('+++') || line.startsWith('---')) continue
    const m = /^[+-](.*)$/.exec(line)
    const hit = m ? LINES.exec(m[1]!) : null
    if (hit) reasons.set(file, `${file} (changes a line with \`${hit[0]}\`)`)
  }
  if (headers === 0 && diff.trim() !== '') throw new Error('e2e rule: the diff has no `diff --git a/… b/…` header; refusing rather than reading it as empty')
  return [...reasons.values()]
}

/** The summary line e2e:all prints last, pasted in the pull request body: every script passed. A table with failures
 * needs a waiver that says why (a script that already fails on main). */
export function e2eTable(body: string): { passed: number; total: number } | undefined {
  const m = /^\s*(\d+)\/(\d+) passed\s*$/m.exec(body)
  return m ? { passed: Number(m[1]), total: Number(m[2]) } : undefined
}
export const allPassed = (t: { passed: number; total: number } | undefined): boolean => !!t && t.total > 0 && t.passed === t.total

/** MAMORU_E2E_WAIVED="<pr>: <why>" waives the rule for that pull request only, never for every merge in the shell. */
export function waiverFor(pr: string, env: string | undefined): string | undefined {
  const m = /^\s*#?(\d+)\s*:\s*(\S.*)$/.exec(env ?? '')
  return m && m[1] === pr ? m[2]!.trim() : undefined
}
