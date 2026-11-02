// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {OracleLibrary} from "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
import {MamoruActionPolicy, ConfigId, ExactInputSingleParams, IERC20Min} from "../src/MamoruActionPolicy.sol";
import {PolicyFixture} from "./MamoruActionPolicy.t.sol";

/**
 * otto/mamoru#93: what a public engine session key can lose for a 25 USDC account, measured on a Base fork.
 * It prints the numbers docs/security/leaked-key.md quotes, and asserts the bounds those numbers rest on.
 * Run alone:
 *   forge test --mc LeakedKeyLoss -vv
 *
 * The key holder sandwiches the account's own swap in one transaction: push the pool with its own capital, have the
 * account swap through the session, push back. Two rule sets:
 * - v2 (`conservador-live-v2`, UniActionPolicy only, packages/policy/src/grants.ts): `amountOutMinimum > 0` and
 *   `sqrtPriceLimitX96 == 0`. Modelled as the swap the key signs with minOut 1; no policy contract is involved.
 * - v6 (`conservador-live-v6`, MamoruActionPolicyV3): the swap must carry the TWAP band's minOut and price limit,
 *   and the spot must be inside the band at validation. The attacker parks the spot one tick inside the edge.
 * Loss is against the 30-min TWAP quote (fair price), so it includes the pool fee.
 */
