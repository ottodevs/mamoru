# Mamoru demo video: script and shot list

Target length 3:40. ETHGlobal limits (see `requirements.md` §2.5): 2 to 4 minutes, .mp4 or .mov, at least 720p, a human voice, no music, no text-to-speech or AI voiceover, not recorded on a phone, never sped up. Cutting out waiting is allowed; speeding up is not. Record the screen at 1920x1080, browser zoom 110 to 125 percent so chips are readable.

Voiceover: Ot or Brais, recorded live or in one pass over the edit. Lines are written to be read at a normal pace (about 150 words per minute). Timings include short pauses.

## 1. Before recording

- [ ] Latest deploy of app.mamoru.lol is live [PENDING L0 deploy], and the dashboard shows Base pool data with chips [PENDING L2/L3/L4].
- [ ] A fresh browser profile (Chrome or Helium) with a platform passkey available (Touch ID or a security key). No other tabs, no bookmarks bar, no extensions with badges.
- [ ] Hide anything secret: no `.env` on screen, no RPC URL, no MultiBaas deployment URL or key. If the MultiBaas console is shown, crop the address bar and never open the API keys page.
- [ ] Terminal: large font (18 pt or more), dark theme, prompt shortened to `mamoru $`. `RPC_URL` already exported from `.env` before recording (never typed on screen).
- [ ] Pre-warm the fork once (`bun run scenarios run --only M05`) so the first recorded run does not wait on downloads.
- [ ] Editor open on `packages/uniswap-v3/src/index.ts` at line 24 and on `README.md` at "How MultiBaas was used".

## 2. Script

| # | Time | On screen (exact steps) | Voiceover |
|---|---|---|---|
| 1 | 0:00-0:15 | https://mamoru.lol landing, then click "Open app". [PENDING L0: on 26 Sep 20:22 CEST the landing hero reads "APY. DELIVERED." and has no "Open app" link. Either the landing is updated, or the video starts at https://app.mamoru.lol and never shows the landing hero.] On app.mamoru.lol, the home page: simulation banner at the top, "BASE · SIMULATION MODE", and the three blocks OWN, WATCH, LEAVE. | "This is Mamoru, a non-custodial savings account on Base. You own it with a passkey, you can always leave without us, and in this version it runs in simulation mode: it plans and simulates, and it never signs or sends." |
| 2 | 0:15-0:22 | Point at the banner "Simulation mode. Mamoru plans and simulates. It does not sign or send transactions. Deposits are closed." Click "CREATE ACCOUNT". | "The banner says so on every page. Deposits are closed." |
| 3 | 0:22-0:45 | /onboarding, "Four steps." Step 1 "CREATE YOUR OWNER PASSKEY": click "CREATE PASSKEY". The browser passkey prompt appears. Confirm with Touch ID. | "Step one creates a passkey on this device. It is not a login: it is the owner of a Safe smart account. Mamoru never sees its private key." |
| 4 | 0:45-1:00 | Step 2 "YOUR ACCOUNT ON BASE": the counterfactual Safe address appears. Point at it. | "This is the account's address on Base. It is counterfactual: it is computed from the setup and does not exist on chain yet. Nothing has been deployed or paid for." |
| 5 | 1:00-1:32 | Step 3 "SAVE YOUR RECOVERY KIT": click "DOWNLOAD RECOVERY KIT", open the JSON briefly (address, owners, factory, salt, modules). Click "OPEN THE GUIDE" (docs/walkaway.md on GitHub), scroll once, come back. Click "CONFIRM I SAVED THE KIT". Step 4: read the line "Mamoru holds no session on your account." Click "OPEN DASHBOARD". | "Before anything else you save a recovery kit. It holds every public parameter needed to deploy this exact Safe and take the funds out without Mamoru, and this guide shows how. We test that on a fork, as you will see. Step four shows the only preset: one Uniswap V3 pool on Base, USDC and cbBTC. Today Mamoru holds no session on the account." |
| 6 | 1:32-1:55 | Dashboard. Point, in this order: simulation banner; header with chain "Base"; Pools in your plan with the USDC/cbBTC 0.05% pool, price, tick and liquidity; hover a provenance chip ("Base · block N" or "MultiBaas · Base · checked at block N"); Current Action panel with "what Mamoru would do and why"; Actions panel. [PENDING L2/L3/L4 exact panels live] | "The dashboard shows Base only, and every figure carries its chain and its source. This chip says the pool state was read from Base at this block. Rows from our MultiBaas index are checked against Base RPC before they are shown. [PENDING L4: say only if reconciled.] Current Action says what Mamoru would do next and why. In this version that is a plan, not a transaction." |
| 7 | 1:55-2:05 | Cut to terminal. Show `cat scenarios/manifest.json \| head -15` (fork block 51811000, chain id 31337). | "Now the proof. The full cycle runs on a local fork of Base pinned at block 51811000, chain id 31337. The fork is our test bench, not capital." |
| 8 | 2:05-2:35 | Run `bun run scenarios run --only SESS-01,SESS-04,SESS-09,SESS-11,SESS-19`. Cut the wait. Show the pass lines and the reason codes. | "T001 treats the session key as leaked. The attacker tries to swap to itself, transfer tokens out, touch a position it does not manage, reuse a revoked session and sign for Base. Every attempt is rejected by the chain, each with its reason code. The full catalog has 24 of these attacks and they all fail." |
| 9 | 2:35-2:55 | Run `bun run scenarios run --only WALK-01,WALK-02,WALK-04`. Cut the wait. Show 3/3 pass. | "T002 is the walkaway. With our engine, our app and the indexer all off, the owner, here signing with a passkey, revokes the sessions, closes the position and withdraws. WALK-04 deploys the Safe from the recovery kit at the same address." |
| 10 | 2:55-3:15 | [PENDING L1] Run `bun run scenarios run --only M01,M02,M03,M04,DEP-01`. Show pass lines. If L1 is not green at freeze, drop this shot and move 30 seconds to shot 6. | "T003 is the harvest on the fork: the session collects fees from the Uniswap position, quotes with QuoterV2 and swaps to USDC through SwapRouter02, inside its policy." |
| 11 | 3:15-3:30 | Editor: `packages/uniswap-v3/src/index.ts` line 24 (`exactInputSingle`), then line 54 (`mint`). | "Every Uniswap call is built here: swaps always pay the account and always have a positive minimum; mints use ticks on the pool spacing. The session can call nothing else." |
| 12 | 3:30-3:40 | README, section "How MultiBaas was used", then the linked contracts table in `evidence/multibaas/mb-01-deployment.md`. | "MultiBaas indexes the pool, the position manager and the EntryPoint on Base for the dashboard, read-only, from our server. Links to everything are in the README. Thanks." |

Total spoken words: about 520. If the edit runs long, shorten shot 6 last; never speed up.

## 3. Things not to say or show

- No yield, APY, returns, users, deposits or TVL.
- Do not say Mamoru sends transactions on Base, or that MultiBaas signs, sends, relays or indexes the fork.
- Do not present the fork runs as live production.
- Do not show chains other than Base.
- No music, no AI voice.

## 4. Screenshot shot list (form needs at least 3, up to 6)

Take them from the same session, 1920x1080, PNG:

1. Landing hero at https://mamoru.lol.
2. Onboarding passkey step with the browser prompt.
3. Recovery kit step with the counterfactual Safe address.
4. Dashboard top: simulation banner, header, Current Action.
5. Pools in your plan with provenance chips visible.
6. Terminal: `bun run scenarios run` summary line with 36/36 pass (or the latest full run).
