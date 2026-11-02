// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

interface ISmartSessionIds {
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
    function getPermissionIDs(address account) external view returns (bytes32[] memory);
}

/**
 * @title MamoruMigrationCheck (spec 010 "Migration", r1 finding 4; otto/mamoru#292). Not deployed.
 * @notice The last call of the owner's migration transaction (one Safe tx: removeSession for every old id, enable the
 * V4 session, then this). It reverts, and with it the whole Safe transaction (Safe 1.4.1 with safeTxGas = gasPrice = 0
 * reverts on an inner failure, GS013), when the migration left an old session enabled:
 *  - `assertNone(account, ids)`: the spec's check, over the ids the operator inventoried from SmartSession's events.
 *  - `assertOnly(account, keep)`: stronger and independent of that inventory. SmartSession's own enumeration of the
 *    account's enabled permission ids (`getPermissionIDs`, deployed in 0x00000000002B0eCf...) must be exactly `keep`
 *    (the V4 session), so an id the inventory missed reverts too.
 * Stateless, view only, anyone may call it.
 */
contract MamoruMigrationCheck {
    address public constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;

    error StillEnabled(bytes32 permissionId);
    error NotEnabled(bytes32 permissionId);
    error UnexpectedSessionCount(uint256 enabled, uint256 expected);

    function assertNone(address account, bytes32[] calldata ids) external view {
        for (uint256 i; i < ids.length; i++) {
            if (ISmartSessionIds(SMART_SESSION).isPermissionEnabled(ids[i], account)) revert StillEnabled(ids[i]);
        }
    }

    function assertOnly(address account, bytes32[] calldata keep) external view {
        bytes32[] memory live = ISmartSessionIds(SMART_SESSION).getPermissionIDs(account);
        for (uint256 i; i < live.length; i++) {
            bool kept;
            for (uint256 j; j < keep.length; j++) {
                if (live[i] == keep[j]) kept = true;
            }
            if (!kept) revert StillEnabled(live[i]);
        }
        for (uint256 j; j < keep.length; j++) {
            if (!ISmartSessionIds(SMART_SESSION).isPermissionEnabled(keep[j], account)) revert NotEnabled(keep[j]);
        }
        if (live.length != keep.length) revert UnexpectedSessionCount(live.length, keep.length);
    }
}
