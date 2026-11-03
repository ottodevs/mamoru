// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruV4Classes} from "../src/MamoruV4Classes.sol";
import {MamoruV4Chains} from "../src/MamoruV4Chains.sol";

/// Spec 010 A1 T2 (otto/mamoru#316, #318): every row of the code's tables is inside V4's hard bounds (V3's, unchanged:
/// MamoruActionPolicyV4.MIN_TWAP_WINDOW ... MAX_VAULT_RATIO_BPS) and names only pinned tokens. No fork: the table is
/// pure code. A wrong value here stays until a new V4 version, so this test is the gate before T7.
contract MamoruV4ClassesTest is Test {
    uint32 constant MIN_TWAP_WINDOW = 600;
    uint32 constant MAX_TWAP_WINDOW = 86_400;
    uint32 constant MIN_SHORT_WINDOW = 60;
    uint32 constant MIN_WINDOW_RATIO = 4;
    uint24 constant MIN_BAND = 2;
    uint24 constant MAX_BAND = 500;
    uint16 constant MAX_RATIO_BPS = 10_000;
    uint16 constant MAX_VAULT_RATIO_BPS = 5_000;
    uint16 constant MAX_CCTP_FEE_CAP_BPS = 100; // MamoruActionPolicyV4.MAX_CCTP_FEE_CAP_BPS (#345 P2-5)

    function _checkClass(uint256 chainId, address a, address b) internal pure returns (MamoruV4Classes.Class memory c) {
        c = MamoruV4Classes.classOf(chainId, a, b);
        MamoruV4Classes.Class memory r = MamoruV4Classes.classOf(chainId, b, a);
        assertEq(r.ref, c.ref, "order-insensitive");
        if (c.ref == address(0)) return c;
        MamoruV4Chains.Chain memory ch = MamoruV4Chains.byChainId(chainId);
        assertTrue(MamoruV4Chains.isPinned(ch, a) && MamoruV4Chains.isPinned(ch, b), "pinned tokens");
        assertTrue(MamoruV4Chains.isStable(ch, a) || MamoruV4Chains.isStable(ch, b), "a pinned stable as budget side");
        bool stablePair = MamoruV4Chains.isStable(ch, a) && MamoruV4Chains.isStable(ch, b);
        assertTrue(c.twapWindow >= MIN_TWAP_WINDOW && c.twapWindow <= MAX_TWAP_WINDOW, "long window");
        assertGe(c.twapShortWindow, MIN_SHORT_WINDOW, "short window");
        assertLe(uint256(c.twapShortWindow) * MIN_WINDOW_RATIO, c.twapWindow, "LeftClaw M-1");
        assertTrue(c.bandTicks >= MIN_BAND && c.bandTicks <= MAX_BAND, "band");
        assertLe(c.anchorBand, MAX_BAND, "anchor band");
        assertTrue(c.ratioBps != 0 && c.ratioBps <= MAX_RATIO_BPS, "ratio");
        assertTrue(c.feeMask != 0, "a fee set");
        if (stablePair) {
            assertTrue(c.anchorBand != 0, "a stable pair carries the parity anchor");
            assertEq(c.key, MamoruV4Classes.STABLE_KEY);
        } else {
            assertEq(c.anchorBand, 0, "no anchor on a volatile pair");
            assertEq(c.key, MamoruV4Chains.isStable(ch, a) ? b : a, "the volatile asset is the sub-bucket key");
        }
    }

    function test_baseClasses() public pure {
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address usdt = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
        address weth = 0x4200000000000000000000000000000000000006;
        address cbbtc = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
        uint256 sum = _checkClass(8453, usdc, usdt).ratioBps + _checkClass(8453, usdc, weth).ratioBps
            + _checkClass(8453, usdc, cbbtc).ratioBps;
        assertEq(sum, 10_000, "v6's 50/35/15 mix");
        assertEq(_checkClass(8453, usdt, weth).ref, address(0), "USDT/WETH has no class");
        assertEq(_checkClass(8453, usdt, cbbtc).ref, address(0), "USDT/cbBTC has no class");
        assertEq(_checkClass(8453, weth, cbbtc).ref, address(0), "no stable side");
    }

    function test_monadAndEthereumClasses() public pure {
        _checkClass(143, 0x754704Bc059F8C67012fEd69BC8A327a5aafb603, 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A);
        _checkClass(1, 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
        assertEq(MamoruV4Classes.classOf(42161, address(1), address(2)).ref, address(0), "off the table: none");
    }

    function test_vaults() public pure {
        MamoruV4Classes.Vault memory v = MamoruV4Classes.vaultOf(8453, 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61);
        assertTrue(MamoruV4Chains.isStable(MamoruV4Chains.byChainId(8453), v.asset), "a pinned stable");
        assertTrue(v.ratioBps != 0 && v.ratioBps <= MAX_VAULT_RATIO_BPS, "vault ratio");
        assertEq(
            MamoruV4Classes.vaultOf(143, 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61).asset, address(0), "Base only"
        );
        assertEq(
            MamoruV4Classes.vaultOf(8453, 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183).asset,
            address(0),
            "steakUSDC is not listed"
        );
    }

    /// pairsOf / vaultsOf list exactly the rows classOf / vaultOf have (the deploy script iterates them).
    function test_listsMatchTheRows() public pure {
        uint256[3] memory ids = [uint256(8453), 143, 1];
        uint256[3] memory nPairs = [uint256(3), 1, 1];
        for (uint256 k; k < 3; k++) {
            address[2][] memory p = MamoruV4Classes.pairsOf(ids[k]);
            assertEq(p.length, nPairs[k]);
            for (uint256 i; i < p.length; i++) {
                _checkClass(ids[k], p[i][0], p[i][1]);
                assertTrue(MamoruV4Classes.classOf(ids[k], p[i][0], p[i][1]).ref != address(0), "a listed pair has a class");
            }
        }
        assertEq(MamoruV4Classes.vaultsOf(8453).length, 1);
        assertEq(MamoruV4Classes.vaultsOf(143).length, 0);
        assertEq(MamoruV4Classes.pairsOf(42161).length, 0);
    }

    function test_feeBits() public pure {
        assertEq(MamoruV4Classes.feeBit(100), 1);
        assertEq(MamoruV4Classes.feeBit(500), 2);
        assertEq(MamoruV4Classes.feeBit(3000), 4);
        assertEq(MamoruV4Classes.feeBit(10000), 8);
        assertEq(MamoruV4Classes.feeBit(2500), 0);
    }

    function test_gasTable() public pure {
        uint256[3] memory ids = [uint256(8453), 143, 1];
        for (uint256 i; i < 3; i++) {
            MamoruV4Chains.Chain memory ch = MamoruV4Chains.byChainId(ids[i]);
            assertGt(ch.gasPerWindow, 0, "G");
            assertGe(ch.gasWindow, 2 * 5 minutes, "W well over twice the clock slack");
        }
        assertEq(MamoruV4Chains.byChainId(42161).gasPerWindow, 0, "off the table: every op refused");
        // #348: G per day, the values packages/policy V4_GAS_RATE_BY_CHAIN mirrors (Monad raised to 5 MON before T8)
        assertEq(MamoruV4Chains.byChainId(8453).gasPerWindow, 0.002 ether, "Base G");
        assertEq(MamoruV4Chains.byChainId(143).gasPerWindow, 5 ether, "Monad G");
        assertEq(MamoruV4Chains.byChainId(1).gasPerWindow, 0.01 ether, "Ethereum G");
    }

    /// #345 P2-5: every chain caps a CCTP burn's maxFee at 10 bps of the amount, inside V4's hard bound.
    function test_cctpFeeCap() public pure {
        uint256[3] memory ids = [uint256(8453), 143, 1];
        for (uint256 i; i < 3; i++) {
            MamoruV4Chains.Chain memory ch = MamoruV4Chains.byChainId(ids[i]);
            assertEq(ch.cctpFeeCapBps, 10, "10 bps");
            assertLe(ch.cctpFeeCapBps, MAX_CCTP_FEE_CAP_BPS, "hard bound");
        }
        assertEq(MamoruV4Chains.byChainId(42161).cctpFeeCapBps, 0, "off the table");
    }
}
