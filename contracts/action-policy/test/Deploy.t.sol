// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployMamoruActionPolicy, IModuleRegistry, IOraclePool} from "../script/Deploy.s.sol";
import {MamoruActionPolicy, ConfigId} from "../src/MamoruActionPolicy.sol";

interface IRegisterModule {
    function registerModule(bytes32 resolverUID, address moduleAddress, bytes calldata metadata, bytes calldata ctx)
        external;
}

/// T6 L-3 (atomic deploy + ERC-7484 registration) and L-4 (cardinality step), on the Base fork.
contract DeployTest is Test {
    IModuleRegistry constant R = IModuleRegistry(0x000000000069E2a187AEFFb852bF3cCdC95151B2);
    address deployer = makeAddr("deployer");
    address attacker = makeAddr("attacker");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), 52_700_000);
    }

    /// Before (T1-T4 flow): deploy in one transaction, `registerModule` in another. Whoever registers first owns the
    /// record and picks its resolver; the deployer's own registration then reverts.
    function test_L3_before_twoStepRegistrationCanBeFrontRun() public {
        DeployMamoruActionPolicy d = new DeployMamoruActionPolicy();
        vm.prank(deployer);
        address p = address(new MamoruActionPolicy(address(1), address(2), address(3), address(4)));
        bytes32 uid = R.findModule(0x8177451511dE0577b911C254E9551D981C26dc72).resolverUID;
        vm.prank(attacker);
        IRegisterModule(address(R)).registerModule(uid, p, "attacker", "");
        assertEq(R.findModule(p).metadata, bytes("attacker"), "the attacker's record");
        vm.prank(deployer);
        vm.expectRevert();
        IRegisterModule(address(R)).registerModule(uid, p, "", "");
        d; // keeps the import used in both tests
    }

    /// After: one `deployModule` call deploys and registers; the record names the deployer and the expected resolver,
    /// and nobody can register the address again.
    function test_L3_L4_atomicDeployAndCardinality() public {
        DeployMamoruActionPolicy d = new DeployMamoruActionPolicy();
        bytes32 salt = d.saltFor(deployer, 1);
        // The same salt from anyone else is refused by the registry: the address is the deployer's alone.
        bytes memory code = d.initCode();
        bytes32 uid = R.findModule(0x8177451511dE0577b911C254E9551D981C26dc72).resolverUID;
        vm.prank(attacker);
        vm.expectRevert(bytes4(0x81e69d9b)); // InvalidSalt()
        R.deployModule(salt, uid, code, "", "");
        address policy = d.deploy(deployer, salt, 3_600);
        IModuleRegistry.ModuleRecord memory rec = R.findModule(policy);
        assertEq(rec.sender, deployer);
        assertEq(rec.resolverUID, R.findModule(0x8177451511dE0577b911C254E9551D981C26dc72).resolverUID);
        assertGt(policy.code.length, 0);
        vm.prank(attacker);
        vm.expectRevert();
        IRegisterModule(address(R)).registerModule(rec.resolverUID, policy, "", "");

        address[3] memory pools = [d.POOL_STABLE(), d.POOL_BTC(), d.POOL_ETH()];
        for (uint256 i; i < 3; i++) {
            (,,,, uint16 next,,) = IOraclePool(pools[i]).slot0();
            assertGe(next, 3_600);
        }
        // The stables pool can now be enabled (it could not at cardinality 1,000).
        MamoruActionPolicy.Init memory i = MamoruActionPolicy.Init({
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
        vm.prank(0x00000000002B0eCfbD0496EE71e01257dA0E37DE);
        MamoruActionPolicy(policy).initializeWithMultiplexer(makeAddr("safe"), ConfigId.wrap(bytes32(0)), abi.encode(i));
    }

    /// T7 (P1 2): the gas policy is deployed and registered in one call too, at a deployer-only address.
    function test_T7_gasPolicyAtomicDeploy() public {
        DeployMamoruActionPolicy d = new DeployMamoruActionPolicy();
        bytes32 salt = d.saltFor(deployer, 2);
        bytes32 uid = R.findModule(0x8177451511dE0577b911C254E9551D981C26dc72).resolverUID;
        bytes memory code = d.gasPolicyInitCode();
        vm.prank(attacker);
        vm.expectRevert(bytes4(0x81e69d9b)); // InvalidSalt()
        R.deployModule(salt, uid, code, "", "");
        address gasPolicy = d.deployGasPolicy(deployer, salt);
        IModuleRegistry.ModuleRecord memory rec = R.findModule(gasPolicy);
        assertEq(rec.sender, deployer);
        assertEq(rec.resolverUID, uid);
        assertGt(gasPolicy.code.length, 0);
    }
}
