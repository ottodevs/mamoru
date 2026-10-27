// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MamoruPauseGate} from "../src/MamoruPauseGate.sol";
import {IModuleRegistry} from "./Deploy.s.sol";

/**
 * Deployment of MamoruPauseGate on Base (otto/mamoru#213), bound to the deployed MamoruActionPolicyV2. Coordinator only,
 * after Ot's decision; nothing here runs by itself.
 *
 *   forge script script/DeployPauseGate.s.sol --rpc-url $BASE_RPC_URL --sender $DEPLOYER   # dry run
 *
 * Same steps as DeployV2.s.sol: `ModuleRegistry.deployModule` creates it with CREATE2 and writes its ERC-7484
 * ModuleRecord in the same transaction (deployer-prefixed salt, resolver of Mamoru's other policies), then the record
 * and both immutables are checked. Salt nonces 1-3 are V1, MamoruGasPolicy and V2; the gate takes 4.
 */
contract DeployMamoruPauseGate is Script {
    // packages/registry/base.json
    address constant REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant ACTION_POLICY_V2 = 0x9ef35e544C93A6722a13473AB9EF115f719bbE6B;
    /// The resolver Mamoru's other session policies are registered under (TimeFramePolicy's record).
    address constant RESOLVER_REFERENCE = 0x8177451511dE0577b911C254E9551D981C26dc72;

    function run() external returns (address gate) {
        uint96 nonce = uint96(vm.envOr("PAUSE_GATE_SALT_NONCE", uint256(4)));
        gate = deploy(msg.sender, bytes32(abi.encodePacked(msg.sender, nonce)));
    }

    function initCode() public pure returns (bytes memory) {
        return abi.encodePacked(type(MamoruPauseGate).creationCode, abi.encode(SMART_SESSION, ACTION_POLICY_V2));
    }

    function deploy(address deployer, bytes32 salt) public returns (address gate) {
        IModuleRegistry r = IModuleRegistry(REGISTRY);
        bytes32 resolverUID = r.findModule(RESOLVER_REFERENCE).resolverUID;
        vm.startBroadcast(deployer);
        gate = r.deployModule(salt, resolverUID, initCode(), "", "");
        vm.stopBroadcast();
        IModuleRegistry.ModuleRecord memory rec = r.findModule(gate);
        require(rec.resolverUID == resolverUID, "ModuleRecord: unexpected resolver");
        require(rec.sender == deployer, "ModuleRecord: registered by someone else");
        require(MamoruPauseGate(gate).SMART_SESSION() == SMART_SESSION, "SMART_SESSION");
        require(address(MamoruPauseGate(gate).ACTION_POLICY()) == ACTION_POLICY_V2, "ACTION_POLICY");
        console2.log("MamoruPauseGate:", gate);
    }
}
