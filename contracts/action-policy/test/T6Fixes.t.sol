// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {OracleLibrary} from "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
import {PolicyFixture, INPMFull} from "./MamoruActionPolicy.t.sol";
import {
    MamoruActionPolicy,
    ConfigId,
    MintParams,
    DecreaseLiquidityParams,
    CollectParams,
    IERC20Min
} from "../src/MamoruActionPolicy.sol";

/**
 * T6 audit fixes (specs/007-onchain-action-policy/results/t6-audit-claude-2026-10-18.md), one test per finding.
 * The same attacks run against the T4 contract (031be60) in T6Before.t.sol, where they succeed.
 */
contract T6FixesTest is PolicyFixture {
    function setUp() public {
        _fork();
        deal(USDC, safe, 1_000_000e6);
        deal(CBBTC, safe, 10e8);
        deal(USDT, safe, 1_000_000e6);
    }

    function _none() internal pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    function _enable(ConfigId id, bytes memory initData) internal {
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(safe, id, initData);
    }

    /// L-4's deploy step, as script/Deploy.s.sol runs it: raise the stables pool's ring to hold 1,800 observations.
    function _raiseStableCardinality() internal {
        IUniswapV3Pool(POOL_STABLE).increaseObservationCardinalityNext(uint16(TWAP));
    }

    function _swapAtTick(address tIn, address tOut, uint24 fee, uint256 amountIn, int24 tick)
        internal
        view
        returns (bytes memory)
    {
        uint256 q = OracleLibrary.getQuoteAtTick(tick, uint128(amountIn), tIn, tOut);
        return _swapData(tIn, tOut, fee, amountIn, (q * (1e6 - fee)) / 1e6, TickMath.getSqrtRatioAtTick(tick));
    }

    // ================================================================ H-1: one block held far away

    /// The attacker is the last swap of block N (USDC/USDT pushed 9,000 ticks down, ~127k USDC of its own capital)
    /// and the first swap of block N+1 (pushed back). Measured on this fork: the 30-min TWAP moves 10 ticks, the
    /// whole stables band, for ~25 USDC of fees. T4 accepts a swap priced off that shifted TWAP. Now the push also
    /// moves the 5-min TWAP 60 ticks, the two are more than 2 x band apart, and the range is empty.
    function test_H1_oneBlockOutlierOnStablesIsRefused() public {
        _raiseStableCardinality();
        _enable(ID, _initData(POOL_STABLE, STABLE_BAND, STABLE_ANCHOR, false, 1, 20_000e6, 100_000e6, _none()));
        int24 twap0 = _twapOf(POOL_STABLE, TWAP);
        (int24 lo0,) = policy.priceRange(safe, POOL_STABLE);
        assertEq(lo0, twap0 - int24(STABLE_BAND) + 1, "no shift yet: lo = twap - band + 1");

        (uint256 spent, uint256 usdtOut) = _push(POOL_STABLE, USDC, USDT, 100, -9_000);
        _nextBlock(1);
        _sell(USDT, USDC, 100, usdtOut);
        int24 twap1 = _twapOf(POOL_STABLE, TWAP);
        console2.log(
            "H-1 stables: capital (USDC), long TWAP shift (ticks)", spent / 1e6, uint256(int256(twap0 - twap1))
        );
        assertGe(twap0 - twap1, int24(STABLE_BAND), "the one-block outlier shifts the long TWAP by the band");

        // The Safe sells 10k USDC at the shifted band edge: 2 x band under the market.
        bytes memory swap = _swapAtTick(USDC, USDT, 100, 10_000e6, twap1 - int24(STABLE_BAND) + 1);
        assertEq(_check(ROUTER, swap), 1, "priced off a pushed TWAP: refused");
        vm.expectPartialRevert(MamoruActionPolicy.RangeEmpty.selector);
        policy.priceRange(safe, POOL_STABLE);
    }

    /// Pushes that survive the two-TWAP rule: one push far away more than 5 minutes ago (moves only the long TWAP)
    /// plus one recent push (moves both), sized about 5:1 so the two TWAPs agree. On USDC/USDT both are cheap
    /// (~25 USDC of fees each). The parity anchor bounds what they buy: the range never leaves
    /// [anchor - 40, anchor + 40], so it is clipped (a ~50-tick shift) or empty (a ~100-tick shift).
    function test_H1_spreadPushOnStablesIsBoundedByTheAnchor() public {
        _raiseStableCardinality();
        _enable(ID, _initData(POOL_STABLE, STABLE_BAND, STABLE_ANCHOR, false, 1, 20_000e6, 100_000e6, _none()));
        uint256 snap = vm.snapshotState();
        (int24 tl, int24 ts) = _spreadPush(-37_500, -7_500);
        console2.log(
            "H-1 spread push ~50: long / short TWAP now (ticks, +1000)",
            uint256(int256(tl) + 1000),
            uint256(int256(ts) + 1000)
        );
        (int24 lo, int24 hi) = policy.priceRange(safe, POOL_STABLE);
        int24 top = tl > ts ? tl : ts;
        assertLt(top - int24(STABLE_BAND) + 1, -int24(STABLE_ANCHOR), "unclipped, the floor would be past the anchor");
        assertEq(lo, -int24(STABLE_ANCHOR), "clipped to the anchor");
        assertGe(hi, lo);
        assertEq(_check(ROUTER, _swapAtTick(USDC, USDT, 100, 10_000e6, top - int24(STABLE_BAND) + 1)), 1);
        // V2 refuses it at validation while the spot itself sits outside the clipped range (LeftClaw M-2).
        uint256 expected = _validatesSpot() && !_spotInRange(POOL_STABLE, lo, hi) ? 1 : 0;
        assertEq(_check(ROUTER, _swapAtTick(USDC, USDT, 100, 10_000e6, lo)), expected);
        vm.revertToState(snap);

        (tl, ts) = _spreadPush(-75_000, -15_000);
        console2.log(
            "H-1 spread push ~100: long / short TWAP now (ticks, +1000)",
            uint256(int256(tl) + 1000),
            uint256(int256(ts) + 1000)
        );
        vm.expectPartialRevert(MamoruActionPolicy.RangeEmpty.selector);
        policy.priceRange(safe, POOL_STABLE);
    }

    /// One block at `oldTicks` from spot, 10 minutes of nothing, one block at `recentTicks`; returns both TWAPs.
    function _spreadPush(int24 oldTicks, int24 recentTicks) internal returns (int24 tl, int24 ts) {
        (, uint256 usdtOld) = _push(POOL_STABLE, USDC, USDT, 100, oldTicks);
        _nextBlock(1);
        _sell(USDT, USDC, 100, usdtOld);
        vm.warp(block.timestamp + 600);
        vm.roll(block.number + 300);
        (, uint256 usdtNew) = _push(POOL_STABLE, USDC, USDT, 100, recentTicks);
        _nextBlock(1);
        _sell(USDT, USDC, 100, usdtNew);
        tl = _twapOf(POOL_STABLE, TWAP);
        ts = _twapOf(POOL_STABLE, TWAP_SHORT);
    }

    /// The same one-block push inside the dense core (10 ticks): no false refusal, and the range moves 1 tick at most.
    function test_H1_denseCoreOutlierPassesAndBarelyMoves() public {
        _raiseStableCardinality();
        _enable(ID, _initData(POOL_STABLE, STABLE_BAND, STABLE_ANCHOR, false, 1, 20_000e6, 100_000e6, _none()));
        (int24 lo0, int24 hi0) = policy.priceRange(safe, POOL_STABLE);
        (, uint256 usdtOut) = _push(POOL_STABLE, USDC, USDT, 100, -10);
        _nextBlock(1);
        _sell(USDT, USDC, 100, usdtOut);
        (int24 lo1, int24 hi1) = policy.priceRange(safe, POOL_STABLE);
        assertLe(lo0 - lo1, 1);
        assertLe(hi0 - hi1, 1);
    }

    /// USDC/cbBTC: one block 90,000 ticks away (13.5M USDC of the attacker's own capital, ~8.8k of fees) moves the
    /// long TWAP by the whole 100-tick band; T4 accepted it. It moves the short one 600 ticks: the range is empty.
    function test_H1_oneBlockOutlierOnBtcIsRefused() public {
        _initBtc(ID, 1, 300_000e6, 3_000_000e6);
        int24 tl0 = _twapOf(POOL_BTC, TWAP);
        (, uint256 btcOut) = _push(POOL_BTC, USDC, CBBTC, 500, -90_000);
        _nextBlock(1);
        _sell(CBBTC, USDC, 500, btcOut);
        assertGe(tl0 - _twapOf(POOL_BTC, TWAP), int24(BAND));
        vm.expectPartialRevert(MamoruActionPolicy.RangeEmpty.selector);
        policy.priceRange(safe, POOL_BTC);
        bytes memory swap = _swapAtTick(USDC, CBBTC, 500, 10_000e6, _twapOf(POOL_BTC, TWAP) - int24(BAND) + 1);
        assertEq(_check(ROUTER, swap), 1);
    }

    /// An old push alone (more than 5 minutes ago) moves only the long TWAP: the range keeps the short one's edge on
    /// the side that matters, so nothing the Safe does gets a worse price.
    function test_H1_oldPushAloneDoesNotLoosenTheRange() public {
        _initBtc(ID, 1, 300_000e6, 3_000_000e6);
        (int24 lo0,) = policy.priceRange(safe, POOL_BTC);
        (, uint256 btcOut) = _push(POOL_BTC, USDC, CBBTC, 500, -90_000);
        _nextBlock(1);
        _sell(CBBTC, USDC, 500, btcOut);
        vm.warp(block.timestamp + 400);
        vm.roll(block.number + 200);
        int24 tl = _twapOf(POOL_BTC, TWAP);
        int24 ts = _twapOf(POOL_BTC, TWAP_SHORT);
        assertGe(ts - tl, 90, "the long TWAP is ~100 ticks down, the short one is not");
        (int24 lo1, int24 hi1) = policy.priceRange(safe, POOL_BTC);
        assertEq(lo1, ts - int24(BAND) + 1, "selling token0: the floor follows the unpushed short TWAP");
        assertGe(lo1, lo0 - 5, "(the round trip itself leaves spot a few ticks lower)");
        assertEq(hi1, tl + int24(BAND), "buying token0: the ceiling only dropped");
    }

    // ================================================================ M-1: safer side of a long and a short TWAP

    /// cbBTC falls steadily: USDC/cbBTC (token0 USDC) ticks up 120 over 30 minutes. The 30-min TWAP trails spot by
    /// ~60 ticks, the 5-min one by ~10. T4 put the Safe's USDC sale floor at twap30 - band (~160 ticks under the
    /// market); now it is max(twap30, twap5) - band + 1, and the same for the mint's spot check.
    function test_M1_rangeUsesTheSaferOfTwoTwaps() public {
        _initBtc(ID, 1, 300_000e6, 3_000_000e6);
        for (uint256 i; i < 30; i++) {
            _nextBlock(30);
            _push(POOL_BTC, CBBTC, USDC, 500, 4);
        }
        _nextBlock(1);
        int24 spot = _spot(POOL_BTC);
        int24 tl = _twapOf(POOL_BTC, TWAP);
        int24 ts = _twapOf(POOL_BTC, TWAP_SHORT);
        console2.log(
            "M-1 ramp: spot - twap30, spot - twap5 (ticks)", uint256(int256(spot - tl)), uint256(int256(spot - ts))
        );
        assertGt(ts, tl + 30, "the short TWAP is closer to the market");

        (int24 lo, int24 hi) = policy.priceRange(safe, POOL_BTC);
        assertEq(lo, ts - int24(BAND) + 1, "lo from the higher (short) TWAP");
        assertEq(hi, tl + int24(BAND), "hi from the lower (long) TWAP");

        // T4's floor (long TWAP - band) is refused now.
        assertEq(_check(ROUTER, _swapAtTick(USDC, CBBTC, 500, 10_000e6, tl - int24(BAND))), 1);
        assertEq(_check(ROUTER, _swapAtTick(USDC, CBBTC, 500, 10_000e6, lo)), 0);

        // Mint: spot pushed to where T4 still accepted it (twap30 - band + 5) is refused.
        _push(POOL_BTC, USDC, CBBTC, 500, (tl - int24(BAND) + 5) - _spot(POOL_BTC));
        int24 s = _spot(POOL_BTC);
        MintParams memory m = MintParams(
            USDC, CBBTC, 500, ((s - 600) / 10) * 10, ((s + 600) / 10) * 10, 10_000e6, 0.1e8, 0, 0, safe, block.timestamp
        );
        _exec(USDC, abi.encodeCall(IERC20Min.approve, (address(policy), 10_000e6)));
        _exec(CBBTC, abi.encodeCall(IERC20Min.approve, (address(policy), 0.1e8)));
        vm.prank(safe);
        vm.expectPartialRevert(MamoruActionPolicy.SpotOutsideRange.selector);
        policy.mint(m);
    }

    /// L-7: the range edges are floored ticks; lo gets +1 so the true mean is never more than `band` away.
    function test_L7_loIsOneTickInsideTheFlooredMean() public {
        _initBtc(ID, 1, 300_000e6, 3_000_000e6);
        int24 tl = _twapOf(POOL_BTC, TWAP);
        int24 ts = _twapOf(POOL_BTC, TWAP_SHORT);
        int24 top = tl > ts ? tl : ts;
        int24 bottom = tl > ts ? ts : tl;
        (int24 lo, int24 hi) = policy.priceRange(safe, POOL_BTC);
        assertEq(lo, top - int24(BAND) + 1);
        assertEq(hi, bottom + int24(BAND));
        (, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, 1e6);
        assertEq(limit, TickMath.getSqrtRatioAtTick(lo));
    }

    // ================================================================ M-2: one value budget per pool

    /// Round trip USDC -> cbBTC -> USDC under a 100k budget. T4 charged token0 and token1 separately, each at the
    /// full budget, so ~2x crossed. Now both legs draw on one budget in USDC (cbBTC valued at the range edge that
    /// prices it highest).
    function test_M2_roundTripDrawsOnOneBudget() public {
        _initBtc(ID, 1, 100_000e6, 100_000e6);
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, 60_000e6);
        assertEq(_check(ROUTER, _swapData(USDC, CBBTC, 500, 60_000e6, minOut, limit)), 0);
        // cbBTC worth ~50k USDC: over what is left (40k).
        uint256 btc50k = OracleLibrary.getQuoteAtTick(_twapOf(POOL_BTC, TWAP), 50_000e6, USDC, CBBTC);
        (minOut, limit) = policy.swapBounds(safe, POOL_BTC, CBBTC, btc50k);
        assertEq(_check(ROUTER, _swapData(CBBTC, USDC, 500, btc50k, minOut, limit)), 1, "second leg over the budget");
        uint256 btc38k = OracleLibrary.getQuoteAtTick(_twapOf(POOL_BTC, TWAP), 38_000e6, USDC, CBBTC);
        (minOut, limit) = policy.swapBounds(safe, POOL_BTC, CBBTC, btc38k);
        assertEq(_check(ROUTER, _swapData(CBBTC, USDC, 500, btc38k, minOut, limit)), 0);
        (uint256 w, uint256 t) = policy.budgetLeft(safe, POOL_BTC);
        console2.log("M-2 left after 60k + ~38k (USDC):", w / 1e6, t / 1e6);
        assertLt(t, 2_100e6);

        // A two-sided mint is charged its full value too: 1k USDC + cbBTC worth ~1k is over the ~2k left... once.
        uint256 btc1k = OracleLibrary.getQuoteAtTick(_twapOf(POOL_BTC, TWAP), 1_500e6, USDC, CBBTC);
        MintParams memory m = MintParams(USDC, CBBTC, 500, -70000, -60000, 1_000e6, btc1k, 0, 0, safe, block.timestamp);
        assertEq(_check(address(policy), abi.encodeCall(MamoruActionPolicy.mint, (m))), 1);
    }

    // ================================================================ M-3: token bucket, no double window

    /// T4 let a key spend the per-window budget at 86400k - 2 and again at 86400k. The bucket refills
    /// perWindow / budgetWindow per second, so two seconds later only ~1.4 USDC of a 60k bucket is back.
    function test_M3_noDoubleWindowAtTheBoundary() public {
        _initBtc(ID, 1, 60_000e6, 1_000_000e6);
        uint256 boundary = ((block.timestamp / 1 days) + 1) * 1 days;
        vm.warp(boundary - 2);
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, 60_000e6);
        bytes memory full = _swapData(USDC, CBBTC, 500, 60_000e6, minOut, limit);
        assertEq(_check(ROUTER, full), 0);
        vm.warp(boundary);
        vm.roll(block.number + 1);
        (minOut, limit) = policy.swapBounds(safe, POOL_BTC, USDC, 60_000e6);
        assertEq(_check(ROUTER, _swapData(USDC, CBBTC, 500, 60_000e6, minOut, limit)), 1, "no second window");
        (uint256 w,) = policy.budgetLeft(safe, POOL_BTC);
        assertEq(w, (uint256(60_000e6) * 2) / 1 days, "two seconds of refill");

        // Half a day later, half the bucket.
        vm.warp(boundary + 12 hours - 2);
        vm.roll(block.number + 21_600);
        (w,) = policy.budgetLeft(safe, POOL_BTC);
        assertEq(w, 30_000e6);
        (minOut, limit) = policy.swapBounds(safe, POOL_BTC, USDC, 30_000e6 + 1);
        assertEq(_check(ROUTER, _swapData(USDC, CBBTC, 500, 30_000e6 + 1, minOut, limit)), 1);
        (minOut, limit) = policy.swapBounds(safe, POOL_BTC, USDC, 30_000e6);
        assertEq(_check(ROUTER, _swapData(USDC, CBBTC, 500, 30_000e6, minOut, limit)), 0);
    }

    /// L-5: a renewal (new generation, fresh key) resets the per-approval total but not the bucket.
    function test_L5_renewalCarriesTheBucket() public {
        _initBtc(ID, 1, 60_000e6, 60_000e6);
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, 60_000e6);
        assertEq(_check(ROUTER, _swapData(USDC, CBBTC, 500, 60_000e6, minOut, limit)), 0);
        ConfigId fresh = ConfigId.wrap(bytes32(uint256(2)));
        _initBtc(fresh, 2, 60_000e6, 60_000e6);
        (minOut, limit) = policy.swapBounds(safe, POOL_BTC, USDC, 1_000e6);
        assertEq(_checkId(fresh, ROUTER, _swapData(USDC, CBBTC, 500, 1_000e6, minOut, limit)), 1, "bucket carried");
        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 43_200);
        (minOut, limit) = policy.swapBounds(safe, POOL_BTC, USDC, 60_000e6);
        assertEq(_checkId(fresh, ROUTER, _swapData(USDC, CBBTC, 500, 60_000e6, minOut, limit)), 0, "total reset");
    }

    // ================================================================ M-4: owner admits existing positions at enable

    function test_M4_ownerAdmitsPositionsMintedElsewhere() public {
        (uint256 v3Pos, uint128 liq) = _mintDirect(safe, 20_000e6, 0.2e8); // a v2/v3-grant position
        uint256[] memory admit = new uint256[](1);
        admit[0] = v3Pos;
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(
            safe, ID, _initData(POOL_BTC, BAND, NO_ANCHOR, false, 1, 300_000e6, 3_000_000e6, admit)
        );
        assertEq(policy.admittedPool(safe, v3Pos), POOL_BTC);
        (uint256 min0, uint256 min1) = policy.decreaseMins(safe, POOL_BTC, v3Pos, liq);
        bytes memory dec = abi.encodeCall(
            INPMFull.decreaseLiquidity, (DecreaseLiquidityParams(v3Pos, liq, min0, min1, block.timestamp))
        );
        assertEq(_check(NPM, dec), 0);
        _exec(NPM, dec);
        bytes memory col =
            abi.encodeCall(INPMFull.collect, (CollectParams(v3Pos, safe, type(uint128).max, type(uint128).max)));
        assertEq(_check(NPM, col), 0);
        _exec(NPM, col);
        assertEq(_check(NPM, abi.encodeCall(INPMFull.burn, (v3Pos))), 0);
    }

    function test_M4_admitRefusesForeignOrOtherPoolPositions() public {
        (uint256 theirs,) = _mintDirect(makeAddr("other"), 1_000e6, 0.01e8);
        uint256[] memory admit = new uint256[](1);
        admit[0] = theirs;
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.NotAdmissible.selector, theirs));
        policy.initializeWithMultiplexer(
            safe, ID, _initData(POOL_BTC, BAND, NO_ANCHOR, false, 1, 300_000e6, 3_000_000e6, admit)
        );

        // The Safe's own position, but in USDC/USDT, named in a USDC/cbBTC Init.
        int24 s = _spot(POOL_STABLE);
        vm.startPrank(safe);
        IERC20Min(USDC).approve(NPM, 1_000e6);
        IERC20Min(USDT).approve(NPM, 1_000e6);
        (uint256 stablePos,,,) = INPMFull(NPM)
            .mint(MintParams(USDC, USDT, 100, s - 20, s + 20, 1_000e6, 1_000e6, 0, 0, safe, block.timestamp));
        vm.stopPrank();
        admit[0] = stablePos;
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.NotAdmissible.selector, stablePos));
        policy.initializeWithMultiplexer(
            safe, ID, _initData(POOL_BTC, BAND, NO_ANCHOR, false, 1, 300_000e6, 3_000_000e6, admit)
        );
    }

    /// A session key can reach the policy only through checkAction-validated executions from the account. None of
    /// them can write the admitted set except `mint` (which admits only the tokenId it just minted for the account).
    function test_M4_sessionKeyCannotAddToTheAdmitList() public {
        _initBtc(ID, 1, 300_000e6, 3_000_000e6);
        (uint256 v3Pos,) = _mintDirect(safe, 20_000e6, 0.2e8);
        uint256[] memory admit = new uint256[](1);
        admit[0] = v3Pos;
        bytes memory initData = _initData(POOL_BTC, BAND, NO_ANCHOR, false, 1, 300_000e6, 3_000_000e6, admit);
        bytes memory reinit = abi.encodeCall(MamoruActionPolicy.initializeWithMultiplexer, (safe, ID, initData));
        // 1. As an execution of a session userOp, any call to the policy other than `mint` is refused at validation.
        assertEq(_check(address(policy), reinit), 1);
        // 2. Executed by the account itself (e.g. through some other path): only SmartSession may initialize.
        vm.prank(safe);
        vm.expectRevert(MamoruActionPolicy.OnlySmartSession.selector);
        policy.initializeWithMultiplexer(safe, ID, initData);
        // 3. Nobody else either.
        vm.prank(attacker);
        vm.expectRevert(MamoruActionPolicy.OnlySmartSession.selector);
        policy.initializeWithMultiplexer(safe, ID, initData);
        assertEq(policy.admittedPool(safe, v3Pos), address(0));
    }

    // ================================================================ L-4: oracle history margin at enable

    function test_L4_enableRequiresCardinalityForTheWindow() public {
        bytes memory init = _initData(POOL_STABLE, STABLE_BAND, STABLE_ANCHOR, false, 1, 20_000e6, 100_000e6, _none());
        vm.prank(SMART_SESSION);
        vm.expectRevert(
            abi.encodeWithSelector(MamoruActionPolicy.ObservationCardinalityTooLow.selector, uint16(1000), TWAP)
        );
        policy.initializeWithMultiplexer(safe, ID, init);
        _raiseStableCardinality();
        _enable(ID, init);
    }

    // ================================================================ I-1, I-2: Init checks

    function test_I1_sameGenerationDifferentConfigReverts() public {
        _initBtc(ID, 1, 300_000e6, 3_000_000e6);
        _initBtc(ConfigId.wrap(bytes32(uint256(9))), 1, 300_000e6, 3_000_000e6); // same values: fine
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.ConfigMismatch.selector, POOL_BTC, uint64(1)));
        policy.initializeWithMultiplexer(
            safe,
            ConfigId.wrap(bytes32(uint256(10))),
            _initData(POOL_BTC, BAND + 1, NO_ANCHOR, false, 1, 300_000e6, 3_000_000e6, _none())
        );
        // Views follow the generation: a pool left at an older generation has no config any more.
        _raiseStableCardinality();
        _enable(
            ConfigId.wrap(bytes32(uint256(11))),
            _initData(POOL_STABLE, STABLE_BAND, STABLE_ANCHOR, false, 1, 20_000e6, 100_000e6, _none())
        );
        _initBtc(ConfigId.wrap(bytes32(uint256(12))), 2, 300_000e6, 3_000_000e6);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.NoConfig.selector, safe, POOL_STABLE));
        policy.priceRange(safe, POOL_STABLE);
    }

    function test_I2_initBounds() public {
        _expectBadInit(_raw(POOL_BTC, 1, 300, BAND, 1, 0), 1); // twapWindow = 1
        _expectBadInit(_raw(POOL_BTC, 1800, 1800, BAND, 1, 0), 2); // short == long
        _expectBadInit(_raw(POOL_BTC, 1800, 300, 1, 1, 0), 3); // band 1
        _expectBadInit(_raw(POOL_BTC, 1800, 300, 887_272, 1, 0), 3); // band to the end of the tick space
        _expectBadInit(_raw(POOL_BTC, 1800, 300, BAND, type(uint64).max, 0), 4); // bricks later renewals
        _expectBadInit(_raw(POOL_BTC, 1800, 300, BAND, 1, 501), 5); // anchor band past MAX_BAND
        _initBtc(ID, 1, 300_000e6, 3_000_000e6);
        _expectBadInit(_raw(POOL_BTC, 1800, 300, BAND, 3, 0), 4); // jump of two after the first enable
    }

    function _raw(address pool, uint32 w, uint32 ws, uint24 band, uint64 gen, uint24 anchorBand)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            MamoruActionPolicy.Init({
                pool: pool,
                twapWindow: w,
                twapShortWindow: ws,
                bandTicks: band,
                generation: gen,
                anchorTick: 0,
                anchorBand: anchorBand,
                budgetIn1: false,
                budgetWindow: 1 days,
                perWindow: 1e6,
                total: 1e6,
                admit: new uint256[](0)
            })
        );
    }

    function _expectBadInit(bytes memory init, uint256 field) internal {
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.BadInit.selector, field));
        policy.initializeWithMultiplexer(safe, ConfigId.wrap(bytes32(uint256(77))), init);
    }

    // ================================================================ I-5: WETH funded from the manager's ETH comes back

    function test_I5_mintRefundsFromTheBalanceDelta() public {
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(
            safe, ID, _initData(POOL_ETH, BAND, NO_ANCHOR, true, 1, 600_000e6, 6_000_000e6, _none())
        );
        deal(WETH, safe, 10 ether);
        vm.deal(NPM, 10 ether); // anyone can leave ETH in the manager
        int24 s = _spot(POOL_ETH);
        MintParams memory m = MintParams(
            WETH,
            USDC,
            3000,
            ((s - 1200) / 60) * 60,
            ((s + 1200) / 60) * 60,
            1 ether,
            5_000e6,
            0,
            0,
            safe,
            block.timestamp
        );
        uint256 w0 = IERC20Min(WETH).balanceOf(safe);
        _exec(WETH, abi.encodeCall(IERC20Min.approve, (address(policy), 1 ether)));
        _exec(USDC, abi.encodeCall(IERC20Min.approve, (address(policy), 5_000e6)));
        assertEq(_check(address(policy), abi.encodeCall(MamoruActionPolicy.mint, (m))), 0);
        _exec(address(policy), abi.encodeCall(MamoruActionPolicy.mint, (m)));
        assertEq(IERC20Min(WETH).balanceOf(address(policy)), 0, "no WETH stranded in the policy");
        assertEq(IERC20Min(USDC).balanceOf(address(policy)), 0);
        assertEq(IERC20Min(WETH).balanceOf(safe), w0, "the manager paid the WETH leg from its own ETH");
    }
}
