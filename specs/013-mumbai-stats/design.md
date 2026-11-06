# 013 design: Phase D, before any UI is built

Spec: `spec.md` (STATS-R3..R17). No UI implementation task in `tasks.md` starts before the gate in §6 passes.

## 1. Research brief (D1)

Study established, validated patterns. Fables is a reference for content only, not for layout.

- **Navigation:** two-to-four item app navigation at desktop (top bar) and at 390 px (bottom tab bar vs top segmented
  control vs compact top bar). Criteria: thumb reach, one tap to Stats from the sign-up cards, no hamburger for two
  items.
- **Financial charts:** TVL line with range selector (DefiLlama, Uniswap Info, Morpho, Aave, Stripe dashboard,
  Robinhood/Revolut portfolio). Volume bars on the same time axis. Crosshair and tooltip conventions on touch.
- **Number formatting:** compact money (`$1.39K`, `$12.4K`), when to show cents, tabular figures, negative and zero.
- **Truth cues:** how products label partial days, gaps, "data starts here" markers and per-figure sources without
  clutter.

Output: `design/research.md` in this folder, ≤ 1 page, each pattern with a link and what we take or reject.

## 2. Skills (D2)

Use, in this order. Paths on lady:

| Skill | Use |
|---|---|
| `impeccable` | Shape, critique and polish passes; anti-patterns; motion and responsive checks |
| `design-taste-frontend` | Named in `inputs/SKILLS.md`; anti-template direction |
| `hallmark` | Audit of the mockups for AI-slop tells |
| `emil-design-eng` | Microinteractions and motion craft |
| `find-animation-opportunities` | Where motion helps, where it does not |
| `dataviz` | Chart form, axes, ticks, tooltip, color rules |
| `ux-copy` | Labels, (i) texts, empty and error states |
| `web-perf` | Bundle and interaction budget check of the built page |

## 3. Mamoru language (fixed, from `apps/mamoru-app/src/web/styles.css`)

- Colors: paper `#f4f0e6`, rice `#f8f5ef`, ink `#0f0f0e`, wash `#d9d2c3`, emerald `#2f5d50`, stone `#8a8578`, muted
  `#5e5a52`, alert `#9b2c2c`. Emerald is the data color; ink for axes text; wash for grid; alert only for errors.
- Type: Noto Serif for text and headline figures, IBM Plex Mono for axis ticks, dates and small figures (tabular).
- Surface: Kami A matte card (`otto/mamoru#198`). No new tokens without OK.

## 4. Chart rules (binding for D3 and U-tasks)

- **Axes:** y starts at 0 for TVL and volume (bars must). Ticks at 1-2-5 steps, compact units (`$0`, `$500`, `$1K`).
  At most 4 y ticks at 390 px, 5 at 1280. x ticks by range: 1W days (`Mon 2`), 1M weekly, 3M/ALL monthly (`Nov`).
  All dates UTC, said once in the chart caption.
- **Units:** USD, sign before number. Headline: full value to the dollar (`$1,386`); ≥ $10K compact with one decimal.
  Tooltip: whole dollars and the UTC date (`6 Nov 2026 · $1,386`).
- **Legend:** none when one series. "Base only" is a band or annotation on the x axis, not a second color.
- **Gaps:** a `null` point is a gap in the line and a missing bar, with a hatched marker that the tooltip explains
  ("Fewer than 3 accounts: not shown" / "Not counted"). Never interpolated.
- **Partial:** today's point and partial days are hollow markers with "so far" in the tooltip.
- **Tooltip:** follows pointer and touch; on touch it stays until the next tap; keyboard reachable (arrow keys
  move the crosshair); `aria-live` announces the value.
- **Range selector:** segmented control `1W 1M 3M ALL`, default 1M (ALL when history < 1M). Remembered per tab only.
- **Motion budget:** line draw ≤ 400 ms on first view only; range change cross-fades ≤ 200 ms; figures count up
  ≤ 600 ms once; nothing loops. `prefers-reduced-motion`: no motion. Only `transform`/`opacity`/`stroke-dashoffset`.
  No layout shift (reserved chart height). Stats route JS ≤ 30 KB gzipped beyond the shell.
- **Accessibility:** contrast ≥ 4.5:1 for text on paper; each chart has a text summary for screen readers.

## 5. Copy for OK (English)

| Figure | (i) text (proposal from the 6 Nov thread) |
|---|---|
| Total deposits | Total value in Mamoru accounts, vault deposits included. |
| Total volume | Capital Mamoru's engine placed or moved: new liquidity positions plus vault deposits. |
| Earned in the last 24h | Fees and yield Mamoru accounts earned in the last 24 hours. |
| Total earned | All fees and yield earned by Mamoru accounts since launch. |

| Funded accounts | Mamoru accounts holding more than $1 right now. (needs OK) |

"Earned in the last 24h" is a rolling 24 h (plan §3.2); the label stays as the PRD has it.

Other strings: "Start saving", "not counted", "Base only", "Fewer than 3 accounts: not shown", "so far", source
line ("From Mamoru's on-chain reads · data as of 18:20 UTC", with a stale flag past 1 h). All in the mockups for the same OK.

## 6. Deliverables and gate (D3, D4)

1. Mockups as static HTML in this folder (`design/stats-1280.html`, `design/stats-390.html`,
   `design/portfolio-1280.html`, `design/portfolio-390.html`) using the real tokens and **real figures** from D1
   (only D2's guarded export; Portfolio with round example figures, labeled), plus screenshots (`design/*.png`).
2. States shown: with and without session (menu), loading, a gap (< 3 owners), "not counted", partial today, error.
3. An `impeccable` critique pass and a `hallmark` audit, findings fixed, a short note of what changed.
4. Posted in Mattermost `#devcon-8` for Ot and Brais.
5. **Gate:** Ot's and Brais's explicit OK in that thread, linked from `tasks.md`. Only then U-tasks start. A change
   they ask for is applied to the mockup first.
