// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruRemoteSafe, ISafeSetupV4, ISharedSignerV4, IMultiSendV4} from "../src/MamoruRemoteSafe.sol";

/// Spec 010 I4 (otto/mamoru#292): the Solidity encoders of the canonical remote initializer against the TypeScript that
/// builds today's Safes, byte for byte. test/fixtures/remote-safe-monad.json is packages/account/remote's output
/// (`remoteSafe`, design C): its factory call and committed address. The Solidity pieces V4 shares with it (Safe.setup's
/// arguments, MultiSend packing, the shared signer's `configure`, `createProxyWithNonce`, SafeProxyFactory 1.4.1's
/// CREATE2) must rebuild that call and that address exactly. No fork.
contract V4RemoteParityTest is Test {
    bytes createProxy;
    address expected;

    function setUp() public {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/remote-safe-monad.json"));
        createProxy = vm.parseJsonBytes(j, ".createProxy");
        expected = vm.parseJsonAddress(j, ".expected");
    }

    function _args() internal view returns (address singleton, bytes memory initializer, uint256 saltNonce) {
        bytes memory body = new bytes(createProxy.length - 4);
        for (uint256 i; i < body.length; i++) {
            body[i] = createProxy[i + 4];
        }
        (singleton, initializer, saltNonce) = abi.decode(body, (address, bytes, uint256));
    }

    function _strip4(bytes memory b) internal pure returns (bytes memory out) {
        out = new bytes(b.length - 4);
        for (uint256 i; i < out.length; i++) {
            out[i] = b[i + 4];
        }
    }

    function test_createProxyCallAndAddressMatchTheTypeScript() public view {
        (address singleton, bytes memory initializer, uint256 saltNonce) = _args();
        assertEq(singleton, MamoruRemoteSafe.SAFE_SINGLETON);
        assertEq(keccak256(MamoruRemoteSafe.createProxyCall(initializer, saltNonce)), keccak256(createProxy), "factory call");
        assertEq(MamoruRemoteSafe.proxyAddress(initializer, saltNonce), expected, "counterfactual address");
    }

    /// Safe.setup, the MultiSend entries and the passkey `configure` re-encoded by MamoruRemoteSafe's primitives.
    function test_setupMultiSendAndConfigureMatchTheTypeScript() public view {
        (, bytes memory initializer,) = _args();
        SetupArgs memory a = _decodeSetup(initializer);
        assertEq(a.to, MamoruRemoteSafe.MULTISEND);
        assertEq(a.fallbackHandler, MamoruRemoteSafe.SAFE7579);
        assertEq(a.paymentToken, address(0));
        assertEq(a.payment, 0);
        assertEq(a.paymentReceiver, address(0));
        assertEq(
            keccak256(abi.encodeCall(ISafeSetupV4.setup, (a.owners, a.threshold, a.to, a.data, a.fallbackHandler, address(0), 0, payable(address(0))))),
            keccak256(initializer),
            "Safe.setup encoding"
        );
        address[] memory owners = a.owners;
        uint256 threshold = a.threshold;
        bytes memory data = a.data;
        bytes memory packed = abi.decode(_strip4(data), (bytes));
        assertEq(keccak256(abi.encodeCall(IMultiSendV4.multiSend, (packed))), keccak256(data), "multiSend encoding");
        // the two delegatecall entries: the launchpad, then the passkey
        (uint8 op1, address to1, bytes memory d1, uint256 next) = _entryAt(packed, 0);
        (uint8 op2, address to2, bytes memory d2, uint256 end) = _entryAt(packed, next);
        assertEq(end, packed.length);
        assertEq(op1, 1);
        assertEq(op2, 1);
        assertEq(to2, MamoruRemoteSafe.SHARED_SIGNER);
        assertEq(keccak256(abi.encodePacked(MamoruRemoteSafe.entry(to1, d1), MamoruRemoteSafe.entry(to2, d2))), keccak256(packed), "entry packing");
        ISharedSignerV4.Signer memory s = abi.decode(_strip4(d2), (ISharedSignerV4.Signer));
        assertEq(keccak256(abi.encodeCall(ISharedSignerV4.configure, (s))), keccak256(d2), "configure encoding");
        assertTrue(owners[0] == MamoruRemoteSafe.SHARED_SIGNER, "the passkey owner");
        // MamoruRemoteSafe's owners hash and passkey detection over the same state
        MamoruRemoteSafe.OwnerState memory o = MamoruRemoteSafe.OwnerState(owners, threshold, s.x, s.y, s.verifiers);
        assertTrue(MamoruRemoteSafe.ownsWithPasskey(o));
        assertEq(MamoruRemoteSafe.ownersHash(o), keccak256(abi.encode(owners, threshold, s.x, s.y, s.verifiers)));
    }

    struct SetupArgs {
        address[] owners;
        uint256 threshold;
        address to;
        bytes data;
        address fallbackHandler;
        address paymentToken;
        uint256 payment;
        address paymentReceiver;
    }

    function _decodeSetup(bytes memory initializer) internal pure returns (SetupArgs memory a) {
        (a.owners, a.threshold, a.to, a.data, a.fallbackHandler, a.paymentToken, a.payment, a.paymentReceiver) =
            abi.decode(_strip4(initializer), (address[], uint256, address, bytes, address, address, uint256, address));
    }

    /// One MultiSend 1.4.1 entry at `at`: uint8 op | address to | uint256 value | uint256 len | bytes data.
    function _entryAt(bytes memory p, uint256 at) internal pure returns (uint8 op, address to, bytes memory data, uint256 next) {
        op = uint8(p[at]);
        uint256 a;
        uint256 len;
        assembly {
            a := mload(add(add(p, 33), at)) // 32 bytes starting at at+1: address in the high 20
            len := mload(add(add(p, 85), at)) // at + 1 + 20 + 32
        }
        to = address(uint160(a >> 96));
        data = new bytes(len);
        for (uint256 i; i < len; i++) {
            data[i] = p[at + 85 + i];
        }
        next = at + 85 + len;
    }
}
