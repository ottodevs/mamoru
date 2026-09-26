# Mamoru app

Public product repo. GitHub `ottodevs/mamoru` is the only push remote. Forgejo is fetch-only.

The closed architecture is `inputs/mamoru-spec-v1.md`. Do not reopen it. Work on `main`. Do not open a feature branch.

## Now

T001 is on `main` at `82774c7`. Do not start the next task until Ot says so. The next task, when it starts, is T002 only, from `specs/001-mamoru-v1/tasks.md`. Do not skip ahead. Do not deploy. Do not push Forgejo.

## One unit

Implement one task. One short commit. Review that commit. Fix it or approve it. Fast-forward `main`. Only then start the next task. Do not stack a phase of unreviewed commits.

## Read before writing a spec

1. `inputs/mamoru-spec-v1.md`
2. `inputs/SKILLS.md`
3. `.agents/skills/mamoru-sdd/SKILL.md`
4. The skill files that `inputs/SKILLS.md` names for the piece you are specifying.

## Verify

A spec change is done when `specs/` and `.specify/memory/constitution.md` exist, tasks do not say "implement now", and `git status` shows no `src/` or `package.json` created by the spec pass.

An implementation unit is done when its commit is on `main` and the accepting scenarios for that task pass.
