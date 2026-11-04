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
const LINES = /finalized|operatorSignature|x-mamoru-|policyId/
const isTest = (path: string) => /(^|\/)test\/|\.test\.ts$/.test(path)
const shipped = (path: string) => /^(apps|packages)\//.test(path) && !isTest(path)

/** Why a unified diff needs the e2e table: one reason per file, empty when it does not. */
export function e2eReasons(diff: string): string[] {
  const reasons = new Map<string, string>()
  let file = ''
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line)
    if (header) {
      file = header[2]!
      if (!isTest(file) && FILES.some((re) => re.test(file))) reasons.set(file, `${file} (operator auth, routes or policy ids)`)
      continue
    }
    if (!shipped(file) || reasons.has(file) || line.startsWith('+++') || line.startsWith('---')) continue
    const m = /^[+-](.*)$/.exec(line)
    const hit = m ? LINES.exec(m[1]!) : null
    if (hit) reasons.set(file, `${file} (changes a line with \`${hit[0]}\`)`)
  }
  return [...reasons.values()]
}

/** The summary line e2e:all prints last, pasted in the pull request body. */
export const hasE2eTable = (body: string): boolean => /^\s*\d+\/\d+ passed\s*$/m.test(body)
