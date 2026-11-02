// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {V4Fixture, IERC20T, ISafeT, ISmartSessionT} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, MamoruV4Helper, InitV4, SwapParams} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {ISharedSignerV4} from "../src/MamoruRemoteSafe.sol";
import {Session, ConfigIdV4} from "../src/SmartSessionTypes.sol";

interface ISafeModulesT {
    function isModuleEnabled(address module) external view returns (bool);
    function isModuleInstalled(uint256 moduleType, address module, bytes calldata context) external view returns (bool);
}

/**
 * Spec 010 I4 + T1b with V4 (otto/mamoru#292), on forks of Base and Monad at once. The stack is deployed through the
 * canonical deterministic deployer with the same salts and arguments on both forks, so V4, its helper, the gas policy
 * and MamoruRemoteInit sit at the same addresses on both (chain-independent init code). The home account is a
 * Mamoru-shaped Safe created with its V4 session enabled in its setup (the one-screen sign-up, #294).
 *
 * Flow: the session registers the account's Monad remote (V4 computes it from the account's current owners); USDC is
 * minted to that address on Monad before anything is deployed there; anyone deploys it with V4's factory call; the
 * owners, threshold, passkey, modules and the session bound to V4 read back; only then does the guardian mark it ready
 * and the session bridge to it. On Monad the remote's own session operates under V4 and can bridge only home. An
 * owner rotation on Base stops every burn until the remote is re-registered and marked ready again.
 */
