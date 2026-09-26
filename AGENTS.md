# Mamoru app

Public product repo. GitHub `ottodevs/mamoru` is the only push remote. Forgejo is fetch-only.

The closed architecture is `inputs/mamoru-spec-v1.md`. Do not reopen it. Work on `main`. Do not open a feature branch.

## Now

T001 is on `main` at `82774c7`. Do not start the next task until Ot says so. The next task, when it starts, is T002 only, from `specs/001-mamoru-v1/tasks.md`. Do not skip ahead. Do not deploy. Do not push Forgejo.

## One unit

The next task stays off `main` until its review passes. One task, then stop.

1. Implement only that task from `tasks.md`. Cursor, model `claude-opus-5-5-high`. Only the files the task names.
2. One short commit on a branch that exists for that task alone. Push it to GitHub. Do not start the next task on that branch.
3. Codex `gpt-6-astra` at medium reviews that commit. Verdict is APTO or NO-GO. It does not rewrite the commit.
4. NO-GO: one fix commit on the same branch, then review again. APTO: fast-forward `main` and delete the branch.
5. Only then take the next task.

Do not stack a phase of unreviewed commits. Do not open a pull request. Do not squash. Forgejo stays fetch-only.

## Read before writing a spec

1. `inputs/mamoru-spec-v1.md`
2. `inputs/SKILLS.md`
3. `.agents/skills/mamoru-sdd/SKILL.md`
4. The skill files that `inputs/SKILLS.md` names for the piece you are specifying.

## Verify

A spec change is done when `specs/` and `.specify/memory/constitution.md` exist, tasks do not say "implement now", and `git status` shows no `src/` or `package.json` created by the spec pass.

An implementation unit is done when its commit is on `main` and the accepting scenarios for that task pass.
