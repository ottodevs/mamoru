// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruActionPolicyV3} from "../src/MamoruActionPolicyV3.sol";
import {MamoruPauseGate} from "../src/MamoruPauseGate.sol";
import {ConfigId} from "../src/MamoruActionPolicy.sol";

/// otto/mamoru#213, #251: against the real MamoruActionPolicyV3 (the policy v6's grants carry), the guardian's pause and
/// unpause reach the gate.
contract MamoruPauseGateV3Test is Test {
    address smartSession = makeAddr("smartSession");
    address guardian = makeAddr("guardian");
    address safe = makeAddr("safe");
    ConfigId constant ID = ConfigId.wrap(bytes32(uint256(1)));

    function test_guardianPauseStopsTheGate() public {
        MamoruActionPolicyV3 v2 = new MamoruActionPolicyV3(smartSession, address(1), address(2), address(3), guardian, new address[](0), address(0), address(0), 0);
        MamoruPauseGate gate = new MamoruPauseGate(smartSession, address(v2));
        vm.startPrank(smartSession);
        assertEq(gate.checkAction(ID, safe, address(0xC0FFEE), 0, ""), 0, "not paused");
        vm.stopPrank();
        vm.prank(guardian);
        v2.pause(safe);
        vm.prank(smartSession);
        assertEq(gate.checkAction(ID, safe, address(0xC0FFEE), 0, ""), 1, "paused");
        vm.prank(guardian);
        v2.unpause(safe);
        vm.prank(smartSession);
        assertEq(gate.checkAction(ID, safe, address(0xC0FFEE), 0, ""), 0, "unpaused");
    }
}
