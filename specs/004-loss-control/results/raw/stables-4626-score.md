## Shortlist (data fetched 2026-10-23T12:04Z)

| Vault | Address | Kind | Created | TVL now, M USD | Withdrawable now, M USD | APY 30 d / 90 d, % (net of fee) | APY 90 d min / max | Fee | Timelock |
|---|---|---|---|---|---|---|---|---|---|
| gtUSDCp | `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61` | native 4626 (MetaMorpho) | 2024-06-03 | 410.2 | 189.4 | 4.55 / 4.44 | 4.11 / 5.06 | 0% | 7 d |
| sparkUSDC | `0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A` | native 4626 (MetaMorpho) | 2024-12-30 | 420.0 | 176.6 | 4.08 / 3.97 | 3.69 / 4.53 | 10% | 10 d |
| steakUSDC | `0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183` | native 4626 (MetaMorpho) | 2024-05-31 | 116.1 | 114.8 | 3.39 / 3.31 | 3.07 / 3.77 | 25% | 7 d |
| waBasUSDC | `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6` | wrapper (static aToken) | see doc | 191.7 | 18.7 | 4.03 / 3.71 | 3.04 / 4.45 | 0 | gov. |

Morpho markets behind the MetaMorpho vaults (daily utilization since the market was created):

| Market | Created | Utilization now | Days ≥ 95% | Days ≥ 99% | Dates ≥ 99% | Bad debt (unrealized / realized), USD |
|---|---|---|---|---|---|---|
| cbBTC/USDC 86% | 2024-09-04 | 90.1% | 19 | 4 | 2024-11-15, 2024-11-17, 2024-11-23, 2024-12-06 | 0 / 0 |
| WETH/USDC 86% | 2024-06-07 | 90.1% | 26 | 15 | 2024-07-22, 2024-11-14, 2024-11-15, 2024-11-18, 2024-11-20, 2024-11-22, … | 0 / 0 |
| cbETH/USDC 77% | 2025-12-10 | 90.1% | 4 | 4 | 2025-12-11, 2025-12-12, 2025-12-13, 2025-12-14 | 0 / 0 |

Aave v3 Base USDC now: supply 191.7M, utilization 90.3%, available 18.7M; available liquidity over the last 365 d (DefiLlama TVL = supply − borrow): min 0.00M, median 34.5M. Days under 5M in the last 2 years: 2024-10-25 (4.44M), 2024-11-02 (4.52M), 2024-11-05 (4.19M), 2026-02-03 (2.30M), 2026-04-19 (0.00M).

## Gas per operation (simulator formula, window means, USDC)

| Window | Split | Days | collect-like op (650k) | gtUSDCp in + out | sparkUSDC in + out | waBasUSDC in + out | LP exit at 1,000 (not charged by the sweep) |
|---|---|---|---|---|---|---|---|
| sep2026 | train | 30.0 | 0.0094 | 0.0242 | 0.0187 | 0.0187 | 0.0673 |
| oct2025 | train | 7.0 | 0.0069 | 0.0188 | 0.0145 | 0.0146 | 0.0642 |
| feb2025 | train | 7.0 | 0.0179 | 0.0295 | 0.0228 | 0.0230 | 0.0603 |
| mar2025 | train | 7.0 | 0.0061 | 0.0122 | 0.0094 | 0.0095 | 0.0563 |
| dec2024 | train | 14.0 | 0.1183 | 0.2157 | 0.1666 | 0.1678 | 0.1463 |
| aug2024 | train | 7.0 | 0.0121 | 0.0201 | 0.0155 | 0.0157 | 0.0571 |
| calm-2025-09 | train | 30.0 | 0.0033 | 0.0096 | 0.0074 | 0.0074 | 0.0576 |
| calm-2026-04 | train | 30.0 | 0.0082 | 0.0207 | 0.0159 | 0.0160 | 0.0645 |
| apr2025 | test | 7.0 | 0.0026 | 0.0053 | 0.0041 | 0.0041 | 0.0530 |
| may2025 | test | 7.0 | 0.0027 | 0.0076 | 0.0058 | 0.0059 | 0.0558 |
| jun2025 | test | 30.0 | 0.0029 | 0.0067 | 0.0052 | 0.0052 | 0.0544 |
| calm-2026-05 | test | 31.0 | 0.0088 | 0.0202 | 0.0156 | 0.0157 | 0.0629 |
| feb2026 | test | 7.0 | 0.0313 | 0.0497 | 0.0384 | 0.0388 | 0.0654 |

