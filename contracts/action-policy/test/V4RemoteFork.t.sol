// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Vm, console2} from "forge-std/Test.sol";
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
 * Spec 010 I4 + T1b + A1 (otto/mamoru#292, #316, #315), on forks of Base and Monad at once. The stack is deployed through the
 * canonical deterministic deployer with the same salts and arguments on both forks, so V4, its helper, the gas policy
 * and MamoruRemoteInit sit at the same addresses on both (chain-independent init code). The home account is a
 * Mamoru-shaped Safe created with its V4 session enabled in its setup (the one-screen sign-up, #294).
 *
 * Flow: the session registers the account's Monad remote (V4 computes it from the account's current owners); USDC is
 * minted to that address on Monad before anything is deployed there; anyone deploys it with V4's factory call; the
 * owners, threshold, passkey, modules and the session bound to V4 read back; then anyone calls `announceReady` on
 * Monad, V4 there reads the remote back and sends a CCTP V2 message to the same V4 on Base, the account's own session
 * relays it (a userOp), and only then does the session bridge to the remote (A1: no guardian, no key). On Monad the
 * remote's own session operates under V4 and can bridge only home. An owner rotation on Base stops every burn until
 * the remote is re-registered and proven ready again.
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
        // #345 P2-2: rule 4 reads the FILLED ring (1,000 at the fork block; 1,800 live today, read 3 Nov): stand in for
        // the blocks that filled it, by writing slot0's observationCardinality (bits 200-215 of slot 0).
        uint256 w = uint256(vm.load(M_POOL, bytes32(0)));
        vm.store(M_POOL, bytes32(0), bytes32((w & ~(uint256(0xffff) << 200)) | (uint256(1800) << 200)));
        // Base
        vm.selectFork(baseFork);
        _deployStack();
        assertEq(address(v4), monadV4, "V4 at the same address on both chains");
        assertEq(address(gasPol), monadGas, "gas policy at the same address");
        assertEq(address(v4.REMOTE_INIT()), monadInit, "MamoruRemoteInit at the same address");
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
        return _batch(_approved(token, amount, address(v4), abi.encodeCall(MamoruActionPolicyV4.bridge, (domain, token, amount, 0))));
    }

    /// A readiness message as the same V4 on `from` would send it, delivered by the pinned transmitter (pranked: the
    /// transmitter's own checks are exercised once, end to end, in test_I4_remoteEndToEnd).
    function _handle(uint32 from, address h, address safe, bytes32 oh) internal {
        vm.prank(MESSAGE_TRANSMITTER);
        v4.handleReceiveFinalizedMessage(from, bytes32(uint256(uint160(address(v4)))), 2000, abi.encode(h, safe, oh));
    }

    /// Registers, deploys on Monad after the mint, reads back, proves ready by CCTP, bridges; the remote works and
    /// bridges home.
    function test_I4_remoteEndToEnd() public {
        assertEq(v4.generationOf(home), 1, "V4 enabled in the home Safe's setup");
        // 1. the session registers the Monad remote
        _run(home, _single(address(v4), abi.encodeCall(MamoruActionPolicyV4.registerRemote, (DOMAIN_MONAD, remoteSk))), homePid);
        MamoruActionPolicyV4.Remote memory r = v4.remoteOf(home, DOMAIN_MONAD);
        assertTrue(r.remote != address(0));
        assertEq(r.ownersHash, helper.ownersHashOf(home));
        (address at, bytes memory createCall) = lens.remoteDeployment(home, DOMAIN_MONAD);
        assertEq(at, r.remote);
        // 2. no burn before it is proven ready (r4 P0)
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
        // 4. Monad: anyone announces; V4 reads all that back itself and sends a CCTP message to Base (A1)
        vm.recordLogs();
        vm.prank(makeAddr("anyone"));
        g = gasleft();
        v4.announceReady(at, DOMAIN_BASE, remoteSk, _remotePid());
        console2.log("announceReady (read back + sendMessage, exec gas)", g - gasleft());
        bytes memory message = _sentMessage(vm.getRecordedLogs());
        // Base: the account's own session relays the message (a userOp, the user pays); V4 accepts it and the session
        // bridges to the remote
        vm.selectFork(baseFork);
        bytes memory a = _attestable(message, 2000);
        bytes memory att = _attest(a);
        _run(home, _single(MESSAGE_TRANSMITTER, abi.encodeWithSignature("receiveMessage(bytes,bytes)", a, att)), homePid);
        assertTrue(v4.isReady(home, DOMAIN_MONAD), "proven ready by the remote chain's V4");
        assertEq(v4.readyOf(home, DOMAIN_MONAD).remote, at);
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
            (uint256 minOut, uint160 limit) = lens.swapBounds(M_POOL, M_USDC, 10e6);
            Execution[] memory xs = _approved(
                M_USDC, 10e6, address(v4), abi.encodeCall(MamoruActionPolicyV4.swap, (SwapParams(M_POOL, M_USDC, 10e6, minOut, limit, vm.getBlockTimestamp())))
            );
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

    /// r3 P0-1: an owner rotation on the home Safe stops every burn (readiness is cleared by the hash change); a
    /// message for the old remote or the old owners is refused; re-registering gives a new remote, owned by the new keys,
    /// that must be proven ready again.
    function test_I4_ownerChangeClearsReadiness() public {
        vm.prank(home);
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        MamoruActionPolicyV4.Remote memory r1 = v4.remoteOf(home, DOMAIN_MONAD);
        _handle(DOMAIN_MONAD, home, r1.remote, r1.ownersHash);
        assertTrue(v4.isReady(home, DOMAIN_MONAD));
        // the owners rotate the EOA key (an owner Safe tx)
        address newKey = makeAddr("new recovery key");
        vm.prank(home);
        ISafeT(home).swapOwner(SHARED_SIGNER, vm.addr(ownerKey), newKey);
        assertFalse(v4.isReady(home, DOMAIN_MONAD), "readiness cleared by the owner change");
        _approveV4(home, USDC, 100e6);
        vm.prank(home);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.RemoteNotReady.selector, DOMAIN_MONAD));
        v4.bridge(DOMAIN_MONAD, USDC, 100e6, 0);
        // the old remote announcing again, under the old owners: refused (stale owners hash)
        vm.prank(MESSAGE_TRANSMITTER);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 6));
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, bytes32(uint256(uint160(address(v4)))), 2000, abi.encode(home, r1.remote, r1.ownersHash));
        vm.prank(home);
        address r2 = v4.registerRemote(DOMAIN_MONAD, remoteSk);
        assertTrue(r2 != r1.remote, "the new owners give a new remote");
        assertFalse(v4.isReady(home, DOMAIN_MONAD), "a registration starts unready");
        (address at,) = lens.remoteDeployment(home, DOMAIN_MONAD);
        assertEq(at, r2);
        vm.prank(MESSAGE_TRANSMITTER);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 5));
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, bytes32(uint256(uint160(address(v4)))), 2000, abi.encode(home, r1.remote, r1.ownersHash));
        _handle(DOMAIN_MONAD, home, r2, v4.remoteOf(home, DOMAIN_MONAD).ownersHash);
        vm.prank(home);
        v4.bridge(DOMAIN_MONAD, USDC, 100e6, 0);
    }

    /// #345 P2-5: the caller names CCTP's maxFee, up to the chain's pinned cap (10 bps of the amount). Above it the burn
    /// is refused; at it the burn carries that maxFee and the ceiling is charged to the account-wide limits (bucket, 24 h,
    /// 30 days); zero passes and charges nothing, as before. Finality stays Standard (2000).
    function test_345_bridgeMaxFeeCappedAndCharged() public {
        vm.prank(home);
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        MamoruActionPolicyV4.Remote memory r = v4.remoteOf(home, DOMAIN_MONAD);
        _handle(DOMAIN_MONAD, home, r.remote, r.ownersHash);
        uint256 amount = 1_000e6;
        assertEq(table.chain(block.chainid).cctpFeeCapBps, 10);
        uint256 cap = amount * 10 / 10_000;
        _approveV4(home, USDC, amount);
        vm.prank(home);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadBridge.selector, 6));
        v4.bridge(DOMAIN_MONAD, USDC, amount, cap + 1);
        (uint256 b0,, uint256 m0, uint256 d0) = v4.budgetLeft(home, TOKEN_MESSENGER, 10_000);
        vm.prank(home);
        v4.bridge(DOMAIN_MONAD, USDC, amount, 0);
        (uint256 b1,, uint256 m1, uint256 d1) = v4.budgetLeft(home, TOKEN_MESSENGER, 10_000);
        assertEq(b1, b0, "zero fee: nothing charged");
        assertEq(d1, d0);
        _approveV4(home, USDC, amount);
        vm.expectCall(
            TOKEN_MESSENGER,
            abi.encodeWithSignature(
                "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
                amount, DOMAIN_MONAD, bytes32(uint256(uint160(r.remote))), USDC, bytes32(0), cap, uint32(2000)
            )
        );
        vm.prank(home);
        v4.bridge(DOMAIN_MONAD, USDC, amount, cap);
        (uint256 b2,, uint256 m2, uint256 d2) = v4.budgetLeft(home, TOKEN_MESSENGER, 10_000);
        assertEq(b2, b1 - cap, "the fee ceiling is charged to the bucket");
        assertEq(m2, m1 - cap, "and to the 30-day cap");
        assertEq(d2, d1 - cap, "and to the 24 h cap");
        assertEq(m1, m0);
    }

    /// I4: registerRemote acts on msg.sender only. Another account computes its own remote from its own owners and
    /// cannot touch the victim's; a message naming the attacker's remote for the victim is refused; a caller with no V4
    /// config cannot register at all; a domain outside the table cannot be registered.
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
        bytes32 victimHash = v4.remoteOf(home, DOMAIN_MONAD).ownersHash;
        vm.prank(MESSAGE_TRANSMITTER);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 5));
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, bytes32(uint256(uint160(address(v4)))), 2000, abi.encode(home, evilRemote, victimHash));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NoConfig.selector, attacker));
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        vm.prank(home);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4Helper.UnknownDomain.selector, 3));
        v4.registerRemote(3, remoteSk); // Arbitrum: not in the table
    }

    /// A1: who may write readiness. Only the pinned transmitter, only for a message from `address(this)` on a table
    /// domain other than this one, only finalized (2000); Fast messages never.
    function test_A1_readinessMessageChecks() public {
        vm.prank(home);
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        MamoruActionPolicyV4.Remote memory r = v4.remoteOf(home, DOMAIN_MONAD);
        bytes memory body = abi.encode(home, r.remote, r.ownersHash);
        bytes32 me = bytes32(uint256(uint160(address(v4))));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 0));
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, me, 2000, body);
        vm.startPrank(MESSAGE_TRANSMITTER);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 1));
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, bytes32(uint256(uint160(attacker))), 2000, body);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 2));
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, me, 1000, body);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 3));
        v4.handleReceiveFinalizedMessage(DOMAIN_BASE, me, 2000, body); // from this chain itself
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 3));
        v4.handleReceiveFinalizedMessage(3, me, 2000, body); // a domain outside the table
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 2));
        v4.handleReceiveUnfinalizedMessage(DOMAIN_MONAD, me, 1000, body);
        // a sibling message (home == safe) for an account that is not a sibling here
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadMessage.selector, 4));
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, me, 2000, abi.encode(home, home, r.ownersHash));
        vm.stopPrank();
        assertFalse(v4.isReady(home, DOMAIN_MONAD));
        _handle(DOMAIN_MONAD, home, r.remote, r.ownersHash);
        assertTrue(v4.isReady(home, DOMAIN_MONAD));
    }

    /// A1: `announceReady` on the remote's chain refuses a look-alike Safe (the victim's owners, another session key so
    /// another initializer), a destination other than the remote's home domain, an address that is not a Safe, and a
    /// Safe without a live V4 session.
    function test_A1_announceReadyRefusals() public {
        vm.prank(home);
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        (address at, bytes memory createCall) = lens.remoteDeployment(home, DOMAIN_MONAD);
        vm.selectFork(monadFork);
        (bool ok,) = SAFE_FACTORY.call(createCall);
        assertTrue(ok);
        bytes32 rp = _remotePid();
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadAnnounce.selector, 4));
        v4.announceReady(at, DOMAIN_BASE, makeAddr("another session key"), rp); // recomputes to another address
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadAnnounce.selector, 3));
        v4.announceReady(at, 0, remoteSk, rp); // not its home domain
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.NoConfig.selector, attacker));
        v4.announceReady(attacker, DOMAIN_BASE, remoteSk, rp); // no V4 session
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadAnnounce.selector, 5));
        v4.announceReady(at, DOMAIN_BASE, remoteSk, keccak256("not its session")); // a permission not enabled there
        vm.recordLogs();
        v4.announceReady(at, DOMAIN_BASE, remoteSk, rp);
        bytes memory m = _sentMessage(vm.getRecordedLogs());
        // the message names V4 as sender and recipient, Base as destination, finality 2000, an open caller
        assertEq(uint32(bytes4(_slice(m, 8, 4))), DOMAIN_BASE, "destination domain");
        assertEq(bytes32(_slice(m, 44, 32)), bytes32(uint256(uint160(address(v4)))), "sender: V4");
        assertEq(bytes32(_slice(m, 76, 32)), bytes32(uint256(uint160(address(v4)))), "recipient: the same V4");
        assertEq(bytes32(_slice(m, 108, 32)), bytes32(0), "open destinationCaller");
        assertEq(uint32(bytes4(_slice(m, 140, 4))), 2000, "finality 2000");
    }

    /// Review r1 of #228: a remote whose V4 session the owner removed (Stop) cannot be announced ready.
    function test_A1_stoppedSafeCannotBeAnnounced() public {
        vm.prank(home);
        v4.registerRemote(DOMAIN_MONAD, remoteSk);
        (address at, bytes memory createCall) = lens.remoteDeployment(home, DOMAIN_MONAD);
        vm.selectFork(monadFork);
        (bool ok,) = SAFE_FACTORY.call(createCall);
        assertTrue(ok);
        bytes32 rp = _remotePid();
        vm.prank(at);
        ISmartSessionT(SMART_SESSION).removeSession(rp); // the owner's Stop on Monad
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadAnnounce.selector, 5));
        v4.announceReady(at, DOMAIN_BASE, remoteSk, rp);
    }

    function _slice(bytes memory b, uint256 o, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(32);
        for (uint256 i; i < n; i++) {
            out[i] = b[o + i];
        }
        assembly {
            mstore(out, 32)
        }
    }

    /// The remote's deployment depends on nothing that can change: deployed 400 days after the mint, it is the same.
    function test_I4_remoteDeploysAnyDay() public {
        vm.prank(home);
        address r = v4.registerRemote(DOMAIN_MONAD, remoteSk);
        (, bytes memory createCall) = lens.remoteDeployment(home, DOMAIN_MONAD);
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
        (address at,) = lens.remoteDeployment(home, DOMAIN_MONAD);
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
