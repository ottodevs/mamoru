// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployMamoruActionPolicyV2} from "../script/DeployV2.s.sol";
import {IModuleRegistry} from "../script/Deploy.s.sol";
import {MamoruActionPolicyV2, ConfigId} from "../src/MamoruActionPolicyV2.sol";

/// DeployV2.s.sol on the Base fork: one `deployModule` call, deployer-only salt, the guardian as given.
contract DeployV2Test is Test {
    IModuleRegistry constant R = IModuleRegistry(0x000000000069E2a187AEFFb852bF3cCdC95151B2);
    address deployer = makeAddr("deployer");
    address attacker = makeAddr("attacker");
    address guardian = makeAddr("guardian");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), 52_700_000);
    }

    function test_atomicDeployWithGuardian() public {
        DeployMamoruActionPolicyV2 d = new DeployMamoruActionPolicyV2();
        bytes32 salt = d.saltFor(deployer, 3);
        bytes32 uid = R.findModule(0x8177451511dE0577b911C254E9551D981C26dc72).resolverUID;
        bytes memory code = d.initCode(guardian);
        vm.prank(attacker);
        vm.expectRevert(bytes4(0x81e69d9b)); // InvalidSalt()
        R.deployModule(salt, uid, code, "", "");
        address policy = d.deploy(deployer, salt, guardian, 3_600);
        IModuleRegistry.ModuleRecord memory rec = R.findModule(policy);
        assertEq(rec.sender, deployer);
        assertEq(rec.resolverUID, uid);
        MamoruActionPolicyV2 p = MamoruActionPolicyV2(policy);
        assertEq(p.GUARDIAN(), guardian);
        assertEq(p.SMART_SESSION(), 0x00000000002B0eCfbD0496EE71e01257dA0E37DE);
        assertLe(policy.code.length, 24_576);

        // The stables pool enables (cardinality raised by the script), and the guardian can pause that account.
        MamoruActionPolicyV2.Init memory i = MamoruActionPolicyV2.Init({
            pool: d.POOL_STABLE(),
            twapWindow: 1800,
            twapShortWindow: 300,
            bandTicks: 10,
            generation: 1,
            anchorTick: 0,
            anchorBand: 40,
            budgetIn1: false,
            budgetWindow: 1 days,
            perWindow: 1e6,
            total: 1e6,
            admit: new uint256[](0)
        });
        address safe = makeAddr("safe");
        vm.prank(0x00000000002B0eCfbD0496EE71e01257dA0E37DE);
        p.initializeWithMultiplexer(safe, ConfigId.wrap(bytes32(0)), abi.encode(i));
        vm.prank(guardian);
        p.pause(safe);
        assertTrue(p.isPaused(safe));
    }
}
