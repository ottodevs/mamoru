// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {V3SetupBase, Session, ActionData, PolicyData, ISafe7579, ISmartSession, IGasPolicy, IERC20} from "./V3SetupFork.t.sol";
import {OnePolicy} from "./OneAuthProbeFork.t.sol";
import {
    MamoruRemoteInit,
    MamoruRemoteSafe,
    ISharedSignerV4,
    ISafeSetupV4,
    ModuleInitV4,
    RegistryInitV4,
    ISafe7579InitV4
} from "../src/MamoruRemoteSafe.sol";

/**
 * otto/mamoru#292 T1b (spec 010 I4): the canonical remote initializer on forks of Base and Monad (anvil semantics, never
 * a live chain). The remote Safe is a plain Safe 1.4.1 setup (the home account's owners, threshold and passkey
 * `configure`) plus Safe7579 and SmartSession with ONE fallback session bound to a stand-in action policy (OnePolicy,
 * T1's; V4 replaces it in test/V4RemoteFork.t.sol) and MamoruGasPolicy as the only userOp policy. USDC is sent to the
 * counterfactual address first (what a CCTP mint does), then anyone deploys it through the permissionless factory, and
 * owners, threshold, (x, y), modules and the session are read back.
 *
 * Two setup steps are compared:
 *  - `SelfAttestRemoteInit`: the spec's wording, exactly. The Safe self-attests SmartSession in the ERC-7484
 *    ModuleRegistry, trusts only itself, and installs SmartSession with the registry check on.
 *  - `MamoruRemoteInit` (src): Safe7579 with no registry at all.
 * Both deploy today. Then the resolver owner of SmartSession's module record (the Rhinestone attester) points the record's
 * resolver UID at a resolver that refuses: the self-attested setup reverts, so funds minted to its address wait on a
 * third party; MamoruRemoteInit's still deploys. Results: specs/010-one-authorization/results/t2-t4-contracts-2026-11-02.md.
 *
 *   nix shell nixpkgs#foundry --command forge test --isolate --match-path test/OneAuthRemoteInitFork.t.sol -vv
 */

interface IModRegT1b {
    struct ModuleRecord {
        bytes32 resolverUID;
        address sender;
        bytes metadata;
    }

    struct ResolverRecord {
        address resolver;
        address resolverOwner;
    }

    struct AttReq {
        address moduleAddress;
        uint48 expirationTime;
        bytes data;
        uint256[] moduleTypes;
    }

    function findModule(address m) external view returns (ModuleRecord memory);
    function findResolver(bytes32 uid) external view returns (ResolverRecord memory);
    function setResolver(bytes32 uid, address resolver) external;
    function attest(bytes32 schemaUID, AttReq[] calldata requests) external;
    function findTrustedAttesters(address account) external view returns (address[] memory);
}

interface ISafeReadT1b {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isModuleEnabled(address module) external view returns (bool);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

/// The spec's literal setup step: self-attestation inside setup, the Safe the only trusted attester.
contract SelfAttestRemoteInit {
    address constant REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    bytes32 constant SCHEMA = 0x93d46fcca4ef7d66a413c7bde08bb1ff14bacbd04c4069bb24cd7c21729d7bf1;
    address constant SAFE7579 = 0x7579EE8307284F293B1927136486880611F20002;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;

    function init(bytes calldata sessions) external {
        // 1. The Safe attests SmartSession as a validator (type 1). msg.sender at the registry is the Safe.
        IModRegT1b.AttReq[] memory reqs = new IModRegT1b.AttReq[](1);
        uint256[] memory types = new uint256[](1);
        types[0] = 1;
        reqs[0] = IModRegT1b.AttReq(SMART_SESSION, 0, "", types);
        IModRegT1b(REGISTRY).attest(SCHEMA, reqs);
        // 2. What Safe7579Launchpad.addSafe7579 does, with the Safe's own address as the only trusted attester (the
        //    launchpad's attester list is calldata, which cannot name the address it is part of: hence this contract).
        ISafeSetupV4(address(this)).enableModule(SAFE7579);
        ModuleInitV4[] memory validators = new ModuleInitV4[](1);
        validators[0] = ModuleInitV4(SMART_SESSION, abi.encodePacked(uint8(2), sessions));
        address[] memory attesters = new address[](1);
        attesters[0] = address(this);
        ModuleInitV4[] memory none = new ModuleInitV4[](0);
        ISafe7579InitV4(address(this)).initializeAccount(validators, none, none, none, RegistryInitV4(REGISTRY, attesters, 1));
    }
}

/// What the resolver owner can install: `onlyResolver` asks only for ERC-165; every resolve call refuses.
contract RefusingResolver {
    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }

