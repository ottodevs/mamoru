// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {ConfigIdV4, PackedUserOperationV4} from "./SmartSessionTypes.sol";
import {MamoruV4Chains} from "./MamoruV4Chains.sol";
import {IMamoruV4Table} from "./MamoruV4Table.sol";

/**
 * @title MamoruGasPolicyV2 (spec 010 I6 and I9, A1; otto/mamoru#317). Not deployed.
 * @notice The only userOp policy of a Mamoru V4 session. No owner, no guardian, no setter: nothing about it changes
 * after deployment, and no key can reset or widen what it allows (spec 010 I7).
 *
 * Per op, it does three things:
 *
 * 1. Caps every gas field (T6 L-1, T7): priority fee, max fee, verification, call, preVerification and the paymaster's
 *    two limits, so one op can cost the account at most its prefund at the capped price and limits.
 *
 * 2. Rates the account's gas spend without reading the clock (A1; ERC-7562 bans TIMESTAMP in validation). Every session
 *    batch starts with `V4.clock(T)`: this policy decodes T from the userOp's own calldata and returns
 *    `validAfter = T - S`, `validUntil = T + S` in its validation data, so the EntryPoint admits the op only while the
 *    real time is within S of T (SmartSession intersects the validation data of every policy). With that claimed time it
 *    runs a GCRA rate per account: each op costs `c = (the five gas limits) x maxFeePerGas`, the most the EntryPoint v0.7
 *    can take from the account for it, charged at validation;
 *        newTat = max(tat, T) + ceil(c x W / G)
 *    and the op is refused when `newTat - T > W`. G and W are the chain's (MamoruV4Chains). So the account pays at most
 *    G per W plus a burst of G (and S / W of G for the slack), reverting ops included, and an idle account comes back
 *    with at most that burst: nothing to reset, no reviewer (spec 010 A1 replaces GAS_REVIEW). Every op of a bundle is
 *    validated before any executes and each advances `tat`, so a bundle of many ops is bounded like a sequence.
 *
 * 3. Checks the shape of the whole batch, statelessly, which an action policy cannot (it sees one call at a time):
 *    `execute` in batch mode with the default exec type and no mode payload; a first call `clock(T)` with no value and
 *    at least one call after it (no action-free userOp); every position-manager `decreaseLiquidity` immediately preceded
 *    by `checkExit` with the same tokenId, liquidity and minimums (I9: the price check of an exit runs at execution); and
 *    every non-zero `approve` followed later in the batch by its reset `approve(spender, 0)` on the same token, itself
 *    immediately followed by `assertZero(token)` (spec 009 POL-07). Nothing is carried between calls or ops in storage.
 *    Which contract each call reaches is MamoruActionPolicyV4's `checkAction` (clock, checkExit and assertZero only on
 *    V4 itself, approvals only to V4), so this policy needs no address but the chain's position manager.
 *
 * Storage: per-op caps per (ConfigId, account), written only by SmartSession from an owner-authorized enable; `tat` per
 * account. Every mapping has the account as its LAST key, so each slot is `keccak(account || x)`: storage associated
 * with the sender under ERC-7562. The only external call is a pure read of the table contract (code, no storage); no
 * TIMESTAMP, no NUMBER. No owner, no setter: the table address is a constructor argument, the same on every chain.
 */
