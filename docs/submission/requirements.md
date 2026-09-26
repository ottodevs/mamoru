# ETHGlobal Tokyo 2026: submission requirements and where Mamoru stands

Read on 2026-09-26 between 20:10 and 20:20 CEST from the team's logged-in ETHGlobal session (event page, hacker dashboard, project form tabs, rules page, prize pages) and from https://developers.uniswap.org/hackathon-feedback. Nothing was submitted or saved. The form was only read.

Status legend: OK (meets it now), FIX (exists but wrong or stale, L0 must edit before the deadline), MISSING (not there yet), RISK (a rule we may not meet; Brais and Otto decide).

## 1. Deadline and judging

| Item | Source | Value | Status |
|---|---|---|---|
| Submission deadline | Rules page, schedule | Sunday 27 Sep 2026, 09:00 JST = **02:00 CEST**. Late submissions not accepted. Dashboard countdown agreed (5 h 50 min at 20:10 CEST) | OK, matches the sprint plan |
| Edits after submit | Final tab | "You can submit and then still make edits until the submission deadline" | OK |
| Current state | Dashboard | "Congratulations on submitting your project". The project is already submitted; every field below can still be edited until 02:00 CEST | OK |
| Hacking start | Schedule, Fri 25 Sep | 21:00 JST = 14:00 CEST | See §6 |
| Submission type | Select prizes tab | **Partner Prizes only** is selected. Dashboard confirms "Partner Judging only track": partners judge from materials (details, code, screenshots, video); pitching is optional | OK, but it means the written fields, README, screenshots and video are everything the judges see |
| Partner judging | Schedule | Sun 27 Sep 09:30 to 12:30 JST (02:30 to 05:30 CEST), 5F partner booths, optional | OK |
| Finalist judging | Rules | 4 min demo plus 3 min Q&A; only for "Top 10 Finalist" submission type | Not applicable |

## 2. Project form, field by field

The form has seven tabs: Project details, Images, Tech stack, Select prizes, Video, Future, Final. Draft text for every field is in `submission.md`.

### 2.1 Project details

| Field | Rule | Current value | Status |
|---|---|---|---|
| Project name | required | "Mamoru" | OK |
| Category | required | DeFi | OK |
| Emoji | required | set (a wheat sheaf) | OK |
| Demo link | required | https://mamoru.lol | FIX: point to https://app.mamoru.lol (live since main `b27f1af`). The landing hero reads "APY. DELIVERED." and "The yield gets set aside.", both outside the claims policy (dashboard.md §12.3); it also has no link to the app. The landing repo is outside this lane |
| Short description | required, max 100 characters | "Non-custodial savings on Base. The principal keeps working. The yield gets set aside." (84) | FIX: talks about yield; v1 is simulation mode. New text in `submission.md` |
| Description | required, min 280 characters | Says "continuously harvests yield", "private allowlist until 09:00 JST", "Checks run on an Anvil fork" | FIX: overclaims harvesting on Base, stale allowlist line. Replace with `submission.md` §3 |
| How it's made | required, min 280 characters | Points at branch `spec/mamoru-v1` | FIX: that branch no longer exists on GitHub (only `main` and `lane/*`). Replace with `submission.md` §4 |
| GitHub repositories | required, public | `ottodevs/mamoru` (Primary, Monorepo) and `ottodevs/mamoru-landing` (Frontend). Both public | OK |

### 2.2 Images

| Field | Rule | Current | Status |
|---|---|---|---|
| Logo | required, square, e.g. 512x512 | uploaded (id 274458) | OK |
| Cover image | required, 16:9, e.g. 640x360 | uploaded (id 274459) | OK |
| Screenshots | required, **minimum 3**, up to 6 | **none uploaded** (all six slots empty) | MISSING: upload the five in §2.2.1 |

#### 2.2.1 Screenshots to upload

From the L2 shots folder (scratchpad `shots/`). Upload these, in this order. Use only `live-*` and `flow/*` files: they are the deployed app on Base. Never upload `fixture-*` files. They show test fixture data, and presenting them as the product would break the rule against placeholders shown as real data.

