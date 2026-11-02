// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Vm, console2} from "forge-std/Test.sol";
import {V4Fixture, IERC20T, INPMT, IRouterT, ISmartSessionT, IModRegT, IEntryPointT, ISafeT} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, SwapParams, MintParams, ExactInputSingleParams} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruMigrationCheck} from "../src/MamoruMigrationCheck.sol";
import {ConfigIdV4, PackedUserOperationV4, Session, PolicyData, ActionData} from "../src/SmartSessionTypes.sol";

/// Stand-in for the v2-v6 action policies of the old sessions a migration removes (removeSession never calls them).
contract OldPolicy {
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == this.checkAction.selector || id == this.initializeWithMultiplexer.selector;
    }

    function initializeWithMultiplexer(address, bytes32, bytes calldata) external {}

    function checkAction(bytes32, address, address, uint256, bytes calldata) external pure returns (uint256) {
        return 0;
    }
}

/**
 * Spec 010 T4 (otto/mamoru#292) on a Base fork, through the real stack: a Mamoru-shaped Safe (passkey + EOA owner,
 * Safe7579, SmartSession), the production enable flow (trust + self-attest, then enableSessions from an owner Safe
 * tx), and userOps signed by the session key through EntryPoint v0.7. V4, MamoruGasPolicyV2 and the registry are
 * deployed through ModuleRegistry.deployModule so the Safe can attest them (T7's deployment path).
 *
 *   nix shell nixpkgs#foundry --command forge test --isolate --match-path test/V4UserOpFork.t.sol -vv
 * (--isolate: each top-level call is its own transaction, so the gas figures are cold and include the intrinsic.)
 */
