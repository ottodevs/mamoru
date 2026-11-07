# How Mamoru was built, and where AI was used

ETHGlobal asks for attribution of AI tools and for the planning artifacts behind a spec-driven build. This is that record.

## ETHGlobal Mumbai 2026 (5–7 Nov)

**Who decided.** Brais and Otto set the scope, approved the PRD, the copy and every mockup, and tested each piece on beta before production. No change reached `main` or production without a human deciding it.

**How we worked.**
1. **PRD** written from the team's decisions in our Mattermost, reviewed by Brais and Otto in rounds ([summary](../ethglobal-mumbai/prd.md)).
2. **Specs** with GitHub Spec Kit, one folder per piece: [`specs/011-mumbai-cap`](../../specs/011-mumbai-cap/), [`specs/012-mumbai-harvest`](../../specs/012-mumbai-harvest/), [`specs/013-mumbai-stats`](../../specs/013-mumbai-stats/). Spec, plan, tasks and scenarios, drafted with AI and reviewed by models from other vendors before any code.
3. **Implementation** by agents in isolated git worktrees, one task per branch and pull request, small commits, stacked when two tasks touch the same file. One coordinator session holds a lease and is the only one that merges, applies migrations and deploys.
4. **Cross-vendor review.** Every pull request is reviewed by a model from a different vendor than the one that wrote it; funds-touching code gets two independent reviewers. Verdicts are posted on the pull request.
5. **Acceptance** only from real runs: fork scenarios, beta, then production. The agents work from a terminal; the team follows and steers from Mattermost.

**Tools.** Claude Code (Claude Opus 5.5) for specs and implementation; Codex (GPT-6 Sol, GPT-6 Astra), Gemini 4 Argon and Gemini Flash for review. Specs went through up to 8 review rounds before any code. When one reviewer had no quota, the gate was two reviewers from different vendors that both had to approve. Keys, hosts and the session signer are outside the agents' reach.

**What AI wrote in Mumbai.** Most code in the event range, the spec drafts and the first drafts of these docs. Specs, prompts and plans are in the folders above.

## ETHGlobal Tokyo 2026 (25–27 Sep), for the record

### Who decided what

Brais and Otto decided the product, the design, the scope and every merge into `main`. No change reached `main` without a human deciding it should.

### How the work was organized

1. **Spec first.** The closed product spec ([`inputs/mamoru-spec-v1.md`](../../inputs/mamoru-spec-v1.md)) was turned into a spec pack with GitHub Spec Kit: the constitution ([`.specify/memory/constitution.md`](../../.specify/memory/constitution.md)), the spec, the plan, the dashboard spec, the scenario catalog, the threat model and the task list, all in [`specs/001-mamoru-v1/`](../../specs/001-mamoru-v1/). The spec pack was drafted with AI and reviewed by the team. Every task names its requirements, the files it may touch, and the scenarios that accept it.
2. **Scenarios as acceptance.** A task counts as done only when its scenarios pass on a Base fork pinned at block 51811000 ([`scenarios/catalog/`](../../scenarios/catalog/), evidence in [`evidence/scenarios/`](../../evidence/scenarios/)).
3. **Parallel implementation lanes.** During the event the work was split into lanes (engine lab, web app, app API and onboarding, Base read model, submission docs), each on its own branch and allowed to write only its own paths (the lane table is in [`AGENTS.md`](../../AGENTS.md)). Shared contracts between lanes are typed in `packages/domain`. Lanes were merged into `main` at fixed checkpoints, only after typecheck and tests passed.
4. **Independent review.** Lane commits were reviewed by a second model from a different vendor (Codex) than the one that wrote them, with a written verdict (accept or reject) before the merge.

### Tools

| Tool | Model | Used for |
|---|---|---|
| Cursor Agent | Claude Opus 5.5 | Implementation in lanes |
| Claude Code | Claude Opus 5.5 | Implementation in lanes, the spec pack, the submission docs |
| Codex | GPT-6 Astra | Review of lane commits |

### What AI wrote

Most of the code in `packages/`, `apps/` and `scenarios/`, the spec pack drafts, and the first drafts of the README and these docs. Brais and Otto set the direction and the product spec, decided the design, and accepted or rejected the results.

### What AI did not decide

- Scenario results: every pass or fail comes from a real run on the fork, recorded with its run id.
- Claims in the README and the submission: each links to evidence in this repo, and the allowed and forbidden claims are fixed in [`specs/001-mamoru-v1/dashboard.md`](../../specs/001-mamoru-v1/dashboard.md) §12.
