// Pure parts of `review:pr`: which Codex model reviews, how its verdict is read, what it is asked.

export const CODEX_MODELS = ['gpt-6-sol', 'gpt-6-astra'] as const
export type CodexModel = (typeof CODEX_MODELS)[number]

/** Below this share of the Codex seat left, a review is not started: it would starve the next one. */
export const MIN_REMAINING = 15

/**
 * The model for the next review. Asked for by name, it is used as is. On `auto` the two models alternate, so neither
 * carries every review (Ot, 17 Oct: vary by what is left); a seat with less than MIN_REMAINING left refuses.
 */
export function pickModel(asked: string, last: string | null, remaining: number | null): { model: CodexModel } | { error: string } {
  if (remaining !== null && remaining < MIN_REMAINING) {
    return { error: `the Codex seat has ${remaining}% left (under ${MIN_REMAINING}%): wait for its reset, or review on another seat by hand` }
  }
  if (asked !== 'auto') {
    return (CODEX_MODELS as readonly string[]).includes(asked) ? { model: asked as CodexModel } : { error: `unknown model ${asked}: ${CODEX_MODELS.join(' | ')} | auto` }
  }
  return { model: last === 'gpt-6-sol' ? 'gpt-6-astra' : 'gpt-6-sol' }
}

/** The last `VERDICT: APTO|NO-GO` line of the reviewer's answer, or null when it gave none. */
export function parseVerdict(text: string): 'APTO' | 'NO-GO' | null {
  const all = [...text.matchAll(/VERDICT:\s*(APTO|NO-GO)\b/g)]
  return (all.at(-1)?.[1] as 'APTO' | 'NO-GO' | undefined) ?? null
}

/** The reviewer's final message: what Codex prints after its last `codex` header, without the token count. */
export function finalMessage(out: string): string {
  const i = out.lastIndexOf('\ncodex\n')
  const tail = i >= 0 ? out.slice(i + '\ncodex\n'.length) : out
  return tail.replace(/\ntokens used\n[\d,]+\n[\s\S]*$/, '').trim()
}

export function reviewPrompt(p: { number: number; title: string; body: string; diff: string; focus: string; previous: string[] }): string {
  return [
    `Review pull request ottodevs/mamoru#${p.number}: "${p.title}". Read-only: you may read any file of the checkout you are in (the PR head), never modify one.`,
    'Mamoru is a non-custodial savings account on Base with real funds: Safe smart accounts, a passkey owner, a session key the engine uses within on-chain grants. Correctness and fund safety come first.',
    'Review exactly the diff below: it is the pull request against its base, from GitHub, so it holds this PR and nothing else.',
    p.focus ? `Focus: ${p.focus}` : '',
    p.previous.length ? `Earlier review passes on this PR said (check whether they are resolved):\n${p.previous.map((x) => `- ${x}`).join('\n')}` : '',
    'End with your findings ranked by severity (each with file:line and a concrete failure), then one line: VERDICT: APTO or VERDICT: NO-GO.',
    '',
    `PR description:\n${p.body}`,
    '',
    `Diff:\n${p.diff}`,
  ]
    .filter((l) => l !== '')
    .join('\n\n')
}
