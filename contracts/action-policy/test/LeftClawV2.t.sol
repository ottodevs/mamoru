// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {PolicyFixture, INPMFull} from "./MamoruActionPolicy.t.sol";
import {deployV2} from "./MamoruActionPolicyV2.t.sol";
import {
    MamoruActionPolicy,
    ConfigId,
    CollectParams,
    DecreaseLiquidityParams,
    MintParams,
    IERC20Min
} from "../src/MamoruActionPolicy.sol";

/**
 * LeftClaw Services audit, job #1041 (2026-10-20, pinned d9e53b8), against MamoruActionPolicyV2 on the Base fork.
 * Each test is the finding's scenario and fails on V2 before its fix: H-1, M-1, M-2, M-3, M-4, M-5, M-6, L-7. The
 * M-2 limit test and the M-4 renewal-race test are the two P2s of the independent review of PR #102 (bcf6bf5).
 */
abstract contract LeftClawFixture is PolicyFixture {
    uint256 constant FAILED = 1;
    uint256 constant REVOKE = 1 << 255; // MamoruActionPolicyV2.REVOKE_FLAG
    ConfigId constant ID2 = ConfigId.wrap(bytes32(uint256(2)));
    ConfigId constant ID3 = ConfigId.wrap(bytes32(uint256(3)));

    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV2(SMART_SESSION, NPM, ROUTER, FACTORY);
    }

    function _enable(ConfigId id, uint64 gen, uint128 perWindow, uint256[] memory admit) internal {
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(
            safe, id, _initData(POOL_BTC, BAND, NO_ANCHOR, false, gen, perWindow, 1_000_000e6, admit)
        );
    }

    function _windows(uint64 gen, uint32 w, uint32 ws) internal pure returns (bytes memory) {
        return abi.encode(
            MamoruActionPolicy.Init({
                pool: POOL_BTC,
                twapWindow: w,
                twapShortWindow: ws,
                bandTicks: BAND,
                generation: gen,
                anchorTick: 0,
                anchorBand: 0,
                budgetIn1: false,
                budgetWindow: 1 days,
                perWindow: 1e6,
                total: 1e6,
                admit: new uint256[](0)
            })
        );
    }

    /// A USDC/USDT position minted straight at the manager, +-100 ticks around the spot (tick spacing 1).
    function _mintStableDirect(address owner, uint256 usdc, uint256 usdt) internal returns (uint256 id, uint128 liq) {
        int24 sp = _spot(POOL_STABLE);
        MintParams memory m =
            MintParams(USDC, USDT, 100, sp - 100, sp + 100, usdc, usdt, 0, 0, owner, block.timestamp);
        deal(USDC, owner, IERC20Min(USDC).balanceOf(owner) + usdc);
        deal(USDT, owner, IERC20Min(USDT).balanceOf(owner) + usdt);
        vm.startPrank(owner);
        IERC20Min(USDC).approve(NPM, usdc);
        IERC20Min(USDT).approve(NPM, usdt);
        (id, liq,,) = INPMFull(NPM).mint(m);
        vm.stopPrank();
    }

    /// A USDC -> cbBTC swap at the policy's own bounds, through `checkAction` under `id`.
    function _swapCheck(ConfigId id, uint256 usdc) internal returns (uint256) {
        uint256 minOut;
        uint160 limit;
        if (usdc != 0) (minOut, limit) = policy.swapBounds(safe, POOL_BTC, USDC, usdc);
        else (, limit) = policy.swapBounds(safe, POOL_BTC, USDC, 1);
        return _checkId(id, ROUTER, _swapData(USDC, CBBTC, 500, usdc, minOut, limit));
    }
}

