// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {ConfigIdV4, PackedUserOperationV4} from "./SmartSessionTypes.sol";
import {MamoruV4Chains} from "./MamoruV4Chains.sol";

/**
 * @title MamoruGasPolicyV2 (spec 010 I6, otto/mamoru#292). Not deployed.
 * @notice The only userOp policy of a Mamoru V4 session. MamoruGasPolicy's per-op caps (T6 L-1, T7: priority fee, max
 * fee, every gas limit) plus a per-account GAS BUCKET per window and a cumulative GAS_REVIEW threshold, so a leaked
 * session key cannot drain the Safe's gas reserve with valid no-op or tiny userOps (r1 P1-6, r4 P1).
 *
 * SmartSession calls a userOp policy only at validation and has no settlement callback (r5 P1), so the policy cannot
 * see the gas an op actually paid. It charges each op CONSERVATIVELY at validation, from its capped fields: the most the
 * EntryPoint v0.7 can take from the account for it,
 *   (callGasLimit + verificationGasLimit + preVerificationGas + paymasterVerificationGasLimit + paymasterPostOpGasLimit)
 *   x maxFeePerGas
 * (the prefund; actual gas, the 10 % unused-gas penalty and preVerificationGas are all inside it). An op that would
 * cross the bucket or the threshold is REJECTED (VALIDATION_FAILED, nothing written), so the charged total never passes
 * either. The charge is written at validation: an op that validates and then fails or reverts in execution keeps it
 * (conservative). A bundle that reverts as a whole reverts the charge with it, but then nothing was paid either.
 *
 * GAS_REVIEW is pinned per chain (MamoruV4Chains: 0.01 ETH on Base, 5 MON on Monad; any other chain 0, so every op is
 * refused: fail closed). Once the charges since the guardian's last `review(account)` would pass it, every op of the
 * account is refused until the guardian reviews it: a slow drain stops at GAS_REVIEW per chain. The guardian cannot
 * spend, enable or widen anything; it only resets the counter.
 *
 * State: per-op caps and bucket parameters per (ConfigId, account), written only by SmartSession from an
 * owner-authorized enable (`initializeWithMultiplexer`); the bucket and the counter per ACCOUNT, so two sessions of one
 * account share them. Both are written only by SmartSession (V1 let any caller write its own multiplexer slot; V2's
 * account-level state forbids that, as MamoruActionPolicyV3 does). Every mapping has the account as its LAST key, so
 * each slot is `keccak(account || x) + n`: storage associated with the sender under ERC-7562.
 */
