// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/// SmartSession's types (erc7579/smartsessions DataTypes.sol, Sourcify exact match on Base for
/// 0x00000000002B0eCfbD0496EE71e01257dA0E37DE), as MamoruActionPolicyV4 encodes them for a remote Safe's setup
/// (spec 010 I4). Field order is the ABI: do not reorder.

/// SmartSession's policy id type. Every Mamoru policy file declares its own (importing one would pull in its compiler
/// profile, foundry.toml); they are the same bytes32.
type ConfigIdV4 is bytes32;

struct PolicyData {
    address policy;
    bytes initData;
}

struct ERC7739Context {
    bytes32 appDomainSeparator;
    string[] contentName;
}

struct ERC7739Data {
    ERC7739Context[] allowedERC7739Content;
    PolicyData[] erc1271Policies;
}

struct ActionData {
    bytes4 actionTargetSelector;
    address actionTarget;
    PolicyData[] actionPolicies;
}

struct Session {
    address sessionValidator;
    bytes sessionValidatorInitData;
    bytes32 salt;
    PolicyData[] userOpPolicies;
    ERC7739Data erc7739Policies;
    ActionData[] actions;
    bool permitERC4337Paymaster;
}

/// ERC-4337 v0.7 PackedUserOperation.
struct PackedUserOperationV4 {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits; // verificationGasLimit (high 128) | callGasLimit (low 128)
    uint256 preVerificationGas;
    bytes32 gasFees; // maxPriorityFeePerGas (high 128) | maxFeePerGas (low 128)
    bytes paymasterAndData;
    bytes signature;
}
