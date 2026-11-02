// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {V4Fixture, IERC20T} from "./V4Fixture.sol";
import {
    MamoruActionPolicyV4,
    InitV4,
    SwapParams,
    PoolEntryV4,
    VaultEntryV4
} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {ConfigIdV4} from "../src/SmartSessionTypes.sol";

/// A registry that returns whatever entry it is told to: V4's own bounds must refuse what MamoruRegistry never stores.
contract LooseRegistry {
    mapping(address => PoolEntryV4) public entry;

    function set(address pool, PoolEntryV4 calldata e) external {
        entry[pool] = e;
    }

    function poolOf(address pool) external view returns (PoolEntryV4 memory) {
        return entry[pool];
    }

    function vaultOf(address) external pure returns (VaultEntryV4 memory) {}

    function routeOn(uint32) external pure returns (bool) {
        return false;
    }
}

interface IMetaMorphoFactoryT {
    function createMetaMorpho(address owner, uint256 timelock, address asset, string memory name, string memory symbol, bytes32 salt)
        external
        returns (address);
    function isMetaMorpho(address) external view returns (bool);
}

/**
 * The LeftClaw audit's findings (job #1041; test/LeftClawV2.t.sol) ported to MamoruActionPolicyV4, where V4 moved
 * them: M-1 and the hard bounds now apply to the registry's entries (and are re-checked by V4 itself), M-3 to the
 * account bucket when a renewal lowers C. H-1, M-2, M-4, M-5, M-6 and L-7 are in test/MamoruActionPolicyV4.t.sol.
 * Plus an invariant run on the fork (LeftClawV2Invariants' shape) and the residual of the vault family.
 */
contract V4LeftClawTest is V4Fixture {
    function setUp() public {
        _forkBase();
        _listPool(POOL_BTC, 100, 0, 0, 10_000);
        _init(acct);
        deal(USDC, acct, 1_000_000e6);
        deal(CBBTC, acct, 10e8);
    }

    /// M-1 and V3's hard bounds, at V4's side: an entry outside them is refused as if unlisted, whatever a registry says.
    function test_M1_entriesOutsideTheHardBoundsAreRefusedByV4() public {
        LooseRegistry loose = new LooseRegistry();
        MamoruActionPolicyV4 p = new MamoruActionPolicyV4(address(loose), address(gasPol), guardian);
        vm.prank(SMART_SESSION);
        p.initializeWithMultiplexer(acct, ID, abi.encode(InitV4(C, 1, address(0), 0, new uint256[](0))));
        PoolEntryV4[6] memory bad = [
            PoolEntryV4(1800, 451, 100, 0, 0, 10_000, true), // M-1: long < 4 short windows
            PoolEntryV4(599, 60, 100, 0, 0, 10_000, true), // long window under 600 s
            PoolEntryV4(1800, 59, 100, 0, 0, 10_000, true), // short window under 60 s
            PoolEntryV4(1800, 300, 501, 0, 0, 10_000, true), // band over 500
            PoolEntryV4(1800, 300, 100, 0, 501, 10_000, true), // anchor band over 500
            PoolEntryV4(1800, 300, 100, 0, 0, 10_001, true) // share over 100 %
        ];
        SwapParams memory s = SwapParams(POOL_BTC, USDC, 1_000e6, 0, 1, vm.getBlockTimestamp());
        vm.prank(acct);
        IERC20T(USDC).approve(address(p), type(uint256).max);
        for (uint256 i; i < bad.length; i++) {
            loose.set(POOL_BTC, bad[i]);
            vm.prank(acct);
            vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NotListed.selector, POOL_BTC));
            p.swap(s);
        }
    }

    /// M-3, ported: a renewal that lowers C carries at most a full (new) bucket, refilling from then.
    function test_M3_renewalReclampsTheBucket() public {
        _swap(acct, POOL_BTC, USDC, 6_000e6);
        _init(acct, ConfigIdV4.wrap(bytes32(uint256(2))), 1_000e6, 2, new uint256[](0));
        (uint256 bucket,,,,) = v4.budgetLeft(acct, POOL_BTC, 10_000);
        assertEq(bucket, 0, "carried debt clamped to the new capacity: empty, not weeks of debt");
        _nextBlock(1 days);
        (bucket,,,,) = v4.budgetLeft(acct, POOL_BTC, 10_000);
        assertEq(bucket, 1_000e6, "refilled at the new size one window later");
    }

    /// M-3 (peer gate P2 of #102), ported: the refill up to the renewal is settled at the old rate first, so a full
    /// bucket stays full when C drops.
    function test_M3_clampSettlesTheRefillFirst() public {
        _swap(acct, POOL_BTC, USDC, 9_000e6);
        _nextBlock(1 days); // refilled at the old rate
        _init(acct, ConfigIdV4.wrap(bytes32(uint256(2))), 100e6, 2, new uint256[](0));
        (uint256 bucket,,,,) = v4.budgetLeft(acct, POOL_BTC, 10_000);
        assertEq(bucket, 100e6, "refilled bucket read as spent");
    }

    /// Spec 010 r1 finding 3, the residual: anyone can create a MetaMorpho vault through the pinned factory, so a
    /// factory vault with a hostile curator passes V4's membership check once the admin lists it (after 72 h in public,
    /// guardian can cancel). What bounds it is the vault's share of the bucket, the 24 h breaker and the 30-day cap:
    /// at the loosest entry (ratio 10,000) the account can lose at most C in a day through it.
    function test_factoryVaultByAnyoneIsAdmissibleButCapped() public {
        vm.prank(attacker);
        address v = IMetaMorphoFactoryT(0xFf62A7c278C62eD665133147129245053Bbf5918).createMetaMorpho(
            attacker, 1 days, USDC, "evil", "EVIL", bytes32("x")
        );
        assertEq(helper.vaultAsset(v), USDC, "an attacker's own factory vault passes V4's membership check");
        // The cap, shown on a real third-party factory vault (steakUSDC) at the loosest entry
        _listVault(STEAK_USDC, 10_000);
        _approveV4(acct, USDC, type(uint256).max);
        vm.prank(acct);
        v4.deposit(STEAK_USDC, uint256(C)); // the whole bucket, in one call
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BudgetExceeded.selector, address(0), 1));
        v4.deposit(STEAK_USDC, 1);
        console2.log("most an account can put into one listed factory vault in 24 h (USDC units)", uint256(C));
    }
}