## Stables bucket at 50 USDC, per window (net USDC vs holding USDC; LP net of its gas, exit not charged)

| Window | Split | Regime | Days | LP net | LP vs hold 50/50 | LP ops | LP gas | gtUSDCp | sparkUSDC | waBasUSDC | best vault − LP |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sep2026 | train | calm | 30.0 | -0.311 | -0.316 | 26 | 0.262 | +0.151 | +0.139 | +0.134 | +0.462 |
| oct2025 | train | crash | 7.0 | -0.013 | -0.003 | 2 | 0.017 | +0.044 | +0.048 | +0.038 | +0.061 |
| feb2025 | train | crash | 7.0 | -0.157 | -0.145 | 11 | 0.166 | +0.024* | +0.018 | +0.028 | +0.185 |
| mar2025 | train | crash | 7.0 | +0.088 | +0.124 | 13 | 0.101 | +0.039* | +0.042 | +0.027 | -0.045 |
| dec2024 | train | rally | 14.0 | -0.381 | -0.413 | 5 | 0.508 | +0.011* | n/a (predates) | +0.034* | +0.416 |
| aug2024 | train | crash | 7.0 | skipped (no cbBTC yet) | – | – | – | +0.001* | n/a (predates) | +0.045* | – |
| calm-2025-09 | train | calm | 30.0 | +0.152 | +0.143 | 3 | 0.010 | +0.256 | +0.258 | +0.213 | +0.106 |
| calm-2026-04 | train | calm | 30.0 | -0.013 | -0.010 | 2 | 0.016 | +0.148 | +0.152 | +0.122 | +0.165 |
| apr2025 | test | crash | 7.0 | -0.004 | +0.003 | 2 | 0.005 | +0.045* | +0.045 | +0.023 | +0.049 |
| may2025 | test | rally | 7.0 | -0.001 | -0.001 | 2 | 0.006 | +0.035* | +0.036 | +0.024 | +0.037 |
| jun2025 | test | calm | 30.0 | +0.069 | +0.067 | 4 | 0.009 | +0.180* | +0.191 | +0.160 | +0.122 |
| calm-2026-05 | test | calm | 31.0 | +0.712 | +0.725 | 12 | 0.110 | +0.161 | +0.148* | +0.117 | -0.551 |
| feb2026 | test | stable-stress | 7.0 | -5.168 | -5.162 | 27 | 5.534 | -0.016 | -0.006 | +0.009 | +5.177 |

* the vault held under 10M USD at the window's start (not seasoned then).

## Stables bucket at 1,000 USDC, per window (net USDC vs holding USDC; LP net of its gas, exit not charged)

