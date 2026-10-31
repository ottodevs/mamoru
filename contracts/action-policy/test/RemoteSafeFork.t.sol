// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/**
 * otto/mamoru#251 on a Monad fork (anvil semantics, never a live chain): the account's own Safe on Monad, exactly as the
 * TypeScript builds it (`remoteSafe`, packages/account/remote). test/fixtures/remote-safe-monad.json is that code's output
 * (packages/account/remote/remote.test.ts fails while it is stale): the factory call the relayer sends, the address the
 * Base bridge-out grant commits to, and the permission ids of the sessions committed in the setup.
 *
 * MamoruActionPolicyV3 sits at its pinned Monad address (DeployV3.s.sol `expected(143)`) with the Monad constructor
 * arguments; everything else is the live Monad stack, MamoruGasPolicy included. Checked: the relayer's call deploys at the
 * committed address, with the owner's keys as its owners, SmartSession installed, every session enabled with no owner
 * signature, and V3's config of the account at generation 1 (setup mode ran).
 */

interface IFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

interface ISafeView {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

interface ISafe7579View {
    function isModuleInstalled(uint256 moduleType, address module, bytes calldata context) external view returns (bool);
}

interface ISmartSessionView {
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
}

interface IV3View {
    function generationOf(address account) external view returns (uint64);
}

contract RemoteSafeForkMonad is Test {
    uint256 constant FORK_BLOCK = 118_163_000;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant SAFE7579 = 0x7579EE8307284F293B1927136486880611F20002;
    // DeployV3.s.sol argsFor(143) and PINNED_GUARDIAN.
    address constant NPM = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
    address constant ROUTER = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
    address constant FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant GUARDIAN = 0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD;

    address factory;
    bytes createProxy;
    address expected;
    address[] owners;
    address v3;
    address gasPolicy;
    bytes32[] permissionIds;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MONAD_FORK_RPC_URL", string("https://rpc.monad.xyz")), FORK_BLOCK);
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/remote-safe-monad.json"));
        factory = vm.parseJsonAddress(j, ".factory");
        createProxy = vm.parseJsonBytes(j, ".createProxy");
        expected = vm.parseJsonAddress(j, ".expected");
        owners = vm.parseJsonAddressArray(j, ".owners");
        v3 = vm.parseJsonAddress(j, ".actionPolicy");
        gasPolicy = vm.parseJsonAddress(j, ".gasPolicy");
        permissionIds = vm.parseJsonBytes32Array(j, ".permissionIds");
        assertEq(v3.code.length, 0, "V3 is not on Monad yet at this block: placed by the test");
        assertGt(gasPolicy.code.length, 0, "MamoruGasPolicy is live on Monad");
        deployCodeTo(
            "MamoruActionPolicyV3.sol:MamoruActionPolicyV3",
            abi.encode(SMART_SESSION, NPM, ROUTER, FACTORY, GUARDIAN, new address[](0), address(0), address(0), uint32(0)),
            v3
        );
    }

    function _deploy() internal returns (address safe) {
        (bool ok, bytes memory ret) = factory.call(createProxy);
        assertTrue(ok, "the relayer's createProxyWithNonce");
        safe = abi.decode(ret, (address));
    }

    function test_deploysAtTheCommittedAddressWithEverySessionEnabled() public {
        assertEq(permissionIds.length, 3, "enter-swap, enter-mint, manage-any");
        address safe = _deploy();
        assertEq(safe, expected, "the address the Base approval commits to");
        assertEq(ISafeView(safe).getOwners(), owners, "the owner's own keys");
        assertEq(ISafeView(safe).getThreshold(), 1);
        assertTrue(ISafe7579View(safe).isModuleInstalled(1, SMART_SESSION, ""), "SmartSession installed");
        for (uint256 i; i < permissionIds.length; i++) {
            assertTrue(ISmartSessionView(SMART_SESSION).isPermissionEnabled(permissionIds[i], safe), "enabled at setup");
        }
        assertEq(IV3View(v3).generationOf(safe), 1, "V3 config at generation 1 (setup mode)");
    }

    /// Anyone may send the deploy (the relayer pays the gas); a second send cannot change what is there.
    function test_anySenderSameResultAndNoRedeploy() public {
        vm.prank(makeAddr("anyone"));
        assertEq(_deploy(), expected);
        (bool ok,) = factory.call(createProxy);
        assertFalse(ok, "a second deploy at the same address reverts");
    }

    /// Without V3 on chain the setup reverts: nothing is ever deployed half-provisioned at the committed address.
    function test_setupRevertsWithoutV3() public {
        vm.etch(v3, "");
        (bool ok,) = factory.call(createProxy);
        assertFalse(ok, "no V3, no Safe");
        assertEq(expected.code.length, 0);
    }
}
