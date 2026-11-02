// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {
    V3SetupBase,
    Session,
    ActionData,
    PolicyData,
    ISafe7579,
    ISmartSession,
    IEntryPoint,
    IGasPolicy,
    SetupInit,
    IERC20,
    PackedUserOperation
} from "./V3SetupFork.t.sol";

/**
 * otto/mamoru#291 T1 (spec 010): can ONE long-lived SmartSession session carry a single fallback action whose only
 * action policy is a custom one, with MamoruGasPolicy as the only userOp policy? On forks of Base and Monad against
 * the deployed SmartSession 0x00000000002B0eCfbD0496EE71e01257dA0E37DE (same code hash on both chains). Anvil
 * semantics, never a live chain. Results: specs/010-one-authorization/results/t1-smartsession-probe-2026-11-02.md.
 *
 * Run with `--isolate` so every top-level call is its own transaction (cold state, real gas):
 *   nix shell nixpkgs#foundry --command forge test --isolate --match-path test/OneAuthProbeFork.t.sol -vv
 *
 * The flow is the production one (packages/account/sessions): the Safe's owner trusts the Rhinestone attester and
 * itself, self-attests the policies, then calls SmartSession.enableSessions from a Safe transaction. Policies are
 * deployed through ModuleRegistry.deployModule so they have a ModuleRecord.
 */

/// Six storage words, read by one view call: stands in for the registry entry V4 would read on each check.
contract SixLoads {
    uint256[6] public w;

    constructor() {
        for (uint256 i; i < 6; i++) {
            w[i] = i + 1;
        }
    }

    function read() external view returns (uint256 s) {
        s = w[0] + w[1] + w[2] + w[3] + w[4] + w[5];
    }
}

/// The trivial action policy: success only for the one (target, selector) fixed at init. `extra` adds one STATICCALL
/// to SixLoads before deciding (task 3).
contract OnePolicy {
    struct Rule {
        address target;
        bytes4 selector;
        bool extra;
    }

    address public immutable SMART_SESSION;
    address public immutable EXTRA;
    mapping(address account => mapping(bytes32 configId => Rule)) public rules;

    constructor(address smartSession, address extra) {
        SMART_SESSION = smartSession;
        EXTRA = extra;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == this.checkAction.selector || id == this.initializeWithMultiplexer.selector;
    }

    function initializeWithMultiplexer(address account, bytes32 configId, bytes calldata initData) external {
        (address target, bytes4 sel, bool extra) = abi.decode(initData, (address, bytes4, bool));
        rules[account][configId] = Rule(target, sel, extra);
    }

    function checkAction(bytes32 id, address account, address target, uint256, bytes calldata data)
        external
        view
        returns (uint256)
    {
        if (msg.sender != SMART_SESSION) return 1;
        Rule memory r = rules[account][id];
        if (r.target == address(0)) return 1;
        if (r.extra) {
            (bool ok, bytes memory ret) = EXTRA.staticcall(abi.encodeWithSelector(SixLoads.read.selector));
            if (!ok || ret.length != 32) return 1;
        }
        if (target != r.target || data.length < 4 || bytes4(data[:4]) != r.selector) return 1;
        return 0;
    }
}

interface IModReg {
    struct ModuleRecord {
        bytes32 resolverUID;
        address sender;
        bytes metadata;
    }

    struct AttReq {
        address moduleAddress;
        uint48 expirationTime;
        bytes data;
        uint256[] moduleTypes;
    }

    function findModule(address m) external view returns (ModuleRecord memory);
    function deployModule(bytes32 salt, bytes32 resolverUID, bytes calldata initCode, bytes calldata md, bytes calldata rc)
        external
        payable
        returns (address);
    function attest(bytes32 schemaUID, AttReq[] calldata requests) external;
    function trustAttesters(uint8 threshold, address[] calldata attesters) external;
}

interface ISafeExec {
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
}