| Window | Split | Regime | Days | LP net | LP vs hold 50/50 | LP ops | LP gas | gtUSDCp | sparkUSDC | waBasUSDC | best vault − LP |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sep2026 | train | calm | 30.0 | -1.821 | -1.933 | 28 | 0.279 | +3.483 | +3.136 | +3.042 | +5.304 |
| oct2025 | train | crash | 7.0 | +0.047 | +0.258 | 3 | 0.020 | +1.232 | +1.236 | +1.034 | +1.190 |
| feb2025 | train | crash | 7.0 | -0.031 | +0.199 | 18 | 0.212 | +1.036* | +0.799 | +0.998 | +1.066 |
| mar2025 | train | crash | 7.0 | +2.744 | +3.476 | 24 | 0.178 | +1.017* | +1.026 | +0.725 | -1.717 |
| dec2024 | train | rally | 14.0 | +1.941 | +1.303 | 9 | 0.587 | +4.314* | n/a (predates) | +3.875* | +2.372 |
| aug2024 | train | crash | 7.0 | skipped (no cbBTC yet) | – | – | – | +0.394* | n/a (predates) | +1.206* | – |
| calm-2025-09 | train | calm | 30.0 | +3.146 | +2.958 | 15 | 0.093 | +5.297 | +5.300 | +4.392 | +2.154 |
| calm-2026-04 | train | calm | 30.0 | +0.056 | +0.114 | 2 | 0.016 | +3.343 | +3.345 | +2.739 | +3.289 |
| apr2025 | test | crash | 7.0 | +0.011 | +0.148 | 7 | 0.014 | +1.005* | +0.981 | +0.537 | +0.994 |
| may2025 | test | rally | 7.0 | +0.089 | +0.076 | 3 | 0.009 | +0.841* | +0.838 | +0.591 | +0.753 |
| jun2025 | test | calm | 30.0 | +1.533 | +1.494 | 14 | 0.039 | +3.731* | +3.917 | +3.289 | +2.384 |
| calm-2026-05 | test | calm | 31.0 | +14.724 | +14.989 | 27 | 0.217 | +3.611 | +3.256* | +2.647 | -11.113 |
| feb2026 | test | stable-stress | 7.0 | -1.164 | -1.043 | 34 | 5.583 | +0.627 | +0.615 | +0.912 | +2.076 |

* the vault held under 10M USD at the window's start (not seasoned then).

## Totals per split (sum over the windows where the LP and every listed vault ran; net USDC)

| Split | Deposit | Windows | Days | LP net | LP net incl. exit | gtUSDCp | sparkUSDC | waBasUSDC | gtUSDCp / sparkUSDC by share price | LP ann. % | gtUSDCp ann. % | sparkUSDC ann. % | waBasUSDC ann. % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| train | 50 | 6 | 111 | -0.25 | -0.34 | +0.66 | +0.66 | +0.56 | +0.65 / +0.61 | -1.67 | 4.35 | 4.33 | 3.70 |
| train | 1000 | 6 | 111 | +4.14 | +3.77 | +15.41 | +14.84 | +12.93 | +15.09 / +13.98 | 1.36 | 5.07 | 4.88 | 4.25 |
| test | 50 | 5 | 82 | -4.39 | -4.45 | +0.41 | +0.41 | +0.33 | +0.40 / +0.40 | -39.11 | 3.61 | 3.69 | 2.96 |
| test | 1000 | 5 | 82 | +15.19 | +14.90 | +9.82 | +9.61 | +7.98 | +9.68 / +9.39 | 6.77 | 4.37 | 4.28 | 3.55 |
| all | 50 | 11 | 193 | -4.65 | -4.78 | +1.07 | +1.07 | +0.89 | +1.04 / +1.02 | -17.58 | 4.04 | 4.06 | 3.38 |
| all | 1000 | 11 | 193 | +19.33 | +18.67 | +25.22 | +24.45 | +20.91 | +24.77 / +23.37 | 3.66 | 4.77 | 4.63 | 3.95 |

Windows left out above: sparkUSDC predates them (dec2024, aug2024) or the LP did not run (aug2024):

| Window | Deposit | LP net | gtUSDCp | waBasUSDC |
|---|---|---|---|---|
| dec2024 | 50 | -0.381 | young +0.011 | young +0.034 |
| dec2024 | 1000 | +1.941 | young +4.314 | young +3.875 |
| aug2024 | 50 | – | young +0.001 | young +0.045 |
| aug2024 | 1000 | – | young +0.394 | young +1.206 |

## Whole Conservador mix at 1,000 USDC (net USDC vs the deposit)

Live mix: `conservador-live-v2` as it runs. Additive: volatile buckets alone at 500 (cbBTC 80 / WETH 20 of them) + stables bucket alone at 500; its gap to the live mix is the error of splitting the mix. Vault mixes: the same volatile run + 500 in the vault.