contract V4UserOpForkTest is V4Fixture {
    address safe;
    bytes32 pid;
    MamoruMigrationCheck check;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), BASE_BLOCK);
        _deployStackViaModuleRegistry();
        _listBase();
        _route(DOMAIN_MONAD);
        check = new MamoruMigrationCheck();
        safe = _newSafe(1);
        deal(USDC, safe, 100_000e6);
        deal(CBBTC, safe, 1e8);
    }

    function _enable() internal returns (uint256 enableGas) {
        (pid, enableGas) = _enableV4(safe, _v4Session(C, 1, new uint256[](0), _baseCaps(), bytes32(uint256(0x4))));
    }

    // ------------------------------------------------------------ enable

    function test_gas_enableV4SessionWithRealInit() public {
        address[] memory mods = new address[](2);
        (mods[0], mods[1]) = (address(v4), address(gasPol));
        uint256 trustGas = _ownerTxGas(safe, MULTISEND, _multiSend(_trustAndAttest(safe, mods)), 1);
        Session[] memory ss = new Session[](1);
        ss[0] = _v4Session(C, 1, new uint256[](0), _baseCaps(), bytes32(uint256(0x4)));
        uint256 enableGas = _ownerTxGas(safe, SMART_SESSION, abi.encodeCall(ISmartSessionT.enableSessions, (ss)), 0);
        assertTrue(ISmartSessionT(SMART_SESSION).isPermissionEnabled(_pid(ss[0]), safe));
        assertEq(v4.generationOf(safe), 1);
        console2.log("trust + self-attest V4 and MamoruGasPolicyV2 (owner tx)", trustGas);
        console2.log("enableSessions: the V4 fallback session, real Init, no admit (owner tx)", enableGas);
        // with one position admitted (a migration's Init)
        address safe2 = _newSafe(2);
        (uint256 tokenId,) = _mintDirect(safe2, 1_000e6, 0.01e8);
        uint256[] memory admit = new uint256[](1);
        admit[0] = tokenId;
        _ownerTx(safe2, MULTISEND, _multiSend(_trustAndAttest(safe2, mods)), 1);
        ss[0] = _v4Session(C, 1, admit, _baseCaps(), bytes32(uint256(0x4)));
        uint256 enableAdmit = _ownerTxGas(safe2, SMART_SESSION, abi.encodeCall(ISmartSessionT.enableSessions, (ss)), 0);
        assertEq(v4.admittedPool(safe2, tokenId), POOL_BTC);
        console2.log("enableSessions: the V4 fallback session, real Init, 1 position admitted (owner tx)", enableAdmit);
    }

    // ------------------------------------------------------------ the engine's userOps

    function _swapBatch(address pool, address tokenIn, uint256 amountIn) internal view returns (bytes memory) {
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(tokenIn, 0, abi.encodeCall(IERC20T.approve, (address(v4), amountIn)));
        xs[1] = Execution(address(v4), 0, _swapCall(pool, tokenIn, amountIn));
        return _batch(xs);
    }

    function test_gas_swapMintBridgeUserOps() public {
        _enable();
        // swap
        uint256 b0 = IERC20T(CBBTC).balanceOf(safe);
        uint256 swapGas = _run(safe, _swapBatch(POOL_BTC, USDC, 1_000e6), pid);
        assertGt(IERC20T(CBBTC).balanceOf(safe), b0, "swap executed");
        // mint
        MintParams memory m = _mintParams(safe, 1_000e6, 0.01e8);
        Execution[] memory xs = new Execution[](3);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 1_000e6)));
        xs[1] = Execution(CBBTC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0.01e8)));
        xs[2] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.mint, (m)));
        uint256 mintGas = _run(safe, _batch(xs), pid);
        assertEq(INPMT(NPM).balanceOf(safe), 1, "position minted");
        // registerRemote (session) + guardian readiness + bridge
        address sk = makeAddr("remote session key");
        uint256 regGas = _run(safe, _single(address(v4), abi.encodeCall(MamoruActionPolicyV4.registerRemote, (DOMAIN_MONAD, sk))), pid);
        address remote = v4.remoteOf(safe, DOMAIN_MONAD).remote;
        assertTrue(remote != address(0));
        vm.prank(guardian);
        v4.setReady(safe, DOMAIN_MONAD, remote);
        xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 100e6)));
        xs[1] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.bridge, (DOMAIN_MONAD, USDC, 100e6)));
        uint256 u0 = IERC20T(USDC).balanceOf(safe);
        (watchEmitter, watchWord) = (TOKEN_MESSENGER, bytes32(uint256(uint160(remote))));
        uint256 bridgeGas = _run(safe, _batch(xs), pid);
        assertEq(u0 - IERC20T(USDC).balanceOf(safe), 100e6, "burned");
        assertTrue(watchSeen, "the messenger's DepositForBurn names the remote as mintRecipient");
        console2.log("handleOps gas: swap 1,000 USDC (approve + V4.swap)", swapGas);
        console2.log("handleOps gas: mint (2 approves + V4.mint)", mintGas);
        console2.log("handleOps gas: registerRemote", regGas);
        console2.log("handleOps gas: bridge 100 USDC (approve + V4.bridge)", bridgeGas);
        _validationOnly();
    }

    /// The validation side alone, measured as SmartSession calls it: V4.checkAction per call of the batch, and
    /// MamoruGasPolicyV2.checkUserOpPolicy per op (cold, each its own tx under --isolate).
    function _validationOnly() internal {
        bytes32 actionCfg = keccak256("unused"); // a config bound for the direct measurement
        ConfigIdV4 id = ConfigIdV4.wrap(actionCfg);
        _init(safe, id, C, 1, new uint256[](0));
        bytes memory sw = _swapCall(POOL_BTC, USDC, 1_000e6);
        vm.prank(SMART_SESSION);
        v4.checkAction(id, safe, USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 1_000e6)));
        uint256 gApprove = vm.lastCallGas().gasTotalUsed;
        vm.prank(SMART_SESSION);
        v4.checkAction(id, safe, address(v4), 0, sw);
        uint256 gSwap = vm.lastCallGas().gasTotalUsed;
        vm.prank(SMART_SESSION);
        v4.checkAction(id, safe, address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.bridge, (DOMAIN_MONAD, USDC, 1)));
        uint256 gBridge = vm.lastCallGas().gasTotalUsed;
        uint256 tokenId = INPMT(NPM).tokenOfOwnerByIndex(safe, 0);
        (,,,,,,, uint128 liq,,,,) = INPMT(NPM).positions(tokenId);
        (uint256 min0, uint256 min1) = helper.decreaseMins(safe, tokenId, liq);
        bytes memory dec = abi.encodeWithSelector(0x0c49ccbe, tokenId, liq, min0, min1, vm.getBlockTimestamp());
        vm.prank(SMART_SESSION);
        assertEq(v4.checkAction(id, safe, NPM, 0, dec), 0);
        uint256 gDec = vm.lastCallGas().gasTotalUsed;
        PackedUserOperationV4 memory op = _op(safe, "", pid);
        vm.prank(SMART_SESSION);
        gasPol.initializeWithMultiplexer(safe, id, abi.encode(_baseCaps()));
        opMaxFee = 1; // a tiny charge, so the measurement does not hit the bucket
        op = _op(safe, "", pid);
        vm.prank(SMART_SESSION);
        assertEq(gasPol.checkUserOpPolicy(id, op), 0);
        uint256 gGas = vm.lastCallGas().gasTotalUsed;
        console2.log("checkUserOpPolicy tx gas (incl. 21k): MamoruGasPolicyV2 charge", gGas);
        console2.log("checkAction tx gas (incl. 21k): approve(V4)", gApprove);
        console2.log("checkAction tx gas (incl. 21k): V4.swap / V4.mint / V4.increase (same path)", gSwap);
        console2.log("checkAction tx gas (incl. 21k): V4.bridge", gBridge);
        console2.log("checkAction tx gas (incl. 21k): NPM decreaseLiquidity (oracle + positions)", gDec);
    }

    // ------------------------------------------------------------ refusals at validation (nothing executes)

    function test_validationRefusals() public {
        _enable();
        uint256 u0 = IERC20T(USDC).balanceOf(safe);
        console2.log("approve to the router:", _rejected(safe, _single(USDC, abi.encodeCall(IERC20T.approve, (ROUTER, 1e6))), pid));
        console2.log("approve to an attacker:", _rejected(safe, _single(USDC, abi.encodeCall(IERC20T.approve, (attacker, 1e6))), pid));
        console2.log(
            "direct router swap:",
            _rejected(
                safe,
                _single(ROUTER, abi.encodeCall(IRouterT.exactInputSingle, (ExactInputSingleParams(USDC, CBBTC, 500, safe, 1e6, 0, 1)))),
                pid
            )
        );
        console2.log("transfer:", _rejected(safe, _single(USDC, abi.encodeCall(IERC20T.transfer, (attacker, 1e6))), pid));
        console2.log("depositForBurn direct:", _rejected(safe, _single(TOKEN_MESSENGER, abi.encodeWithSelector(0x8e0250ee)), pid));
        console2.log("empty call:", _rejected(safe, _single(USDC, ""), pid));
        console2.log("empty batch:", _rejected(safe, _batch(new Execution[](0)), pid));
        console2.log("a call to the Safe itself:", _rejected(safe, _single(safe, abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", attacker, 1)), pid));
        // a batch with one allowed and one forbidden call: all-or-nothing
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 1e6)));
        xs[1] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (ROUTER, 1e6)));
        console2.log("mixed batch:", _rejected(safe, _batch(xs), pid));
        assertEq(IERC20T(USDC).balanceOf(safe), u0);
        assertEq(IERC20T(USDC).allowance(safe, ROUTER), 0);
    }

    /// The session key cannot sign for the account (ERC-1271): the V4 session carries no ERC-1271 policy, so SmartSession
    /// refuses, and a `permit` or Permit2 signature is never available to a leaked key.
    function test_sessionKeyCannotSignForTheAccount() public {
        _enable();
        bytes32 h = keccak256("a USDC permit digest");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionKey, h);
        bytes memory sig = abi.encodePacked(SMART_SESSION, pid, r, s, v);
        (bool ok, bytes memory ret) = safe.staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", h, sig));
        assertTrue(!ok || ret.length < 4 || bytes4(ret) != bytes4(0x1626ba7e), "a session signature is never valid for the Safe");
    }

    /// A V4 call that validates (V4's entry points are admitted) but fails its own checks at execution reverts there:
    /// nothing moves, and the op is still charged to the gas bucket (validation-time charge, I6).
    function test_executionCheckFailsSafely() public {
        _enable();
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1_000e6);
        s.amountOutMinimum = 0; // looser than the range edge
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 1_000e6)));
        xs[1] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.swap, (s)));
        uint256 u0 = IERC20T(USDC).balanceOf(safe);
        (bool ok,) = _runOp(safe, _batch(xs), pid);
        assertFalse(ok, "execution reverted");
        assertEq(IERC20T(USDC).balanceOf(safe), u0, "nothing moved");
        assertGt(gasPol.chargedSinceReview(safe), 0, "charged to the gas bucket");
    }

    // ------------------------------------------------------------ I6: gas griefing

    /// A leaked session key sends valid, useless userOps at the highest fields the caps allow. The gas bucket stops it
    /// within a window, and the cumulative GAS_REVIEW (0.01 ETH on Base) stops it for good until the guardian reviews.
    function test_gasGriefingHitsBucketThenReview() public {
        _enable();
        opVerification = 3_000_000;
        opCall = 2_000_000;
        opPre = 200_000;
        opMaxFee = 100_000_000; // the caps' maxFeePerGas
        bytes memory noop = _single(USDC, abi.encodeCall(IERC20T.approve, (address(v4), 1)));
        uint256 charge = (opVerification + opCall + opPre) * opMaxFee;
        uint256 eth0 = safe.balance;
        uint256 ops;
        uint256 firstWindow;
        for (uint256 day; day < 30; day++) {
            while (true) {
                PackedUserOperationV4[] memory one = new PackedUserOperationV4[](1);
                one[0] = _op(safe, noop, pid);
                vm.prank(bundler, bundler);
                (bool ok,) = ENTRY_POINT.call(abi.encodeCall(IEntryPointT.handleOps, (one, payable(bundler))));
                if (!ok) break;
                ops++;
            }
            if (day == 0) firstWindow = ops;
            _nextBlock(1 days);
        }
        console2.log("griefing ops accepted in the first window (bucket 0.002 ETH)", firstWindow);
        console2.log("griefing ops accepted over 30 days before GAS_REVIEW", ops);
        console2.log("charged since review (wei)", gasPol.chargedSinceReview(safe));
        console2.log("ETH the Safe actually paid (wei)", eth0 - safe.balance);
        assertEq(firstWindow, 0.002 ether / charge);
        assertEq(ops, 0.01 ether / charge);
        assertLe(eth0 - safe.balance, 0.01 ether, "the Safe never paid more than GAS_REVIEW");
        _rejected(safe, noop, pid);
        vm.prank(guardian);
        gasPol.review(safe);
        _run(safe, noop, pid);
    }

    // ------------------------------------------------------------ migration (v2-v6 -> V4)

    function _oldSession(address pol, address gasV1, bytes32 salt, uint256 nActions) internal view returns (Session memory s) {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(sessionKey);
        s.sessionValidator = OWNABLE_VALIDATOR;
        s.sessionValidatorInitData = abi.encode(uint256(1), signers);
        s.salt = salt;
        s.userOpPolicies = new PolicyData[](2);
        s.userOpPolicies[0] = PolicyData(TIME_FRAME, abi.encodePacked(uint128(vm.getBlockTimestamp() + 365 days), uint128(vm.getBlockTimestamp() - 60)));
        s.userOpPolicies[1] = PolicyData(gasV1, abi.encode(uint64(10_000_000), uint32(3_000_000), uint32(2_000_000), uint32(200_000), uint64(100_000_000)));
        s.actions = new ActionData[](nActions);
        for (uint256 i; i < nActions; i++) {
            s.actions[i].actionTarget = address(uint160(0x1000 + i));
            s.actions[i].actionTargetSelector = bytes4(uint32(0x095ea7b3 + i));
            s.actions[i].actionPolicies = new PolicyData[](1);
            s.actions[i].actionPolicies[0] = PolicyData(pol, "");
        }
    }

    /// A v6-shaped account: three Mamoru sessions (9 + 9 + 3 actions, TimeFrame + MamoruGasPolicy) and a position.
    function _v6Account() internal returns (Session[] memory old, uint256 tokenId) {
        bytes32 resolverUID = IModRegT(MODULE_REGISTRY).findModule(TIME_FRAME).resolverUID;
        vm.startPrank(makeAddr("deployer"));
        address oldPol = IModRegT(MODULE_REGISTRY).deployModule(bytes32(uint256(11)), resolverUID, type(OldPolicy).creationCode, "", "");
        address gasV1 = IModRegT(MODULE_REGISTRY).deployModule(bytes32(uint256(12)), resolverUID, vm.getCode("out/MamoruGasPolicy.sol/MamoruGasPolicy.json"), "", "");
        vm.stopPrank();
        address[] memory mods = new address[](3);
        (mods[0], mods[1], mods[2]) = (oldPol, gasV1, TIME_FRAME);
        assertTrue(_ownerTx(safe, MULTISEND, _multiSend(_trustAndAttest(safe, mods)), 1));
        old = new Session[](3);
        old[0] = _oldSession(oldPol, gasV1, bytes32(uint256(0xf1)), 9);
        old[1] = _oldSession(oldPol, gasV1, bytes32(uint256(0xf2)), 9);
        old[2] = _oldSession(oldPol, gasV1, bytes32(uint256(0xf3)), 3);
        assertTrue(_ownerTx(safe, SMART_SESSION, abi.encodeCall(ISmartSessionT.enableSessions, (old)), 0));
        (tokenId,) = _mintDirect(safe, 1_000e6, 0.01e8);
    }

    /// Spec 010 "Migration": ONE Safe tx: removeSession for every old id, self-attest V4 and the gas policy, enable
    /// the V4 session (the account's positions admitted in its Init), then MamoruMigrationCheck.assertOnly.
    function _migration(Session[] memory old, uint256 removeCount, uint256 tokenId) internal view returns (bytes memory packed, bytes32 v4pid) {
        uint256[] memory admit = new uint256[](1);
        admit[0] = tokenId;
        Session[] memory nu = new Session[](1);
        nu[0] = _v4Session(C, 1, admit, _baseCaps(), bytes32(uint256(0x4)));
        v4pid = _pid(nu[0]);
        address[] memory mods = new address[](2);
        (mods[0], mods[1]) = (address(v4), address(gasPol));
        for (uint256 i; i < removeCount; i++) {
            packed = abi.encodePacked(packed, _ms(0, SMART_SESSION, abi.encodeCall(ISmartSessionT.removeSession, (_pid(old[i])))));
        }
        bytes32[] memory keep = new bytes32[](1);
        keep[0] = v4pid;
        packed = abi.encodePacked(
            packed,
            _trustAndAttest(safe, mods),
            _ms(0, SMART_SESSION, abi.encodeCall(ISmartSessionT.enableSessions, (nu))),
            _ms(0, address(check), abi.encodeCall(MamoruMigrationCheck.assertOnly, (safe, keep)))
        );
    }

    function test_gas_migrationOnV6ShapedAccount() public {
        (Session[] memory old, uint256 tokenId) = _v6Account();
        (bytes memory packed, bytes32 v4pid) = _migration(old, 3, tokenId);
        uint256 g = _ownerTxGas(safe, MULTISEND, _multiSend(packed), 1);
        console2.log("migration tx (removeSession x3 [9+9+3 actions] + attest + enable V4 w/ 1 admit + assertOnly)", g);
        for (uint256 i; i < 3; i++) {
            assertFalse(ISmartSessionT(SMART_SESSION).isPermissionEnabled(_pid(old[i]), safe), "old session removed");
        }
        assertTrue(ISmartSessionT(SMART_SESSION).isPermissionEnabled(v4pid, safe), "V4 session enabled");
        assertEq(ISmartSessionT(SMART_SESSION).getPermissionIDs(safe).length, 1);
        assertEq(v4.admittedPool(safe, tokenId), POOL_BTC, "the position carried over");
        // and the migrated account works with no further signature
        pid = v4pid;
        _run(safe, _swapBatch(POOL_BTC, USDC, 1_000e6), pid);
    }

    /// Spec 010 r1 finding 4: a migration that leaves one old session enabled reverts as a whole (Safe GS013): nothing
    /// is removed, V4 is not enabled.
    function test_migrationWithStaleSessionReverts() public {
        (Session[] memory old, uint256 tokenId) = _v6Account();
        (bytes memory packed, bytes32 v4pid) = _migration(old, 2, tokenId); // forgets the third
        address o = vm.addr(ownerKey);
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(o))), bytes32(0), uint8(1));
        vm.prank(o);
        vm.expectRevert(bytes("GS013"));
        ISafeT(safe).execTransaction(MULTISEND, 0, _multiSend(packed), 1, 0, 0, 0, address(0), payable(address(0)), sig);
        for (uint256 i; i < 3; i++) {
            assertTrue(ISmartSessionT(SMART_SESSION).isPermissionEnabled(_pid(old[i]), safe), "nothing removed");
        }
        assertFalse(ISmartSessionT(SMART_SESSION).isPermissionEnabled(v4pid, safe), "V4 not enabled");
        // the spec's own check, over an inventory that names the stale id, says the same
        bytes32[] memory ids = new bytes32[](3);
        for (uint256 i; i < 3; i++) {
            ids[i] = _pid(old[i]);
        }
        vm.expectRevert(abi.encodeWithSelector(MamoruMigrationCheck.StillEnabled.selector, ids[0]));
        check.assertNone(safe, ids);
    }
}