contract MamoruGasPolicyV2 {
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;
    uint32 public constant MIN_WINDOW = 1 hours;

    address public constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    /// Revoke-only watchdog key (the same as MamoruActionPolicyV4's): `review` only.
    address public immutable GUARDIAN;

    /// MamoruGasPolicy's Caps, then the paymaster's two limits together, the bucket per window (wei) and the window.
    struct Caps {
        uint64 maxPriorityFeePerGas;
        uint32 maxVerificationGasLimit;
        uint32 maxCallGasLimit;
        uint32 maxPreVerificationGas;
        uint64 maxFeePerGas;
        uint32 maxPaymasterGas;
        uint128 perWindow;
        uint32 window;
    }

    struct Bucket {
        uint128 debt; // wei charged and not yet refilled
        uint64 updatedAt;
    }

    mapping(ConfigIdV4 => mapping(address account => Caps)) internal _caps;
    mapping(address account => Bucket) internal _bucket;
    /// Wei charged since the guardian's last review (I6 GAS_REVIEW).
    mapping(address account => uint256) public chargedSinceReview;

    event PolicySet(ConfigIdV4 id, address multiplexer, address account);
    event Charged(address indexed account, uint256 charge);
    event Reviewed(address indexed account, uint256 charged);

    error PolicyNotInitialized(ConfigIdV4 id, address multiplexer, address account);
    error BadInit(uint256 field);
    error OnlySmartSession();
    error OnlyGuardian();

    constructor(address guardian) {
        GUARDIAN = guardian;
    }

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        return interfaceID == 0x01ffc9a7 // IERC165
            || interfaceID == this.checkUserOpPolicy.selector // smartsessions IUserOpPolicy
            || interfaceID == this.initializeWithMultiplexer.selector; // smartsessions IPolicy
    }

    /// The GAS_REVIEW of this chain (0 off the table: every op refused).
    function gasReview() public view returns (uint256) {
        return MamoruV4Chains.byChainId(block.chainid).gasReview;
    }

    function initializeWithMultiplexer(address account, ConfigIdV4 configId, bytes calldata initData) external {
        if (msg.sender != SMART_SESSION) revert OnlySmartSession();
        Caps memory c = abi.decode(initData, (Caps));
        if (c.maxPriorityFeePerGas == 0 || c.maxVerificationGasLimit == 0 || c.maxCallGasLimit == 0) revert BadInit(1);
        if (c.maxPreVerificationGas == 0 || c.maxFeePerGas < c.maxPriorityFeePerGas) revert BadInit(2);
        // The bucket is what bounds the drain per window; the review threshold bounds it over time. A bucket above
        // the threshold would be meaningless, a zero one refuses everything.
        if (c.perWindow == 0 || c.perWindow > gasReview() || c.window < MIN_WINDOW) revert BadInit(3);
        _caps[configId][account] = c;
        emit PolicySet(configId, msg.sender, account);
    }

    function checkUserOpPolicy(ConfigIdV4 id, PackedUserOperationV4 calldata op) external returns (uint256) {
        if (msg.sender != SMART_SESSION) return VALIDATION_FAILED; // nobody else may charge an account's bucket
        Caps memory c = _caps[id][op.sender];
        if (c.maxVerificationGasLimit == 0) revert PolicyNotInitialized(id, msg.sender, op.sender);
        uint256 verificationGasLimit = uint256(op.accountGasLimits) >> 128;
        uint256 callGasLimit = uint128(uint256(op.accountGasLimits));
        uint256 maxPriorityFeePerGas = uint256(op.gasFees) >> 128;
        uint256 maxFeePerGas = uint128(uint256(op.gasFees));
        uint256 pmGas;
        if (op.paymasterAndData.length != 0) {
            // EntryPoint v0.7: paymaster (20) | paymasterVerificationGasLimit (16) | paymasterPostOpGasLimit (16) | data
            if (op.paymasterAndData.length < 52) return VALIDATION_FAILED;
            pmGas = uint256(uint128(bytes16(op.paymasterAndData[20:36]))) + uint256(uint128(bytes16(op.paymasterAndData[36:52])));
        }
        if (
            maxPriorityFeePerGas > c.maxPriorityFeePerGas || maxFeePerGas > c.maxFeePerGas
                || verificationGasLimit > c.maxVerificationGasLimit || callGasLimit > c.maxCallGasLimit
                || op.preVerificationGas > c.maxPreVerificationGas || pmGas > c.maxPaymasterGas
        ) return VALIDATION_FAILED;
        // I6 (r6): the most this op can cost the account, charged now.
        uint256 charge = (callGasLimit + verificationGasLimit + op.preVerificationGas + pmGas) * maxFeePerGas;
        uint256 debt = _debtNow(_bucket[op.sender], c) + charge;
        uint256 since = chargedSinceReview[op.sender] + charge;
        if (debt > c.perWindow || since > gasReview()) return VALIDATION_FAILED; // crossing ops are rejected
        _bucket[op.sender] = Bucket(uint128(debt), uint64(block.timestamp));
        chargedSinceReview[op.sender] = since;
        emit Charged(op.sender, charge);
        return VALIDATION_SUCCESS;
    }

    /// The guardian, after checking the account's gas ledger, resets the cumulative counter (the bucket keeps going).
    function review(address account) external {
        if (msg.sender != GUARDIAN) revert OnlyGuardian();
        emit Reviewed(account, chargedSinceReview[account]);
        chargedSinceReview[account] = 0;
    }

    // ---------------------------------------------------------------- views

    function capsOf(address account, ConfigIdV4 id) external view returns (Caps memory) {
        return _caps[id][account];
    }

    /// (bucket room now, room before the review threshold), in wei, for `account` under `id`.
    function gasLeft(address account, ConfigIdV4 id) external view returns (uint256 window, uint256 untilReview) {
        Caps memory c = _caps[id][account];
        uint256 d = _debtNow(_bucket[account], c);
        window = c.perWindow > d ? c.perWindow - d : 0;
        uint256 r = gasReview();
        untilReview = r > chargedSinceReview[account] ? r - chargedSinceReview[account] : 0;
    }

    /// The largest charge one op under `c` can make (its prefund at the capped price and limits).
    function maxCostPerOp(Caps memory c) public pure returns (uint256) {
        return uint256(c.maxFeePerGas)
            * (uint256(c.maxVerificationGasLimit) + c.maxCallGasLimit + c.maxPreVerificationGas + c.maxPaymasterGas);
    }

    function _debtNow(Bucket memory b, Caps memory c) internal view returns (uint256 d) {
        d = b.debt;
        if (d != 0 && block.timestamp > b.updatedAt) {
            uint256 refill = (uint256(c.perWindow) * (block.timestamp - b.updatedAt)) / c.window;
            d = refill >= d ? 0 : d - refill;
        }
        if (d > c.perWindow) d = c.perWindow; // a re-init with a smaller bucket carries at most a full one
    }
}
