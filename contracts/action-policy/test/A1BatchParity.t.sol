// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruV4Table} from "../src/MamoruV4Table.sol";
import {ConfigIdV4, PackedUserOperationV4} from "../src/SmartSessionTypes.sol";

/// otto/mamoru#348: the operator's V4 session batches, built by the TypeScript builder (packages/account/one-auth
/// `buildA1Batch`, fixture test/fixtures/a1-batches.json from a1-batch-fixture.ts), and malformed ones, through the real
/// MamoruGasPolicyV2.checkUserOpPolicy on Base (no fork: block.chainid 8453, the table gives the position manager). A
/// case marked `shape` must validate with the time range [T - S, T + S]; any other must be refused. batch.test.ts checks
/// that the TypeScript validator (`a1Shape`) gives the same verdict for every case.
contract A1BatchParityTest is Test {
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    ConfigIdV4 constant ID = ConfigIdV4.wrap(bytes32(uint256(0x348)));
    uint256 constant S = 5 minutes;
    MamoruGasPolicyV2 pol;
    string j;

    function setUp() public {
        vm.chainId(8453);
        j = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/a1-batches.json"));
        pol = new MamoruGasPolicyV2(new MamoruV4Table());
        assertEq(vm.parseJsonUint(j, ".chainId"), 8453);
        assertEq(vm.parseJsonAddress(j, ".npm"), 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1, "fixture npm is Base's");
    }

    /// Each case on its own account (the GCRA state of one never touches another), cheap gas under Base's caps.
    function _check(uint256 i, bytes memory callData) internal returns (uint256) {
        address acct = address(uint160(0xA1000 + i));
        vm.prank(SMART_SESSION);
        pol.initializeWithMultiplexer(acct, ID, abi.encode(MamoruGasPolicyV2.Caps(10_000_000, 3_000_000, 2_000_000, 200_000, 100_000_000, 0)));
        PackedUserOperationV4 memory op;
        op.sender = acct;
        op.accountGasLimits = bytes32((uint256(600_000) << 128) | 1_300_000);
        op.preVerificationGas = 80_000;
        op.gasFees = bytes32((uint256(1) << 128) | 1_000_000);
        op.callData = callData;
        vm.prank(SMART_SESSION);
        return pol.checkUserOpPolicy(ID, op);
    }

    function test_everyFixtureCaseGetsItsVerdict() public {
        uint256 n = vm.parseJsonUint(j, ".count");
        uint256 t = vm.parseJsonUint(j, ".t");
        uint256 accepted;
        assertGt(n, 30);
        for (uint256 i; i < n; i++) {
            string memory k = string.concat(".cases[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(j, string.concat(k, ".name"));
            bool shape = vm.parseJsonBool(j, string.concat(k, ".shape"));
            uint256 r = _check(i, vm.parseJsonBytes(j, string.concat(k, ".callData")));
            if (shape) {
                // success: aggregator 0, validUntil = T + S, validAfter = T - S (T is the fixture's for every built case)
                assertEq(uint160(r), 0, name);
                assertEq(r >> 160, ((t - S) << 48) | (t + S), name);
                accepted++;
            } else {
                assertEq(r, 1, name);
            }
        }
        emit log_named_uint("cases", n);
        emit log_named_uint("accepted by MamoruGasPolicyV2", accepted);
    }
}
