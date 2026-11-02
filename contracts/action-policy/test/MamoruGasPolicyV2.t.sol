// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {ConfigIdV4, PackedUserOperationV4} from "../src/SmartSessionTypes.sol";

/// Spec 010 I6 (otto/mamoru#292): MamoruGasPolicyV2 without a fork (block.chainid set to Base, then Monad).
contract MamoruGasPolicyV2Test is Test {
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    ConfigIdV4 constant ID = ConfigIdV4.wrap(bytes32(uint256(7)));
    MamoruGasPolicyV2 pol;
    address guardian = makeAddr("guardian");
    address acct = makeAddr("account");

    function setUp() public {
        vm.chainId(8453);
        pol = new MamoruGasPolicyV2(guardian);
    }

    function _caps(uint128 perWindow) internal pure returns (MamoruGasPolicyV2.Caps memory) {
        return MamoruGasPolicyV2.Caps(10_000_000, 3_000_000, 2_000_000, 200_000, 100_000_000, 100_000, perWindow, 1 days);
    }

    function _init(uint128 perWindow) internal {
        vm.prank(SMART_SESSION);
        pol.initializeWithMultiplexer(acct, ID, abi.encode(_caps(perWindow)));
    }

    function _op(uint256 vgl, uint256 cgl, uint256 pvg, uint256 prio, uint256 maxFee) internal view returns (PackedUserOperationV4 memory op) {
        op.sender = acct;
        op.accountGasLimits = bytes32((vgl << 128) | cgl);
        op.preVerificationGas = pvg;
        op.gasFees = bytes32((prio << 128) | maxFee);
    }

    function _check(PackedUserOperationV4 memory op) internal returns (uint256 r) {
        vm.prank(SMART_SESSION);
        r = pol.checkUserOpPolicy(ID, op);
    }

    function test_initOnlyFromSmartSessionAndBounds() public {
        vm.expectRevert(MamoruGasPolicyV2.OnlySmartSession.selector);
        pol.initializeWithMultiplexer(acct, ID, abi.encode(_caps(0.002 ether)));
        vm.startPrank(SMART_SESSION);
        MamoruGasPolicyV2.Caps memory c = _caps(0.002 ether);
        c.maxCallGasLimit = 0;
        vm.expectRevert(abi.encodeWithSelector(MamoruGasPolicyV2.BadInit.selector, 1));
        pol.initializeWithMultiplexer(acct, ID, abi.encode(c));
        c = _caps(0.002 ether);
        c.maxFeePerGas = c.maxPriorityFeePerGas - 1;
        vm.expectRevert(abi.encodeWithSelector(MamoruGasPolicyV2.BadInit.selector, 2));
        pol.initializeWithMultiplexer(acct, ID, abi.encode(c));
        vm.expectRevert(abi.encodeWithSelector(MamoruGasPolicyV2.BadInit.selector, 3));
        pol.initializeWithMultiplexer(acct, ID, abi.encode(_caps(0))); // no bucket
        vm.expectRevert(abi.encodeWithSelector(MamoruGasPolicyV2.BadInit.selector, 3));
        pol.initializeWithMultiplexer(acct, ID, abi.encode(_caps(0.01 ether + 1))); // above GAS_REVIEW
        c = _caps(0.002 ether);
        c.window = 59 minutes;
        vm.expectRevert(abi.encodeWithSelector(MamoruGasPolicyV2.BadInit.selector, 3));
        pol.initializeWithMultiplexer(acct, ID, abi.encode(c));
        vm.stopPrank();
    }

    function test_perOpCapsAsV1() public {
        _init(0.002 ether);
        assertEq(_check(_op(3_000_000 + 1, 1, 1, 1, 1)), 1);
        assertEq(_check(_op(1, 2_000_000 + 1, 1, 1, 1)), 1);
        assertEq(_check(_op(1, 1, 200_001, 1, 1)), 1);
        assertEq(_check(_op(1, 1, 1, 10_000_001, 10_000_001)), 1);
        assertEq(_check(_op(1, 1, 1, 1, 100_000_001)), 1);
        assertEq(_check(_op(100_000, 100_000, 50_000, 1, 1_000_000)), 0);
    }

    /// r6: the charge is the op's prefund at its own capped fields, written at validation; nobody but SmartSession
    /// can charge (or grief) an account's bucket.
    function test_chargeIsTheConservativePrefund() public {
        _init(0.002 ether);
        PackedUserOperationV4 memory op = _op(1_000_000, 500_000, 100_000, 1, 10_000_000);
        assertEq(pol.checkUserOpPolicy(ID, op), 1, "not SmartSession");
        assertEq(pol.chargedSinceReview(acct), 0);
        assertEq(_check(op), 0);
        assertEq(pol.chargedSinceReview(acct), (1_000_000 + 500_000 + 100_000) * 10_000_000);
        // paymaster limits count too
        op.paymasterAndData = abi.encodePacked(address(0xbeef), uint128(40_000), uint128(30_000));
        uint256 before = pol.chargedSinceReview(acct);
        assertEq(_check(op), 0);
        assertEq(pol.chargedSinceReview(acct) - before, (1_600_000 + 70_000) * 10_000_000);
        op.paymasterAndData = abi.encodePacked(address(0xbeef), uint128(90_000), uint128(30_000));
        assertEq(_check(op), 1, "paymaster gas above its cap");
        op.paymasterAndData = hex"00";
        assertEq(_check(op), 1, "malformed paymasterAndData");
    }

    /// I6: an op that would cross the bucket is rejected; the bucket refills; the cumulative GAS_REVIEW stops a slow
    /// drain until the guardian reviews.
    function test_bucketThenGasReview() public {
        _init(0.002 ether);
        // the most expensive op the caps allow: 5.3M gas x 0.1 gwei = 5.3e14 wei
        PackedUserOperationV4 memory op = _op(3_000_000, 2_000_000, 200_000, 10_000_000, 100_000_000);
        uint256 charge = pol.maxCostPerOp(_caps(0)) - 100_000 * 100_000_000; // no paymaster gas in this op
        uint256 n;
        while (_check(op) == 0) n++;
        assertEq(n, 0.002 ether / charge, "bucket: ops until the next would cross");
        assertLe(pol.chargedSinceReview(acct), 0.002 ether);
        // refill and keep draining slowly, under the bucket, until GAS_REVIEW
        uint256 total = n;
        for (uint256 day; day < 10; day++) {
            vm.warp(block.timestamp + 1 days);
            while (_check(op) == 0) total++;
        }
        assertEq(total, 0.01 ether / charge, "GAS_REVIEW: 0.01 ETH on Base, then every op refused");
        assertLe(pol.chargedSinceReview(acct), 0.01 ether);
        vm.warp(block.timestamp + 30 days);
        assertEq(_check(op), 1, "still refused: the bucket is full but the review threshold is reached");
        vm.prank(acct);
        vm.expectRevert(MamoruGasPolicyV2.OnlyGuardian.selector);
        pol.review(acct);
        vm.prank(guardian);
        pol.review(acct);
        assertEq(_check(op), 0, "after the guardian's review");
    }

    function test_perChainReviewAndFailClosed() public {
        assertEq(pol.gasReview(), 0.01 ether);
        vm.chainId(143);
        assertEq(pol.gasReview(), 5 ether);
        vm.chainId(1);
        assertEq(pol.gasReview(), 0.03 ether); // Ethereum (#307)
        vm.chainId(42161);
        assertEq(pol.gasReview(), 0); // off the table: fail closed
        vm.prank(SMART_SESSION);
        vm.expectRevert(abi.encodeWithSelector(MamoruGasPolicyV2.BadInit.selector, 3));
        pol.initializeWithMultiplexer(acct, ID, abi.encode(_caps(1)));
    }

    function test_uninitializedReverts() public {
        vm.prank(SMART_SESSION);
        vm.expectPartialRevert(MamoruGasPolicyV2.PolicyNotInitialized.selector);
        pol.checkUserOpPolicy(ID, _op(1, 1, 1, 1, 1));
    }
}
