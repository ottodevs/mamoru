// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MamoruActionPolicyV2} from "../src/MamoruActionPolicyV2.sol";
import {IModuleRegistry, IOraclePool} from "./Deploy.s.sol";

/**
 * Deployment of MamoruActionPolicyV2 (otto/mamoru#151, #171). Coordinator only, after Ot's decision; nothing here runs
 * by itself. A separate script from Deploy.s.sol on purpose: importing V2 compiles the importing file at V2's 1,000
 * optimizer runs (foundry.toml), and Deploy.s.sol must keep building the deployed V1 at 10,000.
 *
 *   GUARDIAN=0x... forge script script/DeployV2.s.sol --rpc-url $BASE_RPC_URL --sender $DEPLOYER   # dry run
 *
 * Same steps as Deploy.s.sol's action policy (T6 L-3, L-4): `ModuleRegistry.deployModule` creates the policy with
 * CREATE2 and writes its ERC-7484 ModuleRecord in the same transaction (deployer-prefixed salt, resolver of Mamoru's
 * other policies), the record is checked, and the three pools' `observationCardinalityNext` is raised to the target
 * when it is not there already (on Base it is: Deploy.s.sol raised it for V1). MamoruGasPolicy is not redeployed: V2
 * sessions carry the deployed one.
 *
 * GUARDIAN is required, so a deploy never picks "no guardian" by omission: the revoke-only pause key's address, or
 * 0x0000000000000000000000000000000000000000 for a V2 without one. It is a constructor argument (immutable).
 */
contract DeployMamoruActionPolicyV2 is Script {
    // packages/registry/base.json
    address constant REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    /// The resolver Mamoru's other session policies are registered under (TimeFramePolicy's record).
    address constant RESOLVER_REFERENCE = 0x8177451511dE0577b911C254E9551D981C26dc72;
    address public constant POOL_STABLE = 0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1;
    address public constant POOL_BTC = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address public constant POOL_ETH = 0x6c561B446416E1A00E8E93E221854d6eA4171372;

    /// Each new ring slot costs ~22.1k gas: 600 slots is ~13.3M gas, under the 2^24 per-transaction cap.
    uint16 constant CARDINALITY_STEP = 600;

    function run() external returns (address policy) {
        address guardian = vm.envAddress("GUARDIAN");
        // Salt nonces 1 and 2 are V1 and MamoruGasPolicy (Deploy.s.sol).
        uint96 nonce = uint96(vm.envOr("POLICY_V2_SALT_NONCE", uint256(3)));
        uint16 target = uint16(vm.envOr("CARDINALITY_TARGET", uint256(3_600)));
        policy = deploy(msg.sender, saltFor(msg.sender, nonce), guardian, target);
    }

    function saltFor(address deployer, uint96 nonce) public pure returns (bytes32) {
        return bytes32(abi.encodePacked(deployer, nonce));
    }

    function initCode(address guardian) public pure returns (bytes memory) {
        return abi.encodePacked(
            type(MamoruActionPolicyV2).creationCode, abi.encode(SMART_SESSION, NPM, ROUTER, FACTORY, guardian)
        );
    }

    function deploy(address deployer, bytes32 salt, address guardian, uint16 cardinalityTarget)
        public
        returns (address policy)
    {
        IModuleRegistry r = IModuleRegistry(REGISTRY);
        bytes32 resolverUID = r.findModule(RESOLVER_REFERENCE).resolverUID;
        vm.startBroadcast(deployer);
        policy = r.deployModule(salt, resolverUID, initCode(guardian), "", "");
        address[3] memory pools = [POOL_STABLE, POOL_BTC, POOL_ETH];
        for (uint256 i; i < pools.length; i++) {
            raiseCardinality(pools[i], cardinalityTarget);
        }
        vm.stopBroadcast();
        IModuleRegistry.ModuleRecord memory rec = r.findModule(policy);
        require(rec.resolverUID == resolverUID, "ModuleRecord: unexpected resolver");
        require(rec.sender == deployer, "ModuleRecord: registered by someone else");
        require(MamoruActionPolicyV2(policy).GUARDIAN() == guardian, "GUARDIAN");
        console2.log("MamoruActionPolicyV2:", policy);
        console2.log("GUARDIAN:", guardian);
    }

    function raiseCardinality(address pool, uint16 target) public {
        (,,,, uint16 next,,) = IOraclePool(pool).slot0();
        while (next < target) {
            uint16 n = target - next > CARDINALITY_STEP ? next + CARDINALITY_STEP : target;
            IOraclePool(pool).increaseObservationCardinalityNext(n);
            next = n;
        }
    }
}
