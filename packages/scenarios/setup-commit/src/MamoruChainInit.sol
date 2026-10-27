// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// SPIKE (otto/mamoru#116, T0). Throwaway prototype for fork measurements: not audited, not for deployment.
/// T2 owns the real contract.
///
/// Design D: the Safe initializer is byte-identical on every chain. Safe.setup delegatecalls MultiSend 1.4.1, whose
/// last entry delegatecalls `init` here with the whole list [(chainId, abi.encode(Session[]))...]. Running in the
/// Safe's context, it installs SmartSession through Safe7579.installModule on the Safe itself, with
/// `UNSAFE_ENABLE ‖ sessions` for block.chainid, or with empty data when the chain is not listed.
/// No storage, no admin, no owner: delegatecall only.
interface ISafe7579Install {
    function installModule(uint256 moduleType, address module, bytes calldata initData) external;
}

contract MamoruChainInit {
    struct Entry {
        uint256 chainId;
        /// abi.encode(Session[]) of SmartSession v1.0.0, passed through untouched.
        bytes sessions;
    }

    uint256 private constant MODULE_TYPE_VALIDATOR = 1;
    /// SmartSessionMode.UNSAFE_ENABLE: onInstall enables the sessions without the ERC-7484 registry check.
    bytes1 private constant UNSAFE_ENABLE = 0x02;

    address public immutable SMART_SESSION;
    address private immutable SELF;

    error OnlyDelegateCall();
    error DuplicateChain(uint256 chainId);
    error GasFloor(uint256 left, uint256 floor);

    constructor(address smartSession) {
        SMART_SESSION = smartSession;
        SELF = address(this);
    }

    /// Strict: any failure (policy init, gas) reverts the whole Safe deployment.
    function init(Entry[] calldata entries) external {
        if (address(this) == SELF) revert OnlyDelegateCall();
        ISafe7579Install(address(this)).installModule(MODULE_TYPE_VALIDATOR, SMART_SESSION, _installData(entries));
    }

    /// Fallback variant: tries this chain's sessions; if that call fails, installs SmartSession empty (the account
    /// is deployed without grants and costs the owner a tap, but never locks funds). `minGas` is a floor checked
    /// before trying, so a caller cannot starve the try into the fallback (0 = no floor, to measure the griefing).
    function initOrEmpty(Entry[] calldata entries, uint256 minGas) external {
        if (address(this) == SELF) revert OnlyDelegateCall();
        bytes memory data = _installData(entries);
        if (data.length != 0) {
            if (gasleft() < minGas) revert GasFloor(gasleft(), minGas);
            try ISafe7579Install(address(this)).installModule(MODULE_TYPE_VALIDATOR, SMART_SESSION, data) {
                return;
            } catch {}
        }
        ISafe7579Install(address(this)).installModule(MODULE_TYPE_VALIDATOR, SMART_SESSION, "");
    }

    function _installData(Entry[] calldata entries) private view returns (bytes memory data) {
        for (uint256 i; i < entries.length; i++) {
            for (uint256 j; j < i; j++) {
                if (entries[j].chainId == entries[i].chainId) revert DuplicateChain(entries[i].chainId);
            }
            if (entries[i].chainId == block.chainid && data.length == 0) {
                data = abi.encodePacked(UNSAFE_ENABLE, entries[i].sessions);
            }
        }
    }
}
