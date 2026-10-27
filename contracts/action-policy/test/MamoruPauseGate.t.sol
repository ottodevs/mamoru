// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruPauseGate} from "../src/MamoruPauseGate.sol";
import {ConfigId} from "../src/MamoruActionPolicy.sol";

contract FakeV2 {
    mapping(address => bool) public isPaused;

    function set(address a, bool p) external {
        isPaused[a] = p;
    }
}

contract RevertingV2 {
    function isPaused(address) external pure returns (bool) {
        revert("down");
    }
}

/// otto/mamoru#213: the guardian's pause stops the bridge-out session actions too.
contract MamoruPauseGateTest is Test {
    address smartSession = makeAddr("smartSession");
    address safe = makeAddr("safe");
    ConfigId constant ID = ConfigId.wrap(bytes32(uint256(1)));
    FakeV2 v2 = new FakeV2();
    MamoruPauseGate gate = new MamoruPauseGate(smartSession, address(v2));

    function _check(address account) internal returns (uint256 r) {
        vm.prank(smartSession);
        r = gate.checkAction(ID, account, address(0xC0FFEE), 0, hex"12345678");
    }

    function test_allowsWhileNotPaused() public {
        assertEq(_check(safe), 0);
    }

    function test_refusesWhilePaused() public {
        v2.set(safe, true);
        assertEq(_check(safe), 1);
        v2.set(safe, false);
        assertEq(_check(safe), 0, "the pause lifts with V2's");
    }

    function test_refusesOtherCallers() public {
        assertEq(gate.checkAction(ID, safe, address(0xC0FFEE), 0, hex"12345678"), 1);
    }

    function test_failsClosedWhenThePauseReadReverts() public {
        MamoruPauseGate g = new MamoruPauseGate(smartSession, address(new RevertingV2()));
        vm.prank(smartSession);
        assertEq(g.checkAction(ID, safe, address(0xC0FFEE), 0, ""), 1);
    }

    function test_initTakesOnlyEmptyData() public {
        vm.prank(smartSession);
        gate.initializeWithMultiplexer(safe, ID, "");
        vm.expectRevert(MamoruPauseGate.BadInit.selector);
        gate.initializeWithMultiplexer(safe, ID, hex"01");
    }

    function test_constructorRefusesZero() public {
        vm.expectRevert(MamoruPauseGate.BadInit.selector);
        new MamoruPauseGate(address(0), address(v2));
        vm.expectRevert(MamoruPauseGate.BadInit.selector);
        new MamoruPauseGate(smartSession, address(0));
    }

    function test_interfaces() public view {
        assertTrue(gate.supportsInterface(0x01ffc9a7));
        assertTrue(gate.supportsInterface(gate.checkAction.selector));
        assertTrue(gate.supportsInterface(gate.initializeWithMultiplexer.selector));
        assertFalse(gate.supportsInterface(0xdeadbeef));
    }
}