| Order | File | What it shows |
|---|---|---|
| 1 | `flow/desktop-1-home.png` | Home: simulation banner, OWN, WATCH, LEAVE |
| 2 | `flow/desktop-3-onboarding-account.png` | Passkey done, counterfactual Safe address on Base 8453, recovery kit step |
| 3 | `live-desktop-positions.png` | Uniswap V3 USDC/cbBTC 0.05% pool on Base: price, tick, TWAP within the guard, liquidity, balances, each with a "Base · block N" chip |
| 4 | `live-desktop-dashboard-top.png` | Dashboard header: chain Base 8453, Conservador preset, index "MultiBaas · Base", Current Action "Deposits are closed" |
| 5 | `flow/desktop-4-onboarding-done.png` | Onboarding complete (optional) |

Note: in `live-desktop-positions.png`, taken at 18:36 UTC, the 24-hour swap and liquidity rows read "Not observed". The engine now reads a swap window, so a retake after the next sync would show swaps with MultiBaas chips. Retake it only if time allows; the current shot is honest as it stands.

### 2.3 Tech stack

| Question | Required | Current | Status |
|---|---|---|---|
| Ethereum developer tools | yes | Foundry | FIX: add viem if listed; Foundry (anvil) is correct |
| Blockchain networks | yes | Base | OK. Do not add others (dashboard.md §12.3) |
| Programming languages | yes | TypeScript | OK (add SQL if D1 migrations count) |
| Web frameworks | yes | None | FIX: React, Vite, Hono, Tailwind CSS, TanStack (`submission.md` §5) |
| Databases | yes | None | FIX: Cloudflare D1 |
| Design tools | yes | None | Brais and Otto decide |
| Other technologies | optional | Cloudflare Workers, Astro, Anvil, viem | FIX: add Safe, ERC-4337 EntryPoint v0.7, Rhinestone Smart Sessions (ERC-7579), WebAuthn passkeys, Uniswap v3, Curvegrid MultiBaas, Bun |
| How AI tools were used | optional but see §5 | Present: names Cursor, Codex, Grok and the spec pack | FIX: add Claude Code (implementer pool per AGENTS.md) and keep the spec pack pointer. Draft in `submission.md` §6 |

### 2.4 Select prizes

| Item | Rule | Current | Status |
|---|---|---|---|
| Track | "Building from Scratch" or "Continuity Track"; eligibility only for the chosen track's prizes | **Building from Scratch** | RISK, see §6 |
| Partners | max 3 partners; one partner covers all its tracks | Uniswap Foundation, Curvegrid | OK |
| Per prize: "How are you using this Protocol / API?" | required | Uniswap and Curvegrid texts present | FIX: both cite branch `spec/mamoru-v1` or an old landing mockup. Replace with `submission.md` §7 and §8 |
| Per prize: proof link | present in the form | Uniswap: `.../blob/spec/mamoru-v1/packages/uniswap-v3/src/index.ts#L24` returns **404**. Curvegrid: `mamoru-landing/.../dashboard.astro#L112` (200, but it is the landing mockup, not the product) | FIX: Uniswap -> `https://github.com/ottodevs/mamoru/blob/main/packages/uniswap-v3/src/index.ts#L24`; Curvegrid -> README "How MultiBaas was used" anchor on main |
| Per prize: ease rating 1-10 | form | Uniswap 8, Curvegrid 7 | Brais and Otto decide |
| Per prize: notes | form | Uniswap notes point to FEEDBACK.md on `spec/mamoru-v1` | FIX: point to `main` |
| Other partner tech used | optional | empty | Leave empty |

### 2.5 Video

| Rule | Value | Status |
|---|---|---|
| Optional but "highly recommended"; partners use it for judging | - | MISSING |
| Length | **between 2 and 4 minutes**; upload fails outside that range | Script in `video-script.md` targets 3:40 |
| Format | .mp4 or .mov, minimum 720p | - |
| Audio | must have audio, **no music**, **no text-to-speech or AI voiceover**, no phone recording | A team member must record the voiceover |
| Speed | must not be sped up (manually verified, disqualifies); waiting may be cut | Cut waits, never speed up |
| Intro | under 20 seconds of backstory; slides max 4 bullets | Script follows this |

### 2.6 Future

Optional multiselect: "Interested in grant programs", "Interested in accelerator / incubator programs". Brais and Otto decide.

### 2.7 Final

| Item | Status |
|---|---|
| Team: Brais and Otto | OK. README "Team handles" lists X @entermamoru, mamoru.lol and GitHub ottodevs |
| Checkbox `confirmRules` (already ticked): "built entirely during this hackathon and no work was completed before the event", "starting this project from scratch", "not submitting to another hackathon" | RISK, see §6 |

