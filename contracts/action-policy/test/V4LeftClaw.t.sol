// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {V4Fixture, IERC20T} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, MamoruV4Helper, InitV4, SwapParams} from "../src/MamoruActionPolicyV4.sol";
import {MamoruV4Lens} from "../src/MamoruV4Lens.sol";
import {ConfigIdV4} from "../src/SmartSessionTypes.sol";

struct MarketParamsT {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorphoT {
    function createMarket(MarketParamsT memory marketParams) external;
    function market(bytes32 id) external view returns (uint128, uint128, uint128, uint128, uint128, uint128);
}

interface IMetaMorphoT {
    function setCurator(address) external;
    function setIsAllocator(address, bool) external;
    function submitCap(MarketParamsT memory marketParams, uint256 newSupplyCap) external;
    function acceptCap(MarketParamsT memory marketParams) external;
    function setSupplyQueue(bytes32[] calldata newSupplyQueue) external;
}

interface IERC4626T {
    function convertToAssets(uint256 shares) external view returns (uint256);
}

interface IMetaMorphoFactoryT {
    function createMetaMorpho(address owner, uint256 timelock, address asset, string memory name, string memory symbol, bytes32 salt)
        external
        returns (address);
    function isMetaMorpho(address) external view returns (bool);
}

/**
 * The LeftClaw audit's findings (job #1041; test/LeftClawV2.t.sol) ported to MamoruActionPolicyV4, where V4 moved
 * them: M-1 and the hard bounds now apply to the classes in code (test/MamoruV4Classes.t.sol checks every row against
 * them), M-3 to the account bucket when a renewal lowers C. H-1, M-2, M-4, M-5, M-6 and L-7 are in
 * test/MamoruActionPolicyV4.t.sol. Plus an invariant run on the fork (LeftClawV2Invariants' shape) and the residual of
 * the vault family.
 */
contract V4LeftClawTest is V4Fixture {
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    function setUp() public {
        _forkBase();
        _init(acct);
        deal(USDC, acct, 1_000_000e6);
        deal(CBBTC, acct, 10e8);
    }

    /// M-3, ported: a renewal that lowers C carries at most a full (new) bucket, refilling from then.
    function test_M3_renewalReclampsTheBucket() public {
        _swap(acct, POOL_BTC, USDC, 3_000e6);
        _init(acct, ConfigIdV4.wrap(bytes32(uint256(2))), 1_000e6, 2, new uint256[](0));
        (uint256 bucket,,,) = v4.budgetLeft(acct, CBBTC, 3_500);
        assertEq(bucket, 0, "carried debt clamped to the new capacity: empty, not weeks of debt");
        _nextBlock(1 days);
        (bucket,,,) = v4.budgetLeft(acct, CBBTC, 3_500);
        assertEq(bucket, 1_000e6, "refilled at the new size one window later");
    }

    /// M-3 (peer gate P2 of #102), ported: the refill up to the renewal is settled at the old rate first, so a full
    /// bucket stays full when C drops.
    function test_M3_clampSettlesTheRefillFirst() public {
        _swap(acct, POOL_BTC, USDC, 3_000e6);
        _nextBlock(1 days); // refilled at the old rate
        _init(acct, ConfigIdV4.wrap(bytes32(uint256(2))), 100e6, 2, new uint256[](0));
        (uint256 bucket,,,) = v4.budgetLeft(acct, CBBTC, 3_500);
        assertEq(bucket, 100e6, "refilled bucket read as spent");
    }

    /// Spec 010 A1 "Vaults": a hostile curator's own vault, created through the pinned MetaMorpho factory with an idle
    /// USDC market as its only market, is not in V4's exact list, so nothing reaches it (r2 needed a factory check,
    /// the vault ratio and a registry admin who would not list it; A1 needs none of them).
    function test_A1_hostileCuratorVaultNotListed() public {
        address v = _hostileCuratorVault();
        assertTrue(IMetaMorphoFactoryT(0xFf62A7c278C62eD665133147129245053Bbf5918).isMetaMorpho(v), "a factory vault");
        _approveV4(acct, USDC, type(uint256).max);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.BadVault.selector, v));
        v4.deposit(v, 1_000e6);
    }

    /// Review r1 of #200 (P1): the funds at risk in the listed vault (gtUSDCp, 50 % of C) are capped, not only the
    /// deposit rate: the account's position never passes ratio x C, by the vault's own accounting rounded against the
    /// depositor, however many deposits are spaced past every window. Its curator (Gauntlet) can still reallocate within
    /// Morpho's rules: that is the venue risk this cap bounds (spec 009 POL-07).
    function test_listedVaultExposureCapped() public {
        address v = GT_USDCP;
        _approveV4(acct, USDC, type(uint256).max);
        uint256 cap = uint256(C) * 5_000 / 10_000;
        vm.prank(acct);
        uint256 first = v4.deposit(v, cap - 1e6); // the whole share, in one call (less a dollar of vault rounding)
        vm.prank(acct);
        vm.expectPartialRevert(MamoruActionPolicyV4.VaultExposure.selector);
        v4.deposit(v, 2e6);
        for (uint256 k; k < 3; k++) {
            _nextBlock(32 days); // past the bucket, the 24 h cap and the 30-day window
            vm.prank(acct);
            vm.expectPartialRevert(MamoruActionPolicyV4.VaultExposure.selector);
            v4.deposit(v, uint256(C));
        }
        uint256 held = IERC4626T(v).convertToAssets(IERC20T(v).balanceOf(acct));
        console2.log("held in the listed vault after 4 attempts over 96 days (USDC units, yield included)", held);
        assertEq(IERC20T(v).balanceOf(acct), first, "no deposit got in: the cap holds against the vault's own accounting");
        // a redeem frees room again: the cap is on the position, not on history
        uint256 shares = IERC20T(v).balanceOf(acct);
        _approveV4(acct, v, shares / 2);
        vm.prank(acct);
        v4.redeem(v, shares / 2);
        vm.prank(acct);
        v4.deposit(v, cap / 4);
        assertLe(IERC4626T(v).convertToAssets(IERC20T(v).balanceOf(acct)), cap, "after a deposit, still <= ratio x C");
    }

    /// A MetaMorpho v1.1 vault the attacker owns, curates and allocates, whose only market is Morpho Blue's idle USDC
    /// market (no collateral, no oracle): deposits sit in it, and its curator controls where they go next.
    function _hostileCuratorVault() internal returns (address v) {
        MarketParamsT memory idle = MarketParamsT(USDC, address(0), address(0), address(0), 0);
        bytes32 id = keccak256(abi.encode(idle));
        (,,,, uint128 lastUpdate,) = IMorphoT(MORPHO).market(id);
        if (lastUpdate == 0) IMorphoT(MORPHO).createMarket(idle);
        vm.startPrank(attacker);
        v = IMetaMorphoFactoryT(0xFf62A7c278C62eD665133147129245053Bbf5918).createMetaMorpho(
            attacker, 1 days, USDC, "evil", "EVIL", bytes32("x")
        );
        IMetaMorphoT(v).setCurator(attacker);
        IMetaMorphoT(v).setIsAllocator(attacker, true);
        IMetaMorphoT(v).submitCap(idle, type(uint184).max);
        vm.stopPrank();
        _nextBlock(1 days + 1);
        vm.startPrank(attacker);
        IMetaMorphoT(v).acceptCap(idle);
        bytes32[] memory q = new bytes32[](1);
        q[0] = id;
        IMetaMorphoT(v).setSupplyQueue(q);
        vm.stopPrank();
    }
}

