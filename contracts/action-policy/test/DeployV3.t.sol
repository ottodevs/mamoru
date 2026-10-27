// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployMamoruActionPolicyV3} from "../script/DeployV3.s.sol";
import {IModuleRegistry} from "../script/Deploy.s.sol";
import {MamoruActionPolicyV3} from "../src/MamoruActionPolicyV3.sol";

/// DeployV3.s.sol on the Base fork: one `deployModule` call (CREATE2 from the registry, deployer-only salt), Base's
/// arguments, the predicted address.
contract DeployV3Test is Test {
    IModuleRegistry constant R = IModuleRegistry(0x000000000069E2a187AEFFb852bF3cCdC95151B2);
    address deployer = makeAddr("deployer");
    address attacker = makeAddr("attacker");
    address guardian = makeAddr("guardian");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), 53_140_000);
    }

    function test_deterministicDeployOnBase() public {
        DeployMamoruActionPolicyV3 d = new DeployMamoruActionPolicyV3();
        DeployMamoruActionPolicyV3.Args memory a = d.argsFor(8453);
        bytes32 salt = d.saltFor(deployer, 4);
        bytes memory code = d.initCode(guardian, a);
        bytes32 uid = R.findModule(0x8177451511dE0577b911C254E9551D981C26dc72).resolverUID;
        vm.prank(attacker);
        vm.expectRevert(bytes4(0x81e69d9b)); // InvalidSalt(): only the deployer named in the salt
        R.deployModule(salt, uid, code, "", "");

        address predicted = vm.computeCreate2Address(salt, keccak256(code), address(R));
        address policy = d.deploy(deployer, salt, guardian, a, 1_800);
        assertEq(policy, predicted, "CREATE2 from the registry: f(deployer, nonce, init code)");
        assertEq(R.findModule(policy).sender, deployer);
        MamoruActionPolicyV3 p = MamoruActionPolicyV3(policy);
        assertEq(p.GUARDIAN(), guardian);
        assertEq(p.TOKEN_MESSENGER(), 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d);
        assertEq(p.BURN_TOKEN(), 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        assertEq(p.DESTINATION_DOMAIN(), 15);
        assertEq(p.vaultAsset(0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61), 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        assertEq(p.vaultAsset(0xC768c589647798a6EE01A91FdE98EF2ed046DBD6), 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        assertLe(policy.code.length, 24_576);
    }

    function test_perChainArgs() public {
        DeployMamoruActionPolicyV3 d = new DeployMamoruActionPolicyV3();
        DeployMamoruActionPolicyV3.Args memory m = d.argsFor(143);
        assertEq(m.vaults.length, 0, "Monad: no vaults");
        assertEq(m.tokenMessenger, address(0), "Monad: no bridge family");
        assertEq(m.pools.length, 1);
        // Different arguments, different init code, different address: by design.
        assertTrue(keccak256(d.initCode(guardian, m)) != keccak256(d.initCode(guardian, d.argsFor(8453))));
        vm.expectRevert(bytes("DeployV3: Base (8453) or Monad (143) only"));
        d.argsFor(1);
    }
}
