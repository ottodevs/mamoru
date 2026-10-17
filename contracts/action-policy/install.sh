#!/usr/bin/env bash
# Fetches the PoC's Solidity dependencies at pinned commits into lib/ (gitignored). Run from anywhere.
# Needs foundry: nix shell nixpkgs#foundry --command ./contracts/action-policy/install.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p lib
forge install --no-git \
  foundry-rs/forge-std@77041d2ce690e692d6e03cc812b57d1ddaa4d505 \
  Uniswap/v3-core@6562c52e8f75f0c10f9deaf44861847585fc8129 \
  Uniswap/v3-periphery@b325bb0905d922ae61fcc7df85ee802e8df5e96c
