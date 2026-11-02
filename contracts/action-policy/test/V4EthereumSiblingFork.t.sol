// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {V4Fixture, IERC20T, IEntryPointT, ISmartSessionT} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, InitV4, SwapParams} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruRegistry} from "../src/MamoruRegistry.sol";
import {MamoruV4Chains} from "../src/MamoruV4Chains.sol";
import {ConfigIdV4, PackedUserOperationV4, Session, PolicyData, ActionData} from "../src/SmartSessionTypes.sol";

interface ISessionDigestE {
    function getSessionDigest(bytes32 permissionId, address account, Session memory data, uint8 mode)
        external
        view
        returns (bytes32);
}

interface ISafeDomainE {
    function domainSeparator() external view returns (bytes32);
}

interface IWethE {
    function deposit() external payable;
    function withdraw(uint256) external;
}

struct ChainDigestE {
    uint64 chainId;
    bytes32 sessionDigest;
}

struct EnableSessionE {
    uint8 chainDigestIndex;
    ChainDigestE[] hashesAndChainIds;
    Session sessionToEnable;
    bytes permissionEnableSig;
}

/// The chain table seen from a contract, for the table tests (MamoruV4Chains is internal).
contract ChainsProbe {
    function chainOf(uint32 domain) external pure returns (uint256) {
        return MamoruV4Chains.chainOf(domain);
    }

    function byChainId(uint256 id) external pure returns (MamoruV4Chains.Chain memory) {
        return MamoruV4Chains.byChainId(id);
    }
}

/**
 * otto/mamoru#307 on forks of Ethereum and Base: an account whose ETH sits on Ethereum at its own address (the same
 * SafeProxyFactory CREATE2 address as on Base, as Guillermo's #117) gets a V4 SIBLING session there, enabled by ONE
 * owner signature in a SmartSession UNSAFE_ENABLE userOp (no attestation needed on a Safe set up before V4 existed).
 * The session wraps the native ETH, swaps it to USDC on the listed Uniswap pool under V4's price checks, and burns the
 * USDC through CCTP to the account's own address on Base, only after the guardian read that address back.
 *
 *   nix shell nixpkgs#foundry --command forge test --match-path test/V4EthereumSiblingFork.t.sol -vv
 * ETHEREUM_FORK_RPC_URL overrides the archive RPC (default eth.drpc.org, which serves state at the pinned block).
 */
