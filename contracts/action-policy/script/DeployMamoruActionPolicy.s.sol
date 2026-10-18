// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MamoruActionPolicy} from "../src/MamoruActionPolicy.sol";

/// @dev Minimal slice of the ERC-7484 ModuleRegistry ABI this script needs (packages/registry/src/abis.ts's
/// `moduleRegistryAbi`, same shape, never redefined differently here).
struct ModuleRecord {
    bytes32 resolverUID;
    address sender;
    bytes metadata;
}

interface IModuleRegistry {
    function findModule(address moduleAddress) external view returns (ModuleRecord memory);
    function registerModule(bytes32 resolverUID, address moduleAddress, bytes calldata metadata, bytes calldata resolverContext) external;
}

/**
 * Spec 007 (otto/mamoru#151), task T7(a). Deploys MamoruActionPolicy for Base and registers it on the ERC-7484
 * registry, the same two steps `packages/scenarios/action-policy/t1-fork.ts` already proved on a fork (deploy,
 * then `registerModule` with the resolverUID resolved from an already-registered sibling module, TimeFramePolicy —
 * never a hardcoded resolverUID). Addresses below are `packages/registry/base.json`'s own values, never re-derived.
 *
 * NOT ATOMIC, NOT FINAL. otto/mamoru#151's T6 audit (specs/007-onchain-action-policy/results/
 * t6-audit-claude-2026-10-18.md, finding L-3) and T1's own fork scenario both flag the same gap this script still
 * has: `registerModule` is unprivileged, so the window between this script's deploy and its register call is a
 * real (if low-value — see L-3's "Consequence 1/2") front-run window. A second branch, feat/151-t6-contract-fixes,
 * is building the fix: deploy and register in ONE transaction (a CREATE2/deployModule-style factory). Before this
 * script is used for a real deploy:
 *   1. Check whether feat/151-t6-contract-fixes has landed an atomic deploy+register mechanism.
 *   2. If it has, replace `_deploy` and `_register` below with ONE call into that mechanism — the rest of this
 *      script (address printing, the dry-run-only posture) does not need to change.
 *   3. If it has not, this script's two-step sequence is a stand-in for gas/address estimation only, not a
 *      deploy plan: do not run it with `--broadcast` until the atomic path exists or L-3 is otherwise accepted.
 *
 * Usage (dry-run ONLY — no `--broadcast`, nothing here is sent):
 *   cd contracts/action-policy && ./install.sh && forge build --silent &&
 *   PATH="$HOME/.foundry/bin:$PATH" forge script script/DeployMamoruActionPolicy.s.sol \
 *     --fork-url "${BASE_FORK_RPC_URL:-https://mainnet.base.org}" -vvv
 *
 * A real deploy (coordinator only, never from this repo's CI, never unattended) adds `--broadcast --private-key
 * <deployer>` and a real RPC with funds — out of scope for this script and for this ticket (preparation only).
 * Open question for Ot: which address deploys, and who pays its gas (see this ticket's report).
 */
contract DeployMamoruActionPolicy is Script {
    // packages/registry/base.json — never re-derived, never an env var substitute for these (they do not change).
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant MODULE_REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    // packages/scenarios/action-policy/t1-fork.ts's `resolverUidOf`: the resolverUID is read off an
    // already-registered sibling module at deploy time, never hardcoded (a redeploy of the registry, or a
    // different resolver policy later, must not silently go stale here).
    address constant RESOLVER_REFERENCE_MODULE = 0x8177451511dE0577b911C254E9551D981C26dc72; // TimeFramePolicy

    function run() external {
        // Who pays and signs is the caller's `--private-key`/`--ledger`/`--sender` flag, never a key in this repo.
        console2.log("deployer (msg.sender / --sender):", msg.sender);

        bytes32 resolverUID = IModuleRegistry(MODULE_REGISTRY).findModule(RESOLVER_REFERENCE_MODULE).resolverUID;
        console2.log("resolverUID (read from TimeFramePolicy's own registration):", vm.toString(resolverUID));

        vm.startBroadcast();
        MamoruActionPolicy policy = _deploy();
        _register(address(policy), resolverUID);
        vm.stopBroadcast();

        console2.log("MamoruActionPolicy deployed at:", address(policy));
        console2.log("SMART_SESSION:", SMART_SESSION);
        console2.log("NPM:", NPM);
        console2.log("ROUTER:", ROUTER);
        console2.log("FACTORY:", FACTORY);
        console2.log("registered with resolverUID:", vm.toString(resolverUID));
        console2.log("");
        console2.log("NOT ATOMIC (see this file's header) -- do not broadcast against mainnet until feat/151-t6-contract-fixes lands or L-3 is otherwise accepted.");
    }

    /// @dev Pending feat/151-t6-contract-fixes: replace this and `_register` with one atomic call. See file header.
    function _deploy() internal returns (MamoruActionPolicy) {
        return new MamoruActionPolicy(SMART_SESSION, NPM, ROUTER, FACTORY);
    }

    /// @dev Pending feat/151-t6-contract-fixes: see `_deploy`'s doc and this file's header (L-3).
    function _register(address policy, bytes32 resolverUID) internal {
        IModuleRegistry(MODULE_REGISTRY).registerModule(resolverUID, policy, "", "");
    }
}
