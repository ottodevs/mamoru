// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {V4Fixture, IERC20T, ISmartSessionT} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, InitV4} from "../src/MamoruActionPolicyV4.sol";
import {Session, PolicyData, ActionData} from "../src/SmartSessionTypes.sol";
import {RegisterRemoteRules} from "./RegisterRemoteRules.sol";

/**
 * otto/mamoru#356 (R7) on a Base fork, through SmartSession and EntryPoint v0.7: with a fallback-only V4 session, the
 * session key can call `V4.registerRemote(domain, key)` with ANY key, so a leaked key registers a remote whose session
 * is its own and bridges the balance there. The home session therefore carries a second action, `(V4, registerRemote)`,
 * whose policies are V4 (same Init: generation retirement, no native value) and UniActionPolicy pinning the domain and
 * the remote session key the operator's remote peer gave (`packages/account/one-auth` v4HomeSession). SmartSession
 * checks a call against its own (target, selector) action when one is enabled and never falls back for it, so every
 * other call still goes through the fallback, V4 alone.
 *
 *   nix shell nixpkgs#foundry --command forge test --match-path test/V4RegisterRemoteFork.t.sol -vv
 */
contract V4RegisterRemoteForkTest is V4Fixture {
    address constant UNI_ACTION_POLICY = 0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F;
    uint32 constant DOMAIN_ETHEREUM = 0;

    address safe;
    address remoteKey;
    address attackerKey;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), BASE_BLOCK);
        _deployStackViaModuleRegistry();
        safe = _newSafe(1);
        deal(USDC, safe, 100_000e6);
        remoteKey = makeAddr("remote session key the Monad operator gave");
        attackerKey = makeAddr("a key the attacker holds");
    }

    function _pinned(uint32 domain, address key) internal pure returns (bytes memory) {
        return RegisterRemoteRules.pinned(domain, key);
    }

    function _none() internal pure returns (bytes memory) {
        return RegisterRemoteRules.none();
    }

    /// The home session of generation `gen` with the (V4, registerRemote) action: V4 (Init with no admit) + UniActionPolicy.
    function _homeSession(uint64 gen, bytes memory uni) internal view returns (Session memory s) {
        s = _v4Session(C, gen, new uint256[](0), _baseCaps(), keccak256(abi.encodePacked("mamoru.v4.home-session", gen)));
        ActionData[] memory acts = new ActionData[](2);
        acts[0] = s.actions[0];
        acts[1].actionTarget = address(v4);
        acts[1].actionTargetSelector = MamoruActionPolicyV4.registerRemote.selector;
        acts[1].actionPolicies = new PolicyData[](2);
        acts[1].actionPolicies[0] = PolicyData(address(v4), abi.encode(InitV4(C, gen, address(0), 0, new uint256[](0))));
        acts[1].actionPolicies[1] = PolicyData(UNI_ACTION_POLICY, uni);
        s.actions = acts;
    }

    function _register(uint32 domain, address key) internal view returns (bytes memory) {
        return _single(address(v4), abi.encodeCall(MamoruActionPolicyV4.registerRemote, (domain, key)));
    }

    // ------------------------------------------------------------ the finding

    /// R7 as found: the fallback-only session lets the session key register a remote for any key.
    function test_fallbackOnlySession_leakedKeyRegistersItsOwnRemote() public {
        (bytes32 pid,) = _enableV4(safe, _v4Session(C, 1, new uint256[](0), _baseCaps(), bytes32(uint256(0x4))));
        _run(safe, _register(DOMAIN_MONAD, attackerKey), pid);
        assertEq(v4.remoteOf(safe, DOMAIN_MONAD).sessionKey, attackerKey, "the attacker's key is the remote's session");
    }

    // ------------------------------------------------------------ the fix

    function test_pinned_leakedKeyCannotRegisterItsOwnKey() public {
        (bytes32 pid,) = _enableV4(safe, _homeSession(1, _pinned(DOMAIN_MONAD, remoteKey)));
        _rejected(safe, _register(DOMAIN_MONAD, attackerKey), pid);
        assertEq(v4.remoteOf(safe, DOMAIN_MONAD).remote, address(0), "nothing registered");
    }

    function test_pinned_otherDomainRefused() public {
        (bytes32 pid,) = _enableV4(safe, _homeSession(1, _pinned(DOMAIN_MONAD, remoteKey)));
        _rejected(safe, _register(DOMAIN_ETHEREUM, remoteKey), pid);
    }

    /// The legitimate flow: the pinned key registers, the remote is proven ready, the fallback still serves clock,
    /// approvals, bridge and assertZero, and a re-registration of the same key (owner rotation) passes.
    function test_pinned_operatorRegistersThenBridges() public {
        (bytes32 pid,) = _enableV4(safe, _homeSession(1, _pinned(DOMAIN_MONAD, remoteKey)));
        _run(safe, _register(DOMAIN_MONAD, remoteKey), pid);
        MamoruActionPolicyV4.Remote memory r = v4.remoteOf(safe, DOMAIN_MONAD);
        assertEq(r.sessionKey, remoteKey);
        vm.prank(v4.MESSAGE_TRANSMITTER());
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, bytes32(uint256(uint160(address(v4)))), 2000, abi.encode(safe, r.remote, r.ownersHash));
        assertTrue(v4.isReady(safe, DOMAIN_MONAD));
        uint256 u0 = IERC20T(USDC).balanceOf(safe);
        _run(safe, _batch(_approved(USDC, 100e6, address(v4), abi.encodeCall(MamoruActionPolicyV4.bridge, (DOMAIN_MONAD, USDC, 100e6, 0)))), pid);
        assertEq(u0 - IERC20T(USDC).balanceOf(safe), 100e6, "bridged to the registered remote");
        _run(safe, _register(DOMAIN_MONAD, remoteKey), pid);
        assertEq(v4.remoteOf(safe, DOMAIN_MONAD).sessionKey, remoteKey);
    }

    function test_none_noRegistrationAtAll() public {
        (bytes32 pid,) = _enableV4(safe, _homeSession(1, _none()));
        _rejected(safe, _register(DOMAIN_MONAD, remoteKey), pid);
        _rejected(safe, _register(DOMAIN_MONAD, attackerKey), pid);
        // the rest of the session is untouched: the fallback still serves an approval and its assertZero
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeWithSelector(0x095ea7b3, address(v4), uint256(0)));
        xs[1] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.assertZero, (USDC)));
        _run(safe, _batch(xs), pid);
    }

    /// A re-grant (generation 2, owner-enabled) retires generation 1 in the registerRemote action too: V4 is one of its
    /// policies, so the old session's key cannot register even the key it was pinned to.
    function test_regrant_retiresOldSessionsRegistration() public {
        (bytes32 pid1,) = _enableV4(safe, _homeSession(1, _pinned(DOMAIN_MONAD, remoteKey)));
        Session[] memory ss = new Session[](1);
        ss[0] = _homeSession(2, _pinned(DOMAIN_MONAD, remoteKey));
        _ownerTx(safe, SMART_SESSION, abi.encodeCall(ISmartSessionT.enableSessions, (ss)), 0);
        assertEq(v4.generationOf(safe), 2);
        _rejected(safe, _register(DOMAIN_MONAD, remoteKey), pid1);
        _run(safe, _register(DOMAIN_MONAD, remoteKey), _pid(ss[0]));
    }

    /// The owners may still register a remote themselves (an owner Safe tx), for any key they choose.
    function test_ownersRegisterDirectly() public {
        _enableV4(safe, _homeSession(1, _none()));
        assertTrue(_ownerTx(safe, address(v4), abi.encodeCall(MamoruActionPolicyV4.registerRemote, (DOMAIN_MONAD, remoteKey)), 0), "owner tx");
        assertEq(v4.remoteOf(safe, DOMAIN_MONAD).sessionKey, remoteKey);
    }
}