contract V4EthereumSiblingForkTest is V4Fixture {
    uint256 constant ETH_BLOCK = 26_328_000;
    address constant E_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant E_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant E_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant E_POOL = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640; // USDC/WETH 0.05 %
    uint32 constant DOMAIN_ETHEREUM = 0;
    uint8 constant UNSAFE_ENABLE = 2;
    // SmartSession HashLib.sol (as V4UserOpFork)
    bytes32 constant CHAIN_SESSION_TYPEHASH = 0x1ea7e4bc398fa0ccd68d92b5d8931a3fd93eebe1cf0391b4ba28935801af7c80;
    bytes32 constant MULTICHAIN_SESSION_TYPEHASH = 0x0c9d02fb89a1da34d66ea2088dc9ee6a58efee71cef6f1bb849ed74fc6003d98;
    bytes32 constant MULTICHAIN_DOMAIN_SEPARATOR = 0x057501e891776d1482927e5f094ae44049a4d893ba2d7b334dd7db8d38d3a0e1;
    bytes32 constant SAFE_MSG_TYPEHASH = 0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca;
    uint256 constant ETH_HELD = 55_378_350_000_000_000; // 0.05537835 ETH, #117

    uint256 ethFork;
    uint256 baseFork;
    address safe;
    Session sibling;
    bytes32 pid;

    function setUp() public {
        baseFork = vm.createFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), BASE_BLOCK);
        ethFork = vm.createFork(vm.envOr("ETHEREUM_FORK_RPC_URL", string("https://eth.drpc.org")), ETH_BLOCK);
        vm.selectFork(baseFork);
        _deployStack();
        address baseV4 = address(v4);
        address baseHome = _newSafe(117); // the home account, deployed here to read it back; it may as well be counterfactual
        vm.selectFork(ethFork);
        _deployStack();
        assertEq(address(v4), baseV4, "V4 at the same address on Ethereum and Base");
        // The L1 pool's ring holds 723 observations: a 720 s window (180 s short) fits it without raising it.
        _execAfterDelay(
            MamoruRegistry.Kind.Pool,
            bytes32(uint256(uint160(E_POOL))),
            abi.encode(uint32(720), uint32(180), uint24(100), int24(0), uint24(0), uint16(10_000))
        );
        safe = _newSafe(117);
        assertEq(safe, baseHome, "the account's address is the same on both chains (same factory, same initializer)");
        vm.deal(safe, ETH_HELD);
        sibling = _siblingSession(safe, DOMAIN_BASE);
        pid = _pid(sibling);
    }

    // ------------------------------------------------------------ helpers

    function _ethCaps() internal pure returns (MamoruGasPolicyV2.Caps memory) {
        return MamoruGasPolicyV2.Caps(100_000_000, 3_000_000, 2_000_000, 200_000, 5_000_000_000, 0, 0.01 ether, 1 days);
    }

    function _siblingSession(address account, uint32 homeDomain) internal view returns (Session memory s) {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(sessionKey);
        s.sessionValidator = OWNABLE_VALIDATOR;
        s.sessionValidatorInitData = abi.encode(uint256(1), signers);
        s.salt = keccak256("mamoru.v4.sibling");
        s.userOpPolicies = new PolicyData[](1);
        s.userOpPolicies[0] = PolicyData(address(gasPol), abi.encode(_ethCaps()));
        s.actions = new ActionData[](1);
        s.actions[0].actionTarget = address(1);
        s.actions[0].actionTargetSelector = 0x00000001;
        s.actions[0].actionPolicies = new PolicyData[](1);
        s.actions[0].actionPolicies[0] =
            PolicyData(address(v4), abi.encode(InitV4(C, 1, account, homeDomain, new uint256[](0))));
    }

    /// The owner's one signature: SmartSession's multichain digest (here the Ethereum entry), as a SafeMessage of the
    /// account (Safe7579.isValidSignature with validator address(0) falls back to Safe.checkSignatures).
    function _ownerEnable(Session memory s) internal view returns (EnableSessionE memory e) {
        bytes32 digest = ISessionDigestE(SMART_SESSION).getSessionDigest(_pid(s), safe, s, UNSAFE_ENABLE);
        e.hashesAndChainIds = new ChainDigestE[](1);
        e.hashesAndChainIds[0] = ChainDigestE(uint64(block.chainid), digest);
        e.sessionToEnable = s;
        bytes32 chains = keccak256(abi.encodePacked(keccak256(abi.encode(CHAIN_SESSION_TYPEHASH, uint64(block.chainid), digest))));
        bytes32 hash = keccak256(
            abi.encodePacked(bytes2(0x1901), MULTICHAIN_DOMAIN_SEPARATOR, keccak256(abi.encode(MULTICHAIN_SESSION_TYPEHASH, chains)))
        );
        bytes32 msgHash = keccak256(
            abi.encodePacked(
                bytes2(0x1901), ISafeDomainE(safe).domainSeparator(), keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(hash))))
            )
        );
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(ownerKey, msgHash);
        e.permissionEnableSig = abi.encodePacked(address(0), r, sg, v);
    }

    function _flz(bytes memory data) internal pure returns (bytes memory out) {
        for (uint256 i; i < data.length; i += 32) {
            uint256 n = data.length - i < 32 ? data.length - i : 32;
            bytes memory chunk = new bytes(n);
            for (uint256 k; k < n; k++) {
                chunk[k] = data[i + k];
            }
            out = abi.encodePacked(out, uint8(n - 1), chunk);
        }
    }

    /// The first userOp: the owner's ENABLE payload plus the session key's signature over the op, executing `callData`.
    function _enableOp(bytes memory callData) internal view returns (PackedUserOperationV4 memory op) {
        op = _op(safe, callData, bytes32(0));
        bytes32 h = IEntryPointT(ENTRY_POINT).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(sessionKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        op.signature = abi.encodePacked(UNSAFE_ENABLE, _flz(abi.encode(_ownerEnable(sibling), abi.encodePacked(r, sg, v))));
    }

    function _send(PackedUserOperationV4 memory op) internal returns (bool ok) {
        PackedUserOperationV4[] memory ops = new PackedUserOperationV4[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        (ok,) = ENTRY_POINT.call(abi.encodeCall(IEntryPointT.handleOps, (ops, payable(bundler))));
    }

    /// wrap `amount` of the account's ETH, approve V4, swap it on the listed pool (V4's own bounds).
    function _wrapSwap(uint256 amount) internal view returns (bytes memory) {
        (uint256 minOut, uint160 limit) = helper.swapBounds(E_POOL, E_WETH, amount);
        Execution[] memory xs = new Execution[](3);
        xs[0] = Execution(E_WETH, amount, abi.encodeWithSignature("deposit()"));
        xs[1] = Execution(E_WETH, 0, abi.encodeWithSelector(0x095ea7b3, address(v4), amount));
        xs[2] = Execution(
            address(v4),
            0,
            abi.encodeCall(MamoruActionPolicyV4.swap, (SwapParams(E_POOL, E_WETH, amount, minOut, limit, vm.getBlockTimestamp())))
        );
        return _batch(xs);
    }

    /// approve V4 for exactly `amount`, then V4.bridge (I1: V4 pulls, burns, resets its allowance).
    function _bridgeCall(uint32 domain, uint256 amount) internal view returns (bytes memory) {
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(E_USDC, 0, abi.encodeWithSelector(0x095ea7b3, address(v4), amount));
        xs[1] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.bridge, (domain, E_USDC, amount)));
        return _batch(xs);
    }

    function _enabledAndSwapped() internal returns (uint256 usdc) {
        assertTrue(_send(_enableOp(_wrapSwap(0.05 ether))), "one owner signature: enable + wrap + swap");
        assertTrue(ISmartSessionT(SMART_SESSION).isPermissionEnabled(pid, safe), "sibling session enabled");
        usdc = IERC20T(E_USDC).balanceOf(safe);
    }

    // ------------------------------------------------------------ the chain table

    function test_table_ethereum() public {
        ChainsProbe p = new ChainsProbe();
        assertEq(p.chainOf(0), 1, "CCTP domain 0 is Ethereum");
        assertEq(p.chainOf(6), 8453);
        assertEq(p.chainOf(15), 143);
        assertEq(p.chainOf(3), 0, "Arbitrum is not in the table");
        MamoruV4Chains.Chain memory c = p.byChainId(1);
        assertEq(c.domain, 0);
        assertEq(c.stables[0], E_USDC);
        assertEq(c.stables[1], address(0), "USDT left out on Ethereum");
        assertEq(c.wrapped, E_WETH);
        assertEq(c.assets[0], E_WETH);
        assertEq(c.factory, 0x1F98431c8aD98523631AE4a59f267346ea31F984);
        assertEq(c.npm, 0xC36442b4a4522E871399CD717aBDD847Ab11FE88);
        assertEq(c.router, 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45);
        assertEq(p.byChainId(8453).wrapped, WETH);
        assertEq(p.byChainId(143).wrapped, M_WMON);
        // the pinned stack has the expected code on Ethereum (V4 runs this at every enable)
        helper.checkStack();
        assertEq(gasPol.gasReview(), 0.02 ether);
        // CCTP: USDC burnable on the canonical messenger here, USDT not
        assertEq(helper.poolInfo(E_POOL).token0, E_USDC);
    }

    // ------------------------------------------------------------ Init

    function test_init_siblingRules() public {
        vm.startPrank(SMART_SESSION);
        ConfigIdV4 id = ConfigIdV4.wrap(bytes32(uint256(0x307)));
        // a sibling whose home domain is this chain is refused
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 4));
        v4.initializeWithMultiplexer(safe, id, abi.encode(InitV4(C, 1, safe, DOMAIN_ETHEREUM, new uint256[](0))));
        // a home domain outside the table is refused
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 4));
        v4.initializeWithMultiplexer(safe, id, abi.encode(InitV4(C, 1, safe, 3, new uint256[](0))));
        // no home with a home domain is refused (unchanged)
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadInit.selector, 4));
        v4.initializeWithMultiplexer(safe, id, abi.encode(InitV4(C, 1, address(0), DOMAIN_BASE, new uint256[](0))));
        // the sibling on Base's domain is accepted
        v4.initializeWithMultiplexer(safe, id, abi.encode(InitV4(C, 1, safe, DOMAIN_BASE, new uint256[](0))));
        vm.stopPrank();
        assertEq(v4.configOf(safe).home, safe);
        assertEq(v4.configOf(safe).homeDomain, DOMAIN_BASE);
        // a sibling has no remotes of its own
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadBridge.selector, 4));
        v4.registerRemote(DOMAIN_MONAD, makeAddr("sk"));
    }

    /// A home account on Ethereum (home = 0, domain 0) is accepted: domain 0 is not a sentinel.
    function test_init_homeOnEthereum() public {
        vm.prank(SMART_SESSION);
        v4.initializeWithMultiplexer(acct, ID, abi.encode(InitV4(C, 1, address(0), 0, new uint256[](0))));
        assertEq(v4.configOf(acct).home, address(0));
    }

    // ------------------------------------------------------------ native value

    function test_checkAction_nativeValueOnlyToWrap() public {
        vm.prank(SMART_SESSION);
        v4.initializeWithMultiplexer(acct, ID, abi.encode(InitV4(C, 1, acct, DOMAIN_BASE, new uint256[](0))));
        vm.startPrank(SMART_SESSION);
        bytes memory wrap = abi.encodeWithSignature("deposit()");
        bytes memory unwrap = abi.encodeWithSignature("withdraw(uint256)", 1 ether);
        assertEq(v4.checkAction(ID, acct, E_WETH, 1 ether, wrap), 0, "wrap own ETH");
        assertEq(v4.checkAction(ID, acct, E_WETH, 0, wrap), 1, "wrap of nothing");
        assertEq(v4.checkAction(ID, acct, E_WETH, 1 ether, abi.encodePacked(wrap, uint256(0))), 1, "wrap with extra data");
        assertEq(v4.checkAction(ID, acct, E_WETH, 0, unwrap), 0, "unwrap back to the account");
        assertEq(v4.checkAction(ID, acct, E_WETH, 1, unwrap), 1, "unwrap carrying value");
        assertEq(v4.checkAction(ID, acct, E_USDC, 1, wrap), 1, "value to another token");
        assertEq(v4.checkAction(ID, acct, address(v4), 1, abi.encodeWithSelector(MamoruActionPolicyV4.bridge.selector)), 1);
        assertEq(v4.checkAction(ID, acct, attacker, 1 ether, wrap), 1, "value to anyone else");
        assertEq(v4.checkAction(ID, acct, E_WETH, 1 ether, abi.encodeWithSelector(0x095ea7b3, address(v4), 1)), 1, "approve with value");
        assertEq(v4.checkAction(ID, acct, E_WETH, 0, abi.encodeWithSelector(0x095ea7b3, address(v4), 1)), 0, "approve V4 (unchanged)");
        assertEq(v4.checkAction(ID, acct, E_WETH, 0, abi.encodeWithSelector(0xa9059cbb, attacker, 1)), 1, "WETH transfer out");
        assertEq(v4.checkAction(ID, acct, E_WETH, 0, abi.encodeWithSelector(0x095ea7b3, attacker, 1)), 1, "WETH approve to another");
        vm.stopPrank();
    }

    // ------------------------------------------------------------ end to end: one signature, then Mamoru

    function test_sibling_oneSignatureThenWrapSwapBridgeHome() public {
        uint256 usdc = _enabledAndSwapped();
        assertGt(usdc, 100e6, "0.05 ETH became USDC under V4's bounds");
        assertEq(IERC20T(E_WETH).balanceOf(safe), 0, "all the wrapped ETH swapped");
        assertLt(safe.balance, ETH_HELD - 0.05 ether + 1, "the rest stays as gas");
        // the bridge home waits for the guardian
        assertFalse(v4.isReady(safe, DOMAIN_BASE));
        (bool ok,) = _runOp(safe, _bridgeCall(DOMAIN_BASE, usdc), pid);
        assertFalse(ok, "no burn before the guardian read the home back");
        assertEq(IERC20T(E_USDC).balanceOf(safe), usdc);
        // the guardian read it back on Base (same address, same owners): ready
        vm.prank(guardian);
        v4.setReady(safe, DOMAIN_BASE, safe);
        assertTrue(v4.isReady(safe, DOMAIN_BASE));
        watchEmitter = TOKEN_MESSENGER;
        watchWord = bytes32(uint256(uint160(safe)));
        _run(safe, _bridgeCall(DOMAIN_BASE, usdc), pid);
        assertTrue(watchSeen, "CCTP mintRecipient is the account's own address");
        assertEq(IERC20T(E_USDC).balanceOf(safe), 0, "burned to Base");
    }

    function test_sibling_bridgeOnlyHome() public {
        uint256 usdc = _enabledAndSwapped();
        vm.prank(guardian);
        v4.setReady(safe, DOMAIN_BASE, safe);
        (bool ok,) = _runOp(safe, _bridgeCall(DOMAIN_MONAD, usdc), pid);
        assertFalse(ok, "a sibling bridges only to its home domain");
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.BadBridge.selector, 2));
        v4.bridge(DOMAIN_MONAD, E_USDC, usdc);
    }

    function test_sibling_readinessRules() public {
        _enabledAndSwapped();
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.RemoteNotReady.selector, DOMAIN_MONAD));
        v4.setReady(safe, DOMAIN_MONAD, safe); // not its home domain
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.RemoteNotReady.selector, DOMAIN_BASE));
        v4.setReady(safe, DOMAIN_BASE, attacker); // not the account itself
        vm.stopPrank();
        vm.prank(attacker);
        vm.expectRevert(MamoruActionPolicyV4.OnlyGuardian.selector);
        v4.setReady(safe, DOMAIN_BASE, safe);
        vm.prank(guardian);
        v4.setReady(safe, DOMAIN_BASE, safe);
        assertTrue(v4.isReady(safe, DOMAIN_BASE));
        assertFalse(v4.isReady(safe, DOMAIN_MONAD));
        // an owner change on the sibling stops every burn until the guardian reads it back again
        assertTrue(_ownerTx(safe, safe, abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", makeAddr("new owner"), 1), 0));
        assertFalse(v4.isReady(safe, DOMAIN_BASE), "owners changed: not ready");
        uint256 usdc = IERC20T(E_USDC).balanceOf(safe);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV4.RemoteNotReady.selector, DOMAIN_BASE));
        v4.bridge(DOMAIN_BASE, E_USDC, usdc);
        vm.prank(guardian);
        v4.clearReady(safe, DOMAIN_BASE);
        assertFalse(v4.isReady(safe, DOMAIN_BASE));
    }

    /// Unwrapping pays the account back through WETH9's 2300-gas transfer: the Safe proxy, warm inside its own
    /// execution, accepts it.
    function test_sibling_unwrapBackToTheAccount() public {
        _enabledAndSwapped();
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(E_WETH, 0.001 ether, abi.encodeWithSignature("deposit()"));
        xs[1] = Execution(E_WETH, 0, abi.encodeWithSignature("withdraw(uint256)", 0.001 ether));
        uint256 before = safe.balance;
        _run(safe, _batch(xs), pid);
        assertEq(IERC20T(E_WETH).balanceOf(safe), 0);
        assertGt(safe.balance + 0.0005 ether, before, "the ETH came back (less the op's gas)");
    }

    /// Review of #209: the wrapped native of Base (OP WETH9 predeploy) and Monad (WMON) credit and pay back the Safe
    /// itself, and the unwrap's stipend reaches a Safe proxy there too (from the Safe's own execution).
    function test_wrapUnwrapFromASafeOnBaseAndMonad() public {
        uint256 monadFork = vm.createFork(vm.envOr("MONAD_FORK_RPC_URL", string("https://rpc.monad.xyz")), MONAD_BLOCK);
        address[2] memory wrapped = [WETH, M_WMON];
        uint256[2] memory forks = [baseFork, monadFork];
        for (uint256 i; i < 2; i++) {
            vm.selectFork(forks[i]);
            address s = _newSafe(9_307 + i);
            uint256 before = s.balance;
            assertTrue(_ownerTxValue(s, wrapped[i], 0.01 ether, abi.encodeWithSignature("deposit()")), "wrap");
            assertEq(IERC20T(wrapped[i]).balanceOf(s), 0.01 ether, "credited to the Safe");
            assertTrue(_ownerTxValue(s, wrapped[i], 0, abi.encodeWithSignature("withdraw(uint256)", 0.01 ether)), "unwrap");
            assertEq(IERC20T(wrapped[i]).balanceOf(s), 0);
            assertEq(s.balance, before, "paid back to the Safe");
        }
    }

    /// Review of #209: a route to Ethereum is CCTP domain 0, and the registry takes it like any other.
    function test_routeToEthereumDomainZero() public {
        vm.selectFork(baseFork);
        _route(DOMAIN_ETHEREUM);
        assertTrue(reg.routeOn(DOMAIN_ETHEREUM));
    }

    function _ownerTxValue(address s, address to, uint256 value, bytes memory data) internal returns (bool ok) {
        address o = vm.addr(ownerKey);
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(o))), bytes32(0), uint8(1));
        vm.prank(o);
        (bool sent, bytes memory r) = s.call(
            abi.encodeWithSignature(
                "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
                to, value, data, uint8(0), 0, 0, 0, address(0), address(0), sig
            )
        );
        ok = sent && abi.decode(r, (bool));
    }

    /// The session key alone cannot move native value anywhere but the wrapped native: refused at validation.
    function test_sibling_valueElsewhereRefused() public {
        _enabledAndSwapped();
        Execution[] memory xs = new Execution[](1);
        xs[0] = Execution(attacker, 0.001 ether, "");
        _rejected(safe, _batch(xs), pid);
        xs[0] = Execution(E_USDC, 0.001 ether, abi.encodeWithSelector(0x095ea7b3, address(v4), 1));
        _rejected(safe, _batch(xs), pid);
        assertEq(attacker.balance, 0);
    }
}
