// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruActionPolicyV2} from "../src/MamoruActionPolicyV2.sol";
import {MamoruPauseGate} from "../src/MamoruPauseGate.sol";
import {ConfigId} from "../src/MamoruActionPolicy.sol";

/// otto/mamoru#213: against the real MamoruActionPolicyV2, the guardian's pause and unpause reach the gate.
contract MamoruPauseGateV2Test is Test {
    address smartSession = makeAddr("smartSession");
    address guardian = makeAddr("guardian");
    address safe = makeAddr("safe");
    ConfigId constant ID = ConfigId.wrap(bytes32(uint256(1)));

    function test_guardianPauseStopsTheGate() public {
        MamoruActionPolicyV2 v2 = new MamoruActionPolicyV2(smartSession, address(1), address(2), address(3), guardian);
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
