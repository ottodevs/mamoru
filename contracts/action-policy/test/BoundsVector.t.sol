// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruActionPolicy} from "../src/MamoruActionPolicy.sol";

/// Pool stub: observe([w, 0]) answers cumulatives whose mean over w is `tick`.
contract TwapPool {
    int24 public tick;

    function set(int24 t) external {
        tick = t;
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory c, uint160[] memory s) {
        c = new int56[](2);
        s = new uint160[](2);
        c[1] = int56(tick) * int56(uint56(secondsAgos[0]));
        s[1] = 1; // consult divides by this delta (harmonic mean liquidity)
    }
}

/// Position manager stub: positions(id) answers the range set for it.
contract RangeNpm {
    int24 lower;
    int24 upper;

    function set(int24 l, int24 u) external {
        (lower, upper) = (l, u);
    }

    function positions(uint256)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        return (0, address(0), address(0), address(0), 0, lower, upper, 0, 0, 0, 0, 0);
    }
}

/// Exposes the policy's own internal bound math, unchanged.
contract BoundsHarness is MamoruActionPolicy {
    constructor(address npm) MamoruActionPolicy(address(1), npm, address(2), address(3), address(0)) {}

    function swapAt(int24 twap, uint24 band, uint24 fee, bool zeroForOne, uint256 amountIn)
        external
        pure
        returns (uint256, uint160)
    {
        // Token addresses only decide the direction: token0 < token1, as in every factory pool.
        PoolInfo memory p = PoolInfo({token0: address(0x10), token1: address(0x20), fee: fee});
        Config memory c = Config({pool: address(0), twapWindow: 0, bandTicks: band, generation: 0});
        return _swapBounds(c, p, twap, zeroForOne ? p.token0 : p.token1, amountIn);
    }

    function decreaseAt(address pool, uint24 band, uint128 liquidity) external view returns (uint256, uint256) {
        Config memory c = Config({pool: pool, twapWindow: 1800, bandTicks: band, generation: 0});
        return _decreaseMins(c, 1, liquidity);
    }
}

/**
 * Spec 007 T3: the engine's TS port of the bound math (packages/uniswap-v3/src/action-policy.ts) and the policy agree
 * to the unit. These are the vectors of packages/uniswap-v3/src/action-policy.test.ts; change both or neither.
 */
contract BoundsVectorTest is Test {
    BoundsHarness h;
    TwapPool pool;
    RangeNpm npm;

    function setUp() public {
        npm = new RangeNpm();
        pool = new TwapPool();
        h = new BoundsHarness(address(npm));
    }

    function _swap(int24 twap, uint24 band, uint24 fee, bool z, uint256 amountIn, uint256 minOut, uint160 limit)
        internal
        view
    {
        (uint256 m, uint160 l) = h.swapAt(twap, band, fee, z, amountIn);
        assertEq(m, minOut, "minOut");
        assertEq(uint256(l), uint256(limit), "limit");
    }

    function test_swapBoundsVectors() public view {
        _swap(-69080, 100, 500, true, 10_000_000_000, 9896548, 2493044766816419681857569732);
        _swap(-69080, 80, 500, false, 10_000_000, 9914364963, 2515582309681695196964350041);
        _swap(-193380, 100, 3000, true, 1e18, 3948077151, 4985684817738764271800177);
        _swap(-193380, 80, 3000, false, 3_000_000_000, 741837922569059691, 5030756244769747454520634);
        _swap(1, 10, 100, true, 50_000_000_000, 49950026988, 79192519643494122913931054475);
        _swap(1, 8, 100, false, 50_000_000_000, 49950026988, 79263821427133508858028082997);
        _swap(
            887000,
            100,
            3000,
            true,
            1_000_000,
            326848885033688930083888074281879948672662010,
            1434516369756535367959378355651734405467902527303
        );
        _swap(-887000, 1000, 3000, false, 1_000_000, 298718732998015469598875560024265055078636277, 4577158310);
    }

    function _decrease(int24 twap, uint24 band, int24 lower, int24 upper, uint128 liq, uint256 m0, uint256 m1)
        internal
    {
        pool.set(twap);
        npm.set(lower, upper);
        (uint256 a0, uint256 a1) = h.decreaseAt(address(pool), band, liq);
        assertEq(a0, m0, "amount0Min");
        assertEq(a1, m1, "amount1Min");
    }

    function test_decreaseMinsVectors() public {
        _decrease(-69080, 100, -69600, -68600, 1e15, 592133465427250, 653877192857);
        _decrease(-69080, 80, -69600, -68600, 1e15, 623611109448142, 685358005450);
        _decrease(-69080, 100, -70000, -69500, 1e15, 0, 764545476004);
        _decrease(1, 10, -19, 22, 1e12, 549518991, 499625164);
        _decrease(-193380, 100, -193440, -193320, 1e18, 0, 0);
    }
}
