# Stats and Portfolio mockups (spec 013, Phase D)

For Ot's and Brais's OK before any UI task starts (`../design.md` §6). Open the HTML over a local server from the repo
root (`python3 -m http.server 8737`, then `/specs/013-mumbai-stats/design/stats.html`); `#signed-in` shows the
signed-in menu, `#static` turns motion off. Screenshots: `shoot.sh` (1280 and 390 px).

| File | Shows |
|---|---|
| `stats-out-1280.png`, `stats-out-390.png` | `/stats` without a session: menu, "Start saving", figures, both charts (1280 with a tooltip open) |
| `stats-in-1280.png`, `stats-in-390.png` | `/stats` with a session: no call to action |
| `portfolio-1280.png`, `portfolio-390.png` | Portfolio: Total value chart, Earned so far card, Add capital and Withdraw on top (example figures) |
| `states-1280.png`, `states-390.png` | Loading, withheld (< 3 accounts), not counted, partial today, stale, error |

**Data.** Stats figures are real aggregates read from prod D1 on 6 Nov 2026 (prod + beta, Base; every day ≥ 12
owners, so all pass the 3-account guard): TVL $65 on 18 Oct to $3,874 so far today, 25 Oct has no reading, 9 funded
accounts, earned = fees only ($0.30 in 24 h, $1.44 total; vault yield arrives with spec 012). Volume has no source
until task B4, so its bars are **example data** and say so. Portfolio uses round example figures.

## Copy for OK (English)

| Where | Text |
|---|---|
| Stats title | Mamoru, in public |
| Stats line | Every Mamoru account added up, read from the chain. Aggregates only: no account or address is shown. |
| (i) Total deposits | Total value in Mamoru accounts, vault deposits included. |
| (i) Earned in the last 24h | Fees and yield Mamoru accounts earned in the last 24 hours. Approximate: vault yield is read from share value. |
| (i) Total earned | All fees and yield earned by Mamoru accounts since launch. |
| (i) Funded accounts | Mamoru accounts holding more than $1 right now. |
| (i) Total volume | Capital Mamoru's engine placed or moved: new liquidity positions plus vault deposits. |
| (i) Earned so far (Portfolio) | Fees from your liquidity positions plus your vault yield, since you started. |
| Source line | From Mamoru's on-chain reads · data as of 6 Nov 2026, 16:50 UTC |
| States | so far · Not counted · Fewer than 3 accounts: not shown · Base only · Monad not tracked yet · Stats are not available right now. · Try again |

## Decisions to look at

1. **Phone menu = bottom tab bar** (Portfolio, Stats), top text tabs at desktop. A sign-up visitor reaches Stats in one tap.
2. **Real figures are small today** ($1.44 total earned). They are what the chain says; the page will show more once vault yield (spec 012) is counted.
3. **The TVL line is linear from $0**, so the jump of the last days dominates ALL. That is the honest scale; 1W reads the recent days.

Motion: line draws once (≤ 400 ms), figures count up once (≤ 600 ms), range change cross-fades (≤ 200 ms), nothing loops, none under reduced motion. Charts are hand-written SVG, no library.
