// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {V4Fixture, IERC20T} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, SwapParams} from "../src/MamoruActionPolicyV4.sol";

/**
 * Spec 010 I5 + A1 (otto/mamoru#292, #316) on a Base fork: the account bucket (C a day), the per-asset sub-bucket
 * (the class's ratioBps of C, shared by every pool of the asset), the rolling 30-day cap (3C) and the rolling 24 h cap
 * (C). A call that would pass any of them is refused; nothing pauses, nobody resets anything, and the next window works
 * again by itself. Then the worst-case loss per day at the class's parameters (T4 deliverable, r1 P1-7): measured, and
 * compared with the stated bound.
 */
contract V4BudgetTest is V4Fixture {
    address constant POOL_ETH_05 = 0xd0b53D9277642d899DF5C87A3966A349A798F224; // USDC/WETH 0.05 %, eligible by rule

    function setUp() public {
        _forkBase();
        _init(acct);
        deal(USDC, acct, 1_000_000e6);
        deal(CBBTC, acct, 10e8);
    }

    /// Spend the whole of C: the stable class (50 %), cbBTC (35 %), WETH (15 %). The stables pool's in-band depth is
    /// about 35,000 USDC at the fork block, so its share goes in calls of at most 1/20 of it (I2).
    function _spendC(address a) internal {
        for (uint256 i; i < 3; i++) {
            _swap(a, POOL_STABLE, USDC, 1_500e6);
        }
        _swap(a, POOL_STABLE, USDC, 500e6);
        _swap(a, POOL_BTC, USDC, 3_500e6);
        _swap(a, POOL_ETH, USDC, 1_500e6);
    }

    function test_I5_subBucketPerAssetSharedByItsPools() public {
        _swap(acct, POOL_ETH, USDC, 1_000e6);
        SwapParams memory s = _swapParams(POOL_ETH, USDC, 500e6 + 1);
        _approveV4(acct, USDC, s.amountIn);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BudgetExceeded.selector, WETH, s.amountIn));
        v4.swap(s); // 1,000 + 500.000001 > 15 % of C
        // the second WETH pool shares the sub-bucket: it adds no room
        s = _swapParams(POOL_ETH_05, USDC, 500e6 + 1);
        _approveV4(acct, USDC, s.amountIn);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BudgetExceeded.selector, WETH, s.amountIn));
        v4.swap(s);
        _swap(acct, POOL_ETH_05, USDC, 500e6); // exactly the share
        _swap(acct, POOL_BTC, USDC, 3_000e6); // another asset's sub-bucket is separate
    }

    function test_I5_accountBucketRefillsByItself() public {
        _spendC(acct);
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1e6);
        _approveV4(acct, USDC, 1e6);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BudgetExceeded.selector, address(0), 1e6));
        v4.swap(s);
        _nextBlock(25 hours); // the bucket and the 24 h window have refilled: no one had to reset anything
        _swap(acct, POOL_BTC, USDC, 3_500e6);
    }

    /// I5 (A1): the rolling 24 h cap is C. Half a day after spending C the bucket has refilled half of C, but the 24 h
    /// cap refuses the call (no pause: the next call after the window passes).
    function test_I5_rolling24hCapRefuses() public {
        _spendC(acct);
        _nextBlock(12 hours);
        (uint256 bucket,,, uint256 room24) = v4.budgetLeft(acct, CBBTC, 3_500);
        assertApproxEqAbs(bucket, 5_000e6, 1e6, "the bucket refilled half of C");
        assertEq(room24, 0, "C counted in the last 24 h");
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1_000e6);
        _approveV4(acct, USDC, s.amountIn);
        uint256 usdc0 = IERC20T(USDC).balanceOf(acct);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.Cap24hExceeded.selector, uint256(C), s.amountIn));
        v4.swap(s);
        assertEq(IERC20T(USDC).balanceOf(acct), usdc0, "nothing moved");
        vm.prank(SMART_SESSION);
        assertEq(v4.checkAction(ID, acct, address(v4), 0, abi.encodeWithSelector(v4.swap.selector)), 0, "the session is not paused");
        _nextBlock(13 hours); // the first spend leaves the 25 hourly periods
        _swap(acct, POOL_BTC, USDC, 1_000e6);
    }

    /// I5: the rolling 30-day cap of 3C refuses a spend that would pass it, whatever the bucket and the 24 h cap allow;
    /// it never ends the authorization: 31 days later the oldest spend has left the window.
    function test_I5_rolling30DayCap() public {
        for (uint256 i; i < 3; i++) {
            _spendC(acct);
            _nextBlock(25 hours);
        }
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1e6);
        _approveV4(acct, USDC, s.amountIn);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.Cap30Exceeded.selector, 3 * uint256(C), s.amountIn));
        v4.swap(s);
        _nextBlock(29 days);
        _swap(acct, POOL_BTC, USDC, 3_500e6); // the first C left the 31-day window
    }

    /// A1: no lifetime total and no review threshold. A slow spend under the 24 h and 30-day caps continues with no
    /// end in time (the owner's accepted rate, spec 010 threat model); nothing pauses on the way.
    function test_A1_noLifetimeTotal() public {
        bool zeroForOne = true;
        uint256 spent;
        for (uint256 i; i < 40; i++) {
            // 0.3C every 6 days on cbBTC: at most 1.8C in any 31 days, never more than C in 24 h
            if (zeroForOne) _swap(acct, POOL_BTC, USDC, 3_000e6);
            else _swap(acct, POOL_BTC, CBBTC, _btcWorth(3_000e6));
            spent += 3_000e6;
            zeroForOne = !zeroForOne;
            _nextBlock(6 days);
        }
        assertGe(spent, 12 * uint256(C), "past the old 10C review threshold, never refused");
    }

    /// cbBTC worth `usdc` at the range edge V4 values it at (so the charge is about `usdc`).
    function _btcWorth(uint256 usdc) internal view returns (uint256) {
        (uint256 out,) = lens.swapBounds(POOL_BTC, USDC, usdc);
        return out * 99 / 100;
    }

    // ------------------------------------------------------------ worst-case loss per day, at the class's parameters

    /**
     * T4 / r1 P1-7: WETH/USDC 0.3 % at its class (band 100 ticks, 15 % of C), and an attacker who holds the session key
     * and capital. Each round: push the spot to the far edge of V4's range in the account's disfavour, make the account
     * swap at the edge price, push back (the attacker pockets the difference), then the same the other way. Everything
     * in one block (no TWAP moves, the cheapest attack), repeated until V4 stops it. The loss is the account's USDC
     * shortfall at the end (it ends in USDC). Bound stated by the spec: the whole permitted spend, C per 24 h per chain.
     */
    function test_worstCaseDailyLossAtTheClass() public {
        address a = makeAddr("victim");
        _init(a);
        deal(USDC, a, uint256(C));
        uint256 start = IERC20T(USDC).balanceOf(a);
        uint256 rounds;
        uint256 charged;
        uint256 chunk = 500e6;
        while (rounds < 50) {
            // 1. account buys WETH with USDC at the top edge (token1 in: worst price is hi)
            (, int24 hi) = lens.priceRange(POOL_ETH);
            int24 sp = _spot(POOL_ETH);
            _push(POOL_ETH, USDC, WETH, 3000, (hi - 1) - sp); // USDC in: WETH dearer, the tick goes up to hi
            uint256 usdcBal = IERC20T(USDC).balanceOf(a);
            uint256 amt = usdcBal < chunk ? usdcBal : chunk;
            if (amt == 0) break;
            SwapParams memory s1 = _swapParams(POOL_ETH, USDC, amt);
            _approveV4(a, USDC, amt);
            uint256 weth = _trySwap(a, s1);
            _restore(sp);
            if (weth == 0) break;
            charged += amt;
            // 2. account sells the WETH back at the bottom edge (token0 in: worst price is lo)
            sp = _spot(POOL_ETH);
            (int24 lo,) = lens.priceRange(POOL_ETH);
            _push(POOL_ETH, WETH, USDC, 3000, (lo + 1) - sp);
            SwapParams memory s2 = _swapParams(POOL_ETH, WETH, weth);
            _approveV4(a, WETH, weth);
            uint256 back = _trySwap(a, s2);
            _restore(sp);
            if (back == 0) break;
            charged += back; // about what V4 charged for the WETH leg
            rounds++;
        }
        uint256 end = IERC20T(USDC).balanceOf(a) + _wethInUsdc(IERC20T(WETH).balanceOf(a));
        uint256 loss = start > end ? start - end : 0;
        console2.log("rounds (2 swaps each) before V4 stopped them", rounds);
        console2.log("value charged to the account (USDC units)", charged);
        console2.log("account loss over the day (USDC units)", loss);
        console2.log("loss in bps of C", loss * 10_000 / C);
        assertLe(charged, uint256(C) * 1_500 / 10_000 + chunk, "never more than WETH's share charged in a day");
        assertLe(loss, uint256(C), "the loss is inside the stated bound");
    }

    function _trySwap(address a, SwapParams memory s) internal returns (uint256 out) {
        vm.prank(a);
        try v4.swap(s) returns (uint256 o) {
            out = o;
        } catch {
            out = 0;
        }
    }

    /// The attacker brings the spot back to `tick` with its own capital.
    function _restore(int24 tick) internal {
        int24 sp = _spot(POOL_ETH);
        if (sp > tick) _push(POOL_ETH, WETH, USDC, 3000, tick - sp);
        else if (sp < tick) _push(POOL_ETH, USDC, WETH, 3000, tick - sp);
    }

    function _wethInUsdc(uint256 w) internal view returns (uint256) {
        if (w == 0) return 0;
        (uint160 sp,,,,,,) = IUniswapV3Pool(POOL_ETH).slot0();
        // token0 WETH, token1 USDC: price = sp^2 / 2^192 (USDC units per WETH unit)
        return (w * uint256(sp) / 2 ** 96) * uint256(sp) / 2 ** 96;
    }
}