contract LeftClawV2Test is LeftClawFixture {
    function setUp() public {
        _fork();
    }

    /// H-1: a first enable straight at MAX_GENERATION froze every later renewal and config change of the account.
    function test_H1_firstEnableCannotParkAtTheBound() public {
        uint64 max = policy.MAX_GENERATION();
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.BadInit.selector, 4));
        policy.initializeWithMultiplexer(
            safe, ID, _initData(POOL_BTC, BAND, NO_ANCHOR, false, max, 1e6, 1e6, new uint256[](0))
        );
        // The second route: generation 0 keeps current == 0, so the first-enable cap still holds afterwards.
        _enable(ID, 0, 1e6, new uint256[](0));
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.BadInit.selector, 4));
        policy.initializeWithMultiplexer(
            safe, ID2, _initData(POOL_BTC, BAND, NO_ANCHOR, false, max, 1e6, 1e6, new uint256[](0))
        );
        // A migration's jump stays possible, and a renewal after it steps by one.
        _enable(ID2, 40, 1e6, new uint256[](0));
        _enable(ID3, 41, 1e6, new uint256[](0));
        assertEq(policy.generationOf(safe), 41);
    }

    /// M-1: twapWindow 1800 / short 1700 passed, and two near-equal TWAPs never disagree enough to empty the range.
    function test_M1_windowRatioIsEnforced() public {
        vm.startPrank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.BadInit.selector, 2));
        policy.initializeWithMultiplexer(safe, ID, _windows(1, 1800, 1700));
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.BadInit.selector, 2));
        policy.initializeWithMultiplexer(safe, ID, _windows(1, 1800, 451));
        policy.initializeWithMultiplexer(safe, ID, _windows(1, 1800, 450)); // ratio 4
        vm.stopPrank();
    }

    /// M-2: a third party pushes the spot out of [lo, hi] in the block before the bundle: validation used to pass and
    /// charge the budget for a swap the router then refuses. Now it fails before the charge.
    function test_M2_spotOutsideRangeFailsBeforeCharging() public {
        _enable(ID, 1, 10_000e6, new uint256[](0));
        (uint256 before,) = policy.budgetLeft(safe, POOL_BTC);
        (int24 lo,) = policy.priceRange(safe, POOL_BTC);
        _push(POOL_BTC, USDC, CBBTC, 500, (lo - _spot(POOL_BTC)) - 20); // same block: neither TWAP moves
        assertEq(_swapCheck(ID, 1_000e6), FAILED, "swap validated with the spot outside the range");
        (uint256 afterPush,) = policy.budgetLeft(safe, POOL_BTC);
        assertEq(afterPush, before, "budget charged");
    }

    /// M-3: renewing with a lower perWindow after a full window kept the old debt: 99 days without a charge.
    function test_M3_renewalReclampsDebt() public {
        _enable(ID, 1, 10_000e6, new uint256[](0));
        assertEq(_swapCheck(ID, 10_000e6), 0);
        _enable(ID2, 2, 100e6, new uint256[](0));
        MamoruActionPolicy.Spend memory s = policy.spendOf(safe, POOL_BTC);
        assertLe(s.debt, 100e6, "debt above the new capacity");
        // One budget window later the bucket is full again at the new size.
        _nextBlock(1 days / 2);
        (uint256 window,) = policy.budgetLeft(safe, POOL_BTC);
        assertEq(window, 100e6);
        assertEq(_swapCheck(ID2, 100e6), 0);
    }

    /// M-4 (option C): admission survives a renewal; an owner-signed Init revokes a position explicitly, and only then
    /// the new key cannot manage it. Naming it again re-admits it.
    function test_M4_renewalKeepsPositionUntilRevoked() public {
        (uint256 tokenId,) = _mintDirect(safe, 1_000e6, 1e6);
        uint256[] memory admit = new uint256[](1);
        admit[0] = tokenId;
        bytes memory collect =
            abi.encodeCall(INPMFull.collect, (CollectParams(tokenId, safe, type(uint128).max, type(uint128).max)));

        _enable(ID, 1, 1_000e6, admit);
        assertEq(_checkId(ID, NPM, collect), 0);
        _enable(ID2, 2, 1_000e6, new uint256[](0));
        assertEq(_checkId(ID2, NPM, collect), 0, "renewal without admit keeps the position");
        uint256[] memory revoke = new uint256[](1);
        revoke[0] = tokenId | REVOKE;
        _enable(ID3, 3, 1_000e6, revoke);
        assertEq(_checkId(ID3, NPM, collect), FAILED, "position still managed after an explicit revoke");
        assertEq(MamoruActionPolicy(address(policy)).admittedPool(safe, tokenId), address(0));
        _enable(ConfigId.wrap(bytes32(uint256(4))), 4, 1_000e6, admit);
        assertEq(_checkId(ConfigId.wrap(bytes32(uint256(4))), NPM, collect), 0, "named again");
    }

    /// Review P2 (#102, bcf6bf5): a renewal prepared before the engine minted a position, submitted after, must not
    /// retire the new position (it was never named because it did not exist yet).
    function test_M4_staleRenewalDoesNotRetireANewMint() public {
        deal(USDC, safe, 100_000e6);
        deal(CBBTC, safe, 1e8);
        _enable(ID, 1, 60_000e6, new uint256[](0));
        bytes memory renewal = _initData(POOL_BTC, BAND, NO_ANCHOR, false, 2, 60_000e6, 1_000_000e6, new uint256[](0));
        (uint256 tokenId,) = _mintThroughPolicy(20_000e6, 0.2e8); // under generation 1, after the renewal was built
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(safe, ID2, renewal);
        bytes memory collect =
            abi.encodeCall(INPMFull.collect, (CollectParams(tokenId, safe, type(uint128).max, type(uint128).max)));
        assertEq(_checkId(ID2, NPM, collect), 0, "new position retired by a stale renewal");
    }

    /// Review P2 (#102, bcf6bf5): the engine's limit is narrower than the range edge; a third party pushes the spot
    /// to between the two. The router would revert (SPL: the limit must be strictly past the spot), so validation must
    /// refuse before charging.
    function test_M2_spotPastTheSubmittedLimitFailsBeforeCharging() public {
        _enable(ID, 1, 10_000e6, new uint256[](0));
        (uint256 before,) = policy.budgetLeft(safe, POOL_BTC);
        (int24 lo,) = policy.priceRange(safe, POOL_BTC);
        (uint256 minOut,) = policy.swapBounds(safe, POOL_BTC, USDC, 1_000e6);
        uint160 engineLimit = TickMath.getSqrtRatioAtTick(lo + 20); // narrower than the policy's floor at lo
        bytes memory swap = _swapData(USDC, CBBTC, 500, 1_000e6, minOut, engineLimit);
        _push(POOL_BTC, USDC, CBBTC, 500, (lo + 9) - _spot(POOL_BTC)); // spot in [lo, limit): inside the range
        assertEq(_checkId(ID, ROUTER, swap), FAILED, "validated a swap the pool will revert");
        (uint256 afterPush,) = policy.budgetLeft(safe, POOL_BTC);
        assertEq(afterPush, before, "budget charged");
    }

    /// M-5: an enable whose window budget could walk a thin pool across its band is refused; a normal one passes.
    function test_M5_poolDepthMustCoverTheWindowBudget() public {
        IUniswapV3Pool(POOL_STABLE).increaseObservationCardinalityNext(uint16(TWAP));
        vm.startPrank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.BadInit.selector, 11));
        policy.initializeWithMultiplexer(
            safe,
            ID,
            _initData(POOL_STABLE, STABLE_BAND, STABLE_ANCHOR, false, 1, 10_000_000e6, 10_000_000e6, new uint256[](0))
        );
        policy.initializeWithMultiplexer(
            safe, ID, _initData(POOL_STABLE, STABLE_BAND, STABLE_ANCHOR, false, 1, 50_000e6, 100_000e6, new uint256[](0))
        );
        vm.stopPrank();
    }

    /// M-6: a depeg held past the stables anchor emptied the anchored range, and with it every decrease: the engine
    /// could not take the position out. Decrease now uses the TWAP range alone; swaps keep the anchor.
    function test_M6_depegDoesNotLockTheExit() public {
        IUniswapV3Pool(POOL_STABLE).increaseObservationCardinalityNext(uint16(TWAP));
        (uint256 tokenId, uint128 liq) = _mintStableDirect(safe, 10_000e6, 10_000e6);
        uint256[] memory admit = new uint256[](1);
        admit[0] = tokenId;
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(
            safe, ID, _initData(POOL_STABLE, STABLE_BAND, STABLE_ANCHOR, false, 1, 50_000e6, 100_000e6, admit)
        );
        // USDC up 120 ticks against USDT (outside parity +- 40), held for two hours: both TWAPs follow.
        _push(POOL_STABLE, USDT, USDC, 100, 120 - _spot(POOL_STABLE));
        vm.roll(block.number + 3_600);
        vm.warp(block.timestamp + 7_200);
        vm.expectPartialRevert(MamoruActionPolicy.RangeEmpty.selector);
        policy.priceRange(safe, POOL_STABLE); // the anchored range (swaps, mint, increase) is empty
        (uint256 min0, uint256 min1) = policy.decreaseMins(safe, POOL_STABLE, tokenId, liq);
        bytes memory dec = abi.encodeCall(
            INPMFull.decreaseLiquidity, (DecreaseLiquidityParams(tokenId, liq, min0, min1, block.timestamp))
        );
        assertEq(_checkId(ID, NPM, dec), 0, "exit locked by the anchor");
    }

    /// L-7: amountIn 0 is SwapRouter02's "contract balance" sentinel: no floor and no charge.
    function test_L7_zeroAmountSwapRefused() public {
        _enable(ID, 1, 1_000e6, new uint256[](0));
        assertEq(_swapCheck(ID, 0), FAILED);
    }
}

