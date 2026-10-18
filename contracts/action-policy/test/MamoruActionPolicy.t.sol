// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {OracleLibrary} from "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
import {
    MamoruActionPolicy,
    ConfigId,
    MintParams,
    ExactInputSingleParams,
    DecreaseLiquidityParams,
    CollectParams,
    IERC20Min
} from "../src/MamoruActionPolicy.sol";

interface IRouter02 {
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface INPMFull {
    function mint(MintParams calldata)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256, uint256);
    function collect(CollectParams calldata) external payable returns (uint256, uint256);
    function burn(uint256) external payable;
    function setApprovalForAll(address, bool) external;
    function positions(uint256)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
}

/// Shared fork fixture: addresses, the policy, Init builders, pushes.
abstract contract PolicyFixture is Test {
    uint256 constant FORK_BLOCK = 52_700_000;

    // packages/registry/base.json
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant POOL_BTC = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef; // USDC/cbBTC 0.05%, token0 USDC
    address constant POOL_STABLE = 0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1; // USDC/USDT 0.01%
    address constant POOL_ETH = 0x6c561B446416E1A00E8E93E221854d6eA4171372; // WETH/USDC 0.3%, token0 WETH

    uint24 constant BAND = 100; // ticks, = execution.maxTwapDeviationTicks of the live policy
    uint24 constant STABLE_BAND = 10;
    uint32 constant TWAP = 1800; // seconds, = execution.twapWindowSeconds
    uint32 constant TWAP_SHORT = 300;
    // Harmonic-mean liquidity floors (packages/policy/src/v4-grants.ts V4_POOLS.minLiquidity): a share of each pool's
    // in-range liquidity at block 52,700,000 (btc 2.679e12 x 25%, stables 2.972e14 x 10%, eth 3.40e19 x 10%).
    uint128 constant BTC_MIN_LIQ = 669_000_000_000;
    uint128 constant STABLE_MIN_LIQ = 29_700_000_000_000;
    uint128 constant ETH_MIN_LIQ = 3_400_000_000_000_000_000;

    MamoruActionPolicy policy;
    address safe = makeAddr("safe");
    address attacker = makeAddr("attacker");
    ConfigId constant ID = ConfigId.wrap(bytes32(uint256(1)));

    function _fork() internal {
        // Public Base endpoint with archive state; never the operator's provider key.
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), FORK_BLOCK);
        policy = new MamoruActionPolicy(SMART_SESSION, NPM, ROUTER, FACTORY);
    }

    function _initData(
        address pool,
        uint24 band,
        uint128 minLiq,
        bool in1,
        uint64 gen,
        uint128 perWindow,
        uint128 total,
        uint256[] memory admit
    ) internal pure returns (bytes memory) {
        return abi.encode(
            MamoruActionPolicy.Init({
                pool: pool,
                twapWindow: TWAP,
                twapShortWindow: TWAP_SHORT,
                bandTicks: band,
                generation: gen,
                minLiquidity: minLiq,
                budgetIn1: in1,
                budgetWindow: 1 days,
                perWindow: perWindow,
                total: total,
                admit: admit
            })
        );
    }

    function _initBtc(ConfigId id, uint64 gen, uint128 perWindow, uint128 total) internal {
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(
            safe, id, _initData(POOL_BTC, BAND, BTC_MIN_LIQ, false, gen, perWindow, total, new uint256[](0))
        );
    }

    function _check(address target, bytes memory data) internal returns (uint256 r) {
        vm.prank(SMART_SESSION);
        r = policy.checkAction(ID, safe, target, 0, data);
    }

    function _checkId(ConfigId id, address target, bytes memory data) internal returns (uint256 r) {
        vm.prank(SMART_SESSION);
        r = policy.checkAction(id, safe, target, 0, data);
    }

    function _checkGas(address target, bytes memory data) internal returns (uint256 r, uint256 gas) {
        vm.prank(SMART_SESSION);
        uint256 g = gasleft();
        r = policy.checkAction(ID, safe, target, 0, data);
        gas = g - gasleft();
    }

    function _exec(address target, bytes memory data) internal returns (bytes memory ret) {
        vm.prank(safe);
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _swapData(address tIn, address tOut, uint24 fee, uint256 amountIn, uint256 minOut, uint160 limit)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeCall(
            IRouter02.exactInputSingle, (ExactInputSingleParams(tIn, tOut, fee, safe, amountIn, minOut, limit))
        );
    }

    function _spot(address pool) internal view returns (int24 t) {
        (, t,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    /// The attacker moves `pool` by `ticks` with its own capital (positive: price of token0 in token1 up).
    function _push(address pool, address tokenIn, address tokenOut, uint24 fee, int24 ticks)
        internal
        returns (uint256 spent, uint256 got)
    {
        int24 target = _spot(pool) + ticks;
        deal(tokenIn, attacker, 1e30);
        vm.startPrank(attacker);
        IERC20Min(tokenIn).approve(ROUTER, type(uint256).max);
        uint256 before = IERC20Min(tokenIn).balanceOf(attacker);
        uint256 o0 = IERC20Min(tokenOut).balanceOf(attacker);
        IRouter02(ROUTER)
            .exactInputSingle(
                ExactInputSingleParams(tokenIn, tokenOut, fee, attacker, 1e29, 0, TickMath.getSqrtRatioAtTick(target))
            );
        spent = before - IERC20Min(tokenIn).balanceOf(attacker);
        got = IERC20Min(tokenOut).balanceOf(attacker) - o0;
        vm.stopPrank();
    }

    /// Sells exactly `amountIn` (the attacker's own tokens) with no price limit.
    function _sell(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal {
        vm.startPrank(attacker);
        IERC20Min(tokenIn).approve(ROUTER, type(uint256).max);
        IRouter02(ROUTER)
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

    function _nextBlock(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + 2 * blocks);
    }

    function _twapOf(address pool, uint32 window) internal view returns (int24 t) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory c,) = IUniswapV3Pool(pool).observe(ago);
        int56 d = c[1] - c[0];
        t = int24(d / int56(uint56(window)));
        if (d < 0 && (d % int56(uint56(window)) != 0)) t--;
    }

    function _mintThroughPolicy(uint256 usdc, uint256 btc) internal returns (uint256 tokenId, uint128 liquidity) {
        int24 s = _spot(POOL_BTC);
        int24 lower = ((s - 600) / 10) * 10;
        int24 upper = ((s + 600) / 10) * 10;
        MintParams memory m = MintParams(USDC, CBBTC, 500, lower, upper, usdc, btc, 0, 0, safe, block.timestamp);
        bytes memory a0 = abi.encodeCall(IERC20Min.approve, (address(policy), usdc));
        bytes memory a1 = abi.encodeCall(IERC20Min.approve, (address(policy), btc));
        bytes memory mm = abi.encodeCall(MamoruActionPolicy.mint, (m));
        uint256 ga = gasleft();
        assertEq(_check(USDC, a0), 0);
        console2.log("gas checkAction(approve):", ga - gasleft());
        assertEq(_check(CBBTC, a1), 0);
        uint256 gm = gasleft();
        assertEq(_check(address(policy), mm), 0, "mint refused");
        console2.log("gas checkAction(mint):", gm - gasleft());
        _exec(USDC, a0);
        _exec(CBBTC, a1);
        uint256 g = gasleft();
        (tokenId, liquidity,,) = abi.decode(_exec(address(policy), mm), (uint256, uint128, uint256, uint256));
        console2.log("gas policy.mint (exec only):", g - gasleft());
    }

    /// A position minted straight at the manager (outside this policy), as v2/v3 grants and the owner do.
    function _mintDirect(address owner, uint256 usdc, uint256 btc) internal returns (uint256 id, uint128 liq) {
        int24 s = _spot(POOL_BTC);
        MintParams memory m = MintParams(
            USDC, CBBTC, 500, ((s - 600) / 10) * 10, ((s + 600) / 10) * 10, usdc, btc, 0, 0, owner, block.timestamp
        );
        deal(USDC, owner, IERC20Min(USDC).balanceOf(owner) + usdc);
        deal(CBBTC, owner, IERC20Min(CBBTC).balanceOf(owner) + btc);
        vm.startPrank(owner);
        IERC20Min(USDC).approve(NPM, usdc);
        IERC20Min(CBBTC).approve(NPM, btc);
        (id, liq,,) = INPMFull(NPM).mint(m);
        vm.stopPrank();
    }
}

