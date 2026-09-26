# Mamoru demo video: script and shot list

Target length 3:20. ETHGlobal limits (see `requirements.md` §2.5): 2 to 4 minutes, .mp4 or .mov, at least 720p, a human voice, no music, no text-to-speech or AI voiceover, not recorded on a phone, never sped up. Cutting out waiting is allowed; speeding up is not. Record the screen at 1920x1080, browser zoom 110 to 125 percent so chips are readable.

Voiceover: Brais or Otto, recorded live or in one pass over the edit. Lines are written to be read at a normal pace (about 150 words per minute). Timings include short pauses.

## 1. Before recording

- [ ] app.mamoru.lol is on the latest deploy, the live operator is running (`GET /health` on it returns `live: true`), and the engine has synced in the last few minutes.
- [ ] A funding wallet holds 5 to 10 USDC on Base to send to the new account during the recording, plus a little ETH for its own gas.
- [ ] A fresh browser profile (Chrome or Helium) with a platform passkey available (Touch ID or a security key). No other tabs, no bookmarks bar, no extensions with badges.
- [ ] Hide anything secret: no `.env` on screen, no RPC URL, no `OPERATOR_SECRET`, no relayer key, no MultiBaas deployment URL or key. If the MultiBaas console is shown, crop the address bar and never open the API keys page.
- [ ] Terminal: large font (18 pt or more), dark theme, prompt shortened to `mamoru $`. `RPC_URL` already exported from `.env` before recording (never typed on screen).
- [ ] Pre-warm the fork once (`bun run scenarios run --only M05`) so the first recorded fork run does not wait on downloads.
- [ ] Know the real Basescan links for this run's activate, swap, mint, transfer and stop transactions, to caption or narrate in the edit (`TX_ACTIVATE`, `TX_SWAP`, `TX_MINT`, `TX_TRANSFER`, `TX_STOP`, filled in by L0 after the run).

## 2. Script

| # | Time | On screen (exact steps) | Voiceover |
|---|---|---|---|
| 1 | 0:00-0:10 | Start at https://mamoru.lol. Show the landing only if its hero no longer says "APY. DELIVERED." | "This is Mamoru, a non-custodial savings account on Base. You own it with a passkey, and you can always leave without us." |
| 2 | 0:10-0:20 | Click through to https://app.mamoru.lol. Home page: header, chain "Base", the three blocks OWN, WATCH, LEAVE. Click "CREATE ACCOUNT". | "Tonight this runs live on Base, up to a cap of 25 USDC per account. Let's open a new one." |
| 3 | 0:20-0:45 | /onboarding. Step 1 "CREATE YOUR OWNER PASSKEY": click "CREATE PASSKEY". The browser passkey prompt appears. Confirm with Touch ID. Step 2: the counterfactual Safe address on Base appears. | "This passkey becomes the owner of a Safe smart account on Base. Mamoru never sees its private key. The address is counterfactual: it exists on chain only once something is sent to it." |
| 4 | 0:45-1:00 | Step 3 "SAVE YOUR RECOVERY KIT": click "DOWNLOAD RECOVERY KIT", open the JSON briefly (address, owners, factory, salt, modules). Click "CONFIRM I SAVED THE KIT". Click "OPEN DASHBOARD". | "The kit holds everything needed to deploy this exact Safe and take funds out without Mamoru. We test that path on a fork, later in this video." |
| 5 | 1:00-1:20 | "Your money on Base" panel: point at the account address and the send instructions. Cut to a second wallet sending 5 to 10 USDC on Base to that address. Back on the dashboard, the USDC balance updates with its "Base · block N" chip. | "Now I send USDC on Base to the account, from any wallet. The balance and its block both come straight from Base." |
| 6 | 1:20-1:40 | Click "Start allocation". Review card appears: deploy, allocate the USDC into the USDC/cbBTC 0.05% pool, the engine key's limits, the 25 USDC cap. Click "Approve with passkey". Touch ID prompt, then "Signed and sent." | "Starting is one signature. My passkey approves deploying the Safe and letting the engine, through a scoped session key, allocate this deposit into Uniswap. It can never move funds anywhere but back to me." |
| 7 | 1:40-2:05 | Activity panel: the engine's swap and mint entries appear, each with a Basescan link. Point at the links. Positions panel: the open USDC/cbBTC position, in range, with its amounts. | "A relayer sends my signed transaction and pays for it. Once the session is active, the engine enters the pool itself: a swap, then a mint, both on Base, both linked here to Basescan. This is the open position." |
| 8 | 2:05-2:25 | "Transfer out" form: address, amount "2". Click "Review transfer". Review card: the Safe transaction summary. Click "Approve with passkey". Touch ID, then "Signed and sent." Activity shows the transfer entry with its Basescan link. | "I can take money out at any time. I ask for 2 USDC, my passkey signs it, and if the position needs to shrink first, Mamoru does that in the same transaction." |
| 9 | 2:25-2:40 | Click "Stop allocation". Review card: revoke the session, close and burn the position, swap cbBTC to USDC. Approve with passkey. Funding block updates: USDC balance up, cbBTC and the position gone. | "Stopping revokes the engine's session, closes the position and swaps everything back to USDC, which stays in my Safe." |
| 10 | 2:40-2:50 | Click "Start allocation" again on the same, still-funded account. Review card appears. | "And I can start again whenever I choose. Nothing about the account or its passkey changes between runs." |
| 11 | 2:50-3:20 | Cut to terminal. Run `bun run scenarios run --only SESS-01,SESS-09,SESS-19,WALK-01` (cut the wait), then `bun run scenarios demo` for the harvest line (cut the wait, never speed up). Show the pass lines. | "Everything above the 25 USDC cap, every attack on a leaked session key, the owner's recovery walkaway, and the harvest, we still only demonstrate on a Base fork pinned at block 51811000. The full catalog is 45 scenarios, and they all pass." |

Total spoken words: about 430. If the edit runs long, shorten shot 11 last; never speed up.

## 3. Things not to say or show

- No yield, APY, returns, or TVL. You may say what one account holds and moved, since that is real.
- Do not say the live path runs above 25 USDC per account, or that it runs on any chain but Base.
- Do not present the fork runs (attacks, walkaway, harvest) as happening on Base mainnet.
- Do not say MultiBaas signs, sends, relays or indexes the fork; it only reads Base.
- Do not show `OPERATOR_SECRET`, the relayer's key, or any `.env` value.
- No music, no AI voice.

## 4. Screenshot shot list (form needs at least 3, up to 6)

Take them from the same recorded session, 1920x1080, PNG:

1. Landing hero at https://mamoru.lol.
2. Onboarding passkey step with the browser prompt.
3. "Your money on Base" panel after the USDC deposit arrives.
4. Activity panel showing the engine's swap and mint entries with their Basescan links.
5. Positions panel with the open USDC/cbBTC 0.05% position.
6. Terminal: `bun run scenarios run` summary line with 45/45 pass.

For the form upload, use only shots taken from this live run, never fixture shots.
