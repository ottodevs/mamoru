# 012 threats: full harvest

Only what this spec adds. The session-key and walkaway models of `specs/001-mamoru-v1/threats.md` and
`contracts/action-policy/SECURITY.md` (I5) are unchanged: no new grant, recipient or contract.

| Id | Threat | Bound | Check |
|---|---|---|---|
| HT-01 | Sale sized before the harvest lands swaps principal (#140) | Sale is a later review, sized on `held` at that review | HRV-S01, decide precedence `index.ts:250` |
| HT-02 | Sweep and drain loop: deposit, then redeem the same USDC, burning gas and V4 room | Sweep stops below target + 5 pts; `reduceOf` acts only above it | HRV-S12 |
| HT-03 | Reinvestment spends V4 room a re-range needs; position stays out of range for hours | Room − largest re-mint reserve; re-range never gated | HRV-S03, S04 |
| HT-04 | Harvest burst after release: many accounts at once | One op per account per review; relayer nonce serial; gas policy rate per account | observed in prod, A7 |
| HT-05 | Vault yield overstated from shares the engine did not deposit | Unexplained shares → null | HRV-S08 |
| HT-06 | Sandwich on the sale | Policy slippage + TWAP gate as every swap; amounts are fees (small) | existing gates |