/**
 * Spec 007 PoC on a Base mainnet fork (public archive RPC, pinned block). The policy is called the way SmartSession
 * calls it during validateUserOp (msg.sender = SmartSession, account = the Safe), and the actions are then executed
 * from the account, as Safe7579 does after validation. The real SmartSession/Safe7579 stack is in the TS fork
 * scenarios (packages/scenarios/action-policy/t1..t4-fork.ts).
 */
contract MamoruActionPolicyTest is PolicyFixture {
    function setUp() public {
        _fork();
        deal(USDC, safe, 100_000e6);
        deal(CBBTC, safe, 1e8);
        _initBtc(ID, 1, 60_000e6, 180_000e6);
    }

    // ------------------------------------------------------------ the engine's normal operations pass

    function test_normalSwapPasses() public {
        uint256 amountIn = 10_000e6;
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, amountIn);
        bytes memory swap = _swapData(USDC, CBBTC, 500, amountIn, minOut, limit);
        (uint256 r, uint256 gas) = _checkGas(ROUTER, swap);
        assertEq(r, 0);
        console2.log("gas checkAction(exactInputSingle):", gas);
        _exec(USDC, abi.encodeCall(IERC20Min.approve, (ROUTER, amountIn)));
        uint256 b0 = IERC20Min(CBBTC).balanceOf(safe);
        _exec(ROUTER, swap);
        uint256 got = IERC20Min(CBBTC).balanceOf(safe) - b0;
        assertGe(got, minOut);
        console2.log("swap 10k USDC: out sats / policy minimum sats", got, minOut);
    }

    function test_normalMintDecreaseCollectBurnPass() public {
        uint256 g = gasleft();
        (uint256 tokenId, uint128 liq) = _mintThroughPolicy(20_000e6, 0.2e8);
        console2.log("gas approve+approve+policy.mint (exec, incl. checks):", g - gasleft());
        assertEq(policy.admittedPool(safe, tokenId), POOL_BTC);
        assertEq(IERC20Min(USDC).balanceOf(address(policy)), 0, "nothing left in the policy");
        assertEq(IERC20Min(CBBTC).balanceOf(address(policy)), 0, "nothing left in the policy");

        (uint256 min0, uint256 min1) = policy.decreaseMins(safe, POOL_BTC, tokenId, liq);
        bytes memory dec = abi.encodeCall(
            INPMFull.decreaseLiquidity, (DecreaseLiquidityParams(tokenId, liq, min0, min1, block.timestamp))
        );
        (uint256 r, uint256 gas) = _checkGas(NPM, dec);
        assertEq(r, 0);
        console2.log("gas checkAction(decreaseLiquidity):", gas);
        _exec(NPM, dec);

        bytes memory col =
            abi.encodeCall(INPMFull.collect, (CollectParams(tokenId, safe, type(uint128).max, type(uint128).max)));
        (r, gas) = _checkGas(NPM, col);
        assertEq(r, 0);
        console2.log("gas checkAction(collect):", gas);
        _exec(NPM, col);

        bytes memory burn = abi.encodeCall(INPMFull.burn, (tokenId));
        (r, gas) = _checkGas(NPM, burn);
        assertEq(r, 0);
        console2.log("gas checkAction(burn):", gas);
        _exec(NPM, burn);
    }

    function test_gasDirectMintBaseline() public {
        int24 s = _spot(POOL_BTC);
        MintParams memory m = MintParams(
            USDC, CBBTC, 500, ((s - 600) / 10) * 10, ((s + 600) / 10) * 10, 20_000e6, 0.2e8, 0, 0, safe, block.timestamp
        );
        uint256 g = gasleft();
        _exec(USDC, abi.encodeCall(IERC20Min.approve, (NPM, 20_000e6)));
        _exec(CBBTC, abi.encodeCall(IERC20Min.approve, (NPM, 0.2e8)));
        uint256 g2 = gasleft();
        _exec(NPM, abi.encodeCall(INPMFull.mint, (m)));
        console2.log("gas NPM.mint (exec only):", g2 - gasleft());
        console2.log("gas approve+approve+NPM.mint (today's grant, exec):", g - gasleft());
    }

    // ------------------------------------------------------------ (a) a manipulated-price swap reverts

    function test_manipulatedSwapReverts() public {
        uint256 amountIn = 10_000e6;
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, amountIn);

        // The attacker buys cbBTC with USDC: 500 ticks (~5%) fewer cbBTC per USDC. Same block, so the TWAPs are unchanged.
        (uint256 spent,) = _push(POOL_BTC, USDC, CBBTC, 500, -500);
        console2.log("attacker USDC to move USDC/cbBTC by 500 ticks:", spent / 1e6);

        // What today's grant accepts (amountOutMinimum > 0, sqrtPriceLimitX96 == 0): the policy refuses it.
        bytes memory loose = _swapData(USDC, CBBTC, 500, amountIn, 1, 0);
        assertEq(_check(ROUTER, loose), 1, "loose swap must be refused");

        uint256 snap = vm.snapshotState();
        _exec(USDC, abi.encodeCall(IERC20Min.approve, (ROUTER, amountIn)));
        uint256 b0 = IERC20Min(CBBTC).balanceOf(safe);
        _exec(ROUTER, loose);
        uint256 got = IERC20Min(CBBTC).balanceOf(safe) - b0;
        console2.log("today's grant: filled sats vs the policy minimum sats", got, minOut);
        console2.log("today's grant: shortfall vs the policy floor, bps", (minOut - got) * 10_000 / minOut);
        vm.revertToState(snap);

        bytes memory tight = _swapData(USDC, CBBTC, 500, amountIn, minOut, limit);
        assertEq(_check(ROUTER, tight), 0);
        _exec(USDC, abi.encodeCall(IERC20Min.approve, (ROUTER, amountIn)));
        vm.prank(safe);
        vm.expectRevert();
        IRouter02(ROUTER).exactInputSingle(ExactInputSingleParams(USDC, CBBTC, 500, safe, amountIn, minOut, limit));

        _assertOutOfBandRefused(amountIn, minOut, limit);
    }

    /// A minimum below the band, no price limit, or a limit past the band edge: refused at validation.
    function _assertOutOfBandRefused(uint256 amountIn, uint256 minOut, uint160 limit) internal {
        assertEq(_check(ROUTER, _swapData(USDC, CBBTC, 500, amountIn, minOut - 1, limit)), 1);
        assertEq(_check(ROUTER, _swapData(USDC, CBBTC, 500, amountIn, minOut, 0)), 1);
        assertEq(_check(ROUTER, _swapData(USDC, CBBTC, 500, amountIn, minOut, limit - 1)), 1);
    }

    function test_mintRefusedWhenSpotManipulated() public {
        _push(POOL_BTC, USDC, CBBTC, 500, -300);
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

    function test_decreaseRefusedWhenSpotManipulated() public {
        (uint256 tokenId, uint128 liq) = _mintThroughPolicy(20_000e6, 0.2e8);
        (uint256 min0, uint256 min1) = policy.decreaseMins(safe, POOL_BTC, tokenId, liq);
        _push(POOL_BTC, USDC, CBBTC, 500, -300);
        bytes memory dec = abi.encodeCall(
            INPMFull.decreaseLiquidity, (DecreaseLiquidityParams(tokenId, liq, min0, min1, block.timestamp))
        );
        assertEq(_check(NPM, dec), 0); // calldata is within policy; the manager's own slippage check stops it
        vm.prank(safe);
        vm.expectRevert(bytes("Price slippage check"));
        INPMFull(NPM).decreaseLiquidity(DecreaseLiquidityParams(tokenId, liq, min0, min1, block.timestamp));
        bytes memory loose =
            abi.encodeCall(INPMFull.decreaseLiquidity, (DecreaseLiquidityParams(tokenId, liq, 0, 0, block.timestamp)));
        assertEq(_check(NPM, loose), 1);
    }

    /// Review point (agy, PR #63): a range inside the band gets zero minimums. The loss still stays within the band,
    /// because liquidity converts at prices inside its own range, never at the manipulated spot.
    function test_narrowRangeDecreaseLossStaysInBand() public {
        int24 s = _spot(POOL_BTC);
        int24 lower = ((s - 40) / 10) * 10;
        int24 upper = ((s + 40) / 10) * 10;
        MintParams memory m = MintParams(USDC, CBBTC, 500, lower, upper, 20_000e6, 0.2e8, 0, 0, safe, block.timestamp);
        _exec(USDC, abi.encodeCall(IERC20Min.approve, (address(policy), 20_000e6)));
        _exec(CBBTC, abi.encodeCall(IERC20Min.approve, (address(policy), 0.2e8)));
        (uint256 tokenId, uint128 liq, uint256 in0, uint256 in1) = abi.decode(
            _exec(address(policy), abi.encodeCall(MamoruActionPolicy.mint, (m))), (uint256, uint128, uint256, uint256)
        );
        (uint256 min0, uint256 min1) = policy.decreaseMins(safe, POOL_BTC, tokenId, liq);
        assertEq(min0 + min1, 0, "range inside the band: both minimums are zero");
        _push(POOL_BTC, CBBTC, USDC, 500, 2_000); // spot 2,000 ticks up, far outside the band
        bytes memory dec =
            abi.encodeCall(INPMFull.decreaseLiquidity, (DecreaseLiquidityParams(tokenId, liq, 0, 0, block.timestamp)));
        assertEq(_check(NPM, dec), 0);
        (uint256 out0, uint256 out1) = abi.decode(_exec(NPM, dec), (uint256, uint256));
        int24 twap = _twapOf(POOL_BTC, TWAP);
        uint256 vin = in0 + _btcInUsdc(in1, twap);
        uint256 vout = out0 + _btcInUsdc(out1, twap);
        uint256 lossBps = vout >= vin ? 0 : (vin - vout) * 10_000 / vin;
        console2.log("narrow range, spot +2000 ticks: decrease loss vs TWAP value, bps", lossBps);
        assertLe(lossBps, BAND, "loss must stay within the band");
    }

    /// cbBTC (token1) in USDC (token0) at `tick`: amount1 / 1.0001^tick.
    function _btcInUsdc(uint256 amount1, int24 tick) internal pure returns (uint256) {
        uint256 sp = TickMath.getSqrtRatioAtTick(tick);
        return (amount1 << 192) / (sp * sp);
    }

    function test_supportsSmartSessionInterfaceIds() public view {
        // smartsessions: IActionPolicy is IPolicy, so type(IActionPolicy).interfaceId == checkAction.selector and
        // type(IPolicy).interfaceId == initializeWithMultiplexer.selector (interfaceId excludes inherited functions).
        assertTrue(policy.supportsInterface(0x01ffc9a7));
        assertTrue(policy.supportsInterface(MamoruActionPolicy.checkAction.selector));
        assertTrue(policy.supportsInterface(MamoruActionPolicy.initializeWithMultiplexer.selector));
    }

    // ------------------------------------------------------------ (b) an unrelated NFT cannot be touched

    function test_unrelatedNftDecreaseReverts() public {
        (uint256 own, uint128 liq) = _mintDirect(safe, 30_000e6, 0.3e8);
        bytes memory dec =
            abi.encodeCall(INPMFull.decreaseLiquidity, (DecreaseLiquidityParams(own, liq, 0, 0, block.timestamp)));
        assertEq(_check(NPM, dec), 1, "unadmitted decrease must be refused");
        assertEq(_check(NPM, abi.encodeCall(INPMFull.collect, (CollectParams(own, safe, 1, 1)))), 1);
        assertEq(_check(NPM, abi.encodeCall(INPMFull.burn, (own))), 1);

        // A position held elsewhere whose owner approved the Safe as operator: also refused.
        address other = makeAddr("other");
        (uint256 theirs, uint128 l2) = _mintDirect(other, 1_000e6, 0.01e8);
        vm.prank(other);
        INPMFull(NPM).setApprovalForAll(safe, true);
        dec = abi.encodeCall(INPMFull.decreaseLiquidity, (DecreaseLiquidityParams(theirs, l2, 0, 0, block.timestamp)));
        assertEq(_check(NPM, dec), 1, "approved-but-foreign decrease must be refused");
    }

    // ------------------------------------------------------------ (c) cumulative budget across one batch

    function test_batchOverBudgetReverts() public {
        // SmartSession validates a batch by calling checkAction once per execution, in order, in one validateUserOp.
        uint256 amountIn = 25_000e6; // bucket capacity 60k USDC of value
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, amountIn);
        bytes memory swap = _swapData(USDC, CBBTC, 500, amountIn, minOut, limit);
        assertEq(_check(ROUTER, swap), 0);
        assertEq(_check(ROUTER, swap), 0);
        assertEq(_check(ROUTER, swap), 1, "third 25k swap in one window must be refused");
        // A mint draws on the same budget.
        MintParams memory m = MintParams(USDC, CBBTC, 500, -70000, -60000, 10_001e6, 0, 0, 0, safe, block.timestamp);
        assertEq(_check(address(policy), abi.encodeCall(MamoruActionPolicy.mint, (m))), 1);
        m.amount0Desired = 10_000e6;
        assertEq(_check(address(policy), abi.encodeCall(MamoruActionPolicy.mint, (m))), 0);

        // A day later the bucket is full again; the per-approval total (180k) does not refill.
        for (uint256 d; d < 2; d++) {
            vm.warp(block.timestamp + 1 days);
            vm.roll(block.number + 43_200);
            (minOut, limit) = policy.swapBounds(safe, POOL_BTC, USDC, amountIn);
            swap = _swapData(USDC, CBBTC, 500, amountIn, minOut, limit);
            assertEq(_check(ROUTER, swap), 0);
            assertEq(_check(ROUTER, swap), 0);
        }
        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 43_200);
        (minOut, limit) = policy.swapBounds(safe, POOL_BTC, USDC, 20_000e6);
        assertEq(_check(ROUTER, _swapData(USDC, CBBTC, 500, 20_000e6, minOut, limit)), 0); // 180k: exactly the total
        (minOut, limit) = policy.swapBounds(safe, POOL_BTC, USDC, 1e6);
        assertEq(
            _check(ROUTER, _swapData(USDC, CBBTC, 500, 1e6, minOut, limit)),
            1,
            "approval total must hold across windows"
        );
    }

    // ------------------------------------------------------------ (d) renewal retires the old grant

    function test_renewalRetiresOldGrant() public {
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, 1_000e6);
        bytes memory swap = _swapData(USDC, CBBTC, 500, 1_000e6, minOut, limit);
        assertEq(_check(ROUTER, swap), 0);
        ConfigId fresh = ConfigId.wrap(bytes32(uint256(2))); // new session key -> new permissionId -> new ConfigId
        uint256 g = gasleft();
        _initBtc(fresh, 2, 60_000e6, 180_000e6);
        console2.log("gas initializeWithMultiplexer (one action, renewal):", g - gasleft());
        assertEq(_check(ROUTER, swap), 1, "generation-1 grant must be dead after renewal");
        assertEq(_checkId(fresh, ROUTER, swap), 0);
        // An older approval cannot be re-enabled.
        vm.expectRevert();
        this.initAt(ConfigId.wrap(bytes32(uint256(3))), 1);
    }

    function initAt(ConfigId id, uint64 gen) external {
        _initBtc(id, gen, 1, 1);
    }

    function test_onlySmartSession() public {
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, 1_000e6);
        bytes memory swap = _swapData(USDC, CBBTC, 500, 1_000e6, minOut, limit);
        vm.prank(attacker);
        assertEq(policy.checkAction(ID, safe, ROUTER, 0, swap), 1);
        vm.prank(attacker);
        vm.expectRevert(MamoruActionPolicy.OnlySmartSession.selector);
        policy.initializeWithMultiplexer(safe, ID, "");
    }

    // ------------------------------------------------------------ measurement for the spec: capital to move each pool

    function test_measureManipulationDepth() public {
        int24[3] memory moves = [int24(10), 100, 500];
        for (uint256 i; i < 3; i++) {
            uint256 snap = vm.snapshotState();
            (uint256 st,) = _push(POOL_STABLE, USDC, USDT, 100, -moves[i]); // USDC is token0: USDC in lowers the price
            vm.revertToState(snap);
            (uint256 bt,) = _push(POOL_BTC, USDC, CBBTC, 500, -moves[i]);
            vm.revertToState(snap);
            (uint256 et,) = _push(POOL_ETH, USDC, WETH, 3000, moves[i]); // USDC is token1: USDC in raises the price
            vm.revertToState(snap);
            console2.log("ticks", uint256(int256(moves[i])));
            console2.log("  USDC to move USDC/USDT 0.01%:", st / 1e6);
            console2.log("  USDC to move USDC/cbBTC 0.05%:", bt / 1e6);
            console2.log("  USDC to move WETH/USDC 0.3%:", et / 1e6);
        }
        console2.log("oldest observation, seconds ago: stable / btc / eth");
        console2.log(_oldest(POOL_STABLE), _oldest(POOL_BTC), _oldest(POOL_ETH));
    }

    function _oldest(address pool) internal view returns (uint256) {
        (,, uint16 idx, uint16 card,,,) = IUniswapV3Pool(pool).slot0();
        (uint32 ts,,, bool init) = IUniswapV3Pool(pool).observations((idx + 1) % card);
        if (!init) (ts,,,) = IUniswapV3Pool(pool).observations(0);
        return block.timestamp - ts;
    }
}