/// Drives renewals, swaps and time on the fork; the invariants below read the policy's state after each call.
contract LeftClawHandler is Test {
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant POOL_BTC = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;

    MamoruActionPolicy immutable policy;
    address immutable safe;
    bytes init0;
    uint64 public gen;
    uint256 public renewals;

    constructor(MamoruActionPolicy p, address s, bytes memory firstInit) {
        policy = p;
        safe = s;
        init0 = firstInit;
    }

    function _id() internal view returns (ConfigId) {
        return ConfigId.wrap(bytes32(uint256(gen)));
    }

    /// The owner renews (next generation) with any perWindow between 1 and 20,000 USDC.
    function renew(uint256 perWindow) external {
        perWindow = bound(perWindow, 1e6, 20_000e6);
        MamoruActionPolicy.Init memory i = abi.decode(init0, (MamoruActionPolicy.Init));
        i.generation = gen + 1;
        i.perWindow = uint128(perWindow);
        i.total = uint128(perWindow * 10);
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(safe, ConfigId.wrap(bytes32(uint256(gen + 1))), abi.encode(i));
        gen++;
        renewals++;
    }

    /// The session swaps any amount up to 30,000 USDC at the policy's bounds (refused or charged).
    function swap(uint256 usdc) external {
        if (gen == 0) return;
        usdc = bound(usdc, 1, 30_000e6);
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, usdc);
        bytes memory data = abi.encodeWithSelector(
            0x04e45aaf, USDC, CBBTC, uint24(500), safe, usdc, minOut, limit
        );
        vm.prank(SMART_SESSION);
        policy.checkAction(_id(), safe, ROUTER, 0, data);
    }

    function wait(uint256 secs) external {
        secs = bound(secs, 1, 3 days);
        vm.roll(block.number + secs / 2 + 1);
        vm.warp(block.timestamp + secs);
    }
}

