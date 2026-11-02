// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/**
 * @title MamoruV4Classes (spec 010 A1 "Eligibility rules", otto/mamoru#316, #318): pool classes, reference pools and
 * the exact vault list, per chain, in code.
 * @notice Replaces MamoruRegistry. There is no list anyone edits: a pool is eligible for an entry when it passes the
 * rules MamoruActionPolicyV4 checks at every use (official factory, pinned tokens, the class's fee set, an observation
 * ring that serves the class's window, depth, the parity anchor for stable pairs, and agreement with the pair's
 * reference pool). This table only names, per pinned pair, the class's risk parameters and the reference pool, and per
 * chain the vaults by exact address. A pair without a row has no eligible pool; a chain without rows has none either.
 * Changing any value is a new V4 version, adopted only by an owner signature (spec 010 I8).
 *
 * Classes (spec 010 open question 3: v6's 50/35/15 mix on Base; one asset on Monad and Ethereum):
 *  - stable/stable: 30 min / 5 min TWAPs, band 10 ticks, parity anchor +-40 ticks, 50 % of C, fee 0.01 %.
 *  - a volatile asset against a pinned stable: 30 min / 5 min (Ethereum 12 min / 3 min: the reference pool's ring
 *    holds 723 observations), band 100 ticks, its v6 share of C, fees 0.05 % and 0.3 % (Monad 0.3 % and 1 %).
 * The sub-bucket key of a class (`key`) is the volatile asset, or STABLE_KEY for stable/stable: every pool of an asset
 * against any pinned stable and any fee tier shares one sub-bucket (spec 010 "What the old remove protected").
 *
 * Reference pools (read on chain 2 Nov: `factory.getPool`, in-range liquidity, observation cardinality):
 *  - Base: USDC/USDT 0.01 % 0xD56da2B7... (ring 2000), USDC/cbBTC 0.05 % 0xfBB6Eed8... (2000), WETH/USDC 0.3 %
 *    0x6c561B44... (2000; the deepest in-range liquidity of the pair's four tiers). USDT pairs with a volatile asset
 *    have no row: no eligible pool.
 *  - Monad: WMON/USDC 0.3 % 0x659bD0BC... (ring 1800; the other tiers hold a fraction of its liquidity).
 *  - Ethereum: USDC/WETH 0.05 % 0x88e6A0c2... (ring 723).
 * Vaults: Base gtUSDCp (Gauntlet USDC Prime, MetaMorpho v1.0) 0xeE8F4eC5..., the vault spec 004 measured and V3
 * lists, at 50 % of C. Monad and Ethereum list none.
 */
library MamoruV4Classes {
    uint256 internal constant BASE = 8453;
    uint256 internal constant MONAD = 143;
    uint256 internal constant ETHEREUM = 1;

    /// The sub-bucket key of the stable/stable class (no token address can collide with a hash-derived one).
    address internal constant STABLE_KEY = address(uint160(uint256(keccak256("mamoru.v4.class.stable"))));

    uint8 internal constant FEE_100 = 1;
    uint8 internal constant FEE_500 = 2;
    uint8 internal constant FEE_3000 = 4;
    uint8 internal constant FEE_10000 = 8;

    struct Class {
        address ref; // the pair's reference pool; address(0) = no class: the pair has no eligible pool
        address key; // sub-bucket key: the volatile asset, or STABLE_KEY
        uint32 twapWindow;
        uint32 twapShortWindow;
        uint24 bandTicks;
        uint24 anchorBand; // stable/stable only: +-ticks around parity (tick 0); 0 for a volatile asset
        uint16 ratioBps; // the sub-bucket: ratioBps of C
        uint8 feeMask; // FEE_* bits of the fee tiers a pool of the pair may have
    }

    struct Vault {
        address asset; // a pinned stable; address(0) = not listed
        uint16 ratioBps;
    }

    function feeBit(uint24 fee) internal pure returns (uint8) {
        return fee == 100 ? FEE_100 : fee == 500 ? FEE_500 : fee == 3000 ? FEE_3000 : fee == 10000 ? FEE_10000 : 0;
    }

    /// The class of the pair (a, b), in either order, on `chainId`; the empty class (ref 0) when it has none.
    function classOf(uint256 chainId, address a, address b) internal pure returns (Class memory c) {
        (address x, address y) = a < b ? (a, b) : (b, a);
        if (chainId == BASE) {
            // USDC 0x8335..., USDT 0xfde4..., WETH 0x4200...06, cbBTC 0xcbB7...
            if (x == 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 && y == 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2) {
                return Class(0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1, STABLE_KEY, 1800, 300, 10, 40, 5_000, FEE_100);
            }
            if (x == 0x4200000000000000000000000000000000000006 && y == 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) {
                return Class(
                    0x6c561B446416E1A00E8E93E221854d6eA4171372,
                    0x4200000000000000000000000000000000000006,
                    1800,
                    300,
                    100,
                    0,
                    1_500,
                    FEE_500 | FEE_3000
                );
            }
            if (x == 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 && y == 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf) {
                return Class(
                    0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef,
                    0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf,
                    1800,
                    300,
                    100,
                    0,
                    3_500,
                    FEE_500 | FEE_3000
                );
            }
        } else if (chainId == MONAD) {
            // WMON 0x3bd3..., USDC 0x7547...
            if (x == 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A && y == 0x754704Bc059F8C67012fEd69BC8A327a5aafb603) {
                return Class(
                    0x659bD0BC4167BA25c62E05656F78043E7eD4a9da,
                    0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A,
                    1800,
                    300,
                    100,
                    0,
                    10_000,
                    FEE_3000 | FEE_10000
                );
            }
        } else if (chainId == ETHEREUM) {
            // USDC 0xA0b8..., WETH 0xC02a...
            if (x == 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 && y == 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2) {
                return Class(
                    0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640,
                    0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2,
                    720,
                    180,
                    100,
                    0,
                    10_000,
                    FEE_500 | FEE_3000
                );
            }
        }
    }

    /// A vault listed on `chainId` by exact address (spec 010 A1 "Vaults"); asset 0 when it is not.
    function vaultOf(uint256 chainId, address vault) internal pure returns (Vault memory v) {
        if (chainId == BASE && vault == 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61) {
            return Vault(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 5_000); // gtUSDCp
        }
    }
}
