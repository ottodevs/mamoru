// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MamoruActionPolicyV4} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruMigrationCheck} from "../src/MamoruMigrationCheck.sol";
import {MamoruV4Table, IMamoruV4Table} from "../src/MamoruV4Table.sol";
import {MamoruV4Chains} from "../src/MamoruV4Chains.sol";
import {IModuleRegistry} from "./Deploy.s.sol";

/**
 * Spec 010 T7 + A1 (otto/mamoru#292, #307, #316): the one-authorization stack on every chain of the table (Base, Monad
 * and Ethereum today), at the SAME addresses on all of them. One script for any EVM chain the table knows: adding a
 * chain is contracts/action-policy/ADD-A-CHAIN.md. Coordinator only, with Ot's GO in the deploying session. Nothing here
 * runs by itself.
 *
 *   forge script script/DeployV4.s.sol --rpc-url <chain> --sender 0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0          # dry run
 *   forge script script/DeployV4.s.sol --rpc-url <chain> --sender 0x8F7D… --broadcast --private-key <from env>      # deploy
 *
 * What, and how (each address follows from chain-independent init code, so it is the same everywhere):
 *  1. MamoruV4Table (pure data, no argument) and MamoruMigrationCheck through the deterministic deployer (CREATE2).
 *  2. MamoruGasPolicyV2(table) and MamoruActionPolicyV4(gas policy, table) through
 *     ModuleRegistry.deployModule (CREATE2 from the ModuleRegistry, the same address on the three chains, verified with
 *     calcModuleAddress), so both have an ERC-7484 ModuleRecord: the owner enable flow (trust + self-attest +
 *     enableSessions) attests them. The resolver is the one SmartSession's record uses, present on all three chains.
 * Spec 010 A1: there is no registry, no registry admin and no guardian. Neither contract takes an address with any
 * power, and `check` refuses bytecode that carries a guardian, pause, review or readiness-setter selector (spec 009
 * POL-01). Pools, vaults and chains are the table's constants (MamoruV4Chains, MamoruV4Classes in MamoruV4Table).
 * `run()` refuses any other deployer, and any chain outside V4's table; it skips what is already deployed, so a run
 * that stopped half-way resumes, and checks every address and wiring after.
 */