/// Drives renewals (any C), swaps (any size, refused or charged) and time on the fork.
contract V4LeftClawHandler is Test {
    MamoruActionPolicyV4 immutable v4;
    MamoruV4Lens immutable lens;
    address immutable acct;
    address immutable pool;
    address immutable usdc;
    address immutable btc;
    uint64 public gen = 1;
    uint256 public renewals;
    uint128 public maxCap;

    constructor(MamoruActionPolicyV4 p, MamoruV4Lens l, address a, address pl, address u, address b, uint128 c) {
        (v4, lens, acct, pool, usdc, btc, maxCap) = (p, l, a, pl, u, b, c);
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
        address tIn = usdcIn ? usdc : btc;
        amount = bound(amount, 1, usdcIn ? 20_000e6 : 0.2e8);
        (uint256 minOut, uint160 limit) = lens.swapBounds(pool, tIn, amount);
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
        _init(acct);
        deal(USDC, acct, 10_000_000e6);
        deal(CBBTC, acct, 100e8);
        handler = new V4LeftClawHandler(v4, lens, acct, POOL_BTC, USDC, CBBTC, C);
        targetContract(address(handler));
    }

    /// H-1: the generation moves one step per renewal.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 20
    function invariant_generationStepsByOne() public view {
        assertEq(v4.generationOf(acct), 1 + handler.renewals());
    }

    /// I5 (A1): the rolling 24 h and 30-day spend never pass C and 3C of the largest C the owner ever signed; the
    /// room views say so whatever the handler did (refused calls write nothing).
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 20
    function invariant_rollingCapsHold() public view {
        uint256 cap = v4.configOf(acct).capUsd;
        (,, uint256 cap30, uint256 room24) = v4.budgetLeft(acct, CBBTC, 3_500);
        assertLe(room24, cap);
        assertLe(cap30, 3 * cap);
        assertLe(cap, handler.maxCap());
    }

    /// I5 / M-3: the room views never underflow, whatever renewals did to C.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 20
    function invariant_budgetViewsConsistent() public view {
        uint256 cap = v4.configOf(acct).capUsd;
        (uint256 bucket, uint256 sub, uint256 cap30, uint256 room24) = v4.budgetLeft(acct, CBBTC, 3_500);
        assertLe(bucket, cap);
        assertLe(sub, cap * 3_500 / 10_000);
        assertLe(cap30, 3 * cap);
        assertLe(room24, cap);
    }
}
