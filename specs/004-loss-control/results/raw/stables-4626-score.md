## Shortlist (data fetched 2026-10-23T12:18Z)

| Vault | Address | Kind | Vault created | TVL now, M USD | Withdrawable now, M USD | Base rate 30 d / 90 d, % (convention) | 90 d min / max | Fee | Timelock |
|---|---|---|---|---|---|---|---|---|---|
| gtUSDCp | `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61` | native 4626 (MetaMorpho) | 2024-06-03 | 410.1 | 188.9 | 4.55 / 4.44 (apy) | 4.11 / 5.06 | 0% | 7 d |
| sparkUSDC | `0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A` | native 4626 (MetaMorpho) | 2024-12-30 | 420.0 | 176.2 | 4.08 / 3.97 (apy) | 3.69 / 4.53 | 10% | 10 d |
| steakUSDC | `0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183` | native 4626 (MetaMorpho) | 2024-05-31 | 116.1 | 114.8 | 3.39 / 3.31 (apy) | 3.07 / 3.77 | 25% | 7 d |
| waBasUSDC | `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6` | wrapper (static aToken) | 2025-01-20 | 191.7 (reserve supply) | 18.6 (reserve available) | 4.03 / 3.71 (apr, reserve) | 3.04 / 4.45 | 0 | gov. |

Morpho markets behind the MetaMorpho vaults (daily utilization since the market was created):

| Market | Created | Utilization now | Days ≥ 95% | Days ≥ 99% | Dates ≥ 99% | Bad debt (unrealized / realized), USD |
|---|---|---|---|---|---|---|
| cbBTC/USDC 86% | 2024-09-04 | 90.1% | 19 | 4 | 2024-11-15, 2024-11-17, 2024-11-23, 2024-12-06 | 0 / 0 |
| WETH/USDC 86% | 2024-06-07 | 90.1% | 26 | 15 | 2024-07-22, 2024-11-14, 2024-11-15, 2024-11-18, 2024-11-20, 2024-11-22, … | 0 / 0 |
| cbETH/USDC 77% | 2025-12-10 | 90.1% | 4 | 4 | 2025-12-11, 2025-12-12, 2025-12-13, 2025-12-14 | 0 / 0 |

