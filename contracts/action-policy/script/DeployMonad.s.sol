// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MamoruActionPolicyV2} from "../src/MamoruActionPolicyV2.sol";
import {MamoruGasPolicy} from "../src/MamoruGasPolicy.sol";
import {IModuleRegistry, IOraclePool} from "./Deploy.s.sol";

/**
 * Deployment of MamoruGasPolicy and MamoruActionPolicyV2 on Monad mainnet (chain 143) (otto/mamoru#214, parent #201).
 * Coordinator only, after Ot's decision, with MON on the deployer; nothing here runs by itself. A separate script from
 * Deploy.s.sol and DeployV2.s.sol on purpose: those two are the Base scripts and keep their constants and their
 * compiler settings (importing V2 compiles the importing file at 1,000 optimizer runs via_ir, see foundry.toml).
 *
 *   GUARDIAN=0x... forge script script/DeployMonad.s.sol --rpc-url https://rpc.monad.xyz --sender $DEPLOYER   # dry run
 *
 * Same steps as the Base scripts, with Monad's addresses (packages/registry/monad.json):
 * 1. `ModuleRegistry.deployModule` creates each policy with CREATE2 and writes its ERC-7484 ModuleRecord in the same
 *    transaction (deployer-prefixed salt, resolver of TimeFramePolicy's record, which Monad has since #62 under the same
 *    resolverUID as Base). Both records are checked (resolver and sender) before the script goes on.
 * 2. `observationCardinalityNext` of the WMON/USDC 0.3% pool is raised to CARDINALITY_TARGET, in steps that keep each
 *    transaction well under a 30M per-transaction gas limit. `initializeWithMultiplexer` refuses a pool whose
 *    `observationCardinalityNext` is under `twapWindow`; the pool stands at 1,000 slots, under the 1,800 s long window.
 *
 * GUARDIAN is required, so a deploy never picks "no guardian" by omission: the revoke-only pause key's address (on Base,
 * 0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD), or the zero address for a V2 without one. It is an immutable.
 *
 * Cardinality target, 12,000. A pool writes at most one observation per block. Monad's block time measured on mainnet
 * (100,000 blocks, 2026-10-27) is 0.30 s, so the long TWAP window (1,800 s) spans up to ~6,000 blocks and the short
 * one (300 s) up to ~1,000; a ring under ~6,000 slots can lose the start of the long window to a swap in every block
 * (`observe` reverts OLD). 12,000 is 2x that worst case (Base: 3,600 slots for 900 blocks of 2 s, 4x). Each new slot
 * costs ~22.3k gas (measured on a fork: 1,000 slots = 22.27M), so the raise from 1,000 is ~245M gas over fourteen
 * transactions, paid in MON at gas LIMIT (Monad charges the limit, not the use): ~25 MON at the 100 gwei base fee.
 */
contract DeployMonad is Script {
    uint256 constant MONAD_CHAIN_ID = 143;

    // packages/registry/monad.json
    address constant REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant NPM = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
    address constant ROUTER = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
    address constant FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    /// The resolver Mamoru's other session policies are registered under (TimeFramePolicy's record, same on Monad).
    address constant RESOLVER_REFERENCE = 0x8177451511dE0577b911C254E9551D981C26dc72;
    /// pool:WMON/USDC/3000
    address public constant POOL_WMON_USDC = 0x659bD0BC4167BA25c62E05656F78043E7eD4a9da;

    /// ~22.3k gas per new ring slot: 800 slots is ~17.8M gas per transaction (forge sets a limit ~30% above, ~23M), so a
    /// per-transaction cap of 30M would still fit. 1,000 slots measured 22.27M used, 28.9M limit: too close.
    uint16 constant CARDINALITY_STEP = 800;

    function run() external returns (address gasPolicy, address policy) {
        require(block.chainid == MONAD_CHAIN_ID, "not Monad (143)");
        address guardian = vm.envAddress("GUARDIAN");
        // Base nonces: 1 MamoruActionPolicy (V1, not deployed on Monad), 2 MamoruGasPolicy, 3 MamoruActionPolicyV2.
        uint96 gasNonce = uint96(vm.envOr("GAS_POLICY_SALT_NONCE", uint256(2)));
        uint96 nonce = uint96(vm.envOr("POLICY_V2_SALT_NONCE", uint256(3)));
        // The policy's own floor (cardinalityNext >= twapWindow, 1,800), nothing more: measured 2026-10-27, the pool's 1,000
        // slots held about 20 h of history (one observation per block with a swap, not per block), so a 30-minute TWAP
        // already resolves. If trading ever fills the ring inside the window, observe() reverts and the policy and the
        // engine refuse the action (a hold, never a loss); raise it then. 1,000 -> 1,800 is one ~17.8M-gas transaction.
        uint16 target = uint16(vm.envOr("CARDINALITY_TARGET", uint256(1_800)));
        (gasPolicy, policy) =
            deploy(msg.sender, saltFor(msg.sender, gasNonce), saltFor(msg.sender, nonce), guardian, target);
    }

    function saltFor(address deployer, uint96 nonce) public pure returns (bytes32) {
        return bytes32(abi.encodePacked(deployer, nonce));
    }

    function initCode(address guardian) public pure returns (bytes memory) {
        return abi.encodePacked(
            type(MamoruActionPolicyV2).creationCode, abi.encode(SMART_SESSION, NPM, ROUTER, FACTORY, guardian)
        );
    }

    function gasPolicyInitCode() public pure returns (bytes memory) {
        return type(MamoruGasPolicy).creationCode;
    }

    function deploy(address deployer, bytes32 gasSalt, bytes32 salt, address guardian, uint16 cardinalityTarget)
        public
        returns (address gasPolicy, address policy)
    {
        IModuleRegistry r = IModuleRegistry(REGISTRY);
        bytes32 resolverUID = r.findModule(RESOLVER_REFERENCE).resolverUID;
        require(resolverUID != bytes32(0), "no resolver: TimeFramePolicy not registered on this chain");
        vm.startBroadcast(deployer);
        gasPolicy = r.deployModule(gasSalt, resolverUID, gasPolicyInitCode(), "", "");
        policy = r.deployModule(salt, resolverUID, initCode(guardian), "", "");
        raiseCardinality(POOL_WMON_USDC, cardinalityTarget);
        vm.stopBroadcast();
        checkRecord(r, gasPolicy, resolverUID, deployer);
        checkRecord(r, policy, resolverUID, deployer);
        require(MamoruActionPolicyV2(policy).GUARDIAN() == guardian, "GUARDIAN");
        (,,,, uint16 next,,) = IOraclePool(POOL_WMON_USDC).slot0();
        require(next >= cardinalityTarget, "cardinality not raised");
        console2.log("MamoruGasPolicy:", gasPolicy);
        console2.log("MamoruActionPolicyV2:", policy);
        console2.log("GUARDIAN:", guardian);
        console2.log("WMON/USDC observationCardinalityNext:", next);
    }

    function checkRecord(IModuleRegistry r, address module, bytes32 resolverUID, address deployer) internal view {
        IModuleRegistry.ModuleRecord memory rec = r.findModule(module);
        require(rec.resolverUID == resolverUID, "ModuleRecord: unexpected resolver");
        require(rec.sender == deployer, "ModuleRecord: registered by someone else");
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
