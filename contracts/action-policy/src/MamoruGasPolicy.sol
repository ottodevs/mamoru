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
 * @title MamoruGasPolicy (spec 007, T6 L-1). Not deployed; wiring into the session grants is T7.
 * @notice A SmartSession USEROP policy that caps what a session key can make the account pay a bundler. Without it a
 * leaked key signs a valid op with a huge `maxPriorityFeePerGas` / `preVerificationGas`, bundles it itself with
 * `beneficiary = attacker` at a low `tx.gasprice`, and keeps the difference (audit L-1).
 *
 * Why caps on the priority fee and the gas limits are enough (and `maxFeePerGas` needs none): the EntryPoint charges
 * gasUsed x min(maxFeePerGas, basefee + maxPriorityFeePerGas), and the bundler's own transaction pays at least basefee
 * per gas it burns. What the beneficiary can keep per op is therefore at most
 *   maxPriorityFeePerGas x (gas charged) + gasPrice x (preVerificationGas + the 10% unused-gas penalty),
 * the last two being gas the op is charged for without burning it. Caps on those four fields bound it per op; the
 * session's UsageLimitPolicy bounds the number of ops. A large `maxFeePerGas` only raises the prefund, which is
 * refunded.
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
        if (c.maxPriorityFeePerGas == 0 || c.maxVerificationGasLimit == 0 || c.maxCallGasLimit == 0) revert BadInit();
        _caps[configId][msg.sender][account] = c;
        emit PolicySet(configId, msg.sender, account);
    }

    function checkUserOpPolicy(ConfigId id, PackedUserOperation calldata op) external view returns (uint256) {
        Caps memory c = _caps[id][msg.sender][op.sender];
        if (c.maxVerificationGasLimit == 0) revert PolicyNotInitialized(id, msg.sender, op.sender);
        uint256 verificationGasLimit = uint256(op.accountGasLimits) >> 128;
        uint256 callGasLimit = uint128(uint256(op.accountGasLimits));
        uint256 maxPriorityFeePerGas = uint256(op.gasFees) >> 128;
        if (
            maxPriorityFeePerGas > c.maxPriorityFeePerGas || verificationGasLimit > c.maxVerificationGasLimit
                || callGasLimit > c.maxCallGasLimit || op.preVerificationGas > c.maxPreVerificationGas
        ) return VALIDATION_FAILED;
        return VALIDATION_SUCCESS;
    }

    function capsOf(ConfigId id, address multiplexer, address account) external view returns (Caps memory) {
        return _caps[id][multiplexer][account];
    }
}
