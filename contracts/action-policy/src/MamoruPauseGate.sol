// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {ConfigId} from "./MamoruActionPolicy.sol";

/// The one view of MamoruActionPolicyV2 this gate reads.
interface IPausable {
    function isPaused(address account) external view returns (bool);
}

/**
 * @title MamoruPauseGate (otto/mamoru#213). Not deployed.
 * @notice A SmartSession ACTION policy for the session actions that MamoruActionPolicyV2 cannot check because they are
 * not Uniswap calls (the CCTP bridge-out of conservador-live-v6). It allows an action only while the guardian has not
 * paused the account in MamoruActionPolicyV2, so the guardian's pause stops every session action of the account, the
 * bridge included (GPT-6 review of #134, P1). It checks nothing else: the amounts, recipient and domain stay in
 * UniActionPolicy, the gas in MamoruGasPolicy, both in the same session.
 *
 * Stateless: no per-account configuration, so `initializeWithMultiplexer` accepts only empty init data and stores
 * nothing. Fails closed: a call not from SmartSession, or a pause read that reverts, is refused.
 */
contract MamoruPauseGate {
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;

    address public immutable SMART_SESSION;
    IPausable public immutable ACTION_POLICY;

    event PolicySet(ConfigId id, address multiplexer, address account);

    error BadInit();

    constructor(address smartSession, address actionPolicy) {
        if (smartSession == address(0) || actionPolicy == address(0)) revert BadInit();
        SMART_SESSION = smartSession;
        ACTION_POLICY = IPausable(actionPolicy);
    }

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        return interfaceID == 0x01ffc9a7 // IERC165
            || interfaceID == this.checkAction.selector // smartsessions IActionPolicy
            || interfaceID == this.initializeWithMultiplexer.selector; // smartsessions IPolicy
    }

    function initializeWithMultiplexer(address account, ConfigId configId, bytes calldata initData) external {
        if (initData.length != 0) revert BadInit();
        emit PolicySet(configId, msg.sender, account);
    }

    function checkAction(ConfigId, address account, address, uint256, bytes calldata) external view returns (uint256) {
        if (msg.sender != SMART_SESSION) return VALIDATION_FAILED;
        try ACTION_POLICY.isPaused(account) returns (bool paused) {
            return paused ? VALIDATION_FAILED : VALIDATION_SUCCESS;
        } catch {
            return VALIDATION_FAILED;
        }
    }
}
