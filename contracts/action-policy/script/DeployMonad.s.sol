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
 * 2. `observationCardinalityNext` of the WMON/USDC 0.3% pool is raised to CARDINALITY_TARGET (default 1,800, the policy's
 *    own floor), in steps of CARDINALITY_STEP slots. `initializeWithMultiplexer` refuses a pool whose
 *    `observationCardinalityNext` is under `twapWindow`; the pool stands at 1,000 slots, under the 1,800 s long window.
 *
 * Re-runnable: a module already deployed under the same salt is skipped, and the raise continues from the pool's
 * current `observationCardinalityNext`. After any partial broadcast (out of MON, RPC drop) run the same command again.
 * Broadcast with `--slow` so each transaction waits for the previous one: without it forge may send the later nonces
 * even after an earlier step failed.
 *
 * GUARDIAN is required, so a deploy never picks "no guardian" by omission: the revoke-only pause key's address (on Base,
 * 0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD), or the zero address for a V2 without one. It is an immutable.
 *
 * Cardinality target, 1,800 (Ot's cost decision): measured 2026-10-27, the pool's 1,000 slots held ~20 h of history
 * (one observation per block with a swap, not per block), so a 30-minute TWAP already resolves. If trading ever fills
 * the ring inside the window, observe() reverts and the policy and the engine refuse the action (a hold, never a
 * loss); raise it then. Each new slot costs ~22.3k gas measured on an anvil fork (Ethereum gas schedule; Monad
 * reprices cold state access, UNVERIFIED). Funding: Monad charges the gas LIMIT (forge sets ~30% above the estimate),
 * not the use, so budget on limits: two deployModule transactions plus the raise (two transactions, 500 + 300 slots).
 * The fork run prints the sum of limits; at a 100 gwei fee that is a few MON. Fund the deployer with at least 10 MON.
 * The fork funds 100 MON and charges gas used, so it cannot prove the budget.
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

    /// 500 slots per transaction: ~11M gas used on the fork's schedule, ~14M limit. Leaves 2x under a 30M per-transaction
    /// cap even if Monad's cold-slot cost were well above Ethereum's (unverified); total gas is the same as bigger steps.
    uint16 constant CARDINALITY_STEP = 500;

    function run() external returns (address gasPolicy, address policy) {
        require(block.chainid == MONAD_CHAIN_ID, "not Monad (143)");
        address guardian = vm.envAddress("GUARDIAN");
        // Base nonces: 1 MamoruActionPolicy (V1, not deployed on Monad), 2 MamoruGasPolicy, 3 MamoruActionPolicyV2.
        uint96 gasNonce = uint96(vm.envOr("GAS_POLICY_SALT_NONCE", uint256(2)));
        uint96 nonce = uint96(vm.envOr("POLICY_V2_SALT_NONCE", uint256(3)));
        // The policy's own floor (cardinalityNext >= twapWindow, 1,800); see the header.
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
        gasPolicy = deployOnce(r, gasSalt, resolverUID, gasPolicyInitCode());
        policy = deployOnce(r, salt, resolverUID, initCode(guardian));
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

    /// Deploys through the registry unless the module is already there (a rerun after a partial broadcast).
    function deployOnce(IModuleRegistry r, bytes32 salt, bytes32 resolverUID, bytes memory code)
        internal
        returns (address module)
    {
        module = r.calcModuleAddress(salt, code);
        if (module.code.length == 0) return r.deployModule(salt, resolverUID, code, "", "");
        console2.log("already deployed, skipped:", module);
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