contract LeakedKeyLoss is PolicyFixture {
    // Per-call swap caps of v2 at a 25 USDC cap (packages/policy/src/policies.ts: stables 50%, btc 40%, risk 20%).
    uint256 constant SWAP_STABLE = 12_500_000;
    uint256 constant SWAP_BTC = 10_000_000;
    uint256 constant SWAP_ETH = 5_000_000;

    ConfigId constant ID_STABLE = ConfigId.wrap(bytes32(uint256(11)));
    ConfigId constant ID_BTC = ConfigId.wrap(bytes32(uint256(12)));
    ConfigId constant ID_ETH = ConfigId.wrap(bytes32(uint256(13)));

    struct Leg {
        string name;
        address pool;
        address tokenOut;
        uint24 fee;
        int24 dir; // sign of the push that makes tokenOut dearer for USDC in
        uint256 amountIn;
        ConfigId id;
    }

    function _newPolicy() internal override returns (MamoruActionPolicy) {
        address[] memory vaults = new address[](2);
        (vaults[0], vaults[1]) =
        (0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61, 0xC768c589647798a6EE01A91FdE98EF2ed046DBD6);
        return MamoruActionPolicy(
            deployCode(
                "MamoruActionPolicyV3.sol:MamoruActionPolicyV3",
                abi.encode(
                    SMART_SESSION,
                    NPM,
                    ROUTER,
                    FACTORY,
                    address(0x6A2d1A9), // guardian, unused here
                    vaults,
                    0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d, // CCTP V2 TokenMessenger on Base
                    USDC,
                    uint32(15)
                )
            )
        );
    }

    function setUp() public {
        _fork();
        IUniswapV3PoolCard(POOL_STABLE).increaseObservationCardinalityNext(uint16(TWAP));
        deal(USDC, safe, 25e6);
        vm.startPrank(SMART_SESSION);
        // v6 budgets at a 25 USDC cap (packages/policy/src/policies-v6.ts): stables W 62.5 / T 125, WETH/USDC
        // W 17.5 / T 87.5. cbBTC is exit-only in v6; it gets W 10 / T 50 here only to measure its band.
        policy.initializeWithMultiplexer(
            safe,
            ID_STABLE,
            _initData(POOL_STABLE, STABLE_BAND, STABLE_ANCHOR, false, 1, 62_500_000, 125e6, new uint256[](0))
        );
        policy.initializeWithMultiplexer(
            safe, ID_BTC, _initData(POOL_BTC, BAND, NO_ANCHOR, false, 1, 10e6, 50e6, new uint256[](0))
        );
        policy.initializeWithMultiplexer(
            safe, ID_ETH, _initData(POOL_ETH, BAND, NO_ANCHOR, true, 1, 17_500_000, 87_500_000, new uint256[](0))
        );
        vm.stopPrank();
    }

    function _legs() internal pure returns (Leg[3] memory l) {
        l[0] = Leg("USDC/USDT 0.01%", POOL_STABLE, USDT, 100, -1, SWAP_STABLE, ID_STABLE);
        l[1] = Leg("USDC/cbBTC 0.05%", POOL_BTC, CBBTC, 500, -1, SWAP_BTC, ID_BTC);
        l[2] = Leg("WETH/USDC 0.3%", POOL_ETH, WETH, 3000, 1, SWAP_ETH, ID_ETH);
    }

    /// Fair output of `amountIn` USDC at the 30-min TWAP.
    function _fair(Leg memory g, uint256 amountIn) internal view returns (uint256) {
        return OracleLibrary.getQuoteAtTick(_twapOf(g.pool, TWAP), uint128(amountIn), USDC, g.tokenOut);
    }

    /// The account's swap, sent from the account as Safe7579 does after validation. Returns tokenOut received.
    function _accountSwap(Leg memory g, uint256 amountIn, uint256 minOut, uint160 limit)
        internal
        returns (uint256 got)
    {
        _exec(USDC, abi.encodeCall(IERC20Min.approve, (ROUTER, amountIn)));
        uint256 b0 = IERC20Min(g.tokenOut).balanceOf(safe);
        _exec(ROUTER, _swapData(USDC, g.tokenOut, g.fee, amountIn, minOut, limit));
        got = IERC20Min(g.tokenOut).balanceOf(safe) - b0;
    }

    /// USDC value lost on `amountIn`, given `got` against the fair output.
    function _lossUsdc(uint256 amountIn, uint256 fair, uint256 got) internal pure returns (uint256) {
        return got >= fair ? 0 : (amountIn * (fair - got)) / fair;
    }

    // ------------------------------------------------------------ v2: minOut 1

    /// Pushes of increasing depth before a minOut-1 swap. Prints the account's loss and what the push and the push
    /// back cost a pure taker (an attacker who also owns the pool's liquidity gets that back; not modelled).
    function test_v2_minOutOneSandwich() public {
        Leg[3] memory legs = _legs();
        int24[4] memory depths = [int24(10), 100, 1000, 10_000];
        for (uint256 i; i < 3; i++) {
            Leg memory g = legs[i];
            uint256 fair = _fair(g, g.amountIn);
            console2.log(g.name, "swap of USDC (6 dp):", g.amountIn);
            for (uint256 j; j < 4; j++) {
                _v2Push(g, fair, depths[j]);
            }
        }
        // The deepest push takes nearly the whole swap: v2 bounds nothing but the amount.
        Leg memory s = legs[1];
        uint256 fairBtc = _fair(s, s.amountIn);
        _push(s.pool, USDC, s.tokenOut, s.fee, s.dir * 10_000);
        uint256 gotBtc = _accountSwap(s, s.amountIn, 1, 0);
        assertGt(_lossUsdc(s.amountIn, fairBtc, gotBtc), (s.amountIn * 60) / 100, "v2: a deep push takes most of it");
    }

    function _v2Push(Leg memory g, uint256 fair, int24 depth) internal {
        uint256 snap = vm.snapshotState();
        (uint256 spent, uint256 bought) = _push(g.pool, USDC, g.tokenOut, g.fee, g.dir * depth);
        uint256 got = _accountSwap(g, g.amountIn, 1, 0);
        uint256 back = _pushBack(g, bought);
        uint256 loss = _lossUsdc(g.amountIn, fair, got);
        console2.log("  push ticks / account loss USDC (6 dp) / loss bps:");
        console2.log("   ", uint256(int256(depth)), loss, (loss * 10_000) / g.amountIn);
        _logNet(spent, back);
        vm.revertToState(snap);
    }

    /// The attacker sells back what its push bought; returns the USDC it got.
    function _pushBack(Leg memory g, uint256 bought) internal returns (uint256 back) {
        uint256 a0 = IERC20Min(USDC).balanceOf(attacker);
        _sell(g.tokenOut, USDC, g.fee, bought);
        back = IERC20Min(USDC).balanceOf(attacker) - a0;
    }

    function _logNet(uint256 spent, uint256 back) internal pure {
        if (back >= spent) console2.log("    taker round trip +USDC (6 dp):", back - spent);
        else console2.log("    taker round trip -USDC (6 dp):", spent - back);
    }

    // ------------------------------------------------------------ v6: the TWAP band

    /// The spot parked one tick inside the band edge (the worst V3 admits), then the account's swap at the policy's
    /// minOut and limit. Prints the loss per swap and what the push cost; asserts the fill meets that minOut
    /// and that one tick past the edge is refused at validation.
    function test_v6_bandEdgeSandwich() public {
        Leg[3] memory legs = _legs();
        for (uint256 i; i < 3; i++) {
            _v6Leg(legs[i]);
        }
    }

    function _v6Leg(Leg memory g) internal {
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, g.pool, USDC, g.amountIn);
        bytes memory tight = _swapData(USDC, g.tokenOut, g.fee, g.amountIn, minOut, limit);
        int24 edge = TickMath.getTickAtSqrtRatio(limit);

        // minOut 1, as v2 allows: refused.
        assertEq(_checkId(g.id, ROUTER, _swapData(USDC, g.tokenOut, g.fee, g.amountIn, 1, 0)), 1, "loose");

        uint256 snap = vm.snapshotState();
        // No push: what churning costs the account at the current spot (the fee and the spot's drift from the TWAP).
        uint256 fair = _fair(g, g.amountIn);
        uint256 atSpot = _lossUsdc(g.amountIn, fair, _accountSwap(g, g.amountIn, minOut, limit));
        console2.log(g.name, "swap of USDC (6 dp):", g.amountIn);
        console2.log("  no push: account loss USDC (6 dp) / bps:", atSpot, (atSpot * 10_000) / g.amountIn);
        vm.revertToState(snap);

        _v6AtEdge(g, minOut, limit, tight, edge - g.dir); // one tick back toward the TWAP
        vm.revertToState(snap);

        // One tick past the edge: refused before anything is charged.
        _push(g.pool, USDC, g.tokenOut, g.fee, edge + g.dir - _spot(g.pool));
        assertEq(_checkId(g.id, ROUTER, tight), 1, "past the edge");
        vm.revertToState(snap);
    }

    function _v6AtEdge(Leg memory g, uint256 minOut, uint160 limit, bytes memory tight, int24 inside) internal {
        uint256 fair = _fair(g, g.amountIn);
        (uint256 spent, uint256 bought) = _push(g.pool, USDC, g.tokenOut, g.fee, inside - _spot(g.pool));
        assertEq(_checkId(g.id, ROUTER, tight), 0, "at the edge the policy still admits it");
        uint256 got = _accountSwap(g, g.amountIn, minOut, limit);
        assertGe(got, minOut);
        uint256 loss = _lossUsdc(g.amountIn, fair, got);
        uint256 back = _pushBack(g, bought);
        console2.log("  spot at the band edge: account loss USDC (6 dp) / bps:", loss, (loss * 10_000) / g.amountIn);
        _logNet(spent, back);
    }
}

interface IUniswapV3PoolCard {
    function increaseObservationCardinalityNext(uint16) external;
}
