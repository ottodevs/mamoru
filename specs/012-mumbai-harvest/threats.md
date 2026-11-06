# 012 threats: full harvest (r2)

Only what this spec adds. Session-key and walkaway models (`specs/001-mamoru-v1/threats.md`,
`contracts/action-policy/SECURITY.md` I5) unchanged: no new grant, recipient or contract.

| Id | Threat | Bound | Check |
|---|---|---|---|
| HT-01 | Harvest path sells principal | sale = `min(harvested-unsold, balance)`; counter from receipts, clipped to balance | HRV-S01 |
| HT-02 | Sweep/drain loop burns gas and V4 room | sweep stops 1 unit below the drain line | HRV-S12 |
| HT-03 | Reinvestment spends the room re-ranges need | reserve 1.25 x all LP value; re-range never gated | HRV-S03, S04 |
| HT-04 | Bridge ping-pong Base ↔ Monad | return only after 6 h idle; no `bridge_out` for 24 h after a return | HRV-S18 |
| HT-05 | Harvest burst after release | one op per account per review; relayer nonce serial; gas policy rate | S21 observation |
| HT-06 | Vault yield overstated | flows from receipts; unexplained shares → not counted, marked | HRV-S08, S15 |
| HT-07 | Double count of income on replay | event key tx hash + log index / sample id, insert-or-ignore | HRV-S09 |
| HT-08 | Sandwich on the sale | policy slippage + TWAP gate; amounts are fees | existing gates |
