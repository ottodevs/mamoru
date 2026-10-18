// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Uniswap v4 PoolKey with plain types. Same ABI as v4-core types/PoolKey.sol (Currency and IHooks are address-sized),
/// so keccak256(abi.encode(key)) is the v4 PoolId.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}
