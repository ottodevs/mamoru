You are one lane of a 5-lane parallel sprint on the Mamoru repo (GitHub ottodevs/mamoru). Hard deadline: ETHGlobal Tokyo submission 2026-09-27 02:00 CEST. Code freeze 00:15 CEST. The integrator (L0) merges and deploys at checkpoints 20:50, 21:35, 22:20, 23:05, 23:50 CEST; have something green pushed before each.

Read first, in order: AGENTS.md (the "Sprint mode" section overrides "One unit" and the deploy ban), inputs/mamoru-spec-v1.md, specs/001-mamoru-v1/README.md, and the spec sections named in your lane brief. The spec is closed: do not reopen architecture.

Rules:
- Your worktree is your cwd. Your branch is the one checked out (lane/<name>). Write ONLY inside the paths your lane owns (AGENTS.md table). If you need a change elsewhere (contract types in packages/domain, D1 schema, root package.json), stop and write the request in your final report instead of editing.
- Contracts: packages/domain/src/dashboard-payload.ts and packages/domain/src/app-api.ts. D1 schema: migrations/d1/0001_sprint.sql (D1 "mamoru", binding DB).
- Small conventional commits in English, short single-line comments. After each green step (bun run typecheck && bun test pass, previously accepted scenarios still green) run: git push origin HEAD:<your branch>. Never push main. Never force-push. No PRs.
- Never sign or send on Base (8453) or Base Sepolia. CORE_DRY_RUN stays true. Funds gate closed. No keys or keyed URLs in files, argv or logs. No wrangler.toml. Do not run wrangler deploy / secret put (L0 does).
- Quality bar is AAA: typed end to end, tests for what you build, no dead code, no placeholders presented as real data. If something is not observed, show it as not observed (Figure with null value and status not_observed), never a fake number.
- Before finishing, write a final report: what is done (commit SHAs), how to run it, what is missing, and any request to L0.
