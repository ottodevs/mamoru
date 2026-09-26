# Mamoru app

Public product repo. GitHub `ottodevs/mamoru` is the only push remote. Forgejo is fetch-only.

This checkout is in spec phase. The closed architecture is `inputs/mamoru-spec-v1.md`. Do not reopen it.

## Now

The spec pack in `specs/001-mamoru-v1/` is closed. Codex marked it APTO on 2026-09-26. The next implementation commit is T001 only, from `specs/001-mamoru-v1/tasks.md`. Do not skip ahead. Do not deploy. Do not push Forgejo. Publishing to GitHub is Ot's call per the task rules.

## Read before writing a spec

1. `inputs/mamoru-spec-v1.md`
2. `inputs/SKILLS.md`
3. `.agents/skills/mamoru-sdd/SKILL.md`
4. The skill files that `inputs/SKILLS.md` names for the piece you are specifying.

## Verify

A spec change is done when `specs/` and `.specify/memory/constitution.md` exist, tasks do not say "implement now", and `git status` shows no `src/` or `package.json` created by the spec pass.
