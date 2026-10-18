// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruGasPolicy, PackedUserOperation} from "../src/MamoruGasPolicy.sol";
import {ConfigId} from "../src/MamoruActionPolicy.sol";

/// T6 L-1: the userOp gas caps (no fork needed). T7 (GPT-6 review of #97, P1 4): maxFeePerGas is capped too.
contract MamoruGasPolicyTest is Test {
    // packages/policy/src/v4-grants.ts V4_GAS_CAPS: 0.01 gwei priority, 3M / 2M / 200k gas, 0.1 gwei maxFeePerGas.
    uint64 constant PRIORITY_CAP = 10_000_000;
    uint64 constant MAX_FEE_CAP = 100_000_000;
    MamoruGasPolicy policy = new MamoruGasPolicy();
    address smartSession = makeAddr("smartSession");
    address safe = makeAddr("safe");
    ConfigId constant ID = ConfigId.wrap(bytes32(uint256(1)));

    function setUp() public {
        // The engine's own settings (packages/scenarios/driver/engine.ts LAB_GAS_LIMITS, MAX_PRIORITY_FEE_PER_GAS,
        // maxFeePerGas = 2 x basefee + priority) fit under these: 1e6 wei priority, 3M / 2M / 100k gas, ~1.1e7 wei
        // maxFeePerGas at Base's usual 0.005 gwei basefee. Encoded field by field (the struct's ABI) so this file also
        // compiles against the T6 contract, where the maxFeePerGas tests fail (see results/t7-2026-10-18.md).
        vm.prank(smartSession);
        policy.initializeWithMultiplexer(
            safe, ID, abi.encode(PRIORITY_CAP, uint32(3_000_000), uint32(2_000_000), uint32(200_000), MAX_FEE_CAP)
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
        assertEq(_check(_op(1_000_000, 11_000_000, 3_000_000, 2_000_000, 100_000)), 0, "engine op at 0.005 gwei basefee");
        assertEq(_check(_op(1_000_000, MAX_FEE_CAP, 3_000_000, 2_000_000, 200_000)), 0, "at every cap");
    }

    /// P1 4: before T7 a leaked key could sign any maxFeePerGas; the prefund (maxFeePerGas x gas limits) leaves the
    /// Safe and, in the legacy branch (maxFee == priority), the price ignores basefee.
    function test_T7_maxFeePerGasOverCapIsRefused() public {
        assertEq(_check(_op(1_000_000, MAX_FEE_CAP + 1, 3_000_000, 2_000_000, 100_000)), 1, "maxFeePerGas over the cap");
        assertEq(_check(_op(1_000_000, 100 gwei, 3_000_000, 2_000_000, 100_000)), 1, "huge prefund");
        assertEq(_check(_op(PRIORITY_CAP, 1 ether, 3_000_000, 2_000_000, 100_000)), 1, "priority at cap, maxFee not");
    }

    /// The per-op bound the spec's loss table uses: 0.1 gwei x 5.2M gas = 5.2e14 wei.
    function test_T7_maxCostPerOp() public view {
        MamoruGasPolicy.Caps memory caps = policy.capsOf(ID, smartSession, safe);
        assertEq(caps.maxFeePerGas, MAX_FEE_CAP);
        assertEq(policy.maxCostPerOp(caps), 520_000_000_000_000);
    }

    function test_T7_initRefusesAMissingFeeCap() public {
        vm.startPrank(smartSession);
        vm.expectRevert(MamoruGasPolicy.BadInit.selector);
        policy.initializeWithMultiplexer(safe, ID, abi.encode(PRIORITY_CAP, uint32(3_000_000), uint32(2_000_000), uint32(200_000), uint64(0)));
        vm.expectRevert(MamoruGasPolicy.BadInit.selector);
        policy.initializeWithMultiplexer(safe, ID, abi.encode(PRIORITY_CAP, uint32(3_000_000), uint32(2_000_000), uint32(0), MAX_FEE_CAP));
        vm.stopPrank();
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
        policy.initializeWithMultiplexer(safe, ID, abi.encode(type(uint64).max, uint32(1), uint32(1), uint32(1), type(uint64).max));
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
