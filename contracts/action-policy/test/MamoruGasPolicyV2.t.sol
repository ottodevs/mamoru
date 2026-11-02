// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruV4Table} from "../src/MamoruV4Table.sol";
import {ConfigIdV4, PackedUserOperationV4} from "../src/SmartSessionTypes.sol";

/// Spec 010 I6 and I9, A1 (otto/mamoru#317): MamoruGasPolicyV2 without a fork (block.chainid set to Base, then Monad).
contract MamoruGasPolicyV2Test is Test {
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1; // Base's position manager
    address constant V4 = address(0x4444); // any address: which contract each call reaches is V4's checkAction
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    ConfigIdV4 constant ID = ConfigIdV4.wrap(bytes32(uint256(7)));
    uint256 constant S = 5 minutes;
    MamoruGasPolicyV2 pol;
    address acct = makeAddr("account");
    uint256 t0 = 1_800_000_000;

    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    function setUp() public {
        vm.chainId(8453);
        vm.warp(t0);
        pol = new MamoruGasPolicyV2(new MamoruV4Table());
    }

    function _caps() internal pure returns (MamoruGasPolicyV2.Caps memory) {
        return MamoruGasPolicyV2.Caps(10_000_000, 3_000_000, 2_000_000, 200_000, 100_000_000, 100_000);
    }

    function _init() internal {
        vm.prank(SMART_SESSION);
        pol.initializeWithMultiplexer(acct, ID, abi.encode(_caps()));
    }

    function _clock(uint256 t) internal pure returns (Execution memory) {
        return Execution(V4, 0, abi.encodeWithSignature("clock(uint256)", t));
    }

    function _swapLike() internal pure returns (Execution memory) {
        return Execution(V4, 0, abi.encodeWithSignature("redeem(address,uint256)", address(1), uint256(1)));
    }

    function _batch(Execution[] memory xs) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("execute(bytes32,bytes)", bytes32(uint256(1) << 248), abi.encode(xs));
    }

    /// A batch [clock(t), one V4 call].
    function _simple(uint256 t) internal pure returns (bytes memory) {
        Execution[] memory xs = new Execution[](2);
        (xs[0], xs[1]) = (_clock(t), _swapLike());
        return _batch(xs);
    }

    function _op(uint256 vgl, uint256 cgl, uint256 pvg, uint256 prio, uint256 maxFee, bytes memory callData)
        internal
        view
        returns (PackedUserOperationV4 memory op)
    {
        op.sender = acct;
        op.accountGasLimits = bytes32((vgl << 128) | cgl);
        op.preVerificationGas = pvg;
        op.gasFees = bytes32((prio << 128) | maxFee);
        op.callData = callData;
    }

    function _cheap(bytes memory callData) internal view returns (PackedUserOperationV4 memory) {
        return _op(100_000, 100_000, 50_000, 1, 1_000_000, callData);
    }

    function _check(PackedUserOperationV4 memory op) internal returns (uint256 r) {
        vm.prank(SMART_SESSION);
        r = pol.checkUserOpPolicy(ID, op);
    }

    function _range(uint256 t) internal pure returns (uint256) {
        return ((t + S) << 160) | ((t - S) << 208);
    }

    function test_initOnlyFromSmartSessionAndBounds() public {
        vm.expectRevert(MamoruGasPolicyV2.OnlySmartSession.selector);
        pol.initializeWithMultiplexer(acct, ID, abi.encode(_caps()));
        vm.startPrank(SMART_SESSION);
        MamoruGasPolicyV2.Caps memory c = _caps();
        c.maxCallGasLimit = 0;
        vm.expectRevert(abi.encodeWithSelector(MamoruGasPolicyV2.BadInit.selector, 1));
        pol.initializeWithMultiplexer(acct, ID, abi.encode(c));
        c = _caps();
        c.maxFeePerGas = c.maxPriorityFeePerGas - 1;
        vm.expectRevert(abi.encodeWithSelector(MamoruGasPolicyV2.BadInit.selector, 2));
        pol.initializeWithMultiplexer(acct, ID, abi.encode(c));
        vm.stopPrank();
    }

    function test_perOpCapsAsV1() public {
        _init();
        bytes memory b = _simple(t0);
        assertEq(_check(_op(3_000_000 + 1, 1, 1, 1, 1, b)), 1);
        assertEq(_check(_op(1, 2_000_000 + 1, 1, 1, 1, b)), 1);
        assertEq(_check(_op(1, 1, 200_001, 1, 1, b)), 1);
        assertEq(_check(_op(1, 1, 1, 10_000_001, 10_000_001, b)), 1);
        assertEq(_check(_op(1, 1, 1, 1, 100_000_001, b)), 1);
        assertEq(_check(_op(1, 1, 1, 0, 0, b)), 1, "a zero max fee charges nothing: refused");
        assertEq(_check(_op(100_000, 100_000, 50_000, 1, 1_000_000, b)), _range(t0));
        PackedUserOperationV4 memory op = _cheap(b);
        op.paymasterAndData = abi.encodePacked(address(0xbeef), uint128(90_000), uint128(30_000));
        assertEq(_check(op), 1, "paymaster gas above its cap");
        op.paymasterAndData = hex"00";
        assertEq(_check(op), 1, "malformed paymasterAndData");
    }

    /// A1: the returned range is T +- S, so the EntryPoint admits the op only while the real time is within S of T.
    /// Nobody but SmartSession can advance an account's rate.
    function test_returnsTheClaimedTimeRange() public {
        _init();
        PackedUserOperationV4 memory op = _cheap(_simple(t0 + 100));
        assertEq(pol.checkUserOpPolicy(ID, op), 1, "not SmartSession");
        assertEq(pol.tatOf(acct), 0);
        uint256 r = _check(op);
        assertEq(uint160(r), 0, "no aggregator, no signature failure");
        assertEq(uint48(r >> 160), t0 + 100 + S, "validUntil");
        assertEq(uint48(r >> 208), t0 + 100 - S, "validAfter");
        assertGt(pol.tatOf(acct), t0 + 100);
    }

    /// I6: GCRA. At most G per W plus a burst of G, each op charged its prefund at validation, refused (nothing written)
    /// past it; an idle account comes back with the burst and nothing to reset.
    function test_rateBoundsGasPerWindow() public {
        _init();
        // the most expensive op the caps allow, no paymaster: 5.2M gas x 0.1 gwei = 5.2e14 wei; Base G = 0.002 ETH/day
        uint256 cost = uint256(3_000_000 + 2_000_000 + 200_000) * 100_000_000;
        uint256 n;
        uint256 t = t0;
        while (_check(_op(3_000_000, 2_000_000, 200_000, 10_000_000, 100_000_000, _simple(t))) != 1) n++;
        assertEq(n, 0.002 ether / cost, "the burst: G worth of ops");
        uint256 tat = pol.tatOf(acct);
        assertEq(_check(_op(3_000_000, 2_000_000, 200_000, 10_000_000, 100_000_000, _simple(t))), 1);
        assertEq(pol.tatOf(acct), tat, "a refused op writes nothing");
        // a day later the same burst again, never more: G per W
        uint256 total = n;
        for (uint256 day = 1; day <= 10; day++) {
            t = t0 + day * 1 days;
            while (_check(_op(3_000_000, 2_000_000, 200_000, 10_000_000, 100_000_000, _simple(t))) != 1) total++;
        }
        assertLe(total * cost, 0.002 ether * 11, "at most G per W over 11 windows (the first one's burst included)");
        assertGe(total * cost, (0.002 ether - cost) * 10, "and the rate keeps serving: no reviewer, nothing to reset");
        // idle for 30 days: the account comes back with one burst, not 30 days' worth
        t = t0 + 41 days;
        uint256 burst;
        while (_check(_op(3_000_000, 2_000_000, 200_000, 10_000_000, 100_000_000, _simple(t))) != 1) burst++;
        assertEq(burst, 0.002 ether / cost, "one burst after idle");
    }

    /// Many ops claiming the same time (one bundle) are bounded like a sequence: each advances `tat`.
    function test_bundleIsBoundedLikeASequence() public {
        _init();
        uint256 cost = uint256(3_000_000 + 2_000_000 + 200_000) * 100_000_000;
        uint256 ok;
        for (uint256 i; i < 100; i++) {
            if (_check(_op(3_000_000, 2_000_000, 200_000, 10_000_000, 100_000_000, _simple(t0))) != 1) ok++;
        }
        assertEq(ok, 0.002 ether / cost);
    }

    /// I9: the batch shape, statelessly.
    function test_batchShape() public {
        _init();
        bytes memory dec = abi.encodeWithSelector(0x0c49ccbe, uint256(42), uint128(1e9), uint256(5), uint256(6), uint256(t0));
        bytes memory chk = abi.encodeWithSignature("checkExit(uint256,uint128,uint256,uint256)", uint256(42), uint128(1e9), uint256(5), uint256(6));
        Execution[] memory xs;

        // single mode, or a batch with a mode payload, or the try exec type: refused
        assertEq(_check(_cheap(abi.encodeWithSignature("execute(bytes32,bytes)", bytes32(0), abi.encodePacked(V4, uint256(0), hex"68c7c155")))), 1);
        xs = new Execution[](2);
        (xs[0], xs[1]) = (_clock(t0), _swapLike());
        assertEq(_check(_cheap(abi.encodeWithSignature("execute(bytes32,bytes)", bytes32(uint256(0x0101) << 240), abi.encode(xs)))), 1, "try");
        assertEq(_check(_cheap(abi.encodeWithSignature("execute(bytes32,bytes)", bytes32((uint256(1) << 248) | 1), abi.encode(xs)))), 1, "payload");
        assertEq(_check(_cheap(abi.encodeWithSignature("executeFromExecutor(bytes32,bytes)", bytes32(uint256(1) << 248), abi.encode(xs)))), 1);

        // an empty batch, a clock alone, no leading clock, a clock with value: refused
        assertEq(_check(_cheap(_batch(new Execution[](0)))), 1, "empty");
        xs = new Execution[](1);
        xs[0] = _clock(t0);
        assertEq(_check(_cheap(_batch(xs))), 1, "action-free");
        xs = new Execution[](2);
        (xs[0], xs[1]) = (_swapLike(), _clock(t0));
        assertEq(_check(_cheap(_batch(xs))), 1, "clock not first");
        (xs[0], xs[1]) = (Execution(V4, 1, abi.encodeWithSignature("clock(uint256)", t0)), _swapLike());
        assertEq(_check(_cheap(_batch(xs))), 1, "clock with value");

        // a decrease must come right after checkExit with the same arguments
        xs = new Execution[](2);
        (xs[0], xs[1]) = (_clock(t0), Execution(NPM, 0, dec));
        assertEq(_check(_cheap(_batch(xs))), 1, "decrease without checkExit");
        xs = new Execution[](3);
        (xs[0], xs[1], xs[2]) = (_clock(t0), Execution(V4, 0, chk), Execution(NPM, 0, dec));
        assertEq(_check(_cheap(_batch(xs))), _range(t0), "checkExit then decrease");
        bytes memory chkOther = abi.encodeWithSignature("checkExit(uint256,uint128,uint256,uint256)", uint256(42), uint128(1e9), uint256(4), uint256(6));
        (xs[0], xs[1], xs[2]) = (_clock(t0), Execution(V4, 0, chkOther), Execution(NPM, 0, dec));
        assertEq(_check(_cheap(_batch(xs))), 1, "checkExit with looser minimums");
        xs = new Execution[](4);
        (xs[0], xs[1], xs[2], xs[3]) = (_clock(t0), Execution(V4, 0, chk), _swapLike(), Execution(NPM, 0, dec));
        assertEq(_check(_cheap(_batch(xs))), 1, "checkExit not immediately before");

        // a non-zero approve must be reset later and the reset followed by assertZero(token)
        bytes memory ap = abi.encodeWithSelector(0x095ea7b3, V4, uint256(1e6));
        bytes memory reset = abi.encodeWithSelector(0x095ea7b3, V4, uint256(0));
        bytes memory z = abi.encodeWithSignature("assertZero(address)", USDC);
        xs = new Execution[](3);
        (xs[0], xs[1], xs[2]) = (_clock(t0), Execution(USDC, 0, ap), _swapLike());
        assertEq(_check(_cheap(_batch(xs))), 1, "approve never reset");
        xs = new Execution[](4);
        (xs[0], xs[1], xs[2], xs[3]) = (_clock(t0), Execution(USDC, 0, ap), _swapLike(), Execution(USDC, 0, reset));
        assertEq(_check(_cheap(_batch(xs))), 1, "reset without assertZero");
        xs = new Execution[](5);
        (xs[0], xs[1], xs[2], xs[3], xs[4]) =
            (_clock(t0), Execution(USDC, 0, ap), _swapLike(), Execution(USDC, 0, reset), Execution(V4, 0, z));
        assertEq(_check(_cheap(_batch(xs))), _range(t0), "approve, use, reset, assertZero");
        (xs[0], xs[1], xs[2], xs[3], xs[4]) = (
            _clock(t0),
            Execution(USDC, 0, ap),
            _swapLike(),
            Execution(address(0xdead), 0, reset),
            Execution(V4, 0, abi.encodeWithSignature("assertZero(address)", address(0xdead)))
        );
        assertEq(_check(_cheap(_batch(xs))), 1, "the reset is on another token");
        xs = new Execution[](3);
        (xs[0], xs[1], xs[2]) = (_clock(t0), Execution(USDC, 0, abi.encodeWithSelector(0x095ea7b3, V4, uint256(0))), _swapLike());
        assertEq(_check(_cheap(_batch(xs))), _range(t0), "an approve of zero needs no reset");
    }

    function test_failClosedOffTheTableAndClaimedTimeBounds() public {
        _init();
        assertEq(_check(_cheap(_simple(S))), 1, "T <= S");
        assertEq(_check(_cheap(_simple(type(uint48).max))), 1, "T beyond uint48");
        vm.chainId(143);
        assertEq(_check(_cheap(_simple(t0))), _range(t0), "Monad is in the table");
        vm.chainId(42161);
        assertEq(_check(_cheap(_simple(t0))), 1, "a chain outside the table refuses every op");
    }

    function test_uninitializedReverts() public {
        vm.prank(SMART_SESSION);
        vm.expectPartialRevert(MamoruGasPolicyV2.PolicyNotInitialized.selector);
        pol.checkUserOpPolicy(ID, _cheap(_simple(t0)));
    }

    function test_noPrivilegedState() public view {
        // no owner, no guardian, no setter: the only writes are SmartSession's (init, checkUserOpPolicy)
        bytes memory code = address(pol).code;
        bytes4[4] memory f = [
            bytes4(keccak256("GUARDIAN()")),
            bytes4(keccak256("review(address)")),
            bytes4(keccak256("owner()")),
            bytes4(keccak256("gasReview()"))
        ];
        for (uint256 k; k < f.length; k++) {
            for (uint256 i; i + 5 <= code.length; i++) {
                bool hit = code[i] == 0x63 && code[i + 1] == f[k][0] && code[i + 2] == f[k][1] && code[i + 3] == f[k][2]
                    && code[i + 4] == f[k][3];
                assertFalse(hit, "a privileged selector in the bytecode");
            }
        }
    }
}
