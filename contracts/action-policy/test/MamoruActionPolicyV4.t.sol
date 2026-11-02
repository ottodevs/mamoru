// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {V4Fixture, IERC20T, INPMT, IRouterT} from "./V4Fixture.sol";
import {
    MamoruActionPolicyV4,
    MamoruV4Helper,
    InitV4,
    SwapParams,
    MintParams,
    ExactInputSingleParams,
    DecreaseLiquidityParams,
    CollectParams,
    IncreaseLiquidityParams,
    PoolEntryV4
} from "../src/MamoruActionPolicyV4.sol";
import {DeployMamoruV4} from "../script/DeployV4.s.sol";
import {ConfigIdV4} from "../src/SmartSessionTypes.sol";

/// An ERC-4626 that takes the assets and mints worthless shares: what a "hostile vault" entry would point at.
contract HostileVault {
    address public immutable asset;
    mapping(address => uint256) public balanceOf;

    constructor(address a) {
        asset = a;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        IERC20From(asset).transferFrom(msg.sender, address(0xdead), assets);
        balanceOf[receiver] += 1;
        return 1;
    }
}

interface IERC20From {
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IFactoryT {
    function createPool(address, address, uint24) external returns (address);
    function getPool(address, address, uint24) external view returns (address);
}

/**
 * Spec 010 T3/T4 + A1 (otto/mamoru#292, #316) on a Base fork: MamoruActionPolicyV4 called the way SmartSession calls it
 * (`checkAction` from SMART_SESSION, `initializeWithMultiplexer` from SMART_SESSION) and executed from the account
 * (msg.sender = the account), as Safe7579 does after validation. The real SmartSession / EntryPoint path is in
 * test/V4UserOpFork.t.sol.
 */
contract MamoruActionPolicyV4Test is V4Fixture {
    uint256 constant FAILED = 1;
    address constant POOL_BTC_30 = 0xeC558e484cC9f2210714E345298fdc53B253c27D; // USDC/cbBTC 0.3 %: eligible by rule
    address constant POOL_ETH_05 = 0xd0b53D9277642d899DF5C87A3966A349A798F224; // USDC/WETH 0.05 %: eligible by rule
    address constant POOL_USDT_ETH = 0xd92E0767473D1E3FF11Ac036f2b1DB90aD0aE55F; // USDT/WETH 0.05 %: no class

    function setUp() public {
        _forkBase();
        _init(acct);
        deal(USDC, acct, 100_000e6);
        deal(CBBTC, acct, 1e8);
        deal(USDT, acct, 100_000e6);
    }

    // ------------------------------------------------------------ deployment, pins

    function test_deploymentShapeAndSizes() public {
        assertEq(address(v4.GAS_POLICY()), address(gasPol));
        assertEq(helper.POLICY(), address(v4));
        assertEq(helper.GAS_POLICY(), address(gasPol));
        assertEq(helper.REMOTE_INIT(), address(v4.REMOTE_INIT()));
        assertLt(address(v4).code.length, 24_577, "V4 under EIP-170");
        assertLt(address(helper).code.length, 24_577, "helper under EIP-170");
        console2.log("V4 runtime bytes", address(v4).code.length);
        console2.log("helper runtime bytes", address(helper).code.length);
        console2.log("gas policy runtime bytes", address(gasPol).code.length);
        // Spec 010 I7 (A1): no contract of the stack carries a guardian, pause, review, readiness-setter or registry
        // selector, and the deploy script refuses one that does.
        DeployMamoruV4 d = new DeployMamoruV4();
        bytes4[] memory f = d.forbiddenSelectors();
        address[4] memory all = [address(v4), address(gasPol), address(helper), address(v4.REMOTE_INIT())];
        for (uint256 i; i < all.length; i++) {
            for (uint256 k; k < f.length; k++) {
                assertFalse(d.hasSelector(all[i].code, f[k]), "forbidden selector");
            }
        }
        assertTrue(d.hasSelector(address(v4).code, v4.swap.selector), "the scan finds a real selector");
        // The pinned stables are counted 1:1 as USD units: they must all have 6 decimals.
        assertEq(IERC20T(USDC).decimals(), 6);
        assertEq(IERC20T(USDT).decimals(), 6);
    }

    function test_initOnlyFromSmartSessionAndBounds() public {
        address a = makeAddr("fresh");
        vm.expectRevert(MamoruActionPolicyV4.OnlySmartSession.selector);
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, 1, address(0), 0, new uint256[](0))));
        vm.startPrank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 1));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(0, 1, address(0), 0, new uint256[](0))));
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 1));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(1e15 + 1, 1, address(0), 0, new uint256[](0))));
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 3));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, 1, address(0), 0, new uint256[](65))));
        // a home account names no home domain; a remote's home is another chain of the table (a sibling's, #307, its
        // own address there: V4EthereumSiblingFork)
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 4));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, 1, address(0), 15, new uint256[](0))));
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 4));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, 1, a, 6, new uint256[](0)))); // a sibling of itself here
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 4));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, 1, acct, 6, new uint256[](0)))); // Base's own domain
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 4));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, 1, acct, 3, new uint256[](0)))); // Arbitrum: not pinned
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, 1, acct, 15, new uint256[](0)))); // a Monad home
        vm.stopPrank();
    }

    /// LeftClaw H-1, ported: the first enable jumps at most to MAX_FIRST_GENERATION; renewals step by one.
    function test_H1_generationSteps() public {
        address a = makeAddr("h1");
        uint64 max = v4.MAX_GENERATION();
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 2));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, max, address(0), 0, new uint256[](0))));
        _init(a, ID, C, 40, new uint256[](0)); // a migration's jump
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 2));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, 42, address(0), 0, new uint256[](0))));
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.StaleGeneration.selector, 39, 40));
        v4.initializeWithMultiplexer(a, ID, abi.encode(InitV4(C, 39, address(0), 0, new uint256[](0))));
        _init(a, ConfigIdV4.wrap(bytes32(uint256(2))), C, 41, new uint256[](0));
        assertEq(v4.generationOf(a), 41);
        // same generation, different terms: refused (T6 I-1)
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.ConfigMismatch.selector, a, 41));
        v4.initializeWithMultiplexer(a, ConfigIdV4.wrap(bytes32(uint256(3))), abi.encode(InitV4(C + 1, 41, address(0), 0, new uint256[](0))));
    }

    /// Spec 010 "Pinned in V4": the Safe stack is checked by code hash at every enable.
    function test_enableChecksTheStack() public {
        vm.etch(OWNABLE_VALIDATOR, hex"00");
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.BadStack.selector, 8));
        v4.initializeWithMultiplexer(makeAddr("x"), ID, abi.encode(InitV4(C, 1, address(0), 0, new uint256[](0))));
    }

    /// A chain outside V4's table: nothing enables, nothing validates.
    function test_unsupportedChainFailsClosed() public {
        vm.chainId(42161);
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.UnsupportedChain.selector, 42161));
        v4.initializeWithMultiplexer(makeAddr("x"), ID, abi.encode(InitV4(C, 1, address(0), 0, new uint256[](0))));
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.UnsupportedChain.selector, 42161));
        v4.checkAction(ID, acct, NPM, 0, abi.encodeWithSelector(0x42966c68, uint256(1)));
    }

    // ------------------------------------------------------------ I1: what the fallback action admits

    function test_I1_checkActionAdmitsOnlyV4AndExits() public {
        // V4's own entry points
        assertEq(_check(acct, address(v4), _swapCall(POOL_BTC, USDC, 1_000e6)), 0);
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.mint.selector)), 0);
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.increase.selector)), 0);
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.deposit.selector)), 0);
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.redeem.selector)), 0);
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.bridge.selector)), 0);
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.registerRemote.selector)), 0);
        assertEq(_check(acct, address(v4), abi.encodeCall(v4.clock, (vm.getBlockTimestamp()))), 0);
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.checkExit.selector)), 0);
        assertEq(_check(acct, address(v4), abi.encodeCall(v4.assertZero, (USDC))), 0);
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.announceReady.selector)), 0);
        // A1: the account relays a readiness message itself, and nothing else on the transmitter
        assertEq(_check(acct, v4.MESSAGE_TRANSMITTER(), abi.encodeWithSelector(0x57ecfd28, "", "")), 0, "receiveMessage");
        assertEq(_check(acct, v4.MESSAGE_TRANSMITTER(), abi.encodeWithSelector(0x8d3638f4)), FAILED, "sendMessage");
        // approvals: only to V4
        assertEq(_check(acct, USDC, abi.encodeCall(IERC20T.approve, (address(v4), 1e6))), 0);
        assertEq(_check(acct, CBBTC, abi.encodeCall(IERC20T.approve, (address(v4), type(uint256).max))), 0);
        assertEq(_check(acct, USDC, abi.encodeCall(IERC20T.approve, (ROUTER, 1e6))), FAILED, "approve router");
        assertEq(_check(acct, USDC, abi.encodeCall(IERC20T.approve, (NPM, 1e6))), FAILED, "approve NPM");
        assertEq(_check(acct, USDC, abi.encodeCall(IERC20T.approve, (TOKEN_MESSENGER, 1e6))), FAILED, "approve messenger");
        assertEq(_check(acct, USDC, abi.encodeCall(IERC20T.approve, (GT_USDCP, 1e6))), FAILED, "approve vault");
        assertEq(_check(acct, USDC, abi.encodeCall(IERC20T.approve, (attacker, 1e6))), FAILED, "approve attacker");
        assertEq(_check(acct, NPM, abi.encodeCall(IERC20T.approve, (address(v4), 1))), FAILED, "NFT approve on the NPM");
        // direct calls to the router, the manager, the messenger, a vault: refused
        assertEq(
            _check(acct, ROUTER, abi.encodeCall(IRouterT.exactInputSingle, (ExactInputSingleParams(USDC, CBBTC, 500, acct, 1e6, 0, 1)))),
            FAILED,
            "direct router swap"
        );
        assertEq(_check(acct, ROUTER, abi.encodeWithSelector(0x5ae401dc, vm.getBlockTimestamp(), new bytes[](0))), FAILED, "router multicall");
        assertEq(_check(acct, NPM, abi.encodeWithSelector(INPMT.mint.selector)), FAILED, "NPM mint");
        assertEq(_check(acct, NPM, abi.encodeWithSelector(0x219f5d17)), FAILED, "NPM increaseLiquidity");
        assertEq(_check(acct, TOKEN_MESSENGER, abi.encodeWithSelector(0x8e0250ee)), FAILED, "depositForBurn");
        assertEq(_check(acct, GT_USDCP, abi.encodeWithSelector(0x6e553f65, 1e6, acct)), FAILED, "vault deposit");
        assertEq(_check(acct, USDC, abi.encodeCall(IERC20T.transfer, (attacker, 1))), FAILED, "transfer");
        // init, the CCTP handlers, and unknown selectors (r2's guardian functions no longer exist)
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.initializeWithMultiplexer.selector)), FAILED);
        assertEq(_check(acct, address(v4), abi.encodeWithSelector(v4.handleReceiveFinalizedMessage.selector)), FAILED);
        assertEq(_check(acct, address(v4), abi.encodeWithSignature("pause(address)", acct)), FAILED);
        // no native value, no empty call (I6: no action-free op)
        bytes memory sw = _swapCall(POOL_BTC, USDC, 1e6); // built before any prank: it reads the pool
        vm.prank(SMART_SESSION);
        assertEq(v4.checkAction(ID, acct, address(v4), 1, sw), FAILED, "value");
        assertEq(_check(acct, address(v4), ""), FAILED, "empty call");
        assertEq(_check(acct, address(v4), hex"aabbcc"), FAILED, "short call");
        // only SmartSession validates; an unbound config reverts
        assertEq(v4.checkAction(ID, acct, address(v4), 0, sw), FAILED, "direct caller");
        vm.prank(SMART_SESSION);
        vm.expectPartialRevert(MamoruActionPolicyV4.PolicyNotInitialized.selector);
        v4.checkAction(ConfigIdV4.wrap(bytes32(uint256(9))), acct, address(v4), 0, sw);
    }

    function test_I1_renewalRetiresOldBinding() public {
        bytes memory sw = _swapCall(POOL_BTC, USDC, 1e6);
        _init(acct, ConfigIdV4.wrap(bytes32(uint256(2))), C, 2, new uint256[](0));
        assertEq(_check(acct, address(v4), sw), FAILED, "retired by a renewal");
        vm.prank(SMART_SESSION);
        assertEq(v4.checkAction(ConfigIdV4.wrap(bytes32(uint256(2))), acct, address(v4), 0, sw), 0, "the new binding");
    }

    /// I6: the batch's clock is within S of the block's time; I9 / spec 009 POL-07: assertZero after a reset.
    function test_clockAndAssertZero() public {
        uint256 now_ = vm.getBlockTimestamp();
        v4.clock(now_);
        v4.clock(now_ - 300);
        v4.clock(now_ + 300);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.ClockSkew.selector, now_ - 301));
        v4.clock(now_ - 301);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.ClockSkew.selector, now_ + 301));
        v4.clock(now_ + 301);
        _approveV4(acct, USDC, 1);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.AllowanceLeft.selector, USDC));
        v4.assertZero(USDC);
        _approveV4(acct, USDC, 0);
        vm.prank(acct);
        v4.assertZero(USDC);
    }

    /// I1: the swap goes through V4 with an exact approval, the account is the recipient, nothing stays behind.
    function test_I1_swapThroughV4() public {
        uint256 b0 = IERC20T(CBBTC).balanceOf(acct);
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1_000e6);
        _approveV4(acct, USDC, 1_000e6);
        vm.prank(acct);
        uint256 g = gasleft();
        uint256 out = v4.swap(s);
        console2.log("V4.swap 1,000 USDC -> cbBTC, execution gas", g - gasleft());
        assertGe(out, s.amountOutMinimum);
        assertEq(IERC20T(CBBTC).balanceOf(acct) - b0, out, "output to the account");
        assertEq(IERC20T(USDC).balanceOf(acct), 99_000e6, "exactly amountIn left the account");
        assertEq(IERC20T(USDC).balanceOf(address(v4)), 0, "nothing in V4");
        assertEq(IERC20T(USDC).allowance(address(v4), ROUTER), 0, "router allowance back to 0");
        assertEq(IERC20T(USDC).allowance(acct, address(v4)), 0, "the exact approval was spent");
        // the other direction
        uint256 back = _swap(acct, POOL_BTC, CBBTC, out / 2);
        assertGt(back, 0);
    }

    function _copy(SwapParams memory s) internal pure returns (SwapParams memory t) {
        t = SwapParams(s.pool, s.tokenIn, s.amountIn, s.amountOutMinimum, s.sqrtPriceLimitX96, s.deadline);
    }

    function test_I1_swapRefusals() public {
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1_000e6);
        _approveV4(acct, USDC, type(uint256).max);
        vm.startPrank(acct);
        SwapParams memory t = _copy(s);
        t.amountIn = 0;
        vm.expectRevert(MamoruActionPolicyV4.ZeroAmount.selector); // LeftClaw L-7
        v4.swap(t);
        t = _copy(s);
        t.amountOutMinimum = s.amountOutMinimum - 1;
        vm.expectRevert(MamoruV4Helper.SwapBounds.selector);
        v4.swap(t);
        t = _copy(s);
        t.sqrtPriceLimitX96 = 0;
        vm.expectRevert(MamoruV4Helper.SwapBounds.selector);
        v4.swap(t);
        t = _copy(s);
        t.sqrtPriceLimitX96 = s.sqrtPriceLimitX96 - 1; // zeroForOne: a floor below the range edge
        vm.expectRevert(MamoruV4Helper.SwapBounds.selector);
        v4.swap(t);
        t = _copy(s);
        t.deadline = s.deadline - 1;
        vm.expectRevert(MamoruActionPolicyV4.Expired.selector);
        v4.swap(t);
        t = _copy(s);
        t.tokenIn = WETH;
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NotPinned.selector, WETH));
        v4.swap(t);
        t = _copy(s);
        t.pool = POOL_EURC; // a real factory pool of a token V4 does not pin
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.NotPinned.selector, EURC));
        v4.swap(t);
        vm.stopPrank();
        // an account without a config
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NoConfig.selector, attacker));
        v4.swap(s);
        // and the original passes
        vm.prank(acct);
        v4.swap(s);
    }

    /// I1 (r3 P1): an allowance left on V4 is inert. V4 spends only the caller's own allowance, inside its own checked
    /// functions; nobody else can make it pull from the account.
    function test_I1_leftoverAllowanceIsInert() public {
        _approveV4(acct, USDC, type(uint256).max); // the worst leftover: unlimited
        _init(attacker);
        deal(USDC, attacker, 1e6);
        vm.prank(attacker);
        IERC20T(USDC).approve(address(v4), type(uint256).max);
        // the attacker's own swap pulls the attacker's USDC, never the account's
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1_000e6);
        vm.prank(attacker);
        vm.expectRevert(MamoruActionPolicyV4.TransferFailed.selector);
        v4.swap(s);
        assertEq(IERC20T(USDC).balanceOf(acct), 100_000e6, "the account's USDC did not move");
        // V4 exposes no function that transfers on behalf of another address
        (bool ok,) = address(v4).call(abi.encodeWithSelector(0x23b872dd, acct, attacker, 1e6));
        assertFalse(ok, "no transferFrom on V4");
    }

    // ------------------------------------------------------------ I3: positions (V3 kept)

    function test_I3_mintIncreaseDecreaseCollectBurn() public {
        uint256 g = gasleft();
        (uint256 tokenId, uint128 liq) = _mintThroughV4(acct, 1_000e6, 0.01e8);
        console2.log("V4.mint execution gas (approve x2 + mint)", g - gasleft());
        assertEq(v4.admittedPool(acct, tokenId), POOL_BTC, "admitted");
        assertEq(INPMT(NPM).balanceOf(acct), 1, "position minted to the account");
        assertEq(IERC20T(USDC).balanceOf(address(v4)), 0);
        assertEq(IERC20T(CBBTC).balanceOf(address(v4)), 0);
        assertEq(IERC20T(USDC).allowance(address(v4), NPM), 0, "NPM allowance back to 0");
        // increase
        _approveV4(acct, USDC, 500e6);
        _approveV4(acct, CBBTC, 0.005e8);
        (,,,,, int24 lower, int24 upper,,,,,) = INPMT(NPM).positions(tokenId);
        assertTrue(lower < upper);
        vm.prank(acct);
        (uint128 added,,) = v4.increase(IncreaseLiquidityParams(tokenId, 500e6, 0.005e8, 0, 0, vm.getBlockTimestamp()));
        assertGt(added, 0);
        liq += added;
        // decrease at the policy's minimums, collect to the account, burn. I9: validation is static (an admitted
        // position); the price check is `checkExit` at execution, right before the decrease (the gas policy pairs them).
        (uint256 min0, uint256 min1) = lens.decreaseMins(acct, tokenId, liq);
        bytes memory dec = abi.encodeCall(INPMT.decreaseLiquidity, (DecreaseLiquidityParams(tokenId, liq, min0, min1, vm.getBlockTimestamp())));
        assertEq(_check(acct, NPM, dec), 0);
        vm.prank(acct);
        vm.expectRevert(MamoruActionPolicyV4.ExitBelowBand.selector);
        v4.checkExit(tokenId, liq, 0, 0); // below the range minimums
        vm.prank(acct);
        v4.checkExit(tokenId, liq, min0, min1);
        vm.prank(acct);
        INPMT(NPM).decreaseLiquidity(DecreaseLiquidityParams(tokenId, liq, min0, min1, vm.getBlockTimestamp()));
        bytes memory col = abi.encodeCall(INPMT.collect, (CollectParams(tokenId, acct, type(uint128).max, type(uint128).max)));
        assertEq(_check(acct, NPM, col), 0);
        assertEq(
            _check(acct, NPM, abi.encodeCall(INPMT.collect, (CollectParams(tokenId, attacker, type(uint128).max, type(uint128).max)))),
            FAILED,
            "collect to someone else"
        );
        assertEq(_check(acct, NPM, abi.encodeCall(INPMT.burn, (tokenId))), 0);
    }

    function test_I3_foreignAndMovedPositionsRefused() public {
        (uint256 foreign,) = _mintDirect(attacker, 1_000e6, 0.01e8);
        assertEq(
            _check(acct, NPM, abi.encodeCall(INPMT.collect, (CollectParams(foreign, acct, type(uint128).max, type(uint128).max)))),
            FAILED,
            "not admitted"
        );
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NotAdmitted.selector, foreign));
        v4.increase(IncreaseLiquidityParams(foreign, 1e6, 0, 0, 0, vm.getBlockTimestamp()));
        // a position admitted then moved out of the account is not the session's any more: validation is static (I9),
        // so the position manager itself refuses the account (not owner), and `checkExit` refuses the decrease
        (uint256 tokenId, uint128 liq) = _mintThroughV4(acct, 1_000e6, 0.01e8);
        vm.prank(acct);
        INPMT(NPM).transferFrom(acct, attacker, tokenId);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NotAdmitted.selector, tokenId));
        v4.checkExit(tokenId, liq, 0, 0);
        vm.prank(acct);
        vm.expectRevert(); // "Not approved"
        INPMT(NPM).burn(tokenId);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NotAdmitted.selector, tokenId));
        v4.increase(IncreaseLiquidityParams(tokenId, 1e6, 0, 0, 0, vm.getBlockTimestamp()));
    }

    /// LeftClaw M-4, ported: admission at enable, survival across renewals, explicit revocation for good.
    function test_M4_admitRenewRevoke() public {
        (uint256 tokenId,) = _mintDirect(acct, 1_000e6, 0.01e8);
        uint256[] memory admit = new uint256[](1);
        admit[0] = tokenId;
        _init(acct, ConfigIdV4.wrap(bytes32(uint256(2))), C, 2, admit);
        assertEq(v4.admittedPool(acct, tokenId), POOL_BTC);
        bytes memory col = abi.encodeCall(INPMT.collect, (CollectParams(tokenId, acct, type(uint128).max, type(uint128).max)));
        vm.prank(SMART_SESSION);
        assertEq(v4.checkAction(ConfigIdV4.wrap(bytes32(uint256(2))), acct, NPM, 0, col), 0);
        _init(acct, ConfigIdV4.wrap(bytes32(uint256(3))), C, 3, new uint256[](0));
        vm.prank(SMART_SESSION);
        assertEq(v4.checkAction(ConfigIdV4.wrap(bytes32(uint256(3))), acct, NPM, 0, col), 0, "renewal keeps the position");
        uint256[] memory revoke = new uint256[](1);
        revoke[0] = tokenId | v4.REVOKE_FLAG();
        _init(acct, ConfigIdV4.wrap(bytes32(uint256(4))), C, 4, revoke);
        vm.prank(SMART_SESSION);
        assertEq(v4.checkAction(ConfigIdV4.wrap(bytes32(uint256(4))), acct, NPM, 0, col), FAILED, "revoked");
        _init(acct, ConfigIdV4.wrap(bytes32(uint256(5))), C, 5, admit); // naming it again cannot undo the revocation
        assertEq(v4.admittedPool(acct, tokenId), address(1));
        // a session key cannot admit: only SmartSession reaches the init, and a foreign position is refused there
        (uint256 foreign,) = _mintDirect(attacker, 1_000e6, 0.01e8);
        admit[0] = foreign;
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.NotAdmissible.selector, foreign));
        v4.initializeWithMultiplexer(acct, ConfigIdV4.wrap(bytes32(uint256(6))), abi.encode(InitV4(C, 6, address(0), 0, admit)));
    }

    /// LeftClaw M-2, ported: a push that keeps the spot in range but breaks the mint's minimums refuses the mint
    /// before anything is charged (at execution now: the call reverts, the budget is untouched).
    function test_M2_mintWhoseMinimumsTheSpotBreaksRefused() public {
        MintParams memory m = _mintParams(acct, 2_000e6, 0.02e8);
        (uint256 bucket0,,,) = v4.budgetLeft(acct, CBBTC, 3_500);
        m.amount0Min = 1_990e6; // what the engine would ask at today's spot, about 50 bps
        _approveV4(acct, USDC, 2_000e6);
        _approveV4(acct, CBBTC, 0.02e8);
        _push(POOL_BTC, CBBTC, USDC, 500, 20);
        vm.prank(acct);
        vm.expectRevert(MamoruV4Helper.Slippage.selector);
        v4.mint(m);
        (uint256 bucket1,,,) = v4.budgetLeft(acct, CBBTC, 3_500);
        assertEq(bucket1, bucket0, "nothing charged");
    }

    /// LeftClaw M-2 / T6: a third party pushes the spot out of range in the same block (neither TWAP moves): refused.
    function test_M2_spotOutsideRangeRefused() public {
        (int24 lo,) = lens.priceRange(POOL_BTC);
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1_000e6);
        _approveV4(acct, USDC, 1_000e6);
        _push(POOL_BTC, USDC, CBBTC, 500, (lo - _spot(POOL_BTC)) - 20);
        vm.prank(acct);
        vm.expectPartialRevert(MamoruV4Helper.SpotOutsideRange.selector);
        v4.swap(s);
    }

    /// LeftClaw M-6, ported: a depeg held past the stables anchor empties the anchored range (no swap, mint), but
    /// decrease uses the TWAP range alone, so the exit is never locked.
    function test_M6_depegDoesNotLockTheExit() public {
        int24 sp = _spot(POOL_STABLE);
        MintParams memory m = MintParams(USDC, USDT, 100, sp - 100, sp + 100, 500e6, 500e6, 0, 0, acct, vm.getBlockTimestamp());
        _approveV4(acct, USDC, 500e6);
        _approveV4(acct, USDT, 500e6);
        vm.prank(acct);
        (uint256 tokenId, uint128 liq,,) = v4.mint(m);
        _push(POOL_STABLE, USDT, USDC, 100, 120 - _spot(POOL_STABLE));
        vm.roll(vm.getBlockNumber() + 3_600);
        vm.warp(vm.getBlockTimestamp() + 7_200);
        vm.expectPartialRevert(MamoruV4Helper.RangeEmpty.selector);
        lens.priceRange(POOL_STABLE);
        (uint256 min0, uint256 min1) = lens.decreaseMins(acct, tokenId, liq);
        bytes memory dec = abi.encodeCall(INPMT.decreaseLiquidity, (DecreaseLiquidityParams(tokenId, liq, min0, min1, vm.getBlockTimestamp())));
        assertEq(_check(acct, NPM, dec), 0, "exit locked by the anchor");
        vm.prank(acct);
        v4.checkExit(tokenId, liq, min0, min1); // the price check at execution passes too
    }

    // ------------------------------------------------------------ A1: exits are never gated by eligibility

    /// A position whose pool stops being eligible (here: the factory no longer names it) is exit-only: no swap, no
    /// increase, but `checkExit` and the decrease, collect and burn stay allowed (spec 010 A1, LeftClaw M-6).
    function test_A1_ineligiblePoolIsExitOnly() public {
        (uint256 tokenId, uint128 liq) = _mintThroughV4(acct, 1_000e6, 0.01e8);
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1_000e6);
        (uint256 min0, uint256 min1) = lens.decreaseMins(acct, tokenId, liq);
        vm.mockCall(FACTORY, abi.encodeWithSignature("getPool(address,address,uint24)", USDC, CBBTC, uint24(500)), abi.encode(address(0xbad)));
        _approveV4(acct, USDC, 1_000e6);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.NotAFactoryPool.selector, POOL_BTC));
        v4.swap(s);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.NotAFactoryPool.selector, POOL_BTC));
        v4.increase(IncreaseLiquidityParams(tokenId, 1e6, 0, 0, 0, vm.getBlockTimestamp()));
        bytes memory dec = abi.encodeCall(INPMT.decreaseLiquidity, (DecreaseLiquidityParams(tokenId, liq, min0, min1, vm.getBlockTimestamp())));
        assertEq(_check(acct, NPM, dec), 0, "the decrease validates");
        vm.prank(acct);
        v4.checkExit(tokenId, liq, min0, min1);
        assertEq(_check(acct, NPM, abi.encodeCall(INPMT.burn, (tokenId))), 0);
    }

    // ------------------------------------------------------------ A1: eligibility by rule (no registry)

    /// Rule 2: a pool of a token V4 does not pin, and a pair of pinned tokens without a class (USDT/WETH), are refused.
    function test_A1_rule2_pinnedTokensAndAClass() public {
        deal(EURC, acct, 1_000e6);
        _approveV4(acct, USDC, 1_000e6);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.NotPinned.selector, EURC));
        v4.swap(SwapParams(POOL_EURC, USDC, 1_000e6, 0, 1, vm.getBlockTimestamp()));
        _approveV4(acct, USDT, 1_000e6);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.NotEligible.selector, address(0), 2));
        v4.swap(SwapParams(POOL_USDT_ETH, USDT, 1_000e6, 0, 1, vm.getBlockTimestamp()));
    }

    /// Rule 3: a pool of a class's pair on a fee tier outside the class's fee set (USDC/cbBTC 1 %) is refused.
    function test_A1_rule3_feeSet() public {
        address p = IFactoryT(FACTORY).getPool(USDC, CBBTC, 10_000);
        _approveV4(acct, USDC, 1_000e6);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.NotEligible.selector, p, 3));
        v4.swap(SwapParams(p, USDC, 1_000e6, 0, 1, vm.getBlockTimestamp()));
    }

    /// Rule 7: a second pool of the pair (USDC/cbBTC 0.3 %) is eligible while it agrees with the reference pool; an
    /// outsider who pushes its price more than one band from the reference's makes it refused. It shares the asset's
    /// sub-bucket with the reference pool: a second pool adds no room.
    function test_A1_rule7_referencePoolAndSharedSubBucket() public {
        assertEq(_key(POOL_BTC_30), CBBTC, "cbBTC's sub-bucket");
        assertEq(_key(POOL_BTC), CBBTC, "the same sub-bucket as the reference pool");
        assertEq(_key(POOL_ETH_05), WETH);
        assertEq(_key(POOL_ETH), WETH);
        // spend most of cbBTC's sub-bucket (35 % of C) on the reference pool; the second pool cannot add to it
        _swap(acct, POOL_BTC, USDC, 3_000e6);
        SwapParams memory s = _swapParams(POOL_BTC_30, USDC, 600e6);
        _approveV4(acct, USDC, 600e6);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BudgetExceeded.selector, CBBTC, 600e6));
        v4.swap(s);
        // an outsider pushes the second pool 300 ticks away from the reference: refused by rule 7
        _push(POOL_BTC_30, CBBTC, USDC, 3000, 300);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.NotEligible.selector, POOL_BTC_30, 7));
        helper.priced(POOL_BTC_30);
    }

    /// Nothing outside the code's tables can be named: not a "pool" that is a router, not a vault outside the exact
    /// list (a messenger, a position manager, a real MetaMorpho vault V4 does not list), not a chain outside the table.
    function test_A1_nothingOutsideTheTables() public {
        _approveV4(acct, USDC, 1_000e6);
        vm.prank(acct);
        vm.expectRevert(); // the router has no token0(): not a pool at all
        v4.swap(SwapParams(ROUTER, USDC, 1_000e6, 0, 1, vm.getBlockTimestamp()));
        vm.startPrank(acct);
        vm.expectRevert();
        v4.deposit(TOKEN_MESSENGER, 1_000e6);
        vm.expectRevert();
        v4.deposit(NPM, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.BadVault.selector, STEAK_USDC));
        v4.deposit(STEAK_USDC, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadBridge.selector, 3));
        v4.bridge(3, USDC, 1e6); // Arbitrum's CCTP domain
        vm.stopPrank();
        assertEq(v4.TOKEN_MESSENGER(), TOKEN_MESSENGER);
    }

    /// Spec 010 r1 finding 3: an ERC-4626 that keeps the assets, and Aave's static aToken, are not in the table.
    function test_hostileVaultRefused() public {
        HostileVault h = new HostileVault(USDC);
        _approveV4(acct, USDC, 1_000e6);
        vm.startPrank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.BadVault.selector, address(h)));
        v4.deposit(address(h), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.BadVault.selector, WA_BAS_USDC));
        v4.deposit(WA_BAS_USDC, 1_000e6);
        vm.stopPrank();
        assertEq(IERC20T(USDC).balanceOf(acct), 100_000e6);
    }

    /// The listed MetaMorpho vault (gtUSDCp, 50 % of C): exact deposit, shares to the account, the position capped at
    /// the vault's ratio, redeem back; a vault outside the list redeems nothing through V4.
    function test_metaMorphoVaultDepositRedeem() public {
        _approveV4(acct, USDC, 1_000e6);
        vm.prank(acct);
        uint256 g = gasleft();
        uint256 shares = v4.deposit(GT_USDCP, 1_000e6);
        console2.log("V4.deposit (MetaMorpho) execution gas", g - gasleft());
        assertEq(IERC20T(GT_USDCP).balanceOf(acct), shares, "shares to the account");
        assertEq(IERC20T(USDC).allowance(address(v4), GT_USDCP), 0, "vault allowance back to 0");
        assertEq(IERC20T(USDC).balanceOf(address(v4)), 0);
        // the vault's ratio caps the position: 50 % of C = 5,000 USDC held, by the vault's own accounting
        _approveV4(acct, USDC, 4_001e6 + 1);
        vm.prank(acct);
        vm.expectPartialRevert(MamoruActionPolicyV4.VaultExposure.selector);
        v4.deposit(GT_USDCP, 4_001e6 + 1);
        _approveV4(acct, GT_USDCP, shares);
        vm.prank(acct);
        uint256 assets = v4.redeem(GT_USDCP, shares);
        assertApproxEqAbs(assets, 1_000e6, 2, "assets back to the account");
        assertEq(IERC20T(GT_USDCP).balanceOf(acct), 0);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.BadVault.selector, STEAK_USDC));
        v4.redeem(STEAK_USDC, 1);
    }

    // ------------------------------------------------------------ I2: depth at every priced use; a trap pool

    /// I2 (r3 P1) + A1: an outsider creates a pool of a class's pair on a fee tier of the class (USDC/WETH 0.3 % is
    /// taken, so a fresh pair would need a new tier: here the 1 % tier of USDC/cbBTC is outside the fee set and the
    /// USDT/cbBTC pair has no class), seeds it at a bad price, and the session tries to use it. Refused at every step.
    function test_trapPoolRefused() public {
        address pool = IFactoryT(FACTORY).getPool(CBBTC, USDT, 10_000);
        if (pool == address(0)) pool = IFactoryT(FACTORY).createPool(CBBTC, USDT, 10_000);
        (uint160 sp,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (sp == 0) IUniswapV3Pool(pool).initialize(TickMath.getSqrtRatioAtTick(-80_000)); // a bad price
        _approveV4(acct, USDT, 1_000e6);
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.NotEligible.selector, address(0), 2));
        v4.swap(SwapParams(pool, USDT, 1_000e6, 0, 1, vm.getBlockTimestamp()));
    }

    /// LeftClaw M-5 at every use: the depth V4 measures is what a swap across the band takes (the floor of both
    /// directions); a call worth more than 1/20 of it is refused, one under it passes.
    function test_M5_depthAtEveryUse() public {
        IUniswapV3Pool(POOL_STABLE).increaseObservationCardinalityNext(1800);
        uint256 d = helper.depthIn(POOL_STABLE, USDC, USDT, 10, false);
        console2.log("stables pool depth over 10 ticks (USDC units)", d);
        uint256 over = d / 20 + 1e6;
        uint256 under = d / 20 - 1e6;
        SwapParams memory big = _swapParams(POOL_STABLE, USDC, over);
        SwapParams memory small = _swapParams(POOL_STABLE, USDC, under < 2_000e6 ? under : 2_000e6);
        _approveV4(acct, USDC, type(uint256).max);
        vm.startPrank(acct);
        vm.expectPartialRevert(MamoruV4Helper.TooThin.selector);
        v4.swap(big);
        v4.swap(small);
        vm.stopPrank();
    }

    /// I2 + stable pairs: the class carries the parity anchor (MamoruV4Classes), so the stables pool's range is
    /// always clipped to parity +-40 ticks; a depeg past it empties the range for entries (test_M6 covers exits).
    function test_stableClassCarriesTheParityAnchor() public view {
        (, PoolEntryV4 memory e, address key) = helper.priced(POOL_STABLE);
        assertEq(e.anchorBand, 40);
        assertEq(e.anchorTick, 0);
        assertEq(e.ratioBps, 5_000);
        assertTrue(key != USDC && key != USDT, "the stable class's own key");
        (int24 lo, int24 hi) = lens.priceRange(POOL_STABLE);
        assertGe(lo, -40);
        assertLe(hi, 40);
    }
}