contract DeployMamoruV4 is Script {
    address constant MODULE_REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;

    address public constant PINNED_DEPLOYER = 0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0;

    bytes32 public constant CHECK_SALT = keccak256("mamoru.v4.migration-check");
    bytes32 public constant TABLE_SALT = keccak256("mamoru.v4.table");
    uint96 public constant GAS_POLICY_NONCE = 7; // ModuleRegistry salts deployer ‖ nonce (V3 took 4; r2's V4 5 and 6)
    uint96 public constant POLICY_NONCE = 8;

    /// The addresses `predict()` gives for this source and compiler (identical on Base, Monad and Ethereum). A source
    /// or compiler change moves them: `run()` then refuses, and re-pinning is a deliberate commit.
    address public constant EXPECTED_TABLE = 0x89df2e7d14aE0225422cD125D458a31D26F89eC6;
    address public constant EXPECTED_GAS_POLICY = 0xbC532f4b0A1bb29c9565F590a351c924baD4f606;
    address public constant EXPECTED_POLICY = 0x74EB63d0dC4f7645BF06EA6011FED14e3BEeFe53;
    address public constant EXPECTED_CHECK = 0xc04046b4649471875372FA9e800143491cD4fB31;

    /// Selectors no V4 contract may carry (spec 010 I7, spec 009 POL-01): guardian, pause, review, readiness setter.
    function forbiddenSelectors() public pure returns (bytes4[] memory f) {
        f = new bytes4[](9);
        f[0] = bytes4(keccak256("GUARDIAN()"));
        f[1] = bytes4(keccak256("pause(address)"));
        f[2] = bytes4(keccak256("unpause(address)"));
        f[3] = bytes4(keccak256("review(address)"));
        f[4] = bytes4(keccak256("setReady(address,uint32,address)"));
        f[5] = bytes4(keccak256("clearReady(address,uint32)"));
        f[6] = bytes4(keccak256("isPaused(address)"));
        f[7] = bytes4(keccak256("REGISTRY()"));
        f[8] = bytes4(keccak256("cancel(uint8,bytes32,bytes,uint256)"));
    }

    /// True when `code` holds `PUSH4 sel` (how a dispatcher compares a selector): a forbidden function is present.
    function hasSelector(bytes memory code, bytes4 sel) public pure returns (bool) {
        for (uint256 i; i + 5 <= code.length; i++) {
            if (
                code[i] == 0x63 && code[i + 1] == sel[0] && code[i + 2] == sel[1] && code[i + 3] == sel[2]
                    && code[i + 4] == sel[3]
            ) return true;
        }
        return false;
    }

    struct Stack {
        address table;
        address gasPolicy;
        address policy;
        address check;
    }

    // ------------------------------------------------------------ addresses (pure functions of the init code)

    function gasPolicyInitCode(address table) public pure returns (bytes memory) {
        return abi.encodePacked(type(MamoruGasPolicyV2).creationCode, abi.encode(table));
    }

    function policyInitCode(address gasPolicy, address table) public pure returns (bytes memory) {
        return abi.encodePacked(type(MamoruActionPolicyV4).creationCode, abi.encode(gasPolicy, table));
    }

    function moduleSalt(uint96 nonce) public pure returns (bytes32) {
        return bytes32(abi.encodePacked(PINNED_DEPLOYER, nonce));
    }

    function _create2(address deployer, bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, keccak256(initCode))))));
    }

    function predict() public pure returns (Stack memory s) {
        s.table = _create2(CREATE2_DEPLOYER, TABLE_SALT, type(MamoruV4Table).creationCode);
        s.check = _create2(CREATE2_DEPLOYER, CHECK_SALT, type(MamoruMigrationCheck).creationCode);
        s.gasPolicy = _create2(MODULE_REGISTRY, moduleSalt(GAS_POLICY_NONCE), gasPolicyInitCode(s.table));
        s.policy = _create2(MODULE_REGISTRY, moduleSalt(POLICY_NONCE), policyInitCode(s.gasPolicy, s.table));
    }

    // ------------------------------------------------------------ deploy

    function run() external returns (Stack memory) {
        return _run(msg.sender);
    }

    function _run(address sender) internal returns (Stack memory s) {
        require(sender == PINNED_DEPLOYER, "DeployV4: not the pinned deployer");
        require(MamoruV4Chains.byChainId(block.chainid).chainId != 0, "DeployV4: chain outside V4's table");
        s = predict();
        require(
            s.table == EXPECTED_TABLE && s.gasPolicy == EXPECTED_GAS_POLICY && s.policy == EXPECTED_POLICY
                && s.check == EXPECTED_CHECK,
            "DeployV4: predicted addresses moved (source or compiler change): re-pin deliberately"
        );
        IModuleRegistry mr = IModuleRegistry(MODULE_REGISTRY);
        require(mr.calcModuleAddress(moduleSalt(GAS_POLICY_NONCE), gasPolicyInitCode(s.table)) == s.gasPolicy, "DeployV4: gas policy address");
        require(mr.calcModuleAddress(moduleSalt(POLICY_NONCE), policyInitCode(s.gasPolicy, s.table)) == s.policy, "DeployV4: policy address");
        bytes32 resolverUID = mr.findModule(SMART_SESSION).resolverUID;
        require(resolverUID != bytes32(0), "DeployV4: no resolver");

        vm.startBroadcast(sender);
        if (s.table.code.length == 0) _viaDeterministic(TABLE_SALT, type(MamoruV4Table).creationCode);
        if (s.check.code.length == 0) _viaDeterministic(CHECK_SALT, type(MamoruMigrationCheck).creationCode);
        if (s.gasPolicy.code.length == 0) mr.deployModule(moduleSalt(GAS_POLICY_NONCE), resolverUID, gasPolicyInitCode(s.table), "", "");
        if (s.policy.code.length == 0) mr.deployModule(moduleSalt(POLICY_NONCE), resolverUID, policyInitCode(s.gasPolicy, s.table), "", "");
        vm.stopBroadcast();
        check(s);
        console2.log("MamoruV4Table         ", s.table);
        console2.log("MamoruGasPolicyV2     ", s.gasPolicy);
        console2.log("MamoruActionPolicyV4  ", s.policy);
        console2.log("MamoruV4Helper        ", address(MamoruActionPolicyV4(s.policy).HELPER()));
        console2.log("MamoruRemoteInit      ", address(MamoruActionPolicyV4(s.policy).REMOTE_INIT()));
        console2.log("MamoruMigrationCheck  ", s.check);
    }

    function _viaDeterministic(bytes32 salt, bytes memory initCode) internal {
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok, "DeployV4: deterministic deployer");
    }

    /// Every address has code, the wiring is the one predicted, and no contract carries a forbidden selector (after
    /// `run`, or alone to audit a chain).
    function check(Stack memory s) public view {
        MamoruActionPolicyV4 p = MamoruActionPolicyV4(s.policy);
        require(address(p.GAS_POLICY()) == s.gasPolicy, "policy gas");
        require(address(p.TABLE()) == s.table && address(MamoruGasPolicyV2(s.gasPolicy).TABLE()) == s.table, "table");
        require(IMamoruV4Table(s.table).chain(block.chainid).chainId == block.chainid, "this chain is in the table");
        p.HELPER().checkStack(); // the pinned Safe stack and CCTP have the expected code on this chain
        require(s.check.code.length != 0, "migration check");
        address[5] memory all = [s.policy, s.gasPolicy, address(p.HELPER()), address(p.REMOTE_INIT()), s.table];
        bytes4[] memory f = forbiddenSelectors();
        for (uint256 i; i < all.length; i++) {
            require(all[i].code.length != 0, "no code");
            for (uint256 k; k < f.length; k++) {
                require(!hasSelector(all[i].code, f[k]), "DeployV4: a guardian, pause or admin selector in the bytecode");
            }
        }
        IModuleRegistry mr = IModuleRegistry(MODULE_REGISTRY);
        require(mr.findModule(s.policy).sender == PINNED_DEPLOYER, "ModuleRecord policy");
        require(mr.findModule(s.gasPolicy).sender == PINNED_DEPLOYER, "ModuleRecord gas policy");
    }
}
