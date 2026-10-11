# Contributing to Mamoru

Mamoru manages real funds. A change is small, reviewed by someone who did not write it, and watched on
beta before it reaches production.

1. **Open or take a ticket** and say you are on it.
2. **One branch, one concern.** Branch from `main` as `<type>/<ticket>-<slug>` (`feat`, `fix`, `docs`,
   `refactor`, `chore`). About 12 files at most.
3. **Check it locally:** `bun install --frozen-lockfile` and `bun run release:check` (typecheck, tests,
   build). Add tests that fail without your change.
4. **Open a pull request against `main`.** The template asks for what a reviewer and the release
   coordinator need: what was tested and what was not, the risk, and the deploy notes.
5. **Review.** CI must be green, and the change needs an independent review before it is merged with
   "Rebase and merge". You do not merge your own pull request.
6. **Release.** Merged is not released. [`docs/process/releasing.md`](docs/process/releasing.md) is the
   path from `main` to beta to production.

Commit subjects say what is now true, in the form `type(scope): sentence`, for example
`fix(operator): a head that does not have the grant yet is waited for`.

Never put a key, a secret or a URL that carries a token in code, a commit, a pull request or a log.
Report a security problem privately to the maintainers, not in a public issue.

Agents and maintainers working on this repository follow [`AGENTS.md`](AGENTS.md), which has the full
operating flow and the roles. How the project was built and where AI was used:
[`docs/process/ai-attribution.md`](docs/process/ai-attribution.md).
