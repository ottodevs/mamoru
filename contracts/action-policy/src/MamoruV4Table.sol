// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {MamoruV4Chains} from "./MamoruV4Chains.sol";
import {MamoruV4Classes} from "./MamoruV4Classes.sol";

/// What MamoruActionPolicyV4, its helper and MamoruGasPolicyV2 read of the per-chain table.
interface IMamoruV4Table {
    function chain(uint256 chainId) external pure returns (MamoruV4Chains.Chain memory);
    function chainOf(uint32 domain) external pure returns (uint256);
    function classOf(uint256 chainId, address a, address b) external pure returns (MamoruV4Classes.Class memory);
    function vaultOf(uint256 chainId, address vault) external pure returns (MamoruV4Classes.Vault memory);
    function pairsOf(uint256 chainId) external pure returns (address[2][] memory);
    function vaultsOf(uint256 chainId) external pure returns (address[] memory);
}

/**
 * @title MamoruV4Table (spec 010 A1, otto/mamoru#316): the per-chain table as its own data contract.
 * @notice Pure data, no state, no owner, no constructor argument: every chain's row (MamoruV4Chains), pool classes,
 * reference pools and the exact vault list (MamoruV4Classes), keyed by `block.chainid` or CCTP domain. It is deployed
 * with CREATE2 through the canonical deterministic deployer, so the same table has the same address on every chain,
 * and MamoruActionPolicyV4 and MamoruGasPolicyV2 take that address as a constructor argument.
 *
 * Why a separate contract: adding a chain (or a token, a vault, a class) changes only this data. The policy and gas
 * policy code stay byte for byte the same; only their constructor argument moves, so their addresses move and the owner
 * adopts the new version with one opt-in signature (spec 010 I8). See contracts/action-policy/ADD-A-CHAIN.md.
 */
contract MamoruV4Table is IMamoruV4Table {
    function chain(uint256 chainId) external pure returns (MamoruV4Chains.Chain memory) {
        return MamoruV4Chains.byChainId(chainId);
    }

    function chainOf(uint32 domain) external pure returns (uint256) {
        return MamoruV4Chains.chainOf(domain);
    }

    function classOf(uint256 chainId, address a, address b) external pure returns (MamoruV4Classes.Class memory) {
        return MamoruV4Classes.classOf(chainId, a, b);
    }

    function vaultOf(uint256 chainId, address vault) external pure returns (MamoruV4Classes.Vault memory) {
        return MamoruV4Classes.vaultOf(chainId, vault);
    }

    function pairsOf(uint256 chainId) external pure returns (address[2][] memory) {
        return MamoruV4Classes.pairsOf(chainId);
    }

    function vaultsOf(uint256 chainId) external pure returns (address[] memory) {
        return MamoruV4Classes.vaultsOf(chainId);
    }
}