| Window | Split | Live mix | Additive (LP) | Additive − live | + gtUSDCp | + sparkUSDC | + waBasUSDC | best vault mix − additive |
|---|---|---|---|---|---|---|---|---|
| sep2026 | train | +25.54 | +21.71 | -3.83 | +24.33 | +24.16 | +24.12 | +2.62 |
| oct2025 | train | -33.30 | -30.45 | +2.85 | -29.86 | -29.85 | -29.95 | +0.59 |
| feb2025 | train | -35.69 | -36.96 | -1.27 | -36.35 | -36.47 | -36.37 | +0.60 |
| mar2025 | train | -35.27 | -36.13 | -0.86 | -37.16 | -37.15 | -37.30 | -1.02 |
| dec2024 | train | +20.75 | +21.55 | +0.80 | +22.89 | n/a | +22.69 | +1.33 |
| calm-2025-09 | train | +6.03 | +6.19 | +0.16 | +7.27 | +7.27 | +6.82 | +1.08 |
| calm-2026-04 | train | +28.51 | +28.24 | -0.27 | +29.89 | +29.89 | +29.59 | +1.64 |
| apr2025 | test | -35.79 | -39.42 | -3.63 | -38.92 | -38.94 | -39.16 | +0.50 |
| may2025 | test | +24.55 | +24.67 | +0.12 | +25.04 | +25.04 | +24.92 | +0.37 |
| jun2025 | test | +11.10 | +10.89 | -0.22 | +11.99 | +12.08 | +11.77 | +1.20 |
| calm-2026-05 | test | -1.51 | -1.56 | -0.05 | -7.41 | -7.58 | -7.89 | -5.85 |
| feb2026 | test | -28.73 | -23.54 | +5.19 | -20.61 | -20.61 | -20.46 | +3.08 |

| Split | Windows | Live mix | Additive (LP) | + gtUSDCp | + sparkUSDC | + waBasUSDC |
|---|---|---|---|---|---|---|
| train | 6 | -44.17 | -47.39 | -41.88 | -42.15 | -43.10 |
| all | 11 | -74.55 | -76.36 | -71.79 | -72.15 | -73.92 |
| test | 5 | -30.38 | -28.97 | -29.91 | -30.00 | -30.82 |

## Break-even (90-day mean APY now)

| Vault | APY 90 d % | in + out gas, Lab mean / Lab max / live 2 × 0.07 $ | Days to pay gas at 50 USDC (mean / max / live) | at 1,000 | Smallest deposit that pays the gas in 7 d (mean / live) | in 30 d (mean / live) |
|---|---|---|---|---|---|---|
| gtUSDCp | 4.44 | 0.034 / 0.216 / 0.140 | 5.7 / 36.2 / 23.5 | 0.28 / 1.81 / 1.18 | 40.7 / 168.1 | 9.5 / 39.2 |
| sparkUSDC | 3.97 | 0.026 / 0.167 / 0.140 | 4.9 / 31.1 / 26.2 | 0.24 / 1.56 / 1.31 | 35.0 / 187.2 | 8.1 / 43.6 |
| waBasUSDC | 3.71 | 0.026 / 0.168 / 0.140 | 5.3 / 33.6 / 28.0 | 0.26 / 1.68 / 1.40 | 37.7 / 200.4 | 8.8 / 46.7 |

## APY model vs the Morpho share price (growth over each window, bps)

| Window | gtUSDCp APY model | gtUSDCp share price | sparkUSDC APY model | sparkUSDC share price |
|---|---|---|---|---|
| sep2026 | 35.08 | 35.08 | 31.54 | 31.54 |
| oct2025 | 12.51 | 11.91 | 12.51 | 11.28 |
| feb2025 | 10.65 | 10.99 | 8.22 | 9.14 |
| mar2025 | 10.29 | 9.77 | 10.36 | 10.28 |
| dec2024 | 45.29 | 44.75 | – | – |
| aug2024 | 4.14 | 3.96 | – | – |
| calm-2025-09 | 53.06 | 50.23 | 53.07 | 47.59 |
| calm-2026-04 | 33.64 | 34.05 | 33.60 | 30.83 |
| apr2025 | 10.11 | 9.84 | 9.86 | 10.35 |
| may2025 | 8.49 | 8.36 | 8.44 | 8.44 |
| jun2025 | 37.37 | 36.30 | 39.22 | 37.17 |
| calm-2026-05 | 36.31 | 36.23 | 32.72 | 32.64 |
| feb2026 | 6.76 | 7.02 | 6.53 | 6.00 |