interface ISSAdmin {
    function enableSessions(Session[] calldata sessions) external returns (bytes32[] memory);
    function removeSession(bytes32 permissionId) external;
}

abstract contract OneAuthProbe is V3SetupBase {
    address constant REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    bytes32 constant SCHEMA = 0x93d46fcca4ef7d66a413c7bde08bb1ff14bacbd04c4069bb24cd7c21729d7bf1;
    address constant FALLBACK_FLAG = address(1);
    bytes4 constant FALLBACK_SEL = 0x00000001;
    bytes32 constant FALLBACK_ACTIONID = 0xd884b6afa19f8ace90a388daca691e4e28f20cdac5aeefd46ad8bd1c074d28cf;
    bytes32 constant SS_CODEHASH = 0xf2817b8943b9fc813ad3602de2f0b973dc6b7e190f1b77dc9eb02b8d3022ab0c;

    address safe;
    address gasPol;
    OnePolicy onePol;
    OnePolicy onePolExtra;
    SixLoads sixLoads;
    bytes32 resolverUID;

    function _usdc() internal pure virtual returns (address);
    function _other() internal pure virtual returns (address); // a second token, for "different target"
    function _router() internal pure virtual returns (address);

    function _probeSetUp() internal {
        setupInit = new SetupInit(SMART_SESSION);
        nowTs = block.timestamp;
        resolverUID = IModReg(REGISTRY).findModule(TIME_FRAME).resolverUID;
        sixLoads = new SixLoads();
        gasPol = _deployModule(vm.getCode("out/MamoruGasPolicy.sol/MamoruGasPolicy.json"), 1);
        onePol = OnePolicy(_deployModule(abi.encodePacked(type(OnePolicy).creationCode, abi.encode(SMART_SESSION, address(sixLoads))), 2));
        onePolExtra = OnePolicy(_deployModule(abi.encodePacked(type(OnePolicy).creationCode, abi.encode(SMART_SESSION, address(sixLoads))), 3));
        (safe,) = _deploy(_deployCall(new Session[](0), 5), 40_000_000);
        require(safe != address(0), "safe");
        require(ISafe7579(safe).isModuleInstalled(1, SMART_SESSION, ""), "SmartSession installed (empty)");
        vm.deal(safe, 1 ether);
        vm.deal(vm.addr(ownerKey), 1 ether);
        assertEq(SMART_SESSION.codehash, SS_CODEHASH, "SmartSession code hash equals the registry pin");
    }

    function _deployModule(bytes memory initCode, uint256 salt) internal returns (address m) {
        vm.prank(makeAddr("deployer"));
        m = IModReg(REGISTRY).deployModule(bytes32(salt), resolverUID, initCode, "", "");
    }

    // ---------------------------------------------------------------- owner Safe transactions

    function _ownerTx(address to, bytes memory data, uint8 op) internal returns (bool) {
        address o = vm.addr(ownerKey);
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(o))), bytes32(0), uint8(1));
        vm.prank(o);
        return ISafeExec(safe).execTransaction(to, 0, data, op, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    /// One owner tx; logs gas as the transaction costs (lastCallGas under --isolate: intrinsic included).
    function _gasTx(string memory label, address to, bytes memory data, uint8 op) internal returns (uint256 total) {
        uint256 g0 = gasleft();
        _ownerTx(to, data, op);
        uint256 delta = g0 - gasleft();
        total = vm.lastCallGas().gasTotalUsed;
        console2.log(label);
        console2.log("  gasUsed (lastCallGas, tx incl. intrinsic)", total);
        console2.log("  gas spent in test frame (exec only)", delta);
    }

    function _ms(uint8 op, address to, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(op, to, uint256(0), data.length, data);
    }

    function _trustAttest(address[] memory modules) internal returns (uint256 total) {
        address[] memory att = new address[](2);
        (address a, address b) = (ATTESTER, safe);
        (att[0], att[1]) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        IModReg.AttReq[] memory reqs = new IModReg.AttReq[](modules.length);
        for (uint256 i; i < modules.length; i++) {
            reqs[i] = IModReg.AttReq(modules[i], 0, "", new uint256[](0));
        }
        bytes memory packed = abi.encodePacked(
            _ms(0, REGISTRY, abi.encodeCall(IModReg.trustAttesters, (1, att))),
            _ms(0, REGISTRY, abi.encodeCall(IModReg.attest, (SCHEMA, reqs)))
        );
        total = _gasTx("trustAttesters + self-attest", MULTISEND, abi.encodeWithSignature("multiSend(bytes)", packed), 1);
    }

    function _enable(Session[] memory s) internal returns (uint256) {
        return _gasTx("enableSessions (Safe tx)", SMART_SESSION, abi.encodeCall(ISSAdmin.enableSessions, (s)), 0);
    }

    function _attestDefault() internal {
        address[] memory m = new address[](4);
        (m[0], m[1], m[2], m[3]) = (gasPol, address(onePol), address(onePolExtra), TIME_FRAME);
        _trustAttest(m);
    }

    // ---------------------------------------------------------------- sessions

    function _gasUop() internal view returns (PolicyData memory) {
        return PolicyData(gasPol, abi.encode(IGasPolicy.Caps(10_000_000, 3_000_000, 2_000_000, 200_000, 100_000_000)));
    }

    function _fallbackSession(OnePolicy pol, address target, bytes4 sel, PolicyData[] memory uop, bytes32 salt)
        internal
        view
        returns (Session memory s)
    {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(sessionKey);
        s.sessionValidator = OWNABLE_VALIDATOR;
        s.sessionValidatorInitData = abi.encode(uint256(1), signers);
        s.salt = salt;
        s.userOpPolicies = uop;
        s.actions = new ActionData[](1);
        s.actions[0].actionTarget = FALLBACK_FLAG;
        s.actions[0].actionTargetSelector = FALLBACK_SEL;
        s.actions[0].actionPolicies = new PolicyData[](1);
        s.actions[0].actionPolicies[0] = PolicyData(address(pol), abi.encode(target, sel, address(pol) == address(onePolExtra)));
    }

    function _gasOnly() internal view returns (PolicyData[] memory u) {
        u = new PolicyData[](1);
        u[0] = _gasUop();
    }

    function _approveCall(address token) internal view returns (bytes memory) {
        return _single(token, abi.encodeCall(IERC20.approve, (_router(), 1e6)));
    }

    // ---------------------------------------------------------------- Q1: fallback action support

    function test_q1_bytecodeCarriesFallbackFlags() public view {
        bytes memory c = SMART_SESSION.code;
        assertTrue(_has32(c, FALLBACK_ACTIONID), "FALLBACK_ACTIONID constant in the deployed bytecode");
        // FALLBACK_TARGET_FLAG = address(1), FALLBACK_TARGET_SELECTOR_FLAG = 0x00000001 are immediates (PUSH1 0x01 / PUSH4).
        console2.log("SmartSession codehash == registry pin; FALLBACK_ACTIONID constant found in runtime code");
    }

    function test_q1_fallbackSessionAllowedCallValidatesAndExecutes() public {
        _attestDefault();
        Session[] memory ss = new Session[](1);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, _gasOnly(), bytes32(uint256(0xa1)));
        _enable(ss);
        bytes32 pid = _pid(ss[0]);
        assertTrue(ISmartSession(SMART_SESSION).isPermissionEnabled(pid, safe), "session enabled");
        uint256 gas = _run(safe, _approveCall(_usdc()), pid);
        console2.log("allowed userOp (USDC.approve) handleOps gas", gas);
        (bool ok, bytes memory r) = _usdc().staticcall(abi.encodeWithSignature("allowance(address,address)", safe, _router()));
        assertTrue(ok);
        assertEq(abi.decode(r, (uint256)), 1e6, "approve executed");
    }

    function test_q1_fallbackSessionRefusesOtherTargetAndOtherSelector() public {
        _attestDefault();
        Session[] memory ss = new Session[](1);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, _gasOnly(), bytes32(uint256(0xa2)));
        _enable(ss);
        bytes32 pid = _pid(ss[0]);
        string memory r1 = _rejected(safe, _approveCall(_other()), pid);
        console2.log("different target refused:", r1);
        string memory r2 = _rejected(safe, _single(_usdc(), abi.encodeWithSignature("transfer(address,uint256)", attacker, 1)), pid);
        console2.log("different selector refused:", r2);
        // The generic fallback does not open the SmartSession module itself (FALLBACK_ACTIONID_SMARTSESSION_CALL).
        string memory r3 = _rejected(safe, _single(SMART_SESSION, abi.encodeCall(ISSAdmin.removeSession, (pid))), pid);
        console2.log("call to SmartSession itself refused:", r3);
        // Same selector and target but a batch that also carries a forbidden call: all-or-nothing.
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(_usdc(), 0, abi.encodeCall(IERC20.approve, (_router(), 1)));
        xs[1] = Execution(_other(), 0, abi.encodeCall(IERC20.approve, (_router(), 1)));
        string memory r4 = _rejected(safe, _batch(xs), pid);
        console2.log("batch with one forbidden call refused:", r4);
    }

    // ---------------------------------------------------------------- Q2: userOp policies

    function test_q2_gasPolicyOnly_enablesAndValidates() public {
        // Same as q1 allowed (userOpPolicies = [MamoruGasPolicy]); this one also reads the exact policy lists.
        _attestDefault();
        Session[] memory ss = new Session[](1);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, _gasOnly(), bytes32(uint256(0xb1)));
        assertEq(ss[0].userOpPolicies.length, 1);
        _enable(ss);
        _run(safe, _approveCall(_usdc()), _pid(ss[0]));
        console2.log("userOpPolicies=[MamoruGasPolicy], fallback action: enabled and validated, no NoPoliciesSet");
    }

    function test_q2_noUserOpPolicyAtAll_enablesAndValidates() public {
        _attestDefault();
        Session[] memory ss = new Session[](1);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, new PolicyData[](0), bytes32(uint256(0xb2)));
        _enable(ss);
        _run(safe, _approveCall(_usdc()), _pid(ss[0]));
        console2.log("userOpPolicies=[] : enabled and validated too (userOp minPolicies is 0)");
    }

    function test_q2_noActionPolicy_revertsAtUse() public {
        // Probe the error SmartSession gives when the fallback action has NO action policy (NoPoliciesSet territory).
        _attestDefault();
        Session[] memory ss = new Session[](1);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, _gasOnly(), bytes32(uint256(0xb3)));
        ss[0].actions[0].actionPolicies = new PolicyData[](0);
        vm.prank(safe);
        (bool ok, bytes memory err) = SMART_SESSION.call(abi.encodeCall(ISSAdmin.enableSessions, (ss)));
        console2.log("enable with fallback action carrying zero policies ok?", ok);
        if (!ok) {
            console2.logBytes4(bytes4(err));
            console2.logBytes(err);
            return;
        }
        string memory r = _rejected(safe, _approveCall(_usdc()), _pid(ss[0]));
        console2.log("use of that session refused at validation:", r);
    }

    function test_q2_timeFrameZeroMeansNoUpperBound() public {
        _attestDefault();
        PolicyData[] memory u = new PolicyData[](2);
        u[0] = PolicyData(TIME_FRAME, abi.encodePacked(uint128(0), uint128(nowTs - 60))); // validUntil = 0, validAfter set
        u[1] = _gasUop();
        PolicyData[] memory u0 = new PolicyData[](2);
        u0[0] = PolicyData(TIME_FRAME, abi.encodePacked(uint128(0), uint128(0))); // both zero
        u0[1] = _gasUop();
        PolicyData[] memory u2 = new PolicyData[](2);
        u2[0] = PolicyData(TIME_FRAME, abi.encodePacked(uint128(nowTs + 1 days), uint128(nowTs - 60)));
        u2[1] = _gasUop();
        Session[] memory ss = new Session[](3);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, u, bytes32(uint256(0xc1)));
        ss[1] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, u0, bytes32(uint256(0xc2)));
        ss[2] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, u2, bytes32(uint256(0xc3)));
        _enable(ss); // all three enable without revert, including (0,0)
        _run(safe, _approveCall(_usdc()), _pid(ss[0]));
        console2.log("TimeFrame(validUntil=0, validAfter=now-60): valid now");
        string memory r0 = _rejected(safe, _approveCall(_usdc()), _pid(ss[1]));
        console2.log("TimeFrame(0, 0) refused at validation (policy reads as not initialized):", r0);
        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + 3650 days);
        _run(safe, _approveCall(_usdc()), _pid(ss[0]));
        console2.log("TimeFrame(validUntil=0, validAfter>0): still valid 10 years later => 0 = no upper bound on chain");
        string memory r = _rejected(safe, _approveCall(_usdc()), _pid(ss[2]));
        console2.log("control TimeFrame(validUntil=now+1d): refused after 10 years:", r);
        vm.revertToState(snap);
    }

    /// Calls TimeFramePolicy.checkUserOpPolicy as SmartSession would, for one (validUntil, validAfter), and logs the
    /// returned validation data or the exact revert data. 
    function _tfProbe(uint128 until_, uint128 after_, bytes32 salt) internal {
        PolicyData[] memory u = new PolicyData[](2);
        u[0] = PolicyData(TIME_FRAME, abi.encodePacked(until_, after_));
        u[1] = _gasUop();
        Session[] memory ss = new Session[](1);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, u, salt);
        _enable(ss);
        bytes32 cfg = keccak256(abi.encodePacked(safe, _pid(ss[0])));
        PackedUserOperation memory op;
        op.sender = safe;
        vm.prank(SMART_SESSION);
        (bool ok, bytes memory ret) = TIME_FRAME.call(
            abi.encodeWithSignature("checkUserOpPolicy(bytes32,(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))", cfg, op)
        );
        console2.log("validUntil", uint256(until_));
        console2.log("validAfter", uint256(after_));
        console2.log("  checkUserOpPolicy as SmartSession ok?", ok);
        console2.logBytes(ret);
    }

    function test_q2_timeFrameProbe() public {
        _attestDefault();
        _tfProbe(0, 0, bytes32(uint256(0x71)));
        _tfProbe(0, uint128(nowTs - 60), bytes32(uint256(0x72)));
        _tfProbe(uint128(nowTs + 365 days), uint128(nowTs - 60), bytes32(uint256(0x73)));
    }

    // ---------------------------------------------------------------- Q3: gas

    function test_q3_gasTrustAttestAndEnableOneFallbackSession() public {
        _attestDefault(); // logs the trust + attest cost (once per account)
        Session[] memory ss = new Session[](1);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, _gasOnly(), bytes32(uint256(0xd1)));
        console2.log("-- enable ONE fallback session, userOp=[MamoruGasPolicy], 1 action policy");
        _enable(ss);
    }

    function test_q3_gasEnableTimeFrameVariant() public {
        _attestDefault();
        PolicyData[] memory u = new PolicyData[](2);
        u[0] = PolicyData(TIME_FRAME, abi.encodePacked(uint128(0), uint128(0)));
        u[1] = _gasUop();
        Session[] memory ss = new Session[](1);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, u, bytes32(uint256(0xd2)));
        console2.log("-- enable ONE fallback session, userOp=[TimeFrame(0,0), MamoruGasPolicy]");
        _enable(ss);
    }

    /// A session shaped like today's biggest (conservador-live-v6 manage-any: 9 actions, 1 action policy each,
    /// TimeFrame + MamoruGasPolicy). removeSession does not call the policies, so only the counts matter.
    function _nineActionSession(bytes32 salt, uint256 nActions) internal view returns (Session memory s) {
        PolicyData[] memory u = new PolicyData[](2);
        u[0] = PolicyData(TIME_FRAME, abi.encodePacked(uint128(nowTs + 365 days), uint128(nowTs - 60)));
        u[1] = _gasUop();
        s = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, u, salt);
        s.actions = new ActionData[](nActions);
        for (uint256 i; i < nActions; i++) {
            s.actions[i].actionTarget = address(uint160(0x1000 + i));
            s.actions[i].actionTargetSelector = bytes4(uint32(0x095ea7b3 + i));
            s.actions[i].actionPolicies = new PolicyData[](1);
            s.actions[i].actionPolicies[0] = PolicyData(address(onePol), abi.encode(_usdc(), IERC20.approve.selector, false));
        }
    }

    function test_q3_gasRemoveSession() public {
        _attestDefault();
        Session[] memory ss = new Session[](3);
        ss[0] = _nineActionSession(bytes32(uint256(0xe1)), 9);
        ss[1] = _nineActionSession(bytes32(uint256(0xe2)), 3);
        ss[2] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, _gasOnly(), bytes32(uint256(0xe3)));
        console2.log("-- enable 9-action v6-shaped session (for reference)");
        _enable(_slice(ss, 0));
        _enable(_slice(ss, 1));
        _enable(_slice(ss, 2));
        console2.log("-- removeSession: 9-action session (TimeFrame + Gas userOp policies)");
        _gasTx("removeSession(9 actions)", SMART_SESSION, abi.encodeCall(ISSAdmin.removeSession, (_pid(ss[0]))), 0);
        console2.log("-- removeSession: 3-action session");
        _gasTx("removeSession(3 actions)", SMART_SESSION, abi.encodeCall(ISSAdmin.removeSession, (_pid(ss[1]))), 0);
        console2.log("-- removeSession: the fallback session (1 action)");
        _gasTx("removeSession(fallback)", SMART_SESSION, abi.encodeCall(ISSAdmin.removeSession, (_pid(ss[2]))), 0);
        assertFalse(ISmartSession(SMART_SESSION).isPermissionEnabled(_pid(ss[0]), safe), "removed");
    }

    function test_q3_gasMigrationBatch_removeThreeThenEnableFallback() public {
        // The migration shape of spec 010: ONE Safe tx (MultiSend) = removeSession x N + enableSessions(fallback).
        _attestDefault();
        Session[] memory old = new Session[](3);
        old[0] = _nineActionSession(bytes32(uint256(0xf1)), 9);
        old[1] = _nineActionSession(bytes32(uint256(0xf2)), 9);
        old[2] = _nineActionSession(bytes32(uint256(0xf3)), 3);
        _enable(old);
        Session[] memory nu = new Session[](1);
        nu[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, _gasOnly(), bytes32(uint256(0xf9)));
        bytes memory packed = abi.encodePacked(
            _ms(0, SMART_SESSION, abi.encodeCall(ISSAdmin.removeSession, (_pid(old[0])))),
            _ms(0, SMART_SESSION, abi.encodeCall(ISSAdmin.removeSession, (_pid(old[1])))),
            _ms(0, SMART_SESSION, abi.encodeCall(ISSAdmin.removeSession, (_pid(old[2])))),
            _ms(0, SMART_SESSION, abi.encodeCall(ISSAdmin.enableSessions, (nu)))
        );
        _gasTx("migration tx: removeSession x3 (9+9+3 actions) + enable 1 fallback session", MULTISEND,
            abi.encodeWithSignature("multiSend(bytes)", packed), 1);
        assertTrue(ISmartSession(SMART_SESSION).isPermissionEnabled(_pid(nu[0]), safe));
        assertFalse(ISmartSession(SMART_SESSION).isPermissionEnabled(_pid(old[0]), safe));
    }

    function test_q3_extraStaticcallValidationGas() public {
        _attestDefault();
        Session[] memory ss = new Session[](2);
        ss[0] = _fallbackSession(onePol, _usdc(), IERC20.approve.selector, _gasOnly(), bytes32(uint256(0x91)));
        ss[1] = _fallbackSession(onePolExtra, _usdc(), IERC20.approve.selector, _gasOnly(), bytes32(uint256(0x92)));
        _enable(ss);
        uint256 snap = vm.snapshotState();
        uint256 plain = _run(safe, _approveCall(_usdc()), _pid(ss[0]));
        vm.revertToState(snap);
        uint256 withExtra = _run(safe, _approveCall(_usdc()), _pid(ss[1]));
        console2.log("handleOps gas, checkAction without extra call", plain);
        console2.log("handleOps gas, checkAction + STATICCALL (6 SLOADs, cold)", withExtra);
        console2.log("delta (cold contract access + 6 cold SLOADs + call overhead)", withExtra - plain);
        // direct measurement of checkAction, cold, as its own tx
        bytes32 cfg = bytes32(uint256(1));
        vm.prank(SMART_SESSION);
        onePolExtra.initializeWithMultiplexer(safe, cfg, abi.encode(_usdc(), IERC20.approve.selector, true));
        vm.prank(SMART_SESSION);
        onePol.initializeWithMultiplexer(safe, cfg, abi.encode(_usdc(), IERC20.approve.selector, false));
        bytes memory d = abi.encodeCall(IERC20.approve, (_router(), 1e6));
        vm.prank(SMART_SESSION);
        uint256 r0 = onePol.checkAction(cfg, safe, _usdc(), 0, d);
        uint256 g0 = vm.lastCallGas().gasTotalUsed;
        vm.prank(SMART_SESSION);
        uint256 r1 = onePolExtra.checkAction(cfg, safe, _usdc(), 0, d);
        uint256 g1 = vm.lastCallGas().gasTotalUsed;
        assertEq(r0 + r1, 0);
        console2.log("checkAction tx gas, no extra call (incl. 21k intrinsic)", g0);
        console2.log("checkAction tx gas, with extra call (incl. 21k intrinsic)", g1);
        console2.log("extra STATICCALL cost (Ethereum schedule)", g1 - g0);
    }

    // ---------------------------------------------------------------- utils

    function _slice(Session[] memory a, uint256 i) internal pure returns (Session[] memory r) {
        r = new Session[](1);
        r[0] = a[i];
    }

    function _has32(bytes memory hay, bytes32 needle) internal pure returns (bool) {
        if (hay.length < 32) return false;
        for (uint256 i; i + 32 <= hay.length; i++) {
            bytes32 w;
            assembly {
                w := mload(add(add(hay, 32), i))
            }
            if (w == needle) return true;
        }
        return false;
    }
}

contract OneAuthProbeBase is OneAuthProbe {
    uint256 constant FORK_BLOCK = 53_140_000;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), FORK_BLOCK);
        console2.log("Base fork block", block.number, "timestamp", block.timestamp);
        _probeSetUp();
    }

    function _usdc() internal pure override returns (address) {
        return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    }

    function _other() internal pure override returns (address) {
        return 0x4200000000000000000000000000000000000006; // WETH
    }

    function _router() internal pure override returns (address) {
        return 0x2626664c2603336E57B271c5C0b26F421741e481;
    }
}

contract OneAuthProbeMonad is OneAuthProbe {
    uint256 constant FORK_BLOCK = 116_980_000;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MONAD_FORK_RPC_URL", string("https://rpc.monad.xyz")), FORK_BLOCK);
        console2.log("Monad fork block", block.number, "timestamp", block.timestamp);
        _probeSetUp();
    }

    function _usdc() internal pure override returns (address) {
        return 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    }

    function _other() internal pure override returns (address) {
        return 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A; // WMON
    }

    function _router() internal pure override returns (address) {
        return 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
    }
}