Aave v3 Base USDC **reserve** (under the waBasUSDC wrapper; reserve figures, not the wrapper's) now: supply 191.7M, utilization 90.3%, available 18.6M; available liquidity over the last 365 d (DefiLlama TVL = supply − borrow): min 0.00M, median 34.5M. Days under 5M in the last 2 years: 2024-10-25 (4.44M), 2024-11-02 (4.52M), 2024-11-05 (4.19M), 2026-02-03 (2.30M), 2026-04-19 (0.00M).

## Gas per operation (simulator formula, window means, USDC)

| Window | Split | Days | collect-like op (650k) | gtUSDCp in + out | sparkUSDC in + out | waBasUSDC in + out | LP exit at 1,000 (charged below) |
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

## Stables bucket at 50 USDC, per window (net USDC vs holding USDC; every arm ends in USDC: LP exit and vault redeem paid)

| Window | Split | Regime | Days | LP net | LP before exit | LP vs hold 50/50 | LP ops | LP gas | gtUSDCp | sparkUSDC | waBasUSDC | best vault − LP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sep2026 | train | calm | 30.0 | -0.331 | -0.311 | -0.316 | 26 | 0.262 | +0.151 | +0.139 | +0.137† | +0.482 |
| oct2025 | train | crash | 7.0 | -0.030 | -0.013 | -0.003 | 2 | 0.017 | +0.041 | +0.042 | +0.040† | +0.072 |
| feb2025 | train | crash | 7.0 | -0.170 | -0.157 | -0.145 | 11 | 0.166 | +0.026* | +0.023 | +0.033† | +0.202 |
| mar2025 | train | crash | 7.0 | +0.079 | +0.088 | +0.124 | 13 | 0.101 | +0.037* | +0.042 | +0.028† | -0.037 |
| dec2024 | train | rally | 14.0 | -0.480 | -0.381 | -0.413 | 5 | 0.508 | +0.008* | n/a (predates) | n/a (predates) | +0.488 |
| aug2024 | train | crash | 7.0 | skipped (no cbBTC yet) | – | – | – | – | -0.000* | n/a (predates) | n/a (predates) | – |
| calm-2025-09 | train | calm | 30.0 | +0.142 | +0.152 | +0.143 | 3 | 0.010 | +0.242 | +0.231 | +0.219† | +0.100 |
| calm-2026-04 | train | calm | 30.0 | -0.030 | -0.013 | -0.010 | 2 | 0.016 | +0.150 | +0.138 | +0.124† | +0.179 |
| apr2025 | test | crash | 7.0 | -0.009 | -0.004 | +0.003 | 2 | 0.005 | +0.044* | +0.048 | +0.024† | +0.057 |
| may2025 | test | rally | 7.0 | -0.009 | -0.001 | -0.001 | 2 | 0.006 | +0.034* | +0.036 | +0.024† | +0.045 |
| jun2025 | test | calm | 30.0 | +0.062 | +0.069 | +0.067 | 4 | 0.009 | +0.175* | +0.181 | +0.164† | +0.118 |
| calm-2026-05 | test | calm | 31.0 | +0.696 | +0.712 | +0.725 | 12 | 0.110 | +0.161 | +0.148* | +0.120† | -0.536 |
| feb2026 | test | stable-stress | 7.0 | -5.186 | -5.168 | -5.162 | 27 | 5.534 | -0.015 | -0.008 | +0.011† | +5.197 |

* the vault held under 10M USD at the window's start (not seasoned then). † growth from the rate model (no share-price series); otherwise the observed share price.

## Stables bucket at 1,000 USDC, per window (net USDC vs holding USDC; every arm ends in USDC: LP exit and vault redeem paid)

| Window | Split | Regime | Days | LP net | LP before exit | LP vs hold 50/50 | LP ops | LP gas | gtUSDCp | sparkUSDC | waBasUSDC | best vault − LP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sep2026 | train | calm | 30.0 | -1.888 | -1.821 | -1.933 | 28 | 0.279 | +3.484 | +3.136 | +3.103† | +5.372 |
| oct2025 | train | crash | 7.0 | -0.018 | +0.047 | +0.258 | 3 | 0.020 | +1.172 | +1.114 | +1.068† | +1.190 |
| feb2025 | train | crash | 7.0 | -0.091 | -0.031 | +0.199 | 18 | 0.212 | +1.070* | +0.891 | +1.091† | +1.182 |
| mar2025 | train | crash | 7.0 | +2.687 | +2.744 | +3.476 | 24 | 0.178 | +0.965* | +1.018 | +0.749† | -1.669 |
| dec2024 | train | rally | 14.0 | +1.795 | +1.941 | +1.303 | 9 | 0.587 | +4.259* | n/a (predates) | n/a (predates) | +2.464 |
| aug2024 | train | crash | 7.0 | skipped (no cbBTC yet) | – | – | – | – | +0.376* | n/a (predates) | n/a (predates) | – |
| calm-2025-09 | train | calm | 30.0 | +3.089 | +3.146 | +2.958 | 15 | 0.093 | +5.013 | +4.751 | +4.514† | +1.924 |
| calm-2026-04 | train | calm | 30.0 | -0.009 | +0.056 | +0.114 | 2 | 0.016 | +3.384 | +3.067 | +2.780† | +3.393 |
| apr2025 | test | crash | 7.0 | -0.042 | +0.011 | +0.148 | 7 | 0.014 | +0.978* | +1.030 | +0.553† | +1.072 |
| may2025 | test | rally | 7.0 | +0.033 | +0.089 | +0.076 | 3 | 0.009 | +0.828* | +0.838 | +0.599† | +0.805 |
| jun2025 | test | calm | 30.0 | +1.478 | +1.533 | +1.494 | 14 | 0.039 | +3.623* | +3.712 | +3.373† | +2.234 |
| calm-2026-05 | test | calm | 31.0 | +14.661 | +14.724 | +14.989 | 27 | 0.217 | +3.602 | +3.248* | +2.693† | -11.059 |
| feb2026 | test | stable-stress | 7.0 | -1.229 | -1.164 | -1.043 | 34 | 5.583 | +0.652 | +0.562 | +0.948† | +2.177 |

* the vault held under 10M USD at the window's start (not seasoned then). † growth from the rate model (no share-price series); otherwise the observed share price.

## Totals per split (sum over the windows where the LP and every listed vault ran; net USDC, every arm ends in USDC)

| Split | Deposit | Windows | Days | LP net | LP before exit | gtUSDCp | sparkUSDC | waBasUSDC | gtUSDCp / sparkUSDC by APY model | LP ann. % | gtUSDCp ann. % | sparkUSDC ann. % | waBasUSDC ann. % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| train | 50 | 6 | 111 | -0.34 | -0.25 | +0.65 (5/6) | +0.61 (5/6) | +0.58 (5/6) | +0.66 / +0.66 | -2.23 | 4.24 | 4.04 | 3.82 |
| train | 1000 | 6 | 111 | +3.77 | +4.14 | +15.09 (5/6) | +13.98 (5/6) | +13.30 (5/6) | +15.39 / +14.84 | 1.24 | 4.96 | 4.60 | 4.38 |
| test | 50 | 5 | 82 | -4.45 | -4.39 | +0.40 (4/5) | +0.40 (4/5) | +0.34 (4/5) | +0.41 / +0.42 | -39.59 | 3.55 | 3.60 | 3.05 |
| test | 1000 | 5 | 82 | +14.90 | +15.19 | +9.68 (4/5) | +9.39 (4/5) | +8.17 (4/5) | +9.81 / +9.62 | 6.64 | 4.31 | 4.18 | 3.64 |
| all | 50 | 11 | 193 | -4.78 | -4.65 | +1.04 (9/11) | +1.02 (9/11) | +0.92 (9/11) | +1.07 / +1.07 | -18.10 | 3.95 | 3.85 | 3.49 |
| all | 1000 | 11 | 193 | +18.67 | +19.33 | +24.77 (9/11) | +23.37 (9/11) | +21.47 (9/11) | +25.20 / +24.45 | 3.53 | 4.69 | 4.42 | 4.06 |

(n/m): windows where the vault ended above the LP. Windows left out above: a vault predates them or its data has a gap, or the LP did not run (aug2024):

| Window | Deposit | LP net | gtUSDCp | waBasUSDC |
|---|---|---|---|---|
| dec2024 | 50 | -0.480 | young +0.008 | predates |
| dec2024 | 1000 | +1.795 | young +4.259 | predates |
| aug2024 | 50 | – | young -0.000 | predates |
| aug2024 | 1000 | – | young +0.376 | predates |

## Whole Conservador mix at 1,000 USDC (net USDC vs the deposit)

Live mix: `conservador-live-v2` as it runs. Additive: volatile buckets alone at 500 (cbBTC 80 / WETH 20 of them) + stables bucket alone at 500; its gap to the live mix is the error of splitting the mix. Vault mixes: the same volatile run + 500 in the vault. The stables leg ends in USDC in every arm (LP legs pay the exit of a 500 USDC stables position; the vault its redeem); the volatile half is left open in every arm.

| Window | Split | Live mix | Additive (LP) | Additive − live | + gtUSDCp | + sparkUSDC | + waBasUSDC | best vault mix − additive |
|---|---|---|---|---|---|---|---|---|
| sep2026 | train | +25.50 | +21.67 | -3.83 | +24.33 | +24.16 | +24.15 | +2.67 |
| oct2025 | train | -33.34 | -30.48 | +2.85 | -29.89 | -29.91 | -29.94 | +0.60 |
| feb2025 | train | -35.72 | -36.99 | -1.27 | -36.33 | -36.42 | -36.32 | +0.67 |
| mar2025 | train | -35.30 | -36.16 | -0.86 | -37.18 | -37.15 | -37.29 | -0.99 |
| dec2024 | train | +20.63 | +21.43 | +0.80 | +22.86 | n/a | n/a | +1.43 |
| calm-2025-09 | train | +6.00 | +6.16 | +0.16 | +7.13 | +7.00 | +6.88 | +0.97 |
| calm-2026-04 | train | +28.48 | +28.20 | -0.27 | +29.91 | +29.75 | +29.61 | +1.70 |
| apr2025 | test | -35.82 | -39.45 | -3.63 | -38.94 | -38.91 | -39.15 | +0.54 |
| may2025 | test | +24.52 | +24.64 | +0.12 | +25.03 | +25.04 | +24.92 | +0.40 |
| jun2025 | test | +11.07 | +10.86 | -0.22 | +11.93 | +11.98 | +11.81 | +1.12 |
| calm-2026-05 | test | -1.55 | -1.60 | -0.05 | -7.41 | -7.59 | -7.86 | -5.81 |
| feb2026 | test | -28.77 | -23.58 | +5.19 | -20.60 | -20.64 | -20.44 | +3.14 |

| Split | Windows | Live mix | Additive (LP) | + gtUSDCp | + sparkUSDC | + waBasUSDC |
|---|---|---|---|---|---|---|
| train | 6 | -44.39 | -47.61 | -42.04 | -42.58 | -42.91 |
| all | 11 | -74.94 | -76.75 | -72.01 | -72.69 | -73.64 |
| test | 5 | -30.55 | -29.14 | -29.98 | -30.11 | -30.72 |

## Break-even (90-day mean base rate now, as effective APY)

| Vault | APY 90 d % | in + out gas, Lab mean / Lab max / live 2 × 0.07 $ | Days to pay gas at 50 USDC (mean / max / live) | at 1,000 | Smallest deposit that pays the gas in 7 d (mean / live) | in 30 d (mean / live) |
|---|---|---|---|---|---|---|
| gtUSDCp | 4.44 | 0.034 / 0.216 / 0.140 | 5.7 / 36.2 / 23.5 | 0.28 / 1.81 / 1.18 | 40.7 / 168.1 | 9.5 / 39.2 |
| sparkUSDC | 3.97 | 0.026 / 0.167 / 0.140 | 4.9 / 31.1 / 26.2 | 0.24 / 1.56 / 1.31 | 35.0 / 187.2 | 8.1 / 43.6 |
| waBasUSDC | 3.78 | 0.026 / 0.168 / 0.140 | 5.2 / 33.0 / 27.5 | 0.26 / 1.65 / 1.38 | 37.0 / 196.8 | 8.6 / 45.9 |

## Observed share price (scored) vs the DefiLlama APY model (growth over each window, bps)

| Window | gtUSDCp share price | gtUSDCp model | model − price | sparkUSDC share price | sparkUSDC model | model − price | waBasUSDC model (APR, reserve rate) |
|---|---|---|---|---|---|---|---|
| sep2026 | 35.08 | 35.04 | -0.05 | 31.54 | 31.51 | -0.04 | 31.21 |
| oct2025 | 11.91 | 12.51 | +0.60 | 11.28 | 12.51 | +1.23 | 10.82 |
| feb2025 | 10.99 | 10.68 | -0.31 | 9.14 | 8.25 | -0.89 | 11.14 |
| mar2025 | 9.77 | 10.27 | +0.50 | 10.28 | 10.32 | +0.05 | 7.58 |
| dec2024 | 44.75 | 43.43 | -1.32 | – | – | – | predates |
| aug2024 | 3.96 | 4.43 | +0.47 | – | – | – | predates |
| calm-2025-09 | 50.23 | 52.99 | +2.76 | 47.59 | 53.04 | +5.45 | 45.21 |
| calm-2026-04 | 34.05 | 33.55 | -0.50 | 30.83 | 33.63 | +2.80 | 27.96 |
| apr2025 | 9.84 | 10.12 | +0.28 | 10.35 | 9.83 | -0.52 | 5.57 |
| may2025 | 8.36 | 8.46 | +0.11 | 8.44 | 8.44 | -0.00 | 6.05 |
| jun2025 | 36.30 | 37.32 | +1.02 | 37.17 | 39.16 | +1.98 | 33.78 |
| calm-2026-05 | 36.23 | 36.17 | -0.05 | 32.64 | 32.59 | -0.05 | 27.09 |
| feb2026 | 7.02 | 6.96 | -0.06 | 6.00 | 6.84 | +0.83 | 9.87 |

