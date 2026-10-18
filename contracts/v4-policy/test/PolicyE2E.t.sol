// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import "./SessionFork.sol";
import {MamoruV4LiquidityPolicy, ConfigId} from "../src/MamoruV4LiquidityPolicy.sol";

/**
 * Design A end to end: a session key drives modifyLiquidities directly, bounded by MamoruV4LiquidityPolicy through the
 * real Smart Sessions validator. The account pays through Permit2 with an allowance the owner set at activation.
 */
abstract contract PolicyE2E is SessionFork {
    // v4-periphery Actions.sol
    uint8 constant INCREASE = 0x00;
    uint8 constant DECREASE = 0x01;
    uint8 constant MINT = 0x02;
    uint8 constant BURN = 0x03;
    uint8 constant SETTLE = 0x0b;
    uint8 constant SETTLE_PAIR = 0x0d;
    uint8 constant TAKE = 0x0e;
    uint8 constant TAKE_PAIR = 0x11;
    uint8 constant CLOSE = 0x12;
    uint8 constant CLEAR_OR_TAKE = 0x13;
    uint8 constant SWEEP = 0x14;

    uint32 constant WINDOW = 1 hours;
    int24 constant RANGE = 6_000; // allowlisted ticks: spot +-6000 (about +-80% in price)

    MamoruV4LiquidityPolicy policy;
    bytes32 pid;
    int24 minLower;
    int24 maxUpper;

    function setUp() public {
        _setUpFork();
        policy = new MamoruV4LiquidityPolicy();
        vm.label(address(policy), "V4Policy");
        _trustAndSelfAttest(address(policy));
        (minLower, maxUpper) = _range(key, RANGE);
        pid = _enable(_session(_actions(_init(new address[](0), _rules(key))), "v4-policy"));
        // Smart Sessions initialized the policy under the ConfigId the tests recompute (multiplexer = SmartSession).
        assertEq(policy.configOf(_cfg(pid), ch.smartSession, safe).positionManager, ch.positionManager);

        deal(key.currency0, safe, ch.amount0 * 10);
        deal(key.currency1, safe, ch.amount1 * 10);
        // Activation (owner batch): Permit2 is the account's cumulative cap; the policy bounds each call's shape.
        Call[] memory c = new Call[](4);
        c[0] = Call(key.currency0, abi.encodeCall(IERC20.approve, (ch.permit2, type(uint256).max)));
        c[1] = Call(key.currency1, abi.encodeCall(IERC20.approve, (ch.permit2, type(uint256).max)));
        c[2] = Call(
            ch.permit2,
            abi.encodeCall(
                IPermit2.approve,
                (key.currency0, ch.positionManager, uint160(ch.amount0 * 5), uint48(block.timestamp + 30 days))
            )
        );
        c[3] = Call(
            ch.permit2,
            abi.encodeCall(
                IPermit2.approve,
                (key.currency1, ch.positionManager, uint160(ch.amount1 * 5), uint48(block.timestamp + 30 days))
            )
        );
        _ownerBatch(c);
    }

    // ---------------------------------------------------------------- grant

    function _rules(PoolKey memory k) internal view returns (MamoruV4LiquidityPolicy.PoolRule[] memory r) {
        r = new MamoruV4LiquidityPolicy.PoolRule[](1);
        r[0] = MamoruV4LiquidityPolicy.PoolRule(k, minLower, maxUpper, uint128(ch.amount0 * 2), uint128(ch.amount1 * 2));
    }

    function _init(address[] memory hooks, MamoruV4LiquidityPolicy.PoolRule[] memory rules)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(MamoruV4LiquidityPolicy.Init(ch.positionManager, WINDOW, hooks, rules));
    }

    function _actions(bytes memory init) internal view returns (ActionData[] memory a) {
        PolicyData[] memory p = new PolicyData[](1);
        p[0] = PolicyData(address(policy), init);
        a = new ActionData[](1);
        a[0] = ActionData(IPositionManager.modifyLiquidities.selector, ch.positionManager, p);
    }

    // ---------------------------------------------------------------- v4 programs

    function _call(bytes memory actions, bytes[] memory params) internal view returns (bytes memory) {
        return _single(ch.positionManager, _modify(actions, params, block.timestamp + 10 minutes));
    }

    function _modify(bytes memory actions, bytes[] memory params, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(IPositionManager.modifyLiquidities, (abi.encode(actions, params), deadline));
    }

    function _mintParams(PoolKey memory k, int24 lo, int24 hi, address owner) internal view returns (bytes memory) {
        uint128 liq = _liquidityFor(k, lo, hi, ch.amount0, ch.amount1);
        return abi.encode(k, lo, hi, uint256(liq), uint128(ch.amount0 * 2), uint128(ch.amount1 * 2), owner, bytes(""));
    }

    function _mintProgram(PoolKey memory k, int24 lo, int24 hi, address owner)
        internal
        view
        returns (bytes memory actions, bytes[] memory params)
    {
        actions = abi.encodePacked(MINT, SETTLE_PAIR);
        params = new bytes[](2);
        params[0] = _mintParams(k, lo, hi, owner);
        params[1] = abi.encode(k.currency0, k.currency1);
    }

    function _mintNow() internal returns (uint256 tokenId, uint256 gas) {
        (int24 lo, int24 hi) = _range(key, 1_000);
        (bytes memory a, bytes[] memory p) = _mintProgram(key, lo, hi, safe);
        tokenId = IPositionManager(ch.positionManager).nextTokenId();
        gas = _run(_call(a, p), pid);
        assertEq(IPositionManager(ch.positionManager).ownerOf(tokenId), safe, "minted to the account");
    }

    function _takePair(address to) internal view returns (bytes memory) {
        return abi.encode(key.currency0, key.currency1, to);
    }

    function _one(uint8 a, bytes memory p) internal pure returns (bytes memory actions, bytes[] memory params) {
        actions = abi.encodePacked(a);
        params = new bytes[](1);
        params[0] = p;
    }

    function _two(uint8 a, bytes memory p, uint8 b, bytes memory q)
        internal
        pure
        returns (bytes memory actions, bytes[] memory params)
    {
        actions = abi.encodePacked(a, b);
        params = new bytes[](2);
        params[0] = p;
        params[1] = q;
    }

    /// Refused twice over: the policy itself returns VALIDATION_FAILED for the SmartSession config of this session,
    /// and the EntryPoint rejects the userOp at validation (AA23), so nothing runs and no nonce is spent.
    function _deny(bytes memory actions, bytes[] memory params) internal {
        bytes memory data = _modify(actions, params, block.timestamp + 10 minutes);
        vm.prank(ch.smartSession);
        assertEq(policy.checkAction(_cfg(pid), safe, ch.positionManager, 0, data), 1, "policy must refuse");
        assertEq(_rejected(_single(ch.positionManager, data), pid), "AA23 reverted");
    }

    /// smartsessions IdLib: ConfigId = keccak(account, keccak(permissionId, keccak(target, selector))).
    function _cfg(bytes32 permissionId) internal view returns (ConfigId) {
        bytes32 actionId = keccak256(abi.encodePacked(ch.positionManager, IPositionManager.modifyLiquidities.selector));
        return ConfigId.wrap(keccak256(abi.encodePacked(safe, keccak256(abi.encodePacked(permissionId, actionId)))));
    }

    // ---------------------------------------------------------------- the engine's operations pass

    function test_lifecycle_mint_collect_increase_decrease_burn() public {
        (uint256 tokenId, uint256 gMint) = _mintNow();
        _log("policy  mint (MINT+SETTLE_PAIR)", gMint);
        uint128 liq0 = IPositionManager(ch.positionManager).getPositionLiquidity(tokenId);
        assertGt(liq0, 0);

        // Fees: a third party trades through the pool, then the session collects (DECREASE 0 + TAKE_PAIR).
        _churn(key, ch.amount0 / 4);
        uint256 b0 = _bal(key.currency0);
        uint256 b1 = _bal(key.currency1);
        (bytes memory a, bytes[] memory p) = _two(
            DECREASE, abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes("")), TAKE_PAIR, _takePair(safe)
        );
        uint256 gCollect = _run(_call(a, p), pid);
        _log("policy  collect (DECREASE 0+TAKE_PAIR)", gCollect);
        assertGt(_bal(key.currency0) + _bal(key.currency1), b0 + b1, "fees collected to the account");

        // Increase (INCREASE + CLOSE + CLOSE).
        uint128 more = liq0 / 2;
        a = abi.encodePacked(INCREASE, CLOSE, CLOSE);
        p = new bytes[](3);
        p[0] = abi.encode(tokenId, uint256(more), uint128(ch.amount0 * 2), uint128(ch.amount1 * 2), bytes(""));
        p[1] = abi.encode(key.currency0);
        p[2] = abi.encode(key.currency1);
        uint256 gInc = _run(_call(a, p), pid);
        _log("policy  increase (INCREASE+CLOSE x2)", gInc);
        assertEq(IPositionManager(ch.positionManager).getPositionLiquidity(tokenId), liq0 + more);

        // Decrease half (DECREASE + TAKE_PAIR).
        (a, p) = _two(
            DECREASE,
            abi.encode(tokenId, uint256(liq0 / 2), uint128(0), uint128(0), bytes("")),
            TAKE_PAIR,
            _takePair(safe)
        );
        uint256 gDec = _run(_call(a, p), pid);
        _log("policy  decrease (DECREASE+TAKE_PAIR)", gDec);

        // Burn (BURN + TAKE_PAIR).
        (a, p) = _two(BURN, abi.encode(tokenId, uint128(0), uint128(0), bytes("")), TAKE_PAIR, _takePair(safe));
        uint256 gBurn = _run(_call(a, p), pid);
        _log("policy  burn (BURN+TAKE_PAIR)", gBurn);
        vm.expectRevert();
        IPositionManager(ch.positionManager).ownerOf(tokenId);

        (, uint256 gMint2) = _mintNow();
        _log("policy  mint again, warm account", gMint2);
    }

    /// An owner-allowlisted hook works; the policy is not hook-less-only by construction.
    function test_allowlistedHookPoolWorks() public {
        PoolKey memory hk = _hookedPool(key, 1 << 11);
        address[] memory hooks = new address[](1);
        hooks[0] = hk.hooks;
        bytes32 pid2 = _enable(_session(_actions(_init(hooks, _rules(hk))), "v4-policy-hook"));
        (int24 lo, int24 hi) = _range(hk, 1_000);
        (bytes memory a, bytes[] memory p) = _mintProgram(hk, lo, hi, safe);
        _run(_call(a, p), pid2);
    }

    // ---------------------------------------------------------------- attacks a leaked session key tries

    function test_attack_takeToThirdParty() public {
        (uint256 tokenId,) = _mintNow();
        (bytes memory a, bytes[] memory p) = _two(
            DECREASE, abi.encode(tokenId, uint256(1), uint128(0), uint128(0), bytes("")), TAKE_PAIR, _takePair(attacker)
        );
        _deny(a, p);
        // ActionConstants aliases are refused too: address(2) = PositionManager itself (anyone could sweep it).
        (a, p) = _two(
            DECREASE,
            abi.encode(tokenId, uint256(1), uint128(0), uint128(0), bytes("")),
            TAKE_PAIR,
            _takePair(address(2))
        );
        _deny(a, p);
    }

    function test_attack_mintToThirdParty() public {
        (int24 lo, int24 hi) = _range(key, 1_000);
        (bytes memory a, bytes[] memory p) = _mintProgram(key, lo, hi, attacker);
        _deny(a, p);
        (a, p) = _mintProgram(key, lo, hi, address(1)); // MSG_SENDER alias: refused, only the exact account passes
        _deny(a, p);
    }

    function test_attack_foreignPool() public {
        PoolKey memory other = PoolKey(key.currency0, key.currency1, 3000, 60, address(0));
        (int24 lo, int24 hi) = (minLower / 60 * 60 + 600, maxUpper / 60 * 60 - 600);
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encode(other, lo, hi, uint256(1e6), uint128(ch.amount0), uint128(ch.amount1), safe, bytes(""));
        p[1] = abi.encode(other.currency0, other.currency1);
        _deny(abi.encodePacked(MINT, SETTLE_PAIR), p);
    }

    function test_attack_unallowlistedHook() public {
        PoolKey memory hk = _hookedPool(key, 1 << 11);
        (int24 lo, int24 hi) = _range(hk, 1_000);
        (bytes memory a, bytes[] memory p) = _mintProgram(hk, lo, hi, safe);
        _deny(a, p);
    }

    function test_attack_outOfRangeTicks() public {
        int24 s = key.tickSpacing;
        (bytes memory a, bytes[] memory p) = _mintProgram(key, minLower - s, maxUpper, safe);
        _deny(a, p);
        (a, p) = _mintProgram(key, minLower, maxUpper + s, safe);
        _deny(a, p);
        (a, p) = _mintProgram(key, minLower, maxUpper, safe); // the edges themselves pass
        _run(_call(a, p), pid);
    }

    function test_attack_extraActions() public {
        (int24 lo, int24 hi) = _range(key, 1_000);
        bytes memory mint = _mintParams(key, lo, hi, safe);
        bytes memory pair = abi.encode(key.currency0, key.currency1);
        bytes[] memory p = new bytes[](3);
        p[0] = mint;
        p[1] = pair;
        // SWEEP to the attacker appended
        p[2] = abi.encode(key.currency0, attacker);
        _deny(abi.encodePacked(MINT, SETTLE_PAIR, SWEEP), p);
        // TAKE with a free recipient
        p[2] = abi.encode(key.currency0, attacker, uint256(1));
        _deny(abi.encodePacked(MINT, SETTLE_PAIR, TAKE), p);
        // CLEAR_OR_TAKE forfeits a credit
        p[2] = abi.encode(key.currency0, uint256(type(uint128).max));
        _deny(abi.encodePacked(MINT, SETTLE_PAIR, CLEAR_OR_TAKE), p);
        // SETTLE with payerIsUser=false pays from PositionManager's own balance
        p[2] = abi.encode(key.currency0, uint256(0), false);
        _deny(abi.encodePacked(MINT, SETTLE_PAIR, SETTLE), p);
        // unknown action byte
        p[2] = "";
        _deny(abi.encodePacked(MINT, SETTLE_PAIR, uint8(0x19)), p);
        // a second liquidity-adding step doubles the cap: refused
        p[2] = mint;
        _deny(abi.encodePacked(MINT, SETTLE_PAIR, MINT), p);
    }

    function test_attack_increaseIntoAttackerPosition() public {
        // The attacker mints its own position in the allowlisted pool and approves the Safe as operator, so
        // PositionManager's onlyIfApproved would let the Safe add to it. The policy requires ownerOf == account.
        (int24 lo, int24 hi) = _range(key, 1_000);
        deal(key.currency0, attacker, ch.amount0 * 2);
        deal(key.currency1, attacker, ch.amount1 * 2);
        uint256 theirs = IPositionManager(ch.positionManager).nextTokenId();
        vm.startPrank(attacker);
        IERC20(key.currency0).approve(ch.permit2, type(uint256).max);
        IERC20(key.currency1).approve(ch.permit2, type(uint256).max);
        IPermit2(ch.permit2).approve(key.currency0, ch.positionManager, type(uint160).max, type(uint48).max);
        IPermit2(ch.permit2).approve(key.currency1, ch.positionManager, type(uint160).max, type(uint48).max);
        (bytes memory a, bytes[] memory p) = _mintProgram(key, lo, hi, attacker);
        IPositionManager(ch.positionManager).modifyLiquidities(abi.encode(a, p), block.timestamp + 60);
        IPositionManager(ch.positionManager).setApprovalForAll(safe, true);
        vm.stopPrank();

        bytes[] memory q = new bytes[](3);
        q[0] = abi.encode(theirs, uint256(1e6), uint128(ch.amount0), uint128(ch.amount1), bytes(""));
        q[1] = abi.encode(key.currency0);
        q[2] = abi.encode(key.currency1);
        _deny(abi.encodePacked(INCREASE, CLOSE, CLOSE), q);
    }

    function test_attack_positionInUnlistedPool() public {
        // The owner holds a position in another pool (minted outside the session). The session cannot touch it.
        PoolKey memory hk = _hookedPool(key, 1 << 11);
        (int24 lo, int24 hi) = _range(hk, 1_000);
        (bytes memory a, bytes[] memory p) = _mintProgram(hk, lo, hi, safe);
        uint256 own = IPositionManager(ch.positionManager).nextTokenId();
        _ownerCall(
            ch.positionManager,
            abi.encodeCall(IPositionManager.modifyLiquidities, (abi.encode(a, p), block.timestamp + 60))
        );
        assertEq(IPositionManager(ch.positionManager).ownerOf(own), safe);
        (a, p) = _two(BURN, abi.encode(own, uint128(0), uint128(0), bytes("")), TAKE_PAIR, _takePair(safe));
        _deny(a, p);
    }

    function test_attack_nativeValue() public {
        (int24 lo, int24 hi) = _range(key, 1_000);
        (bytes memory a, bytes[] memory p) = _mintProgram(key, lo, hi, safe);
        bytes memory data = _modify(a, p, block.timestamp + 60);
        vm.prank(ch.smartSession);
        assertEq(policy.checkAction(_cfg(pid), safe, ch.positionManager, 1, data), 1, "policy must refuse value");
        assertEq(_rejected(_singleWithValue(ch.positionManager, 1, data), pid), "AA23 reverted");
    }

    function test_attack_deadlineOutsideWindow() public {
        (int24 lo, int24 hi) = _range(key, 1_000);
        (bytes memory a, bytes[] memory p) = _mintProgram(key, lo, hi, safe);
        string memory r = _rejected(_single(ch.positionManager, _modify(a, p, block.timestamp + WINDOW + 60)), pid);
        assertEq(r, "AA22 expired or not due");
        _run(_single(ch.positionManager, _modify(a, p, block.timestamp + WINDOW - 60)), pid);
    }

    function test_attack_hookDataAndNonCanonicalEncoding() public {
        (int24 lo, int24 hi) = _range(key, 1_000);
        uint128 liq = _liquidityFor(key, lo, hi, ch.amount0, ch.amount1);
        bytes[] memory p = new bytes[](2);
        p[1] = abi.encode(key.currency0, key.currency1);
        p[0] = abi.encode(key, lo, hi, uint256(liq), uint128(ch.amount0), uint128(ch.amount1), safe, bytes("x"));
        _deny(abi.encodePacked(MINT, SETTLE_PAIR), p);
        // Trailing bytes after a canonical param: PositionManager's decoder would ignore them, the policy refuses.
        p[0] = abi.encodePacked(_mintParams(key, lo, hi, safe), bytes32(uint256(uint160(attacker))));
        _deny(abi.encodePacked(MINT, SETTLE_PAIR), p);
    }

    // ---------------------------------------------------------------- policy-level checks and isolated gas

    function test_policyInitRefusesLiquidityDeltaHook() public {
        address bad = address(uint160(0xBEEF) << 144 | 1); // AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA
        address[] memory hooks = new address[](1);
        hooks[0] = bad;
        PoolKey memory hk = PoolKey(key.currency0, key.currency1, key.fee, key.tickSpacing, bad);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4LiquidityPolicy.InvalidPool.selector, 0));
        policy.initializeWithMultiplexer(safe, ConfigId.wrap(bytes32(uint256(9))), _init(hooks, _rules(hk)));
    }

    function test_reinitRetiresOldPools() public {
        ConfigId id = ConfigId.wrap(bytes32(uint256(7)));
        policy.initializeWithMultiplexer(safe, id, _init(new address[](0), _rules(key)));
        (int24 lo, int24 hi) = _range(key, 1_000);
        (bytes memory a, bytes[] memory p) = _mintProgram(key, lo, hi, safe);
        bytes memory data = _modify(a, p, block.timestamp + 60);
        uint256 vd = policy.checkAction(id, safe, ch.positionManager, 0, data);
        assertEq(vd & type(uint160).max, 0, "valid under the first init");
        assertEq(vd >> 160 & type(uint48).max, block.timestamp + 60, "validUntil = deadline");
        assertEq(vd >> 208, block.timestamp + 60 - WINDOW, "validAfter = deadline - window");
        PoolKey memory other = PoolKey(key.currency0, key.currency1, 3000, 60, address(0));
        policy.initializeWithMultiplexer(safe, id, _init(new address[](0), _rules(other)));
        assertEq(policy.checkAction(id, safe, ch.positionManager, 0, data), 1, "old pool dead after re-init");
    }

    function test_gas_checkActionIsolated() public {
        ConfigId id = ConfigId.wrap(bytes32(uint256(8)));
        policy.initializeWithMultiplexer(safe, id, _init(new address[](0), _rules(key)));
        (int24 lo, int24 hi) = _range(key, 1_000);
        (bytes memory a, bytes[] memory p) = _mintProgram(key, lo, hi, safe);
        bytes memory data = _modify(a, p, block.timestamp + 60);
        uint256 g = gasleft();
        policy.checkAction(id, safe, ch.positionManager, 0, data);
        _log("policy  checkAction(MINT+SETTLE_PAIR) alone", g - gasleft());

        (uint256 tokenId,) = _mintNow();
        (a, p) = _two(BURN, abi.encode(tokenId, uint128(0), uint128(0), bytes("")), TAKE_PAIR, _takePair(safe));
        data = _modify(a, p, block.timestamp + 60);
        g = gasleft();
        policy.checkAction(id, safe, ch.positionManager, 0, data);
        _log("policy  checkAction(BURN+TAKE_PAIR) alone", g - gasleft());
    }
}

contract PolicyE2EBase is PolicyE2E {
    function _chain() internal view override returns (Net memory) {
        return Chains.base();
    }
}

contract PolicyE2EMonad is PolicyE2E {
    function _chain() internal view override returns (Net memory) {
        return Chains.monad();
    }
}
