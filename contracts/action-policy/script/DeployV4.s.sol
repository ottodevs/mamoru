// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MamoruActionPolicyV4} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruMigrationCheck} from "../src/MamoruMigrationCheck.sol";
import {MamoruV4Table, IMamoruV4Table} from "../src/MamoruV4Table.sol";
import {MamoruV4Chains} from "../src/MamoruV4Chains.sol";
import {MamoruV4Classes} from "../src/MamoruV4Classes.sol";
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
 *
 * After every broadcast, on EACH chain, run `verify()` against that chain's LIVE RPC (#345 P2-3), not a fork:
 *
 *   forge script script/DeployV4.s.sol --sig "verify()" --rpc-url <chain>
 *
 * `run()`'s own `check` runs inside forge's simulation, and DeployV4Fork.t.sol on a fork: neither proves what the chain
 * holds after the transactions landed (a reorg, a dropped transaction, a resumed run on another RPC). `verify()` is
 * `check(predict())` with the pinned addresses, read from the chain itself. Nothing is announced or adopted on a chain
 * until it passes there.
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
    address public constant EXPECTED_TABLE = 0xDa201a0A72660e885b5314C1b889255bcE78a4eD;
    address public constant EXPECTED_GAS_POLICY = 0x16d11189D987E123a7317b5786F1B20a84dFd28A;
    address public constant EXPECTED_POLICY = 0x360FC1f2A0C37E63bfCF772a7efA93D198e2a8C1;
    address public constant EXPECTED_CHECK = 0xc04046b4649471875372FA9e800143491cD4fB31;

    /// Selectors no V4 contract may carry (spec 010 I7, spec 009 POL-01): guardian, pause, review, readiness setter.
    function forbiddenSelectors() public pure returns (bytes4[] memory f) {
        f = new bytes4[](10);
        f[0] = bytes4(keccak256("GUARDIAN()"));
        f[1] = bytes4(keccak256("pause(address)"));
        f[2] = bytes4(keccak256("unpause(address)"));
        f[3] = bytes4(keccak256("review(address)"));
        f[4] = bytes4(keccak256("setReady(address,uint32,address)"));
        f[5] = bytes4(keccak256("clearReady(address,uint32)"));
        f[6] = bytes4(keccak256("isPaused(address)"));
        f[7] = bytes4(keccak256("REGISTRY()"));
        f[8] = bytes4(keccak256("cancel(uint8,bytes32,bytes,uint256)"));
        f[9] = bytes4(keccak256("cancel(bytes32)")); // MamoruRegistry r2's cancel
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

    /// #345 P2-3: the post-broadcast audit of one chain, read-only. Run it against each chain's live RPC (contract
    /// notice). Reverts unless the pinned addresses are the predicted ones and `check` passes on this chain now.
    function verify() external view returns (Stack memory s) {
        require(MamoruV4Chains.byChainId(block.chainid).chainId != 0, "DeployV4: chain outside V4's table");
        s = predict();
        require(
            s.table == EXPECTED_TABLE && s.gasPolicy == EXPECTED_GAS_POLICY && s.policy == EXPECTED_POLICY
                && s.check == EXPECTED_CHECK,
            "DeployV4: predicted addresses moved (source or compiler change): re-pin deliberately"
        );
        check(s);
    }

    function _viaDeterministic(bytes32 salt, bytes memory initCode) internal {
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok, "DeployV4: deterministic deployer");
    }

    /// Spec 010 "Hard bounds": every class and vault of this chain's table is inside V4's hard bounds (V3's), its
    /// tokens are pinned with a stable side, its reference pool is a pool of the pinned factory for that pair, and each
    /// listed vault's asset() is its pinned stable. A row outside them stays until a new version: refused here first.
    function checkTable(IMamoruV4Table t, MamoruActionPolicyV4 p) public view {
        MamoruV4Chains.Chain memory ch = t.chain(block.chainid);
        require(ch.cctpFeeCapBps <= p.MAX_CCTP_FEE_CAP_BPS(), "table: CCTP fee cap"); // #345 P2-5
        address[2][] memory pairs = t.pairsOf(block.chainid);
        for (uint256 i; i < pairs.length; i++) {
            MamoruV4Classes.Class memory c = t.classOf(block.chainid, pairs[i][0], pairs[i][1]);
            require(c.ref != address(0), "table: a listed pair without a class");
            require(MamoruV4Chains.isPinned(ch, pairs[i][0]) && MamoruV4Chains.isPinned(ch, pairs[i][1]), "table: pinned tokens");
            require(MamoruV4Chains.isStable(ch, pairs[i][0]) || MamoruV4Chains.isStable(ch, pairs[i][1]), "table: a stable side");
            require(c.twapWindow >= p.MIN_TWAP_WINDOW() && c.twapWindow <= p.MAX_TWAP_WINDOW(), "table: long window");
            require(c.twapShortWindow >= p.MIN_SHORT_WINDOW(), "table: short window");
            require(uint256(c.twapShortWindow) * p.MIN_WINDOW_RATIO() <= c.twapWindow, "table: LeftClaw M-1");
            require(c.bandTicks >= p.MIN_BAND() && c.bandTicks <= p.MAX_BAND() && c.anchorBand <= p.MAX_BAND(), "table: band");
            require(c.ratioBps != 0 && c.ratioBps <= p.MAX_RATIO_BPS() && c.feeMask != 0, "table: ratio, fee set");
            (address a, address b) = pairs[i][0] < pairs[i][1] ? (pairs[i][0], pairs[i][1]) : (pairs[i][1], pairs[i][0]);
            (bool ok, bytes memory r) = c.ref.staticcall(abi.encodeWithSignature("fee()"));
            require(ok, "table: reference pool");
            (bool ok2, bytes memory got) = ch.factory.staticcall(
                abi.encodeWithSignature("getPool(address,address,uint24)", a, b, abi.decode(r, (uint24)))
            );
            require(ok2 && abi.decode(got, (address)) == c.ref, "table: reference pool not the factory's");
            require(MamoruV4Classes.feeBit(abi.decode(r, (uint24))) & c.feeMask != 0, "table: reference pool's fee outside the set");
            p.HELPER().priced(c.ref); // the reference pool itself is eligible here now: ring, window, class
        }
        address[] memory vaults = t.vaultsOf(block.chainid);
        for (uint256 i; i < vaults.length; i++) {
            MamoruV4Classes.Vault memory v = t.vaultOf(block.chainid, vaults[i]);
            require(v.asset != address(0) && v.ratioBps != 0 && v.ratioBps <= p.MAX_VAULT_RATIO_BPS(), "table: vault ratio");
            require(MamoruV4Chains.isStable(ch, v.asset), "table: vault asset");
            (bool ok, bytes memory r) = vaults[i].staticcall(abi.encodeWithSignature("asset()"));
            require(ok && abi.decode(r, (address)) == v.asset, "table: vault asset() on chain");
        }
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
        address[6] memory all = [s.policy, s.gasPolicy, address(p.HELPER()), address(p.REMOTE_INIT()), s.table, s.check];
        bytes4[] memory f = forbiddenSelectors();
        for (uint256 i; i < all.length; i++) {
            require(all[i].code.length != 0, "no code");
            for (uint256 k; k < f.length; k++) {
                require(!hasSelector(all[i].code, f[k]), "DeployV4: a guardian, pause or admin selector in the bytecode");
            }
        }
        checkTable(IMamoruV4Table(s.table), p);
        IModuleRegistry mr = IModuleRegistry(MODULE_REGISTRY);
        require(mr.findModule(s.policy).sender == PINNED_DEPLOYER, "ModuleRecord policy");
        require(mr.findModule(s.gasPolicy).sender == PINNED_DEPLOYER, "ModuleRecord gas policy");
    }
}
