// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {ExactInputSingleParams, IERC20Min} from "../src/MamoruActionPolicy.sol";

interface IRouter02M {
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface INPMMeasure {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata) external payable returns (uint256, uint128, uint256, uint256);
    function decreaseLiquidity(DecreaseParams calldata) external payable returns (uint256, uint256);
    function collect(CollectParams calldata) external payable returns (uint256, uint256);
}

/**
 * T6 H-1 measurement (spec 007, otto/mamoru#151). Not a pass/fail test: it prints the numbers
 * results/t6-fixes-2026-10-18.md quotes. Run alone:
 *   forge test --mc H1Measure -vv
 * Fork: BASE_FORK_RPC_URL or the public https://mainnet.base.org, block H1_FORK_BLOCK (default 52,700,000).
 */
contract H1Measure is Test {
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant POOL_STABLE = 0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1; // USDC/USDT 0.01%, token0 USDC
    address constant POOL_BTC = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef; // USDC/cbBTC 0.05%, token0 USDC
    address constant POOL_ETH = 0x6c561B446416E1A00E8E93E221854d6eA4171372; // WETH/USDC 0.3%, token0 WETH

    address constant NPM_ADDR = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address attacker = makeAddr("attacker");

    function setUp() public {
        vm.createSelectFork(
            vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")),
            vm.envOr("H1_FORK_BLOCK", uint256(52_700_000))
        );
    }

    // ------------------------------------------------------------ helpers

    function _spot(address pool) internal view returns (int24 t) {
        (, t,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    /// Pushes `pool` to `target` with `tokenIn`; returns (in, out).
    function _swapTo(address pool, address tokenIn, address tokenOut, uint24 fee, int24 target)
        internal
        returns (uint256 spent, uint256 got)
    {
        pool;
        deal(tokenIn, attacker, IERC20Min(tokenIn).balanceOf(attacker) + 1e30);
        vm.startPrank(attacker);
        IERC20Min(tokenIn).approve(ROUTER, type(uint256).max);
        uint256 b0 = IERC20Min(tokenIn).balanceOf(attacker);
        uint256 o0 = IERC20Min(tokenOut).balanceOf(attacker);
        IRouter02M(ROUTER)
            .exactInputSingle(
                ExactInputSingleParams(tokenIn, tokenOut, fee, attacker, 1e29, 0, TickMath.getSqrtRatioAtTick(target))
            );
        spent = b0 - IERC20Min(tokenIn).balanceOf(attacker);
        got = IERC20Min(tokenOut).balanceOf(attacker) - o0;
        vm.stopPrank();
    }

    /// Exact-in swap of `amountIn` (all of it, no limit).
    function _swapExact(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        internal
        returns (uint256 got)
    {
        vm.startPrank(attacker);
        IERC20Min(tokenIn).approve(ROUTER, type(uint256).max);
        uint256 o0 = IERC20Min(tokenOut).balanceOf(attacker);
        bool zeroForOne = tokenIn < tokenOut;
        IRouter02M(ROUTER)
            .exactInputSingle(
                ExactInputSingleParams(
                    tokenIn,
                    tokenOut,
                    fee,
                    attacker,
                    amountIn,
                    0,
                    zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
                )
            );
        got = IERC20Min(tokenOut).balanceOf(attacker) - o0;
        vm.stopPrank();
    }

    /// (twapLong, twapShort, hmLong, hmShort) from one observe([long, short, 0]) — floor-rounded like consult.
    function _oracle(address pool, uint32 longW, uint32 shortW)
        internal
        view
        returns (int24 tl, int24 ts, uint128 hl, uint128 hs)
    {
        uint32[] memory ago = new uint32[](3);
        ago[0] = longW;
        ago[1] = shortW;
        (int56[] memory tc, uint160[] memory sl) = IUniswapV3Pool(pool).observe(ago);
        tl = _mean(tc[2] - tc[0], longW);
        ts = _mean(tc[2] - tc[1], shortW);
        hl = uint128((uint192(longW) * type(uint160).max) / (uint192(sl[2] - sl[0]) << 32));
        hs = uint128((uint192(shortW) * type(uint160).max) / (uint192(sl[2] - sl[1]) << 32));
    }

    function _mean(int56 d, uint32 w) internal pure returns (int24 t) {
        t = int24(d / int56(uint56(w)));
        if (d < 0 && (d % int56(uint56(w)) != 0)) t--;
    }

    // ------------------------------------------------------------ 1. liquidity profile far from price

    /// Active liquidity at each distance from spot, and the capital that moves the pool there (both directions).
    function test_h1_liquidityProfile() public {
        address[3] memory pools = [POOL_STABLE, POOL_BTC, POOL_ETH];
        string[3] memory names = ["USDC/USDT 0.01%", "USDC/cbBTC 0.05%", "WETH/USDC 0.3%"];
        uint24[3] memory fees = [uint24(100), 500, 3000];
        address[3] memory t0 = [USDC, USDC, WETH];
        address[3] memory t1 = [USDT, CBBTC, USDC];
        int24[9] memory d = [int24(10), 50, 100, 500, 1_000, 2_000, 5_000, 9_000, 20_000];
        for (uint256 p; p < 3; p++) {
            console2.log("== pool", names[p]);
            console2.log("   in-range liquidity at spot:", uint256(IUniswapV3Pool(pools[p]).liquidity()));
            for (uint256 i; i < d.length; i++) {
                uint256 snap = vm.snapshotState();
                int24 s = _spot(pools[p]);
                (uint256 inDown,) = _swapTo(pools[p], t0[p], t1[p], fees[p], s - d[i]); // token0 in: price down
                uint128 lDown = IUniswapV3Pool(pools[p]).liquidity();
                vm.revertToState(snap);
                (uint256 inUp,) = _swapTo(pools[p], t1[p], t0[p], fees[p], s + d[i]); // token1 in: price up
                uint128 lUp = IUniswapV3Pool(pools[p]).liquidity();
                vm.revertToState(snap);
                console2.log("   ticks", uint256(int256(d[i])));
                console2.log("     down: token0 in (raw), liquidity there", inDown, uint256(lDown));
                console2.log("     up:   token1 in (raw), liquidity there", inUp, uint256(lUp));
            }
        }
    }

    // ------------------------------------------------------------ 2. one-block and N-block outliers on the stables pool

    /// Attacker is the last swap of block N (pushes D ticks down with USDC), holds for `blocks` block boundaries,
    /// then reverts with the first swap of block N+blocks. Prints the cost and what the oracle sees afterwards.
    struct Obs {
        int24 tl;
        int24 ts;
        uint128 hl;
        uint128 hs;
    }

    function _obs(uint32 shortW) internal view returns (Obs memory o) {
        (o.tl, o.ts, o.hl, o.hs) = _oracle(POOL_STABLE, 1800, shortW);
    }

    function _outlier(int24 dist, uint256 blocks, uint32 shortW) internal {
        uint256 snap = vm.snapshotState();
        Obs memory b = _obs(shortW);
        deal(USDC, attacker, 0);
        deal(USDT, attacker, 0);
        (uint256 usdcIn, uint256 usdtOut) = _swapTo(POOL_STABLE, USDC, USDT, 100, _spot(POOL_STABLE) - dist);
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + 2 * blocks);
        uint256 usdcBack = _swapExact(USDT, USDC, 100, usdtOut);
        Obs memory a = _obs(shortW);
        console2.log("D ticks / blocks held:", uint256(int256(dist)), blocks);
        console2.log("  USDC in (whole) / round-trip loss (USDC, 6dp raw):", usdcIn / 1e6, usdcIn - usdcBack);
        console2.log("  long TWAP shift (ticks):", uint256(int256(b.tl) - int256(a.tl)));
        console2.log("  short TWAP shift (ticks), short window:", uint256(int256(b.ts) - int256(a.ts)), shortW);
        console2.log("  harmonic-mean liquidity long, before/after:", uint256(b.hl), uint256(a.hl));
        console2.log("  harmonic-mean liquidity short, before/after:", uint256(b.hs), uint256(a.hs));
        vm.revertToState(snap);
    }

    function test_h1_oneBlockOutlier() public {
        int24[7] memory d = [int24(10), 100, 500, 1_000, 2_000, 9_000, 20_000];
        for (uint256 i; i < d.length; i++) {
            _outlier(d[i], 1, 300);
        }
    }

    function test_h1_nBlockOutlier() public {
        uint256[4] memory n = [uint256(2), 5, 15, 45];
        for (uint256 i; i < n.length; i++) {
            _outlier(100, n[i], 300);
            _outlier(9_000, n[i], 300);
        }
    }

    /// The arbitrage an attacker gives away per block if someone else closes the gap: value lost when pushing D
    /// and NOT getting to revert (the arb reverts instead). USDC in minus the USDT got, valued at the pre-push price.
    /// Same one-block outlier on USDC/cbBTC (capital is the attacker's own: a flash loan cannot span a block).
    function test_h1_oneBlockOutlierBtc() public {
        int24[6] memory d = [int24(1_000), 2_000, 5_000, 9_000, 20_000, 90_000];
        for (uint256 i; i < d.length; i++) {
            uint256 snap = vm.snapshotState();
            (int24 tl0, int24 ts0, uint128 hl0, uint128 hs0) = _oracle(POOL_BTC, 1800, 300);
            deal(USDC, attacker, 0);
            deal(CBBTC, attacker, 0);
            (uint256 usdcIn, uint256 btcOut) = _swapTo(POOL_BTC, USDC, CBBTC, 500, _spot(POOL_BTC) - d[i]);
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 2);
            uint256 back = _swapExact(CBBTC, USDC, 500, btcOut);
            (int24 tl1, int24 ts1, uint128 hl1, uint128 hs1) = _oracle(POOL_BTC, 1800, 300);
            console2.log("btc D ticks:", uint256(int256(d[i])));
            console2.log("  USDC in / round-trip loss (USDC):", usdcIn / 1e6, (usdcIn - back) / 1e6);
            console2.log(
                "  long / short TWAP shift (ticks):",
                uint256(int256(tl0) - int256(tl1)),
                uint256(int256(ts0) - int256(ts1))
            );
            console2.log("  HM long before/after:", uint256(hl0), uint256(hl1));
            console2.log("  HM short before/after:", uint256(hs0), uint256(hs1));
            vm.revertToState(snap);
        }
    }

    /// Does the harmonic-mean liquidity floor survive an attacker who also mints its own narrow position at the
    /// pushed tick for the block boundary (JIT liquidity)? Push 9,000 ticks, mint ~`jit` USDC of liquidity in a
    /// 2-tick range around the pushed tick, cross the block boundary, swap back, burn.
    function test_h1_jitLiquidityAtThePushedTick() public {
        uint256[3] memory jit = [uint256(100e6), 1_000e6, 10_000e6];
        for (uint256 i; i < jit.length; i++) {
            uint256 snap = vm.snapshotState();
            Obs memory b = _obs(300);
            deal(USDC, attacker, 0);
            deal(USDT, attacker, 0);
            (uint256 usdcIn, uint256 usdtOut) = _swapTo(POOL_STABLE, USDC, USDT, 100, _spot(POOL_STABLE) - 9_000);
            int24 t = _spot(POOL_STABLE);
            deal(USDC, attacker, IERC20Min(USDC).balanceOf(attacker) + jit[i]);
            deal(USDT, attacker, IERC20Min(USDT).balanceOf(attacker) + jit[i]);
            vm.startPrank(attacker);
            IERC20Min(USDC).approve(NPM_ADDR, type(uint256).max);
            IERC20Min(USDT).approve(NPM_ADDR, type(uint256).max);
            (uint256 id, uint128 liq,,) = INPMMeasure(NPM_ADDR)
                .mint(
                    INPMMeasure.MintParams(
                        USDC, USDT, 100, t - 1, t + 1, jit[i], jit[i], 0, 0, attacker, block.timestamp
                    )
                );
            vm.stopPrank();
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 2);
            _swapExact(USDT, USDC, 100, usdtOut);
            vm.startPrank(attacker);
            INPMMeasure(NPM_ADDR).decreaseLiquidity(INPMMeasure.DecreaseParams(id, liq, 0, 0, block.timestamp));
            INPMMeasure(NPM_ADDR).collect(INPMMeasure.CollectParams(id, attacker, type(uint128).max, type(uint128).max));
            vm.stopPrank();
            Obs memory a = _obs(300);
            console2.log("JIT USDC+USDT each / liquidity minted at the pushed tick:", jit[i] / 1e6, uint256(liq));
            console2.log("  push capital (USDC):", usdcIn / 1e6);
            console2.log(
                "  long / short TWAP shift:", uint256(int256(b.tl) - int256(a.tl)), uint256(int256(b.ts) - int256(a.ts))
            );
            console2.log(
                "  HM long / short after, bps of before:", uint256(a.hl) * 10_000 / b.hl, uint256(a.hs) * 10_000 / b.hs
            );
            vm.revertToState(snap);
        }
    }

    /// The residual on USDC/cbBTC after T6: one push more than 5 minutes ago (long TWAP only) plus one recent push
    /// (both), sized so the two TWAPs stay within 2 x band of each other. Prints what the range's floor for a
    /// token0 sale (max(long, short) - 99) moves, and what it cost: fees (round-trip loss) and own capital.
    function test_h1_spreadPushOnBtc() public {
        _spreadBtc(-75_000, -15_000);
        _spreadBtc(-60_000, -30_000);
        _spreadBtc(-45_000, -15_000);
    }

    function _spreadBtc(int24 oldTicks, int24 recentTicks) internal {
        uint256 snap = vm.snapshotState();
        (int24 tl0, int24 ts0,,) = _oracle(POOL_BTC, 1800, 300);
        int24 top0 = tl0 > ts0 ? tl0 : ts0;
        (uint256 inOld, uint256 lossOld) = _roundTrip(oldTicks);
        vm.warp(block.timestamp + 600);
        vm.roll(block.number + 300);
        (uint256 inNew, uint256 lossNew) = _roundTrip(recentTicks);
        (int24 tl1, int24 ts1,,) = _oracle(POOL_BTC, 1800, 300);
        int24 top1 = tl1 > ts1 ? tl1 : ts1;
        int256 gap = int256(tl1) - int256(ts1);
        console2.log("btc spread push, old / recent ticks:", uint256(int256(-oldTicks)), uint256(int256(-recentTicks)));
        console2.log("  capital old / recent (USDC):", inOld / 1e6, inNew / 1e6);
        console2.log("  fees (round-trip loss, USDC):", (lossOld + lossNew) / 1e6);
        console2.log("  long / short shift:", uint256(int256(tl0 - tl1)), uint256(int256(ts0 - ts1)));
        console2.log(
            "  token0-sale floor moved; range empty?", uint256(int256(top0 - top1)), (gap < 0 ? -gap : gap) > 199
        );
        vm.revertToState(snap);
    }

    function _roundTrip(int24 ticks) internal returns (uint256 usdcIn, uint256 loss) {
        deal(USDC, attacker, 0);
        deal(CBBTC, attacker, 0);
        uint256 btcOut;
        (usdcIn, btcOut) = _swapTo(POOL_BTC, USDC, CBBTC, 500, _spot(POOL_BTC) + ticks);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        loss = usdcIn - _swapExact(CBBTC, USDC, 500, btcOut);
    }

    function test_h1_arbGiveaway() public {
        int24[5] memory d = [int24(10), 50, 100, 500, 9_000];
        for (uint256 i; i < d.length; i++) {
            uint256 snap = vm.snapshotState();
            int24 s0 = _spot(POOL_STABLE);
            uint160 sp = TickMath.getSqrtRatioAtTick(s0);
            deal(USDC, attacker, 0);
            deal(USDT, attacker, 0);
            (uint256 usdcIn, uint256 usdtOut) = _swapTo(POOL_STABLE, USDC, USDT, 100, s0 - d[i]);
            // USDT valued in USDC at the pre-push tick: amount1 / price, price = sp^2 / 2^192.
            uint256 usdtValue = (usdtOut << 192) / (uint256(sp) * uint256(sp));
            console2.log("D ticks:", uint256(int256(d[i])));
            console2.log(
                "  USDC in / given away to the arb if it reverts first (USDC):",
                usdcIn / 1e6,
                (usdcIn - usdtValue) / 1e6
            );
            vm.revertToState(snap);
        }
    }
}
