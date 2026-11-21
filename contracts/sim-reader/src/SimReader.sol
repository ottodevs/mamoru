// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice otto/mamoru#429: one userOp execution between two rounds of balance reads, run by eth_call where no
/// provider serves eth_simulateV1. Never deployed: an eth_call gives this runtime code to the EntryPoint's address by a
/// state override, so the account sees msg.sender == EntryPoint exactly as in a real userOp. No storage, no imports.
contract SimReader {
    /// @param account the smart account the userOp executes on
    /// @param tokens every ERC-20 (and the position manager, an ERC-721) whose balanceOf(account) is read
    /// @param callData the userOp's callData, sent to the account with all the gas left
    /// @return ok whether the account's call succeeded
    /// @return ret what it returned, or its revert data
    /// @return gasUsed gas the call consumed (gasleft before minus after)
    /// @return before balanceOf(account) per token, before the call
    /// @return afterwards balanceOf(account) per token, after the call
    function run(address account, address[] calldata tokens, bytes calldata callData)
        external
        returns (bool ok, bytes memory ret, uint256 gasUsed, uint256[] memory before, uint256[] memory afterwards)
    {
        before = balances(account, tokens);
        uint256 g = gasleft();
        (ok, ret) = account.call(callData);
        gasUsed = g - gasleft();
        afterwards = balances(account, tokens);
    }

    function balances(address account, address[] calldata tokens) private view returns (uint256[] memory out) {
        out = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            (bool ok, bytes memory r) = tokens[i].staticcall(abi.encodeWithSelector(0x70a08231, account));
            // A token that cannot be read refuses the whole run: a missing balance would read as no change.
            require(ok && r.length >= 32, "balanceOf");
            out[i] = abi.decode(r, (uint256));
        }
    }
}
