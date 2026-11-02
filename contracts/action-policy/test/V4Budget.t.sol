// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {V4Fixture, IERC20T} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, SwapParams} from "../src/MamoruActionPolicyV4.sol";
import {MamoruRegistry} from "../src/MamoruRegistry.sol";

/**
 * Spec 010 I5 (otto/mamoru#292) on a Base fork: the account bucket (C a day), the per-pool share (ratioBps of C), the
 * rolling 30-day cap (3C), the circuit breaker (C in 24 h, pauses by itself) and the review threshold (10C since the
 * guardian's last review, pauses by itself). Then the worst-case loss per day with the registry at its loosest
 * (T4 deliverable, r1 P1-7): measured, and compared with the stated bound.
 */
contract V4BudgetTest is V4Fixture {
    function setUp() public {
        _forkBase();
        _listPool(POOL_BTC, 100, 0, 0, 10_000); // the whole bucket: account-level limits bind first
        _listPool(POOL_ETH, 100, 0, 0, 5_000);
        _init(acct);
        deal(USDC, acct, 1_000_000e6);
        deal(CBBTC, acct, 10e8);
    }

    function _paused(uint8 reason) internal view returns (bool) {
        return v4.isPaused(acct) && (v4.pauseOf(acct).reasons & reason) != 0;
    }

    function test_I5_poolShareCapsTheSubBucket() public {
        _swap(acct, POOL_ETH, USDC, 4_000e6);
        SwapParams memory s = _swapParams(POOL_ETH, USDC, 1_000e6 + 1);
        _approveV4(acct, USDC, s.amountIn);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BudgetExceeded.selector, POOL_ETH, s.amountIn));
        v4.swap(s); // 4,000 + 1,000.000001 > 50 % of C
        _swap(acct, POOL_BTC, USDC, 5_000e6); // another pool's share is separate
    }

    function test_I5_accountBucketAcrossPools() public {
        _swap(acct, POOL_BTC, USDC, 6_000e6);
        _swap(acct, POOL_ETH, USDC, 3_000e6);
        SwapParams memory s = _swapParams(POOL_ETH, USDC, 1_000e6 + 1);
        _approveV4(acct, USDC, s.amountIn);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BudgetExceeded.selector, address(0), s.amountIn));
        v4.swap(s);
        // it refills C a day
        _nextBlock(12 hours);
        _swap(acct, POOL_BTC, USDC, 4_000e6);
    }

    /// I5 breaker: more than C in 24 h pauses the account by itself, without executing the crossing call; only the
    /// guardian ends it. The bucket alone would allow it (half a day refilled half of C).
    function test_I5_breakerAtCPer24h() public {
        _swap(acct, POOL_BTC, USDC, 6_000e6);
        _nextBlock(12 hours);
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 6_000e6);
        _approveV4(acct, USDC, s.amountIn);
        uint256 usdc0 = IERC20T(USDC).balanceOf(acct);
        vm.prank(acct);
        uint256 out = v4.swap(s);
        assertEq(out, 0, "the crossing swap did not execute");
        assertEq(IERC20T(USDC).balanceOf(acct), usdc0, "nothing moved");
        assertTrue(_paused(v4.PAUSE_BREAKER()), "breaker pause");
        vm.prank(SMART_SESSION);
        assertEq(v4.checkAction(ID, acct, address(v4), 0, abi.encodeWithSelector(v4.swap.selector)), 1, "session refused");
        (,,, uint256 breakerRoom,) = v4.budgetLeft(acct, POOL_BTC, 10_000);
        assertEq(breakerRoom, 4_000e6, "6,000 of C counted in the last 24 h");
        vm.prank(guardian);
        v4.unpause(acct);
        _swap(acct, POOL_BTC, USDC, 4_000e6); // exactly C in 24 h: allowed
        s = _swapParams(POOL_BTC, USDC, 1e6);
        _approveV4(acct, USDC, 1e6);
        vm.prank(acct);
        assertEq(v4.swap(s), 0, "one more unit trips it again");
        assertTrue(_paused(v4.PAUSE_BREAKER()));
        vm.prank(guardian);
        v4.unpause(acct);
        _nextBlock(25 hours); // the first spend leaves the window
        _swap(acct, POOL_BTC, USDC, 5_000e6);
    }

    /// I5: the rolling 30-day cap of 3C refuses (no pause) a spend that would pass it, whatever the bucket and the
    /// breaker allow; it never ends the authorization: 31 days later the oldest spend has left the window.
    function test_I5_rolling30DayCap() public {
        for (uint256 i; i < 3; i++) {
            _swap(acct, POOL_BTC, USDC, 9_000e6);
            _nextBlock(25 hours);
        }
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 3_000e6 + 1);
        _approveV4(acct, USDC, s.amountIn);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.Cap30Exceeded.selector, 27_000e6, s.amountIn));
        v4.swap(s);
        _swap(acct, POOL_BTC, USDC, 3_000e6); // exactly 3C
        assertFalse(v4.isPaused(acct));
        _nextBlock(29 days);
        _swap(acct, POOL_BTC, USDC, 9_000e6); // the first 9,000 left the 31-day window
    }

    /// I5 (r2 P1): a slow leak below the breaker and the 30-day cap stops at 10C: the crossing call pauses the account
    /// until the guardian reviews it; the review resets the counter and ends that pause.
    function test_I5_reviewThresholdAt10C() public {
        bool zeroForOne = true;
        for (uint256 i; i < 20; i++) {
            // 0.5C every 6 days: at most 3C in any 31 days, never more than C in 24 h
            if (zeroForOne) _swap(acct, POOL_BTC, USDC, 5_000e6);
            else _swap(acct, POOL_BTC, CBBTC, _btcWorth(5_000e6));
            zeroForOne = !zeroForOne;
            _nextBlock(6 days);
        }
        uint256 spent = v4.spentSinceReview(acct);
        assertGt(spent, 99 * uint256(C) / 10, "about 10C spent, never paused on the way");
        assertLe(spent, 10 * uint256(C));
        assertFalse(v4.isPaused(acct));
        (,,,, uint256 room) = v4.budgetLeft(acct, POOL_BTC, 10_000);
        assertEq(room, 10 * uint256(C) - spent);
        SwapParams memory s = _swapParams(POOL_BTC, USDC, room + 1);
        _approveV4(acct, USDC, s.amountIn);
        vm.prank(acct);
        assertEq(v4.swap(s), 0, "the call past 10C did not execute");
        assertTrue(_paused(v4.PAUSE_REVIEW()), "review pause");
        vm.prank(attacker);
        vm.expectRevert(MamoruActionPolicyV4.OnlyGuardian.selector);
        v4.review(acct);
        vm.prank(guardian);
        v4.review(acct);
        assertEq(v4.spentSinceReview(acct), 0);
        assertFalse(v4.isPaused(acct), "review ends the review pause");
        _swap(acct, POOL_BTC, USDC, 1_000e6);
    }

    /// cbBTC worth `usdc` at the range edge V4 values it at (so the charge is about `usdc`).
    function _btcWorth(uint256 usdc) internal view returns (uint256) {
        (uint256 out,) = helper.swapBounds(POOL_BTC, USDC, usdc);
        return out * 99 / 100;
    }

    // ------------------------------------------------------------ worst-case loss per day, loosest registry

    /**
     * T4 / r1 P1-7: the registry at its loosest (band 500 ticks, ratio 10,000) on WETH/USDC 0.3 %, and an attacker who
     * holds the session key and capital. Each round: push the spot to the far edge of V4's range in the account's
     * disfavour, make the account swap at the edge price, push back (the attacker pockets the difference), then the same
     * the other way. Everything in one block (no TWAP moves, the cheapest attack), repeated until V4 stops it. The loss
     * is the account's USDC shortfall at the end (it ends in USDC). Bound stated by the spec: the whole permitted spend,
     * C per 24 h per chain.
     */
    function test_worstCaseDailyLossAtLoosestRegistry() public {
        vm.prank(admin);
        reg.removePool(POOL_ETH);
        _listPool(POOL_ETH, 500, 0, 0, 10_000);
        address a = makeAddr("victim");
        _init(a);
        deal(USDC, a, uint256(C));
        uint256 start = IERC20T(USDC).balanceOf(a);
        uint256 rounds;
        uint256 charged;
        uint256 chunk = 1_000e6;
        while (rounds < 50) {
            // 1. account buys WETH with USDC at the top edge (token1 in: worst price is hi)
            (int24 lo, int24 hi) = helper.priceRange(POOL_ETH);
            int24 sp = _spot(POOL_ETH);
            lo;
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
            (lo, hi) = helper.priceRange(POOL_ETH);
            _push(POOL_ETH, WETH, USDC, 3000, (lo + 1) - sp);
            SwapParams memory s2 = _swapParams(POOL_ETH, WETH, weth);
            _approveV4(a, WETH, weth);
            uint256 back = _trySwap(a, s2);
            _restore(sp);
            if (back == 0) break;
            charged += back; // about what V4 charged for the WETH leg
            rounds++;
            lo;
        }
        uint256 end = IERC20T(USDC).balanceOf(a) + _wethInUsdc(IERC20T(WETH).balanceOf(a));
        uint256 loss = start > end ? start - end : 0;
        console2.log("rounds (2 swaps each) before V4 stopped them", rounds);
        console2.log("value charged to the account (USDC units)", charged);
        console2.log("account loss over the day (USDC units)", loss);
        console2.log("loss in bps of C", loss * 10_000 / C);
        console2.log("paused by the breaker", v4.isPaused(a));
        assertLe(charged, uint256(C), "never more than C charged in 24 h");
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
