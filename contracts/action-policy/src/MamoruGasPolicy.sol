// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {ConfigId} from "./MamoruActionPolicy.sol";

/// ERC-4337 v0.7 PackedUserOperation.
struct PackedUserOperation {
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

/**
 * @title MamoruGasPolicy (spec 007, T6 L-1; T7 adds the maxFeePerGas cap). Not deployed.
 * @notice A SmartSession USEROP policy that caps what a session key can make the account pay a bundler. Without it a
 * leaked key signs a valid op with a huge `maxPriorityFeePerGas` / `maxFeePerGas` / `preVerificationGas`, bundles it
 * itself with `beneficiary = attacker` at a low `tx.gasprice`, and keeps the difference (audit L-1).
 *
 * Why every price and gas field is capped (T7, GPT-6 review of #97, P1 4): the EntryPoint (v0.7) charges
 *   actualGas x gasPrice, gasPrice = maxFeePerGas                                   if maxFeePerGas == maxPriorityFeePerGas
 *                                  = min(maxFeePerGas, basefee + maxPriorityFeePerGas) otherwise,
 * and takes a prefund of maxFeePerGas x (verificationGasLimit + callGasLimit + preVerificationGas) from the account
 * (no paymaster: `permitERC4337Paymaster` is false on every Mamoru grant). With the priority fee capped but not
 * `maxFeePerGas`, the price was bounded only by basefee + cap (Base's basefee is not the account's to choose), and the
 * prefund was not bounded at all: an op with a huge `maxFeePerGas` moves up to the Safe's whole ETH into its EntryPoint
 * deposit, where only an owner `withdrawTo` gets it back. Capping `maxFeePerGas` bounds both, whatever the basefee:
 *   what one op can take from the Safe <= maxFeePerGas_cap x (maxVerificationGasLimit + maxCallGasLimit + maxPreVerificationGas)
 * (actual gas, the 10% unused-gas penalty and preVerificationGas are all inside those limits). The session's
 * UsageLimitPolicy bounds the number of ops, and the native ETH the Safe holds bounds the whole.
 *
 * Storage is per (ConfigId, multiplexer, account), like UniActionPolicy: no account-level state, so any caller of
 * `initializeWithMultiplexer` only writes its own slot.
 */
contract MamoruGasPolicy {
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;

    struct Caps {
        uint64 maxPriorityFeePerGas; // wei
        uint32 maxVerificationGasLimit;
        uint32 maxCallGasLimit;
        uint32 maxPreVerificationGas;
        uint64 maxFeePerGas; // wei; T7 (appended, so the first four fields keep their ABI offsets)
    }

    mapping(ConfigId => mapping(address multiplexer => mapping(address account => Caps))) internal _caps;

    event PolicySet(ConfigId id, address multiplexer, address account);

    error PolicyNotInitialized(ConfigId id, address multiplexer, address account);
    error BadInit();

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        return interfaceID == 0x01ffc9a7 // IERC165
            || interfaceID == this.checkUserOpPolicy.selector // smartsessions IUserOpPolicy
            || interfaceID == this.initializeWithMultiplexer.selector; // smartsessions IPolicy
    }

    function initializeWithMultiplexer(address account, ConfigId configId, bytes calldata initData) external {
        Caps memory c = abi.decode(initData, (Caps));
        if (
            c.maxPriorityFeePerGas == 0 || c.maxVerificationGasLimit == 0 || c.maxCallGasLimit == 0
                || c.maxPreVerificationGas == 0 || c.maxFeePerGas < c.maxPriorityFeePerGas
        ) revert BadInit();
        _caps[configId][msg.sender][account] = c;
        emit PolicySet(configId, msg.sender, account);
    }

    function checkUserOpPolicy(ConfigId id, PackedUserOperation calldata op) external view returns (uint256) {
        Caps memory c = _caps[id][msg.sender][op.sender];
        if (c.maxVerificationGasLimit == 0) revert PolicyNotInitialized(id, msg.sender, op.sender);
        uint256 verificationGasLimit = uint256(op.accountGasLimits) >> 128;
        uint256 callGasLimit = uint128(uint256(op.accountGasLimits));
        uint256 maxPriorityFeePerGas = uint256(op.gasFees) >> 128;
        uint256 maxFeePerGas = uint128(uint256(op.gasFees));
        if (
            maxPriorityFeePerGas > c.maxPriorityFeePerGas || maxFeePerGas > c.maxFeePerGas
                || verificationGasLimit > c.maxVerificationGasLimit
                || callGasLimit > c.maxCallGasLimit || op.preVerificationGas > c.maxPreVerificationGas
        ) return VALIDATION_FAILED;
        return VALIDATION_SUCCESS;
    }

    /// The most one op under `c` can make the account pay (wei): the EntryPoint prefund at the capped price and limits.
    function maxCostPerOp(Caps memory c) public pure returns (uint256) {
        return uint256(c.maxFeePerGas)
            * (uint256(c.maxVerificationGasLimit) + uint256(c.maxCallGasLimit) + uint256(c.maxPreVerificationGas));
    }

    function capsOf(ConfigId id, address multiplexer, address account) external view returns (Caps memory) {
        return _caps[id][multiplexer][account];
    }
}