contract MamoruGasPolicyV2 {
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;

    address public constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    /// S: the slack around the claimed time, a few minutes, well under W / 2 (MamoruActionPolicyV4.CLOCK_SLACK).
    uint256 public constant CLOCK_SLACK = 5 minutes;

    bytes4 internal constant EXECUTE = 0xe9ae5c53; // IERC7579Account.execute(bytes32,bytes)
    bytes32 internal constant MODE_BATCH = bytes32(uint256(1) << 248); // callType 0x01, execType 0x00, no selector/payload
    bytes4 internal constant CLOCK = bytes4(keccak256("clock(uint256)"));
    bytes4 internal constant CHECK_EXIT = bytes4(keccak256("checkExit(uint256,uint128,uint256,uint256)"));
    bytes4 internal constant ASSERT_ZERO = bytes4(keccak256("assertZero(address)"));
    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant DECREASE = 0x0c49ccbe; // decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))

    /// MamoruGasPolicy's Caps, then the paymaster's two limits together (MamoruV4Chains.GasCaps, same field order).
    struct Caps {
        uint64 maxPriorityFeePerGas;
        uint32 maxVerificationGasLimit;
        uint32 maxCallGasLimit;
        uint32 maxPreVerificationGas;
        uint64 maxFeePerGas;
        uint32 maxPaymasterGas;
    }

    /// ERC-7579 Execution, as Safe7579 decodes a batch.
    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    /// The per-chain table (MamoruV4Table, CREATE2): G, W and the position manager. Pure code reads (ERC-7562-safe).
    IMamoruV4Table public immutable TABLE;

    mapping(ConfigIdV4 => mapping(address account => Caps)) internal _caps;
    /// GCRA theoretical arrival time per account, in seconds of claimed time.
    mapping(address account => uint256) public tatOf;

    event PolicySet(ConfigIdV4 id, address multiplexer, address account);

    error PolicyNotInitialized(ConfigIdV4 id, address multiplexer, address account);
    error BadInit(uint256 field);
    error OnlySmartSession();

    constructor(IMamoruV4Table table) {
        TABLE = table;
    }

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        return interfaceID == 0x01ffc9a7 // IERC165
            || interfaceID == this.checkUserOpPolicy.selector // smartsessions IUserOpPolicy
            || interfaceID == this.initializeWithMultiplexer.selector; // smartsessions IPolicy
    }

    function initializeWithMultiplexer(address account, ConfigIdV4 configId, bytes calldata initData) external {
        if (msg.sender != SMART_SESSION) revert OnlySmartSession();
        Caps memory c = abi.decode(initData, (Caps));
        if (c.maxPriorityFeePerGas == 0 || c.maxVerificationGasLimit == 0 || c.maxCallGasLimit == 0) revert BadInit(1);
        if (c.maxPreVerificationGas == 0 || c.maxFeePerGas < c.maxPriorityFeePerGas) revert BadInit(2);
        _caps[configId][account] = c;
        emit PolicySet(configId, msg.sender, account);
    }

    function checkUserOpPolicy(ConfigIdV4 id, PackedUserOperationV4 calldata op) external returns (uint256) {
        if (msg.sender != SMART_SESSION) return VALIDATION_FAILED; // nobody else may advance an account's rate
        Caps memory c = _caps[id][op.sender];
        if (c.maxVerificationGasLimit == 0) revert PolicyNotInitialized(id, msg.sender, op.sender);
        MamoruV4Chains.Chain memory ch = TABLE.chain(block.chainid);
        if (ch.gasPerWindow == 0) return VALIDATION_FAILED; // a chain outside the table: fail closed
        uint256 cost = _cost(c, op);
        if (cost == 0) return VALIDATION_FAILED;
        (bool ok, uint256 t) = _shape(op.callData, ch.npm);
        if (!ok) return VALIDATION_FAILED;
        // GCRA on the claimed time t (the EntryPoint enforces |now - t| <= S through the returned range).
        uint256 tat = tatOf[op.sender];
        uint256 newTat = (tat > t ? tat : t) + (cost * ch.gasWindow + ch.gasPerWindow - 1) / ch.gasPerWindow;
        if (newTat - t > ch.gasWindow) return VALIDATION_FAILED; // over the rate: refused, nothing written
        tatOf[op.sender] = newTat;
        // ERC-4337 validation data: aggregator 0 | validUntil << 160 | validAfter << 208.
        return ((t + CLOCK_SLACK) << 160) | ((t - CLOCK_SLACK) << 208);
    }

    // ---------------------------------------------------------------- views

    function capsOf(address account, ConfigIdV4 id) external view returns (Caps memory) {
        return _caps[id][account];
    }

    /// Wei the account can still spend right now at claimed time `t` before the rate refuses (the GCRA's room).
    function gasLeft(address account, uint256 t) external view returns (uint256) {
        MamoruV4Chains.Chain memory ch = TABLE.chain(block.chainid);
        uint256 tat = tatOf[account];
        uint256 used = tat > t ? tat - t : 0;
        if (used >= ch.gasWindow) return 0;
        return (ch.gasWindow - used) * ch.gasPerWindow / ch.gasWindow;
    }

    /// The largest charge one op under `c` can make (its prefund at the capped price and limits).
    function maxCostPerOp(Caps memory c) public pure returns (uint256) {
        return uint256(c.maxFeePerGas)
            * (uint256(c.maxVerificationGasLimit) + c.maxCallGasLimit + c.maxPreVerificationGas + c.maxPaymasterGas);
    }

    // ---------------------------------------------------------------- internals

    /// The op's prefund (the most the EntryPoint v0.7 can take for it), 0 when a field passes its cap.
    function _cost(Caps memory c, PackedUserOperationV4 calldata op) internal pure returns (uint256) {
        uint256 verificationGasLimit = uint256(op.accountGasLimits) >> 128;
        uint256 callGasLimit = uint128(uint256(op.accountGasLimits));
        uint256 maxPriorityFeePerGas = uint256(op.gasFees) >> 128;
        uint256 maxFeePerGas = uint128(uint256(op.gasFees));
        uint256 pmGas;
        if (op.paymasterAndData.length != 0) {
            // EntryPoint v0.7: paymaster (20) | paymasterVerificationGasLimit (16) | paymasterPostOpGasLimit (16) | data
            if (op.paymasterAndData.length < 52) return 0;
            pmGas = uint256(uint128(bytes16(op.paymasterAndData[20:36]))) + uint256(uint128(bytes16(op.paymasterAndData[36:52])));
        }
        if (
            maxPriorityFeePerGas > c.maxPriorityFeePerGas || maxFeePerGas > c.maxFeePerGas || maxFeePerGas == 0
                || verificationGasLimit > c.maxVerificationGasLimit || callGasLimit > c.maxCallGasLimit
                || op.preVerificationGas > c.maxPreVerificationGas || pmGas > c.maxPaymasterGas
        ) return 0;
        return (callGasLimit + verificationGasLimit + op.preVerificationGas + pmGas) * maxFeePerGas;
    }

    /// I9: the batch shape (see the contract notice). Returns the claimed time of the leading `clock`.
    function _shape(bytes calldata callData, address npm) internal pure returns (bool, uint256 t) {
        if (callData.length < 68 || bytes4(callData[:4]) != EXECUTE) return (false, 0);
        (bytes32 mode, bytes memory batch) = abi.decode(callData[4:], (bytes32, bytes));
        if (mode != MODE_BATCH) return (false, 0);
        Execution[] memory xs = abi.decode(batch, (Execution[]));
        uint256 n = xs.length;
        if (n < 2) return (false, 0); // no empty and no action-free batch
        bytes memory d = xs[0].callData;
        if (xs[0].value != 0 || d.length != 36 || bytes4(d) != CLOCK) return (false, 0);
        t = uint256(_word(d, 4));
        if (t <= CLOCK_SLACK || t > type(uint48).max - CLOCK_SLACK) return (false, 0);
        for (uint256 i = 1; i < n; i++) {
            d = xs[i].callData;
            if (d.length < 4) continue; // the action policy refuses it
            bytes4 sel = bytes4(d);
            if (sel == DECREASE && xs[i].target == npm) {
                if (!_exitChecked(xs[i - 1].callData, d)) return (false, 0);
            } else if (sel == APPROVE && d.length == 68 && _word(d, 36) != bytes32(0)) {
                if (!_resetAfter(xs, i)) return (false, 0);
            }
        }
        return (true, t);
    }

    /// `prev` is `checkExit(tokenId, liquidity, amount0Min, amount1Min)` with the decrease's own arguments.
    function _exitChecked(bytes memory prev, bytes memory dec) internal pure returns (bool) {
        if (prev.length != 132 || bytes4(prev) != CHECK_EXIT || dec.length != 164) return false;
        for (uint256 o = 4; o < 132; o += 32) {
            if (_word(prev, o) != _word(dec, o)) return false;
        }
        return true;
    }

    /// The approve at `i` is reset later (`approve(spender, 0)` on the same token) and the reset is immediately
    /// followed by `assertZero(token)`.
    function _resetAfter(Execution[] memory xs, uint256 i) internal pure returns (bool) {
        address token = xs[i].target;
        bytes32 spender = _word(xs[i].callData, 4);
        bytes32 reset = keccak256(abi.encodeWithSelector(APPROVE, spender, uint256(0)));
        bytes32 assert0 = keccak256(abi.encodeWithSelector(ASSERT_ZERO, token));
        for (uint256 j = i + 1; j + 1 < xs.length; j++) {
            if (xs[j].target == token && keccak256(xs[j].callData) == reset && keccak256(xs[j + 1].callData) == assert0) {
                return true;
            }
        }
        return false;
    }

    function _word(bytes memory b, uint256 o) internal pure returns (bytes32 w) {
        assembly {
            w := mload(add(add(b, 32), o))
        }
    }
}
