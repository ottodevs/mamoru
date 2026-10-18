// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruGasPolicy, PackedUserOperation} from "../src/MamoruGasPolicy.sol";
import {ConfigId} from "../src/MamoruActionPolicy.sol";

/// T6 L-1: the userOp gas caps (no fork needed).
contract MamoruGasPolicyTest is Test {
    MamoruGasPolicy policy = new MamoruGasPolicy();
    address smartSession = makeAddr("smartSession");
    address safe = makeAddr("safe");
    ConfigId constant ID = ConfigId.wrap(bytes32(uint256(1)));

    function setUp() public {
        // The engine's own settings (packages/scenarios/driver/engine.ts LAB_GAS_LIMITS, MAX_PRIORITY_FEE_PER_GAS)
        // fit under these with margin: 1e6 wei priority, 3M / 2M / 100k gas.
        vm.prank(smartSession);
        policy.initializeWithMultiplexer(
            safe, ID, abi.encode(MamoruGasPolicy.Caps(10_000_000, 3_000_000, 2_000_000, 200_000))
        );
    }

    function _op(uint256 priority, uint256 maxFee, uint256 vgl, uint256 cgl, uint256 pvg)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = safe;
        op.accountGasLimits = bytes32((vgl << 128) | cgl);
        op.gasFees = bytes32((priority << 128) | maxFee);
        op.preVerificationGas = pvg;
    }

    function _check(PackedUserOperation memory op) internal returns (uint256 r) {
        vm.prank(smartSession);
        r = policy.checkUserOpPolicy(ID, op);
    }

    function test_L1_engineOpPasses() public {
        assertEq(_check(_op(1_000_000, 100 gwei, 3_000_000, 2_000_000, 100_000)), 0, "maxFeePerGas is not capped");
    }

    function test_L1_drainShapesAreRefused() public {
        assertEq(_check(_op(1 gwei, 1 gwei, 3_000_000, 2_000_000, 100_000)), 1, "priority fee over the cap");
        assertEq(_check(_op(1_000_000, 1 gwei, 3_000_000, 2_000_000, 10_000_000)), 1, "preVerificationGas over the cap");
        assertEq(_check(_op(1_000_000, 1 gwei, 30_000_000, 2_000_000, 100_000)), 1, "verificationGasLimit over");
        assertEq(_check(_op(1_000_000, 1 gwei, 3_000_000, 20_000_000, 100_000)), 1, "callGasLimit over (10% penalty)");
    }

    function test_L1_storageIsPerMultiplexer() public {
        // Another caller's init cannot change what SmartSession reads.
        vm.prank(makeAddr("other"));
        policy.initializeWithMultiplexer(safe, ID, abi.encode(MamoruGasPolicy.Caps(type(uint64).max, 1, 1, 1)));
        assertEq(_check(_op(1 gwei, 1 gwei, 3_000_000, 2_000_000, 100_000)), 1);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        policy.checkUserOpPolicy(ID, _op(1, 1, 1, 1, 1));
    }

    function test_L1_interfaceIds() public view {
        assertTrue(policy.supportsInterface(MamoruGasPolicy.checkUserOpPolicy.selector));
        assertTrue(policy.supportsInterface(MamoruGasPolicy.initializeWithMultiplexer.selector));
        assertFalse(policy.supportsInterface(0x05c00895)); // not an action policy (checkAction)
    }
}
