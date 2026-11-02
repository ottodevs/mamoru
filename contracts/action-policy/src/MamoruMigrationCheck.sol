// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

interface ISmartSessionIds {
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
    function getPermissionIDs(address account) external view returns (bytes32[] memory);
    function getNonce(bytes32 permissionId, address account) external view returns (uint256);
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
 *  - `assertMigrated(account, keep, old, noncesBefore)`: `assertOnly`, and every old permission id's ENABLE nonce
 *    moved past the value the operator read when building the transaction (review r1 of #200, P1). Removing a session
 *    does not invalidate an unused owner-signed ENABLE payload for it (SmartSession signs the enable digest over
 *    `$signerNonce[permissionId][account]`, and `removeSession` leaves it as it is); the migration therefore calls
 *    `SmartSession.revokeEnableSignature(id)` for every old id, which bumps that nonce, and this check proves it did.
 * Stateless, view only, anyone may call it.
 */
contract MamoruMigrationCheck {
    address public constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;

    error StillEnabled(bytes32 permissionId);
    error NotEnabled(bytes32 permissionId);
    error UnexpectedSessionCount(uint256 enabled, uint256 expected);
    error EnableNotRevoked(bytes32 permissionId, uint256 nonce);
    error LengthMismatch();

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

    /// The migration's last call: only `keep` enabled, and no ENABLE payload signed before the migration for any `old`
    /// id can still verify (its nonce is past `noncesBefore`, the values SmartSession.getNonce returned off chain).
    function assertMigrated(
        address account,
        bytes32[] calldata keep,
        bytes32[] calldata old,
        uint256[] calldata noncesBefore
    ) external view {
        this.assertOnly(account, keep);
        if (old.length != noncesBefore.length) revert LengthMismatch();
        for (uint256 i; i < old.length; i++) {
            uint256 n = ISmartSessionIds(SMART_SESSION).getNonce(old[i], account);
            if (n <= noncesBefore[i]) revert EnableNotRevoked(old[i], n);
        }
    }
}
