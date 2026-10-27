// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MamoruActionPolicy} from "../src/MamoruActionPolicy.sol";
import {MamoruGasPolicy} from "../src/MamoruGasPolicy.sol";

/// ERC-7484 registry (Rhinestone), the calls this deployment needs.
interface IModuleRegistry {
    struct ModuleRecord {
        bytes32 resolverUID;
        address sender;
        bytes metadata;
    }

    function findModule(address moduleAddress) external view returns (ModuleRecord memory);
    function calcModuleAddress(bytes32 salt, bytes calldata initCode) external view returns (address);
    function deployModule(
        bytes32 salt,
        bytes32 resolverUID,
        bytes calldata initCode,
        bytes calldata metadata,
        bytes calldata resolverContext
    ) external payable returns (address moduleAddress);
}

interface IOraclePool {
    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16 observationCardinality, uint16 observationCardinalityNext, uint8, bool);
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

/**
 * Spec 007 T7 deployment of MamoruActionPolicy (T6 L-3, L-4). Coordinator only; NOT run by T6.
 *
 *   forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --sender $DEPLOYER   # dry run (no --broadcast)
 *
 * 1. L-3: `ModuleRegistry.deployModule` creates the policy with CREATE2 AND writes its ERC-7484 ModuleRecord in the same
 *    transaction, so nobody can pick the module's resolver between the deploy and the registration. The record is
 *    then checked (resolver and sender) before anything else runs; T7 must not attest a policy whose record differs.
 * 1b. T7 (GPT-6 review of #97, P1 2): `MamoruGasPolicy`, the userOp policy every v4 session carries, the same way (its own
 *    `deployModule`, salt nonce `GAS_POLICY_SALT_NONCE`, record checked). Both addresses go to the operator's config
 *    (MAMORU_ACTION_POLICY_ADDRESS, MAMORU_GAS_POLICY_ADDRESS); the operator checks `findModule` of both before any
 *    account attests them.
 * 2. L-4: raises `observationCardinalityNext` of every pool a grant covers to CARDINALITY_TARGET (default 3,600 =
 *    2 x twapWindow), in steps that keep each transaction under Base's 2^24 gas cap. `initializeWithMultiplexer`
 *    refuses a pool whose `observationCardinalityNext` is under `twapWindow`.
 */
contract DeployMamoruActionPolicy is Script {
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

    function run() external returns (address policy, address gasPolicy) {
        uint96 nonce = uint96(vm.envOr("POLICY_SALT_NONCE", uint256(1)));
        uint96 gasNonce = uint96(vm.envOr("GAS_POLICY_SALT_NONCE", uint256(2)));
        uint16 target = uint16(vm.envOr("CARDINALITY_TARGET", uint256(3_600)));
        policy = deploy(msg.sender, saltFor(msg.sender, nonce), target);
        gasPolicy = deployGasPolicy(msg.sender, saltFor(msg.sender, gasNonce));
    }

    /// The registry accepts a CREATE2 salt whose first 20 bytes are the caller (or zero): a caller-prefixed salt means
    /// nobody but `deployer` can create the policy at this address through the registry, under any resolver.
    function saltFor(address deployer, uint96 nonce) public pure returns (bytes32) {
        return bytes32(abi.encodePacked(deployer, nonce));
    }

    function initCode() public pure returns (bytes memory) {
        return abi.encodePacked(type(MamoruActionPolicy).creationCode, abi.encode(SMART_SESSION, NPM, ROUTER, FACTORY));
    }

    function deploy(address deployer, bytes32 salt, uint16 cardinalityTarget) public returns (address policy) {
        IModuleRegistry r = IModuleRegistry(REGISTRY);
        bytes32 resolverUID = r.findModule(RESOLVER_REFERENCE).resolverUID;
        vm.startBroadcast(deployer);
        policy = r.deployModule(salt, resolverUID, initCode(), "", "");
        address[3] memory pools = [POOL_STABLE, POOL_BTC, POOL_ETH];
        for (uint256 i; i < pools.length; i++) {
            raiseCardinality(pools[i], cardinalityTarget);
        }
        vm.stopBroadcast();
        IModuleRegistry.ModuleRecord memory rec = r.findModule(policy);
        require(rec.resolverUID == resolverUID, "ModuleRecord: unexpected resolver");
        require(rec.sender == deployer, "ModuleRecord: registered by someone else");
        console2.log("MamoruActionPolicy:", policy);
    }

    function gasPolicyInitCode() public pure returns (bytes memory) {
        return type(MamoruGasPolicy).creationCode;
    }

    /// T7: the userOp gas policy, deployed and registered in one `deployModule` call like the action policy (L-3).
    function deployGasPolicy(address deployer, bytes32 salt) public returns (address gasPolicy) {
        IModuleRegistry r = IModuleRegistry(REGISTRY);
        bytes32 resolverUID = r.findModule(RESOLVER_REFERENCE).resolverUID;
        vm.startBroadcast(deployer);
        gasPolicy = r.deployModule(salt, resolverUID, gasPolicyInitCode(), "", "");
        vm.stopBroadcast();
        IModuleRegistry.ModuleRecord memory rec = r.findModule(gasPolicy);
        require(rec.resolverUID == resolverUID, "ModuleRecord: unexpected resolver");
        require(rec.sender == deployer, "ModuleRecord: registered by someone else");
        console2.log("MamoruGasPolicy:", gasPolicy);
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
