#!/usr/bin/env bash
# Fetches the Solidity dependencies at pinned commits into lib/ (gitignored). Run from anywhere.
# Needs foundry: nix shell nixpkgs#foundry --command ./contracts/v4-policy/install.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p lib
forge install --no-git \
  foundry-rs/forge-std@b013eff2ac4fce26f34d789e6f5c49021c5ee817 \
  Uniswap/v4-core@e50237c43811bd9b526eff40f26772152a42daba \
  Uniswap/v4-periphery@9969eec44cfdf07e24b41de47f40276a58401976
