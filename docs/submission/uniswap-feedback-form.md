# Uniswap Developer Feedback Form: prepared answers

Form: https://developers.uniswap.org/hackathon-feedback (read 2026-09-26, about 20:20 CEST). L0 submits it; this lane did not. The Uniswap prize requires that the submission includes the link to our FEEDBACK.md. The form has no field for it, so the link goes in "What did you build?" and again in "Any additional feedback?".

FEEDBACK.md link: https://github.com/ottodevs/mamoru/blob/main/FEEDBACK.md

| Field | Required | Answer |
|---|---|---|
| First name | yes | [L0: Ot's first name as on ETHGlobal] |
| Last name | no | [L0] |
| Email | yes | [L0: the email on the ETHGlobal account] |
| Telegram handle | yes | [L0: ask Ot] |
| Which hackathon did you participate in? | yes | ETHGlobal Tokyo 2026 |
| Did you complete a project during the hackathon? | yes | Yes |
| What did you build? | yes | see below |
| Are you building an AI-powered or agentic project? | yes | "Yes: a bot / agent that executes onchain actions" (Mamoru is an autonomous savings agent that plans Uniswap v3 actions for a Safe through a scoped session key; in v1 it runs in simulation mode and does not send) |
| Were you able to successfully integrate Uniswap into your project? | yes | Partially [PENDING L1: "Yes" if the T003 harvest on the fork passes before submission] |
| How long did it take to get your first successful integration working? | yes | [Ot decides: the commits `336cf88` (registry) and `6503732` (call builders) share one timestamp, so the history does not show it] |
| What was the biggest blocker you faced? | no | see below |
| If applicable: what was the hardest part of building an agentic app on Uniswap? | no | see below |
| How helpful was the Uniswap documentation for your use case? (1-5) | yes | 4 [Ot decides] |
| How would you rate the support Uniswap provided overall? (1-5) | yes | 4 [Ot decides; we did not use office hours] |
| Do you plan to continue building the project? | yes | Yes |
| What type of support did you use? | yes | Technical docs |
| What support was missing, or could have been better? | no | see below |
| Any additional feedback? | no | see below |
| Can we follow up with you about your feedback? | no | Yes [Ot decides] |
| I agree to Uniswap Labs Terms of Service and Privacy Policy | yes | L0 ticks it only with Ot's consent |

## What did you build?

> Mamoru, a non-custodial savings account on Base. The user owns a Safe smart account with a passkey. A scoped Rhinestone Smart Session may call only Uniswap v3 on Base: SwapRouter02.exactInputSingle with the account as recipient and a positive minimum, and NonfungiblePositionManager mint, decreaseLiquidity, collect and burn with ticks on the pool spacing and positive minimums. On a Base fork pinned at block 51811000 we attack that session with a leaked key (24 scenarios) and every attack is rejected by the chain. In v1 production Mamoru runs in simulation mode: it plans and simulates, and does not sign or send. Repo: https://github.com/ottodevs/mamoru. Feedback: https://github.com/ottodevs/mamoru/blob/main/FEEDBACK.md

## What was the biggest blocker you faced?

> Finding the exact periphery contracts and ABI versions deployed on Base. SwapRouter02 on Base has no deadline in exactInputSingle, unlike the original SwapRouter, and we found that by comparing ABIs rather than from one page. We pinned the addresses and checked their code hashes at a fixed block ourselves.

## What was the hardest part of building an agentic app on Uniswap?

> Limiting what an agent's key can do. A zero amountOutMinimum or a foreign recipient is valid on chain, so a leaked key could drain a position through a normal-looking swap. We had to write our own policy: allowed selectors, recipient must be the account, positive minimums, and a position can be managed only after the account minted it. There is no reference setup for session keys or policies scoped to Uniswap calls.

## What support was missing, or could have been better?

> One page per chain listing SwapRouter02, QuoterV2 and the NonfungiblePositionManager with the deployed ABI version, and a note on what differs between chains (SwapRouter vs SwapRouter02, deadline placement, sqrtPriceLimitX96 = 0 meaning no limit). An example of a delegated signer limited to Uniswap selectors with argument checks would help every agent project.

## Any additional feedback?

> Our full write-up, with file and line links, is https://github.com/ottodevs/mamoru/blob/main/FEEDBACK.md. We used v3 only on purpose: one pool we could verify on Base at a fixed block.
