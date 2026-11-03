// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruActionPolicyV4, MamoruV4Helper, InitV4} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruV4Table} from "../src/MamoruV4Table.sol";
import {MamoruRemoteSafe, ISharedSignerV4} from "../src/MamoruRemoteSafe.sol";

interface ISafeOwnersParity {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

/// otto/mamoru#293 (spec 010 I4): the TypeScript twin of the canonical V4 remote Safe (packages/account/one-auth `v4Remote`,
/// fixture test/fixtures/v4-remote-init.json) against MamoruV4Helper.remote, byte for byte: MamoruRemoteInit's and the
/// helper's addresses (CREATE from V4), the owners hash, the remote's one session, the initializer, the factory call and the
/// CREATE2 address, with and without a passkey owner; and the home session's InitV4 and MamoruGasPolicyV2 caps. V4 and the
/// gas policy are created by fixed EOAs at fixed nonces, so their addresses do not depend on the bytecode. No fork: the
/// home account's owner state is mocked where V4 reads it (getOwners, getThreshold, the shared signer's configuration).
contract V4RemoteInitParityTest is Test {
    string j;
    MamoruActionPolicyV4 v4;
    MamoruGasPolicyV2 gasPol;
    address home;

    function setUp() public {
        j = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/v4-remote-init.json"));
        MamoruV4Table table = new MamoruV4Table();
        address gasDeployer = vm.parseJsonAddress(j, ".gasDeployer");
        vm.setNonce(gasDeployer, uint64(vm.parseJsonUint(j, ".gasNonce")));
        vm.prank(gasDeployer);
        gasPol = new MamoruGasPolicyV2(table);
        address v4Deployer = vm.parseJsonAddress(j, ".v4Deployer");
        vm.setNonce(v4Deployer, uint64(vm.parseJsonUint(j, ".v4Nonce")));
        vm.prank(v4Deployer);
        v4 = new MamoruActionPolicyV4(address(gasPol), table);
        home = vm.parseJsonAddress(j, ".home");
        vm.etch(home, hex"00");
    }

    function _mockOwners(address[] memory owners, uint256 x, uint256 y, uint256 verifiers) internal {
        vm.mockCall(home, abi.encodeWithSelector(ISafeOwnersParity.getOwners.selector), abi.encode(owners));
        vm.mockCall(home, abi.encodeWithSelector(ISafeOwnersParity.getThreshold.selector), abi.encode(uint256(1)));
        vm.etch(MamoruRemoteSafe.SHARED_SIGNER, hex"00");
        vm.mockCall(
            MamoruRemoteSafe.SHARED_SIGNER,
            abi.encodeWithSelector(ISharedSignerV4.getConfiguration.selector, home),
            abi.encode(ISharedSignerV4.Signer(x, y, uint176(verifiers)))
        );
    }

    function test_addressesFollowFromV4() public view {
        assertEq(address(v4), vm.parseJsonAddress(j, ".policy"), "V4");
        assertEq(address(gasPol), vm.parseJsonAddress(j, ".gasPolicy"), "gas policy");
        assertEq(address(v4.REMOTE_INIT()), vm.parseJsonAddress(j, ".remoteInit"), "MamoruRemoteInit");
        assertEq(address(v4.HELPER()), vm.parseJsonAddress(j, ".helper"), "MamoruV4Helper");
    }

    function test_remoteWithPasskeyMatchesTheTypeScript() public {
        address[] memory owners = vm.parseJsonAddressArray(j, ".owners");
        _mockOwners(owners, vm.parseJsonUint(j, ".x"), vm.parseJsonUint(j, ".y"), vm.parseJsonUint(j, ".verifiers"));
        MamoruV4Helper h = v4.HELPER();
        assertEq(h.ownersHashOf(home), vm.parseJsonBytes32(j, ".ownersHash"), "owners hash");
        (address at, bytes32 oh, bytes memory createCall) =
            h.remote(home, 15, vm.parseJsonAddress(j, ".sessionKey"), uint128(vm.parseJsonUint(j, ".capUsd")), 6);
        assertEq(oh, vm.parseJsonBytes32(j, ".ownersHash"), "owners hash (remote)");
        assertEq(keccak256(createCall), keccak256(vm.parseJsonBytes(j, ".monad.createCall")), "factory call");
        assertEq(at, vm.parseJsonAddress(j, ".monad.expected"), "remote address");
    }

    function test_remoteSessionMatchesTheTypeScript() public view {
        // MamoruV4Helper.sessions is public: the remote's one session, abi.encode(Session[1]).
        (bool ok, bytes memory out) = address(v4.HELPER()).staticcall(
            abi.encodeWithSignature(
                "sessions(address,address,uint128,uint32,(uint256,uint32,address,address,address,address[2],address[2],address,uint128,uint32,(uint64,uint32,uint32,uint32,uint64,uint32),uint16))",
                home,
                vm.parseJsonAddress(j, ".sessionKey"),
                uint128(vm.parseJsonUint(j, ".capUsd")),
                uint32(6),
                _monad()
            )
        );
        assertTrue(ok, "sessions()");
        assertEq(keccak256(abi.decode(out, (bytes))), keccak256(vm.parseJsonBytes(j, ".monad.sessions")), "abi.encode(Session[1])");
    }

    function test_remoteWithoutPasskeyMatchesTheTypeScript() public {
        address[] memory owners = new address[](1);
        owners[0] = vm.parseJsonAddress(j, ".plain.owner");
        _mockOwners(owners, 0, 0, 0);
        MamoruV4Helper h = v4.HELPER();
        assertEq(h.ownersHashOf(home), vm.parseJsonBytes32(j, ".plain.ownersHash"), "owners hash");
        (address at,, bytes memory createCall) =
            h.remote(home, 6, vm.parseJsonAddress(j, ".sessionKey"), uint128(vm.parseJsonUint(j, ".plain.capUsd")), 15);
        assertEq(keccak256(createCall), keccak256(vm.parseJsonBytes(j, ".plain.createCall")), "factory call");
        assertEq(at, vm.parseJsonAddress(j, ".plain.expected"), "remote address");
    }

    function test_homeInitAndGasCapsMatchTheTypeScript() public view {
        bytes32[] memory raw = vm.parseJsonBytes32Array(j, ".homeSession.admit");
        uint256[] memory admit = new uint256[](raw.length);
        for (uint256 i; i < raw.length; i++) {
            admit[i] = uint256(raw[i]);
        }
        bytes memory init = abi.encode(InitV4(uint128(vm.parseJsonUint(j, ".capUsd")), 1, address(0), 0, admit));
        assertEq(keccak256(init), keccak256(vm.parseJsonBytes(j, ".homeSession.init")), "InitV4");
        bytes memory caps = abi.encode(MamoruGasPolicyV2.Caps(10_000_000, 3_000_000, 2_000_000, 200_000, 100_000_000, 0));
        assertEq(keccak256(caps), keccak256(vm.parseJsonBytes(j, ".homeSession.gasInit")), "MamoruGasPolicyV2.Caps (Base)");
    }

    /// MamoruV4Chains.byChainId(143), as the helper's public `sessions` takes it.
    struct GasCapsT {
        uint64 a;
        uint32 b;
        uint32 c;
        uint32 d;
        uint64 e;
        uint32 f;
    }

    struct ChainT {
        uint256 chainId;
        uint32 domain;
        address factory;
        address npm;
        address router;
        address[2] stables;
        address[2] assets;
        address wrapped;
        uint128 gasPerWindow;
        uint32 gasWindow;
        GasCapsT remoteCaps;
        uint16 cctpFeeCapBps; // #345 P2-5
    }

    function _monad() internal pure returns (ChainT memory c) {
        c.chainId = 143;
        c.domain = 15;
        c.factory = 0x204FAca1764B154221e35c0d20aBb3c525710498;
        c.npm = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
        c.router = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
        c.stables = [0x754704Bc059F8C67012fEd69BC8A327a5aafb603, address(0)];
        c.assets = [0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A, address(0)];
        c.wrapped = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
        (c.gasPerWindow, c.gasWindow) = (1 ether, 1 days);
        c.remoteCaps = GasCapsT(1_000_000_000, 3_000_000, 2_000_000, 200_000, 1_000_000_000_000, 0);
        c.cctpFeeCapBps = 10;
    }
}