## 3. Uniswap Foundation prize ("Best Uniswap Stack Contribution")

| Requirement | Status |
|---|---|
| Classic track pool: $6,000 (3,000 / 2,000 / 1,000). A separate $4,000 pool exists only for Continuity Track | We are in the classic pool |
| Public GitHub repository with open-source code | OK: public, MIT license |
| `FEEDBACK.md` in the repo | OK after this lane lands: rewritten for `main` |
| Completed Uniswap Developer Feedback Form that **includes the link to FEEDBACK.md** | MISSING: L0 submits. The form has no dedicated link field; put the link in "What did you build?" and in "Any additional feedback?". Answers in `uniswap-feedback-form.md` |
| README clearly points to the relevant contracts and lines of code | OK after this lane lands: README "Uniswap v3 integration" table with line links on `main` |

## 4. Curvegrid prize

Selecting Curvegrid makes us eligible for all three $1,000 tracks: Best RWA Tokenization, **Best Digital Asset Dashboard** (our target), Best AI Agent Project. MultiBaas is not required. Judging: idea and technical execution.

| Requirement | Status |
|---|---|
| GitHub repo with project artifacts (contracts, tests, documentation) | OK: tests, fork scenarios, spec pack |
| README with 1) one-sentence summary 2) how MultiBaas was used (optional) 3) team intro and social handles 4) setup and testing instructions 5) experience with MultiBaas | OK: five sections in the dashboard.md §12.1 order, each claim linked to evidence |
| Dashboard "helps users understand their digital assets, identify actions, make better operational decisions" | OK: live at https://app.mamoru.lol, with the Base pool read every 2 minutes and every figure chipped with its chain and source |

## 5. Rules that apply to every project

| Rule | Status |
|---|---|
| Open source, repo public and stays public | OK: public, MIT `LICENSE` on main |
| Version control, commit frequently, no large single commits | OK: root commit `c12207d` on 25 Sep 14:03 CEST, then small conventional commits on main and on the lane branches |
| AI attribution: document where and how AI tools were used, which parts | OK: `docs/process/ai-attribution.md`, the README line, and `submission.md` §6 for the form field |
| Spec-driven development: include all spec files, prompts and planning artifacts in the repo | OK for `specs/001-mamoru-v1/`, `.specify/`, `inputs/`. RISK: the lane briefs used tonight (the prompts to the agents) are not in the repo. `docs/process/ai-attribution.md` describes them, but the texts themselves are missing |
| Clearly distinguish what is new and what is reused | OK: README lists the third-party code used as published |

## 6. Track

Decision: Building from Scratch. Hacking began Fri 25 Sep 21:00 JST (14:00 CEST). Both repos, `ottodevs/mamoru` and `ottodevs/mamoru-landing`, were created after that.

## 7. Uniswap Developer Feedback Form (https://developers.uniswap.org/hackathon-feedback)

Fields: first name*, last name, email*, Telegram handle*, which hackathon*, completed a project* (Yes/No/Partially), what did you build*, AI-powered or agentic* (5 options), integrated Uniswap successfully* (Yes/No/Partially), time to first integration* (<1h, 1-4h, 4-8h, 8+h, didn't get there), biggest blocker, hardest part of an agentic app on Uniswap, docs helpfulness 1-5*, support rating 1-5*, plan to continue* (Yes/No/Maybe), support used* (office hours, mentorship, docs, Discord, code examples, other), missing support, additional feedback, follow-up consent, Terms and Privacy checkbox*. Answers: `uniswap-feedback-form.md`. L0 submits.

## 8. At-risk list for L0 (in order of cost if missed)

1. Screenshots: the form needs at least 3 and none are uploaded. Use §2.2.1.
2. Form texts still point to the deleted branch `spec/mamoru-v1` (the Uniswap proof link returns 404) and still claim yield. Paste `submission.md` §1 to §8.
3. Uniswap feedback form: not submitted. It must contain the FEEDBACK.md link (`uniswap-feedback-form.md`).
4. Video: none yet. It must be 2 to 4 minutes, at least 720p, a human voice, no music, not sped up (`video-script.md`).
5. The landing https://mamoru.lol claims APY in its hero and is linked from the form as the second repo. Partners read it.
6. "How it's made" draft is about 3,300 characters. The form states only a minimum; if it refuses the text, cut the Verification paragraph first.