contract V4RemoteForkTest is V4Fixture {
    uint256 baseFork;
    uint256 monadFork;
    address home;
    bytes32 homePid;
    uint256 remoteKey = uint256(keccak256("mamoru.v4.remote-session"));
    address remoteSk;

    function setUp() public {
        monadFork = vm.createFork(vm.envOr("MONAD_FORK_RPC_URL", string("https://rpc.monad.xyz")), MONAD_BLOCK);
        baseFork = vm.createFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), BASE_BLOCK);
        remoteSk = vm.addr(remoteKey);
        // Monad: the same stack, the WMON/USDC pool listed (its observation ring raised first, as the deploy step does)
        vm.selectFork(monadFork);
        _deployStack();
        address monadV4 = address(v4);
        address monadGas = address(gasPol);
        address monadInit = address(v4.REMOTE_INIT());
        address(M_POOL).call(abi.encodeWithSignature("increaseObservationCardinalityNext(uint16)", uint16(1800)));
        _listPool(M_POOL, 100, 0, 0, 10_000);
        _route(DOMAIN_BASE);
        // Base
        vm.selectFork(baseFork);
        _deployStack();
        assertEq(address(v4), monadV4, "V4 at the same address on both chains");
        assertEq(address(gasPol), monadGas, "gas policy at the same address");
        assertEq(address(v4.REMOTE_INIT()), monadInit, "MamoruRemoteInit at the same address");
        _listBase();
        _route(DOMAIN_MONAD);
        Session memory s = _v4Session(C, 1, new uint256[](0), _baseCaps(), bytes32(uint256(0x4)));
        home = _newSafeWithV4(7, s);
        homePid = _pid(s);
        deal(USDC, home, 100_000e6);
    }

    /// A Mamoru-shaped Safe whose setup installs SmartSession with the V4 session (UNSAFE_ENABLE): no owner tx.
    function _newSafeWithV4(uint256 saltNonce, Session memory s) internal returns (address safe) {
        Session[] memory ss = new Session[](1);
        ss[0] = s;
        ModuleInitT[] memory validators = new ModuleInitT[](1);
        validators[0] = ModuleInitT(SMART_SESSION, abi.encodePacked(uint8(2), abi.encode(ss)));
        ModuleInitT[] memory none = new ModuleInitT[](0);
        address[] memory attesters = new address[](1);
        attesters[0] = RHINESTONE_ATTESTER;
        bytes memory launch = abi.encodeWithSignature(
            "addSafe7579(address,(address,bytes)[],(address,bytes)[],(address,bytes)[],(address,bytes)[],address[],uint8)",
            SAFE7579, validators, none, none, none, attesters, uint8(1)
        );
        bytes memory cfg = abi.encodeWithSignature(
            "configure((uint256,uint256,uint176))", uint256(0x1234), uint256(0x5678), uint176(uint256(0x100) << 160)
        );
        bytes memory packed = abi.encodePacked(
            abi.encodePacked(uint8(1), LAUNCHPAD, uint256(0), launch.length, launch),
            abi.encodePacked(uint8(1), SHARED_SIGNER, uint256(0), cfg.length, cfg)
        );
        address[] memory owners = new address[](2);
        (owners[0], owners[1]) = (SHARED_SIGNER, vm.addr(ownerKey));
        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners, uint256(1), MULTISEND, abi.encodeWithSignature("multiSend(bytes)", packed), SAFE7579, address(0), 0, address(0)
        );
        (bool ok, bytes memory r) = SAFE_FACTORY.call(
            abi.encodeWithSignature("createProxyWithNonce(address,bytes,uint256)", SAFE_SINGLETON, initializer, saltNonce)
        );
        require(ok, "safe deploy");
        safe = abi.decode(r, (address));
        vm.deal(safe, 1 ether);
    }

    function _remotePid() internal view returns (bytes32) {
        address[] memory signers = new address[](1);
        signers[0] = remoteSk;
        return keccak256(abi.encode(OWNABLE_VALIDATOR, abi.encode(uint256(1), signers), helper.REMOTE_SESSION_SALT()));
    }

    function _bridgeBatch(uint32 domain, address token, uint256 amount) internal view returns (bytes memory) {
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(token, 0, abi.encodeCall(IERC20T.approve, (address(v4), amount)));
        xs[1] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.bridge, (domain, token, amount)));
        return _batch(xs);
    }

    /// Registers, deploys on Monad after the mint, reads back, marks ready, bridges; the remote works and bridges home.
    function test_I4_remoteEndToEnd() public {
        assertEq(v4.generationOf(home), 1, "V4 enabled in the home Safe's setup");
        // 1. the session registers the Monad remote
        _run(home, _single(address(v4), abi.encodeCall(MamoruActionPolicyV4.registerRemote, (DOMAIN_MONAD, remoteSk))), homePid);
        MamoruActionPolicyV4.Remote memory r = v4.remoteOf(home, DOMAIN_MONAD);
        assertTrue(r.remote != address(0));
        assertEq(r.ownersHash, helper.ownersHashOf(home));
        (address at, bytes memory createCall) = v4.remoteDeployment(home, DOMAIN_MONAD);
        assertEq(at, r.remote);
        // 2. no burn before the guardian marks it ready (r4 P0)
        assertFalse(v4.isReady(home, DOMAIN_MONAD));
        (bool ok,) = _runOp(home, _bridgeBatch(DOMAIN_MONAD, USDC, 100e6), homePid);
        assertFalse(ok, "burn refused before readiness");
        assertEq(IERC20T(USDC).balanceOf(home), 100_000e6);
        // 3. Monad: the mint lands first, then anyone deploys, and everything reads back
        vm.selectFork(monadFork);
        assertEq(at.code.length, 0);
        deal(M_USDC, at, 100e6);
        vm.prank(makeAddr("relayer"));
        uint256 g = gasleft();
        (bool deployed, bytes memory ret) = SAFE_FACTORY.call(createCall);
        console2.log("remote Safe deployment (factory call, exec gas)", g - gasleft());
        assertTrue(deployed, "permissionless deploy");
        assertEq(abi.decode(ret, (address)), at, "deployed where the funds wait");
        address[] memory owners = ISafeT(at).getOwners();
        assertEq(owners.length, 2);
        assertEq(owners[0], SHARED_SIGNER);
        assertEq(owners[1], vm.addr(ownerKey), "the home account's current owners");
        assertEq(ISafeT(at).getThreshold(), 1);
        ISharedSignerV4.Signer memory pk = ISharedSignerV4(SHARED_SIGNER).getConfiguration(at);
        assertEq(pk.x, 0x1234);
        assertEq(pk.y, 0x5678);
        assertTrue(ISafeModulesT(at).isModuleEnabled(SAFE7579), "Safe7579");
        assertTrue(ISafeModulesT(at).isModuleInstalled(1, SMART_SESSION, ""), "SmartSession");
        assertTrue(ISmartSessionT(SMART_SESSION).isPermissionEnabled(_remotePid(), at), "the one session");
        assertEq(ISmartSessionT(SMART_SESSION).getPermissionIDs(at).length, 1);
        MamoruActionPolicyV4.Config memory rc = v4.configOf(at);
        assertEq(rc.home, home, "bound to its home");
        assertEq(rc.homeDomain, DOMAIN_BASE);
        assertEq(rc.capUsd, C);
        assertEq(rc.generation, 1);
        // 4. Base: the guardian, having read all that back, marks it ready; the session bridges to it
        vm.selectFork(baseFork);
        vm.prank(attacker);
        vm.expectRevert(MamoruActionPolicyV4.OnlyGuardian.selector);
        v4.setReady(home, DOMAIN_MONAD, at);
        vm.prank(guardian);
        v4.setReady(home, DOMAIN_MONAD, at);
        assertTrue(v4.isReady(home, DOMAIN_MONAD));
        (watchEmitter, watchWord) = (TOKEN_MESSENGER, bytes32(uint256(uint160(at))));
        _run(home, _bridgeBatch(DOMAIN_MONAD, USDC, 100e6), homePid);
        assertTrue(watchSeen, "minted to the remote");
        assertEq(IERC20T(USDC).balanceOf(home), 99_900e6);
        // 5. Monad: the remote's session runs under V4 with no owner signature, and bridges only home
        vm.selectFork(monadFork);
        vm.deal(at, 10 ether);
        sessionKey = remoteKey;
        bytes32 rpid = _remotePid();
        uint256 w0 = IERC20T(M_WMON).balanceOf(at);
        {
            (uint256 minOut, uint160 limit) = helper.swapBounds(M_POOL, M_USDC, 10e6);
            Execution[] memory xs = new Execution[](2);
            xs[0] = Execution(M_USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 10e6)));
            xs[1] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.swap, (SwapParams(M_POOL, M_USDC, 10e6, minOut, limit, vm.getBlockTimestamp()))));
            _run(at, _batch(xs), rpid);
        }
        assertGt(IERC20T(M_WMON).balanceOf(at), w0, "the remote swapped under V4");
        (ok,) = _runOp(at, _bridgeBatch(3, M_USDC, 10e6), rpid);
        assertFalse(ok, "a remote bridges nowhere but home");
        watchSeen = false;
        (watchEmitter, watchWord) = (TOKEN_MESSENGER, bytes32(uint256(uint160(home))));
        _run(at, _bridgeBatch(DOMAIN_BASE, M_USDC, 50e6), rpid);
        assertTrue(watchSeen, "bridged back to the home account");
        vm.prank(at);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadBridge.selector, 4));
        v4.registerRemote(DOMAIN_BASE, remoteSk); // a remote has no remotes
    }

    /// r3 P0-1: an owner rotation on the home Safe stops every burn (readiness is cleared by the hash change); the old
    /// remote cannot be made ready again; re-registering gives a new remote, owned by the new keys, that the guardian
    /// must read back and mark again.
    function test_I4_ownerChangeClearsReadiness() public {
        vm.prank(home);
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        address r1 = v4.remoteOf(home, DOMAIN_MONAD).remote;
        vm.prank(guardian);
        v4.setReady(home, DOMAIN_MONAD, r1);
        assertTrue(v4.isReady(home, DOMAIN_MONAD));
        // the owners rotate the EOA key (an owner Safe tx)
        address newKey = makeAddr("new recovery key");
        vm.prank(home);
        ISafeT(home).swapOwner(SHARED_SIGNER, vm.addr(ownerKey), newKey);
        assertFalse(v4.isReady(home, DOMAIN_MONAD), "readiness cleared by the owner change");
        _approveV4(home, USDC, 100e6);
        vm.prank(home);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.RemoteNotReady.selector, DOMAIN_MONAD));
        v4.bridge(DOMAIN_MONAD, USDC, 100e6);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.RemoteNotReady.selector, DOMAIN_MONAD));
        v4.setReady(home, DOMAIN_MONAD, r1); // the old remote, under the new owners: refused
        vm.prank(home);
        address r2 = v4.registerRemote(DOMAIN_MONAD, remoteSk);
        assertTrue(r2 != r1, "the new owners give a new remote");
        assertFalse(v4.isReady(home, DOMAIN_MONAD), "a registration starts unready");
        (address at,) = v4.remoteDeployment(home, DOMAIN_MONAD);
        assertEq(at, r2);
        vm.prank(guardian);
        v4.setReady(home, DOMAIN_MONAD, r2);
        vm.prank(home);
        v4.bridge(DOMAIN_MONAD, USDC, 100e6);
    }

    /// I4: registerRemote acts on msg.sender only. Another account computes its own remote from its own owners and
    /// cannot touch the victim's; the guardian cannot mark the attacker's remote ready for the victim; a caller with no
    /// V4 config cannot register at all; a domain without a route cannot be registered.
    function test_I4_registerRemoteWithAnotherAccountsStateRefused() public {
        vm.prank(home);
        address victimRemote = v4.registerRemote(DOMAIN_MONAD, remoteSk);
        Session memory s = _v4Session(C, 1, new uint256[](0), _baseCaps(), bytes32(uint256(0x4)));
        ownerKey = uint256(keccak256("attacker owner"));
        address evil = _newSafeWithV4(8, s);
        vm.prank(evil);
        address evilRemote = v4.registerRemote(DOMAIN_MONAD, remoteSk);
        assertTrue(evilRemote != victimRemote);
        assertEq(v4.remoteOf(home, DOMAIN_MONAD).remote, victimRemote, "the victim's registration is untouched");
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.RemoteNotReady.selector, DOMAIN_MONAD));
        v4.setReady(home, DOMAIN_MONAD, evilRemote);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NoConfig.selector, attacker));
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        vm.prank(admin);
        reg.removeRoute(DOMAIN_MONAD);
        vm.prank(home);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NotListed.selector, address(uint160(DOMAIN_MONAD))));
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        // a removed route also stops bridging at once, ready or not
        vm.prank(guardian);
        v4.setReady(home, DOMAIN_MONAD, victimRemote);
        _approveV4(home, USDC, 1e6);
        vm.prank(home);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NotListed.selector, address(uint160(DOMAIN_MONAD))));
        v4.bridge(DOMAIN_MONAD, USDC, 1e6);
    }

    /// The remote's deployment depends on nothing that can change: deployed 400 days after the mint, it is the same.
    function test_I4_remoteDeploysAnyDay() public {
        vm.prank(home);
        address r = v4.registerRemote(DOMAIN_MONAD, remoteSk);
        (, bytes memory createCall) = v4.remoteDeployment(home, DOMAIN_MONAD);
        vm.selectFork(monadFork);
        deal(M_USDC, r, 100e6);
        vm.warp(vm.getBlockTimestamp() + 400 days);
        vm.roll(vm.getBlockNumber() + 1_000_000);
        (bool ok, bytes memory ret) = SAFE_FACTORY.call(createCall);
        assertTrue(ok);
        assertEq(abi.decode(ret, (address)), r);
        assertEq(IERC20T(M_USDC).balanceOf(r), 100e6);
    }

    /// The registered address is what the relayer deploys even after the home renews with another C (the remote's
    /// Init carries the C of its registration).
    function test_I4_deploymentStableAcrossHomeRenewal() public {
        vm.prank(home);
        address r = v4.registerRemote(DOMAIN_MONAD, remoteSk);
        _init(home, ConfigIdV4.wrap(bytes32(uint256(0x99))), C * 2, 2, new uint256[](0));
        (address at,) = v4.remoteDeployment(home, DOMAIN_MONAD);
        assertEq(at, r);
    }

    /// Gas of registerRemote's Solidity derivation of the canonical initializer (spec 010 open question 2: < ~1M).
    function test_gas_registerRemote() public {
        vm.prank(home);
        uint256 g = gasleft();
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        uint256 used = g - gasleft();
        console2.log("registerRemote execution gas (owners read + initializer + CREATE2 address)", used);
        assertLt(used, 1_000_000);
    }
}
