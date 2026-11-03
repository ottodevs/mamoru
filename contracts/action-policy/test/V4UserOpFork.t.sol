// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Vm, console2} from "forge-std/Test.sol";
import {V4Fixture, IERC20T, INPMT, IRouterT, ISmartSessionT, IModRegT, IEntryPointT, ISafeT} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, SwapParams, MintParams, ExactInputSingleParams} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruMigrationCheck} from "../src/MamoruMigrationCheck.sol";
import {ConfigIdV4, PackedUserOperationV4, Session, PolicyData, ActionData} from "../src/SmartSessionTypes.sol";

interface ISmartSessionNonce {
    function getNonce(bytes32 permissionId, address account) external view returns (uint256);
    function revokeEnableSignature(bytes32 permissionId) external;
    function getSessionDigest(bytes32 permissionId, address account, Session memory data, uint8 mode)
        external
        view
        returns (bytes32);
}

interface ISafeDomain {
    function domainSeparator() external view returns (bytes32);
}

/// SmartSession DataTypes.sol: ChainDigest, EnableSession.
struct ChainDigestT {
    uint64 chainId;
    bytes32 sessionDigest;
}

struct EnableSessionT {
    uint8 chainDigestIndex;
    ChainDigestT[] hashesAndChainIds;
    Session sessionToEnable;
    bytes permissionEnableSig;
}

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
 * Spec 010 T4 + A1 (otto/mamoru#292, #316, #317) on a Base fork, through the real stack: a Mamoru-shaped Safe (passkey +
 * EOA owner, Safe7579, SmartSession), the production enable flow (trust + self-attest, then enableSessions from an owner
 * Safe tx), and userOps signed by the session key through EntryPoint v0.7. V4 and MamoruGasPolicyV2 are deployed
 * through ModuleRegistry.deployModule so the Safe can attest them (T7's deployment path). Every session op is a batch
 * that starts with `V4.clock(T)` (I6) and wraps each approval in approve / use / reset / assertZero (I9, POL-07).
 *
 *   nix shell nixpkgs#foundry --command forge test --isolate --match-path test/V4UserOpFork.t.sol -vv
 * (--isolate: each top-level call is its own transaction, so the gas figures are cold and include the intrinsic.)
 */
contract V4UserOpForkTest is V4Fixture {
    address safe;
    bytes32 pid;
    MamoruMigrationCheck check;
    // SmartSession HashLib.sol
    bytes32 constant CHAIN_SESSION_TYPEHASH = 0x1ea7e4bc398fa0ccd68d92b5d8931a3fd93eebe1cf0391b4ba28935801af7c80;
    bytes32 constant MULTICHAIN_SESSION_TYPEHASH = 0x0c9d02fb89a1da34d66ea2088dc9ee6a58efee71cef6f1bb849ed74fc6003d98;
    bytes32 constant MULTICHAIN_DOMAIN_SEPARATOR = 0x057501e891776d1482927e5f094ae44049a4d893ba2d7b334dd7db8d38d3a0e1;
    bytes32 constant SAFE_MSG_TYPEHASH = 0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), BASE_BLOCK);
        _deployStackViaModuleRegistry();
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
        return _batch(_approved(tokenIn, amountIn, address(v4), _swapCall(pool, tokenIn, amountIn)));
    }

    function test_gas_swapMintBridgeUserOps() public {
        _enable();
        // swap
        uint256 b0 = IERC20T(CBBTC).balanceOf(safe);
        uint256 swapGas = _run(safe, _swapBatch(POOL_BTC, USDC, 1_000e6), pid);
        assertGt(IERC20T(CBBTC).balanceOf(safe), b0, "swap executed");
        // mint
        MintParams memory m = _mintParams(safe, 1_000e6, 0.01e8);
        Execution[] memory xs = new Execution[](7);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 1_000e6)));
        xs[1] = Execution(CBBTC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0.01e8)));
        xs[2] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.mint, (m)));
        xs[3] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
        xs[4] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.assertZero, (USDC)));
        xs[5] = Execution(CBBTC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
        xs[6] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.assertZero, (CBBTC)));
        uint256 mintGas = _run(safe, _batch(xs), pid);
        assertEq(INPMT(NPM).balanceOf(safe), 1, "position minted");
        // registerRemote (session) + readiness (A1: a CCTP message from the remote's V4, delivered here by the pinned
        // transmitter; the real two-chain path is test/V4RemoteFork.t.sol) + bridge
        address sk = makeAddr("remote session key");
        uint256 regGas = _run(safe, _single(address(v4), abi.encodeCall(MamoruActionPolicyV4.registerRemote, (DOMAIN_MONAD, sk))), pid);
        MamoruActionPolicyV4.Remote memory r = v4.remoteOf(safe, DOMAIN_MONAD);
        assertTrue(r.remote != address(0));
        vm.prank(v4.MESSAGE_TRANSMITTER());
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, bytes32(uint256(uint160(address(v4)))), 2000, abi.encode(safe, r.remote, r.ownersHash));
        assertTrue(v4.isReady(safe, DOMAIN_MONAD));
        address remote = r.remote;
        xs = _approved(USDC, 100e6, address(v4), abi.encodeCall(MamoruActionPolicyV4.bridge, (DOMAIN_MONAD, USDC, 100e6, 0)));
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
        v4.checkAction(id, safe, address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.bridge, (DOMAIN_MONAD, USDC, 1, 0)));
        uint256 gBridge = vm.lastCallGas().gasTotalUsed;
        uint256 tokenId = INPMT(NPM).tokenOfOwnerByIndex(safe, 0);
        (,,,,,,, uint128 liq,,,,) = INPMT(NPM).positions(tokenId);
        (uint256 min0, uint256 min1) = lens.decreaseMins(safe, tokenId, liq);
        bytes memory dec = abi.encodeWithSelector(0x0c49ccbe, tokenId, liq, min0, min1, vm.getBlockTimestamp());
        vm.prank(SMART_SESSION);
        assertEq(v4.checkAction(id, safe, NPM, 0, dec), 0);
        uint256 gDec = vm.lastCallGas().gasTotalUsed;
        vm.prank(SMART_SESSION);
        gasPol.initializeWithMultiplexer(safe, id, abi.encode(_baseCaps()));
        opMaxFee = 1; // a tiny charge, so the measurement does not hit the rate
        PackedUserOperationV4 memory op = _op(safe, _swapBatch(POOL_BTC, USDC, 1_000e6), pid);
        vm.prank(SMART_SESSION);
        assertEq(gasPol.checkUserOpPolicy(id, op) >> 160, ((vm.getBlockTimestamp() - 300) << 48) | (vm.getBlockTimestamp() + 300));
        uint256 gGas = vm.lastCallGas().gasTotalUsed;
        console2.log("checkUserOpPolicy tx gas (incl. 21k): MamoruGasPolicyV2 rate + batch shape (swap batch)", gGas);
        console2.log("checkAction tx gas (incl. 21k): approve(V4)", gApprove);
        console2.log("checkAction tx gas (incl. 21k): V4.swap / V4.mint / V4.increase (same path)", gSwap);
        console2.log("checkAction tx gas (incl. 21k): V4.bridge", gBridge);
        console2.log("checkAction tx gas (incl. 21k): NPM decreaseLiquidity (static, I9)", gDec);
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
        console2.log("action-free batch (clock only):", _rejected(safe, _batch(new Execution[](0)), pid));
        console2.log("a call to the Safe itself:", _rejected(safe, _single(safe, abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", attacker, 1)), pid));
        console2.log("installModule on the Safe:", _rejected(safe, _single(safe, abi.encodeWithSignature("installModule(uint256,address,bytes)", 2, attacker, "")), pid));
        // I6, I9: the gas policy's batch shape
        console2.log("single mode:", _rejected(safe, _rawSingle(address(v4), _swapCall(POOL_BTC, USDC, 1e6)), pid));
        Execution[] memory xs = new Execution[](1);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
        console2.log("batch without the leading clock:", _rejected(safe, _rawBatch(xs), pid));
        console2.log("approve never reset:", _rejected(safe, _single(USDC, abi.encodeCall(IERC20T.approve, (address(v4), 1e6))), pid));
        // a batch with one allowed and one forbidden call: all-or-nothing
        xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
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
    /// nothing moves, and the op still advances the gas rate (validation-time charge, I6).
    function test_executionCheckFailsSafely() public {
        _enable();
        SwapParams memory s = _swapParams(POOL_BTC, USDC, 1_000e6);
        s.amountOutMinimum = 0; // looser than the range edge
        Execution[] memory xs = _approved(USDC, 1_000e6, address(v4), abi.encodeCall(MamoruActionPolicyV4.swap, (s)));
        uint256 u0 = IERC20T(USDC).balanceOf(safe);
        (bool ok,) = _runOp(safe, _batch(xs), pid);
        assertFalse(ok, "execution reverted");
        assertEq(IERC20T(USDC).balanceOf(safe), u0, "nothing moved");
        assertGt(gasPol.tatOf(safe), vm.getBlockTimestamp(), "the gas rate advanced");
    }

    // ------------------------------------------------------------ I6: gas griefing

    /// A leaked session key sends valid, useless userOps at the highest fields the caps allow, each with a correct
    /// claimed time. The GCRA rate (A1, I6) stops it at G per W (0.002 ETH a day on Base) plus one burst: no reviewer,
    /// nothing to reset, and the account keeps working the next window.
    function test_gasGriefingHitsTheRate() public {
        _enable();
        opVerification = 3_000_000;
        opCall = 2_000_000;
        opPre = 200_000;
        opMaxFee = 100_000_000; // the caps' maxFeePerGas
        uint256 charge = (opVerification + opCall + opPre) * opMaxFee;
        uint256 eth0 = safe.balance;
        uint256 ops;
        uint256 firstWindow;
        for (uint256 day; day < 30; day++) {
            while (true) {
                bytes memory noop = _single(USDC, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
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
        console2.log("griefing ops accepted in the first window (G = 0.002 ETH)", firstWindow);
        console2.log("griefing ops accepted over 30 days", ops);
        console2.log("ETH the Safe actually paid (wei)", eth0 - safe.balance);
        assertEq(firstWindow, 0.002 ether / charge);
        assertLe(ops * charge, 31 * 0.002 ether, "at most G per W (plus the first burst)");
        assertLe(eth0 - safe.balance, 31 * 0.002 ether, "the Safe never paid more than the rate allows");
        // nothing to reset: the next window serves again
        _run(safe, _single(USDC, abi.encodeCall(IERC20T.approve, (address(v4), 0))), pid);
    }

    /// A1 (T1c, on the real stack): SmartSession intersects the gas policy's time range and the EntryPoint enforces
    /// it. An op whose claimed time is more than S in the past or the future is refused at validation.
    function test_claimedTimeOutsideSlackRefused() public {
        _enable();
        Execution[] memory xs = new Execution[](2);
        xs[1] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
        xs[0] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.clock, (vm.getBlockTimestamp() - 301)));
        string memory r1 = _rejected(safe, _rawBatch(xs), pid);
        xs[0] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.clock, (vm.getBlockTimestamp() + 301)));
        string memory r2 = _rejected(safe, _rawBatch(xs), pid);
        console2.log("claimed time 301 s in the past:", r1);
        console2.log("claimed time 301 s in the future:", r2);
        assertEq(keccak256(bytes(r1)), keccak256("AA22 expired or not due"));
        assertEq(keccak256(bytes(r2)), keccak256("AA22 expired or not due"));
        xs[0] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.clock, (vm.getBlockTimestamp() - 299)));
        _run(safe, _rawBatch(xs), pid);
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

    /// Spec 010 "Migration" with review r1 of #200 (P1): ONE Safe tx: removeSession for the first `removeCount` old ids,
    /// revokeEnableSignature for the first `revokeCount` (it bumps each id's ENABLE nonce, so no owner-signed ENABLE
    /// payload made before the migration verifies any more), self-attest V4 and the gas policy, enable the V4 session
    /// (the account's positions admitted in its Init), then MamoruMigrationCheck.assertMigrated over the nonces read now.
    /// `legacy`: the first version of this PR (no revocation, assertOnly), to show the vector the review found.
    function _migration(Session[] memory old, uint256 removeCount, uint256 revokeCount, uint256 tokenId, bool legacy)
        internal
        view
        returns (bytes memory packed, bytes32 v4pid)
    {
        uint256[] memory admit = new uint256[](1);
        admit[0] = tokenId;
        Session[] memory nu = new Session[](1);
        nu[0] = _v4Session(C, 1, admit, _baseCaps(), bytes32(uint256(0x4)));
        v4pid = _pid(nu[0]);
        address[] memory mods = new address[](2);
        (mods[0], mods[1]) = (address(v4), address(gasPol));
        bytes32[] memory ids = new bytes32[](old.length);
        uint256[] memory noncesBefore = new uint256[](old.length);
        for (uint256 i; i < old.length; i++) {
            ids[i] = _pid(old[i]);
            noncesBefore[i] = ISmartSessionNonce(SMART_SESSION).getNonce(ids[i], safe);
        }
        for (uint256 i; i < removeCount; i++) {
            packed = abi.encodePacked(packed, _ms(0, SMART_SESSION, abi.encodeCall(ISmartSessionT.removeSession, (ids[i]))));
        }
        for (uint256 i; i < (legacy ? 0 : revokeCount); i++) {
            packed = abi.encodePacked(packed, _ms(0, SMART_SESSION, abi.encodeCall(ISmartSessionNonce.revokeEnableSignature, (ids[i]))));
        }
        bytes32[] memory keep = new bytes32[](1);
        keep[0] = v4pid;
        bytes memory last = legacy
            ? abi.encodeCall(MamoruMigrationCheck.assertOnly, (safe, keep))
            : abi.encodeCall(MamoruMigrationCheck.assertMigrated, (safe, keep, ids, noncesBefore));
        packed = abi.encodePacked(
            packed,
            _trustAndAttest(safe, mods),
            _ms(0, SMART_SESSION, abi.encodeCall(ISmartSessionT.enableSessions, (nu))),
            _ms(0, address(check), last)
        );
    }

    function _execMigration(bytes memory packed) internal returns (bool ok, bytes memory err) {
        address o = vm.addr(ownerKey);
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(o))), bytes32(0), uint8(1));
        vm.prank(o);
        (ok, err) = safe.call(
            abi.encodeCall(ISafeT.execTransaction, (MULTISEND, 0, _multiSend(packed), 1, 0, 0, 0, address(0), payable(address(0)), sig))
        );
    }

    // ------------------------------------------------------------ ENABLE payloads (review r1 of #200, P1)

    /// An owner-signed SmartSession ENABLE payload for `s` on `safe`, signed now (over the current ENABLE nonce): what a
    /// v2-v6 renewal could have produced and an old session key's holder could have kept unused.
    function _ownerSignedEnable(Session memory s) internal view returns (EnableSessionT memory e) {
        bytes32 digest = ISmartSessionNonce(SMART_SESSION).getSessionDigest(_pid(s), safe, s, 1); // mode ENABLE
        e.hashesAndChainIds = new ChainDigestT[](1);
        e.hashesAndChainIds[0] = ChainDigestT(uint64(block.chainid), digest);
        e.sessionToEnable = s;
        bytes32 chainsHash = keccak256(abi.encodePacked(keccak256(abi.encode(CHAIN_SESSION_TYPEHASH, uint64(block.chainid), digest))));
        bytes32 hash = keccak256(abi.encodePacked(bytes2(0x1901), MULTICHAIN_DOMAIN_SEPARATOR, keccak256(abi.encode(MULTICHAIN_SESSION_TYPEHASH, chainsHash))));
        // Safe7579.isValidSignature with validator address(0): Safe.checkSignatures over the SafeMessage of `hash`
        bytes32 msgHash = keccak256(
            abi.encodePacked(
                bytes2(0x1901), ISafeDomain(safe).domainSeparator(), keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(hash))))
            )
        );
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(ownerKey, msgHash);
        e.permissionEnableSig = abi.encodePacked(address(0), r, sg, v);
    }

    /// A userOp in SmartSession ENABLE mode: the payload plus the old session key's signature, one call the old
    /// session's policies admit.
    function _enableModeOp(EnableSessionT memory e) internal view returns (PackedUserOperationV4 memory op) {
        op = _op(safe, _rawSingle(address(0x1000), abi.encodeWithSelector(0x095ea7b3, attacker, 1)), bytes32(0));
        bytes32 h = IEntryPointT(ENTRY_POINT).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(sessionKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        op.signature = abi.encodePacked(uint8(1), _flzLiterals(abi.encode(e, abi.encodePacked(r, sg, v))));
    }

    /// A valid FastLZ stream made of literal runs only (control byte = run length - 1, runs of at most 32 bytes), which
    /// SmartSession's `flzDecompress` (Solady LibZip) expands back to `data`.
    function _flzLiterals(bytes memory data) internal pure returns (bytes memory out) {
        for (uint256 i; i < data.length; i += 32) {
            uint256 n = data.length - i < 32 ? data.length - i : 32;
            bytes memory chunk = new bytes(n);
            for (uint256 k; k < n; k++) {
                chunk[k] = data[i + k];
            }
            out = abi.encodePacked(out, uint8(n - 1), chunk);
        }
    }

    function _sendOp(PackedUserOperationV4 memory op) internal returns (bool ok) {
        PackedUserOperationV4[] memory ops = new PackedUserOperationV4[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        (ok,) = ENTRY_POINT.call(abi.encodeCall(IEntryPointT.handleOps, (ops, payable(bundler))));
    }

    /// The vector, on the first version of the migration (no revocation): an ENABLE payload the owner signed before
    /// the migration re-enables the removed session afterwards, and its key acts outside V4.
    function test_enableReplayReEnablesAnOldSessionWithoutRevocation() public {
        (Session[] memory old, uint256 tokenId) = _v6Account();
        vm.prank(safe);
        ISmartSessionT(SMART_SESSION).removeSession(_pid(old[0])); // the payload is for a session not enabled now,
        EnableSessionT memory e = _ownerSignedEnable(old[0]); //     as when a renewal was prepared and never sent
        Session[] memory rest = new Session[](2);
        (rest[0], rest[1]) = (old[1], old[2]);
        (bytes memory packed,) = _migration(rest, 2, 0, tokenId, true);
        (bool ok,) = _execMigration(packed);
        assertTrue(ok, "legacy migration");
        assertTrue(_sendOp(_enableModeOp(e)), "the old payload still enables");
        assertTrue(ISmartSessionT(SMART_SESSION).isPermissionEnabled(_pid(e.sessionToEnable), safe), "old session back");
    }

    /// The fix: the migration revokes every old id's ENABLE signature, so the same payload is refused at validation,
    /// the old session stays removed, and its key cannot act.
    function test_enableReplayRefusedAfterMigration() public {
        (Session[] memory old, uint256 tokenId) = _v6Account();
        EnableSessionT memory e = _ownerSignedEnable(old[0]); // signed while old[0] is enabled: nonce 0
        uint256 n0 = ISmartSessionNonce(SMART_SESSION).getNonce(_pid(old[0]), safe);
        (bytes memory packed, bytes32 v4pid) = _migration(old, 3, 3, tokenId, false);
        (bool ok,) = _execMigration(packed);
        assertTrue(ok, "migration");
        assertEq(ISmartSessionNonce(SMART_SESSION).getNonce(_pid(old[0]), safe), n0 + 1, "ENABLE nonce moved");
        assertFalse(_sendOp(_enableModeOp(e)), "the old payload is refused at validation");
        assertFalse(ISmartSessionT(SMART_SESSION).isPermissionEnabled(_pid(old[0]), safe), "old session stays removed");
        _rejected(safe, _rawSingle(address(0x1000), abi.encodeWithSelector(0x095ea7b3, attacker, 1)), _pid(old[0])); // nor acts
        assertEq(ISmartSessionT(SMART_SESSION).getPermissionIDs(safe).length, 1, "only V4's session");
        assertTrue(ISmartSessionT(SMART_SESSION).isPermissionEnabled(v4pid, safe));
    }

    /// assertMigrated reverts the whole migration when one old id's ENABLE signature was not revoked.
    function test_migrationMissingARevocationReverts() public {
        (Session[] memory old, uint256 tokenId) = _v6Account();
        (bytes memory packed, bytes32 v4pid) = _migration(old, 3, 2, tokenId, false); // forgets the third revocation
        (bool ok, bytes memory err) = _execMigration(packed);
        assertFalse(ok);
        assertEq(keccak256(err), keccak256(abi.encodeWithSignature("Error(string)", "GS013")));
        assertTrue(ISmartSessionT(SMART_SESSION).isPermissionEnabled(_pid(old[2]), safe), "nothing removed");
        assertFalse(ISmartSessionT(SMART_SESSION).isPermissionEnabled(v4pid, safe), "V4 not enabled");
        uint256[] memory before = new uint256[](1);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = _pid(old[2]);
        bytes32[] memory keep = ISmartSessionT(SMART_SESSION).getPermissionIDs(safe);
        vm.expectRevert(abi.encodeWithSelector(MamoruMigrationCheck.EnableNotRevoked.selector, ids[0], 0));
        check.assertMigrated(safe, keep, ids, before);
    }

    function test_gas_migrationOnV6ShapedAccount() public {
        (Session[] memory old, uint256 tokenId) = _v6Account();
        (bytes memory packed, bytes32 v4pid) = _migration(old, 3, 3, tokenId, false);
        uint256 g = _ownerTxGas(safe, MULTISEND, _multiSend(packed), 1);
        console2.log("migration tx (removeSession x3 [9+9+3 actions] + revokeEnableSignature x3 + attest + enable V4 w/ 1 admit + assertMigrated)", g);
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
        (bytes memory packed, bytes32 v4pid) = _migration(old, 2, 3, tokenId, false); // forgets the third removal
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