/// Drives renewals (any C), swaps (any size, refused or charged) and time on the fork.
contract V4LeftClawHandler is Test {
    MamoruActionPolicyV4 immutable v4;
    address immutable acct;
    address immutable pool;
    address immutable usdc;
    address immutable btc;
    uint64 public gen = 1;
    uint256 public renewals;
    uint128 public maxCap;

    constructor(MamoruActionPolicyV4 p, address a, address pl, address u, address b, uint128 c) {
        (v4, acct, pool, usdc, btc, maxCap) = (p, a, pl, u, b, c);
    }

    function renew(uint256 cap) external {
        cap = bound(cap, 100e6, 50_000e6);
        if (cap > maxCap) maxCap = uint128(cap);
        gen++;
        vm.prank(0x00000000002B0eCfbD0496EE71e01257dA0E37DE);
        v4.initializeWithMultiplexer(acct, ConfigIdV4.wrap(bytes32(uint256(gen))), abi.encode(InitV4(uint128(cap), gen, address(0), 0, new uint256[](0))));
        renewals++;
    }

    function swap(uint256 amount, bool usdcIn) external {
        if (v4.isPaused(acct)) {
            vm.prank(v4.GUARDIAN());
            v4.unpause(acct);
        }
        address tIn = usdcIn ? usdc : btc;
        amount = bound(amount, 1, usdcIn ? 20_000e6 : 0.2e8);
        (uint256 minOut, uint160 limit) = v4.HELPER().swapBounds(pool, tIn, amount);
        vm.prank(acct);
        IERC20T(tIn).approve(address(v4), amount);
        vm.prank(acct);
        try v4.swap(SwapParams(pool, tIn, amount, minOut, limit, vm.getBlockTimestamp())) {} catch {}
    }

    function wait(uint256 secs) external {
        secs = bound(secs, 1, 3 days);
        vm.roll(vm.getBlockNumber() + secs / 2 + 1);
        vm.warp(vm.getBlockTimestamp() + secs);
    }
}

contract V4LeftClawInvariants is V4Fixture {
    V4LeftClawHandler handler;

    function setUp() public {
        _forkBase();
        _listPool(POOL_BTC, 100, 0, 0, 10_000);
        _init(acct);
        deal(USDC, acct, 10_000_000e6);
        deal(CBBTC, acct, 100e8);
        handler = new V4LeftClawHandler(v4, acct, POOL_BTC, USDC, CBBTC, C);
        targetContract(address(handler));
    }

    /// H-1: the generation moves one step per renewal.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 20
    function invariant_generationStepsByOne() public view {
        assertEq(v4.generationOf(acct), 1 + handler.renewals());
    }

    /// I5: the review counter never passes 10 x the largest C the owner ever signed (it pauses first).
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 20
    function invariant_reviewCounterBounded() public view {
        assertLe(v4.spentSinceReview(acct), 10 * uint256(handler.maxCap()));
    }

    /// I5 / M-3: the room views never underflow, whatever renewals did to C.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 20
    function invariant_budgetViewsConsistent() public view {
        uint256 cap = v4.configOf(acct).capUsd;
        (uint256 bucket, uint256 sub, uint256 cap30, uint256 breaker,) = v4.budgetLeft(acct, POOL_BTC, 10_000);
        assertLe(bucket, cap);
        assertLe(sub, cap);
        assertLe(cap30, 3 * cap);
        assertLe(breaker, cap);
    }
}
