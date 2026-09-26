---
name: mamoru-sdd
description: Spec-driven method for Mamoru. Use when writing or revising the Mamoru spec pack. Stops before implementation.
---

# Mamoru spec method

Canonical loop, as shipped by GitHub Spec Kit (v1, docs current September 2026):

constitution → specify → plan → tasks → implement → converge

Mamoru runs the first four and stops. Implement is another session. Do not scaffold app code to "finish" the spec.

## Why this shape

- Spec Kit is the portable, agent-neutral reference. Artifacts are markdown in the repo. Cursor, Codex, and Grok can all read them.
- AWS Kiro is an IDE with EARS requirements. It is not the repo of record.
- OpenSpec fits brownfield deltas. Mamoru's app repo is still a teaser README, so the first pack is a full spec, not a delta.
- Tessl treats the spec as a source that regenerates code. That fights the rule that public commits stay short and reviewed.
- Spec Kit does not verify anything by itself. Mamoru adds the scenario catalog. A task is not done, later, until its scenario passes. The scenario is written now. The test code is not.

## Files

- `.specify/memory/constitution.md` — principles that specs, plans, and tasks must obey.
- `specs/001-mamoru-v1/spec.md` — what the system does. User journeys, requirements, entities, acceptance, edge cases. Given / When / Then.
- `specs/001-mamoru-v1/plan.md` — how, at implementation depth. Modules, sequences, state machines, data, failure, providers.
- `specs/001-mamoru-v1/tasks.md` — ordered work for the next session. Each task names the files it will create, the scenario that accepts it, and what it must not do.
- `specs/001-mamoru-v1/scenarios.md` — fork and dry-run scenarios. Reason codes and states. No Packaging thresholds.
- `specs/001-mamoru-v1/threats.md` — session-key abuse, walkaway, isolation, reorg, webhook spoof.
- `specs/001-mamoru-v1/dashboard.md` — panel and MultiBaas read model for the dashboard prize.

## Quality bar

Every requirement has an id. Every task cites requirement ids. Every scenario cites requirement ids. Unresolved product choices are written as `NEEDS CLARIFICATION` only when the constitution does not already decide them. Do not reopen a closed decision by marking it unclear.

No application source. No Solidity. No wrangler deploy. No secrets.