contract LeftClawV2Invariants is LeftClawFixture {
    LeftClawHandler handler;

    function setUp() public {
        _fork();
        handler = new LeftClawHandler(
            policy, safe, _initData(POOL_BTC, BAND, NO_ANCHOR, false, 0, 1e6, 1e6, new uint256[](0))
        );
        targetContract(address(handler));
    }

    /// M-3: the stored debt never exceeds the current capacity, whatever renewals did.
    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 24
    function invariant_debtWithinCapacity() public view {
        MamoruActionPolicy.Spend memory s = policy.spendOf(safe, POOL_BTC);
        MamoruActionPolicy.Config memory c = policy.configOf(safe, POOL_BTC);
        if (c.twapWindow != 0) assertLe(s.debt, c.perWindow);
    }

    /// E-1: a generation never spends past its approval.
    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 24
    function invariant_spendWithinTotal() public view {
        MamoruActionPolicy.Spend memory s = policy.spendOf(safe, POOL_BTC);
        MamoruActionPolicy.Config memory c = policy.configOf(safe, POOL_BTC);
        if (s.generation == c.generation) assertLe(s.total, c.total);
    }

    /// H-1: the generation moves only one step per renewal.
    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 24
    function invariant_generationStepsByOne() public view {
        assertEq(policy.generationOf(safe), handler.renewals());
    }
}