    fallback() external payable {
        revert("refused");
    }
}

abstract contract OneAuthRemoteInit is V3SetupBase {
    address constant REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    address constant SHARED_SIGNER = 0x94a4F6affBd8975951142c3999aEAB7ecee555c2;
    address constant P256_VERIFIER = 0xc2b78104907F722DABAc4C69f826a522B2754De4;
    uint256 constant PASSKEY_X = 0x5a47ec1a3d7c5b1e0f6f0b8e6b0b3a5c0f9b0b8d8f3e2a1c4b5d6e7f8091a2b3;
    uint256 constant PASSKEY_Y = 0x0c1d2e3f405162738495a6b7c8d9eafb0c1d2e3f405162738495a6b7c8d9eafb;

    OnePolicy pol;
    address gasPol;
    MamoruRemoteInit rinit;
    SelfAttestRemoteInit sinit;
    address home = makeAddr("home account on the other chain");

    function _usdc() internal pure virtual returns (address);
    function _domain() internal pure virtual returns (uint32);

    function _setUpT1b() internal {
        nowTs = block.timestamp;
        pol = new OnePolicy(SMART_SESSION, address(0));
        gasPol = deployCode("out/MamoruGasPolicy.sol/MamoruGasPolicy.json");
        rinit = new MamoruRemoteInit();
        sinit = new SelfAttestRemoteInit();
        // The factory's proxy creation code is what MamoruRemoteSafe pins (same on both chains).
        (bool ok, bytes memory r) = MamoruRemoteSafe.SAFE_FACTORY.staticcall(abi.encodeWithSignature("proxyCreationCode()"));
        assertTrue(ok);
        assertEq(
            keccak256(abi.encodePacked(abi.decode(r, (bytes)), uint256(uint160(MamoruRemoteSafe.SAFE_SINGLETON)))),
            MamoruRemoteSafe.PROXY_INIT_CODE_HASH,
            "proxy init code hash"
        );
    }

    function _ownerState() internal view returns (MamoruRemoteSafe.OwnerState memory o) {
        o.owners = new address[](2);
        (o.owners[0], o.owners[1]) = (SHARED_SIGNER, vm.addr(ownerKey)); // passkey + a recovery EOA
        o.threshold = 1;
        (o.x, o.y) = (PASSKEY_X, PASSKEY_Y);
        o.verifiers = uint176((uint256(0x100) << 160) | uint160(P256_VERIFIER));
    }

    /// The remote's one session: a fallback action whose only policy is the stand-in, MamoruGasPolicy as userOp policy.
    function _remoteSession() internal view returns (Session memory s) {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(sessionKey);
        s.sessionValidator = OWNABLE_VALIDATOR;
        s.sessionValidatorInitData = abi.encode(uint256(1), signers);
        s.salt = keccak256("mamoru.v4.remote-session");
        s.userOpPolicies = new PolicyData[](1);
        s.userOpPolicies[0] =
            PolicyData(gasPol, abi.encode(IGasPolicy.Caps(10_000_000, 3_000_000, 2_000_000, 200_000, 100_000_000)));
        s.actions = new ActionData[](1);
        s.actions[0].actionTarget = address(1); // FALLBACK_TARGET_FLAG
        s.actions[0].actionTargetSelector = 0x00000001; // FALLBACK_TARGET_SELECTOR_FLAG
        s.actions[0].actionPolicies = new PolicyData[](1);
        s.actions[0].actionPolicies[0] = PolicyData(address(pol), abi.encode(_usdc(), IERC20.approve.selector, false));
    }

    function _saltNonce(MamoruRemoteSafe.OwnerState memory o) internal view returns (uint256) {
        return uint256(keccak256(abi.encode(home, _domain(), MamoruRemoteSafe.ownersHash(o))));
    }

    function _build(address setupStep) internal view returns (bytes memory call, address at) {
        MamoruRemoteSafe.OwnerState memory o = _ownerState();
        Session[] memory ss = new Session[](1);
        ss[0] = _remoteSession();
        bytes memory init = MamoruRemoteSafe.initializer(o, setupStep, abi.encode(ss));
        uint256 salt = _saltNonce(o);
        call = MamoruRemoteSafe.createProxyCall(init, salt);
        at = MamoruRemoteSafe.proxyAddress(init, salt);
    }

    /// Anyone sends the factory call; returns the Safe, or address(0) and the revert data.
    function _deployBy(address who, bytes memory call) internal returns (address safe, uint256 gasUsed, bytes memory err) {
        vm.prank(who);
        uint256 g = gasleft();
        (bool ok, bytes memory r) = SAFE_FACTORY.call(call);
        gasUsed = g - gasleft();
        if (ok) safe = abi.decode(r, (address));
        else err = r;
    }

    function _readBack(address safe) internal view {
        MamoruRemoteSafe.OwnerState memory o = _ownerState();
        assertEq(ISafeReadT1b(safe).getOwners(), o.owners, "owners: the home account's current owners");
        assertEq(ISafeReadT1b(safe).getThreshold(), 1, "threshold");
        ISharedSignerV4.Signer memory s = ISharedSignerV4(SHARED_SIGNER).getConfiguration(safe);
        assertEq(s.x, PASSKEY_X, "passkey x");
        assertEq(s.y, PASSKEY_Y, "passkey y");
        assertEq(uint256(s.verifiers), uint256(o.verifiers), "passkey verifiers");
        assertTrue(ISafeReadT1b(safe).isModuleEnabled(SAFE7579), "Safe7579 enabled as module");
        // The fallback handler slot of Safe 1.4.1: keccak256("fallback_manager.handler.address").
        bytes memory fh = ISafeReadT1b(safe).getStorageAt(
            uint256(0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5), 1
        );
        assertEq(abi.decode(fh, (address)), SAFE7579, "Safe7579 is the fallback handler");
        assertTrue(ISafe7579(safe).isModuleInstalled(1, SMART_SESSION, ""), "SmartSession installed");
        assertTrue(ISmartSession(SMART_SESSION).isPermissionEnabled(_pid(_remoteSession()), safe), "the one session");
        assertEq(IERC20(_usdc()).balanceOf(safe), 100e6, "the minted USDC is the Safe's");
    }

    /// The session works on the deployed remote: the stand-in policy's one allowed call, signed by the session key.
    function _sessionRuns(address safe) internal {
        vm.deal(safe, 1 ether);
        _run(safe, _single(_usdc(), abi.encodeCall(IERC20.approve, (makeAddr("spender"), 1e6))), _pid(_remoteSession()));
    }

    // ---------------------------------------------------------------- the spec's setup: self-attestation inside setup

    function test_selfAttestedSetupDeploysAfterMint() public {
        (bytes memory call, address at) = _build(address(sinit));
        assertEq(at.code.length, 0);
        deal(_usdc(), at, 100e6); // the CCTP mint lands first, on an address with no code
        (address safe, uint256 gasUsed,) = _deployBy(makeAddr("anyone"), call);
        assertEq(safe, at, "deployed at the address the funds wait at");
        _readBack(safe);
        address[] memory trusted = IModRegT1b(REGISTRY).findTrustedAttesters(safe);
        assertEq(trusted.length, 1);
        assertEq(trusted[0], safe, "the Safe is its own only trusted attester");
        _sessionRuns(safe);
        console2.log("self-attested remote setup, factory call gas", gasUsed);
    }

    // ---------------------------------------------------------------- MamoruRemoteInit: no registry

    function test_registrylessSetupDeploysAfterMint() public {
        (bytes memory call, address at) = _build(address(rinit));
        deal(_usdc(), at, 100e6);
        (address safe, uint256 gasUsed,) = _deployBy(makeAddr("anyone"), call);
        assertEq(safe, at);
        _readBack(safe);
        assertEq(IModRegT1b(REGISTRY).findTrustedAttesters(safe).length, 0, "no ERC-7484 trust at all");
        _sessionRuns(safe);
        console2.log("registry-less remote setup, factory call gas", gasUsed);
    }

    /// r2 P0-1, at the registry level: the resolver owner of SmartSession's record can make every attestation of
    /// SmartSession refuse. The self-attested setup then cannot deploy (the funds at its address wait on Rhinestone);
    /// the registry-less one deploys as before.
    function test_resolverOwnerBricksSelfAttestedSetupOnly() public {
        bytes32 uid = IModRegT1b(REGISTRY).findModule(SMART_SESSION).resolverUID;
        IModRegT1b.ResolverRecord memory rr = IModRegT1b(REGISTRY).findResolver(uid);
        console2.log("SmartSession record resolver", rr.resolver);
        console2.log("resolver owner (can setResolver)", rr.resolverOwner);
        assertGt(rr.resolver.code.length, 0, "an external resolver is consulted on every attestation");
        (bytes memory selfCall, address selfAt) = _build(address(sinit));
        (bytes memory freeCall, address freeAt) = _build(address(rinit));
        deal(_usdc(), selfAt, 100e6);
        deal(_usdc(), freeAt, 100e6);

        address refusing = address(new RefusingResolver());
        vm.prank(rr.resolverOwner);
        IModRegT1b(REGISTRY).setResolver(uid, refusing);

        (address s1,, bytes memory err) = _deployBy(makeAddr("anyone"), selfCall);
        assertEq(s1, address(0), "self-attested setup still deploys");
        console2.logBytes(err);
        assertEq(selfAt.code.length, 0, "nothing at the address the funds wait at");
        (address s2,,) = _deployBy(makeAddr("anyone"), freeCall);
        assertEq(s2, freeAt, "registry-less setup deploys whatever the registry does");
        _readBack(s2);
    }

    /// Deployable any day: 400 days after the mint, with the registry's state irrelevant.
    function test_registrylessSetupDeploysYearsLater() public {
        (bytes memory call, address at) = _build(address(rinit));
        deal(_usdc(), at, 100e6);
        vm.warp(block.timestamp + 400 days);
        vm.roll(block.number + 1_000_000);
        (address safe,,) = _deployBy(makeAddr("anyone"), call);
        assertEq(safe, at);
        _readBack(safe);
    }

    /// One address, one Safe: a second deployment reverts; other owners or another home give another address.
    function test_addressBindsOwnersAndHome() public {
        (bytes memory call, address at) = _build(address(rinit));
        (address safe,,) = _deployBy(makeAddr("anyone"), call);
        assertEq(safe, at);
        (address again,,) = _deployBy(makeAddr("other"), call);
        assertEq(again, address(0), "no redeploy");
        MamoruRemoteSafe.OwnerState memory o = _ownerState();
        o.owners[1] = makeAddr("another key");
        Session[] memory ss = new Session[](1);
        ss[0] = _remoteSession();
        bytes memory init2 = MamoruRemoteSafe.initializer(o, address(rinit), abi.encode(ss));
        assertTrue(MamoruRemoteSafe.proxyAddress(init2, _saltNonce(o)) != at, "owners are in the address");
        address h = home;
        home = makeAddr("another home");
        (, address at3) = _build(address(rinit));
        assertTrue(at3 != at, "the home account is in the address");
        home = h;
    }

    /// The setup step is delegatecall-only.
    function test_remoteInitIsDelegatecallOnly() public {
        vm.expectRevert(MamoruRemoteInit.DelegatecallOnly.selector);
        rinit.init("");
    }
}

contract OneAuthRemoteInitBase is OneAuthRemoteInit {
    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), 53_140_000);
        _setUpT1b();
    }

    function _usdc() internal pure override returns (address) {
        return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    }

    function _domain() internal pure override returns (uint32) {
        return 6; // the remote's own CCTP domain: a Base remote of a Monad home
    }
}

contract OneAuthRemoteInitMonad is OneAuthRemoteInit {
    function setUp() public {
        vm.createSelectFork(vm.envOr("MONAD_FORK_RPC_URL", string("https://rpc.monad.xyz")), 116_980_000);
        _setUpT1b();
    }

    function _usdc() internal pure override returns (address) {
        return 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    }

    function _domain() internal pure override returns (uint32) {
        return 15; // a Monad remote of a Base home
    }
}
