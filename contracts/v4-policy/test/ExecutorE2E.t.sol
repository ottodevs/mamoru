// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./SessionFork.sol";
import {MamoruV4Executor} from "../src/MamoruV4Executor.sol";

// erc7579/smartsessions external/policies/UniActionPolicy.sol, same ABI as packages/account/sessions uniActionInitData.
struct LimitUsage {
    uint256 limit;
    uint256 used;
}

struct ParamRule {
    uint8 condition; // EQUAL, GREATER_THAN, LESS_THAN, GREATER_THAN_OR_EQUAL, LESS_THAN_OR_EQUAL, NOT_EQUAL, IN_RANGE
    uint64 offset;
    bool isLimited;
    bytes32 ref;
    LimitUsage usage;
}

struct ParamRules {
    uint256 length;
    ParamRule[16] rules;
}

struct ActionConfig {
    uint256 valueLimitPerUse;
    ParamRules paramRules;
}

/**
 * Design B end to end: a session key calls MamoruV4Executor with flat arguments, bounded by the stock UniActionPolicy
 * already deployed on both chains. The account approved the executor for ERC-20 budgets and its v4 positions.
 */
abstract contract ExecutorE2E is SessionFork {
    uint8 constant EQUAL = 0;
    uint8 constant LTE = 4;
    uint8 constant IN_RANGE = 6;

    int24 constant RANGE = 6_000;

    MamoruV4Executor executor;
    bytes32 pid;
    int24 minLower;
    int24 maxUpper;

    function setUp() public {
        _setUpFork();
        executor = new MamoruV4Executor(ch.positionManager, ch.permit2);
        vm.label(address(executor), "V4Executor");
        (minLower, maxUpper) = _range(key, RANGE);
        pid = _enable(_session(_grant(key), "v4-executor"));

        deal(key.currency0, safe, ch.amount0 * 20);
        deal(key.currency1, safe, ch.amount1 * 20);
        // Activation (owner batch): ERC-20 budgets to the executor and operator rights over the account's positions.
        // The executor pulls amountMax and refunds the rest, so each call consumes the allowance at amountMax.
        Call[] memory c = new Call[](3);
        c[0] = Call(key.currency0, abi.encodeCall(IERC20.approve, (address(executor), ch.amount0 * 10)));
        c[1] = Call(key.currency1, abi.encodeCall(IERC20.approve, (address(executor), ch.amount1 * 10)));
        c[2] = Call(ch.positionManager, abi.encodeCall(IPositionManager.setApprovalForAll, (address(executor), true)));
        _ownerBatch(c);
    }

    // ---------------------------------------------------------------- grant: four actions, UniActionPolicy rules

    function _rule(uint8 cond, uint256 word, bytes32 ref) internal pure returns (ParamRule memory) {
        return ParamRule(cond, uint64(word * 32), false, ref, LimitUsage(0, 0));
    }

    function _biased(int24 t) internal pure returns (uint24) {
        return uint24(uint256(int256(t) + int256(uint256(1 << 23))));
    }

    /// Words 0..4 = the pool key (EQUAL), 5/6 = biased ticks (IN_RANGE), then per-function amount caps (LTE).
    function _cfg(PoolKey memory k, bool ticks, uint256 a0Word, uint256 a1Word) internal view returns (bytes memory) {
        ActionConfig memory cfg;
        ParamRule[16] memory r;
        r[0] = _rule(EQUAL, 0, bytes32(uint256(uint160(k.currency0))));
        r[1] = _rule(EQUAL, 1, bytes32(uint256(uint160(k.currency1))));
        r[2] = _rule(EQUAL, 2, bytes32(uint256(k.fee)));
        r[3] = _rule(EQUAL, 3, bytes32(uint256(int256(k.tickSpacing))));
        r[4] = _rule(EQUAL, 4, bytes32(uint256(uint160(k.hooks))));
        uint256 n = 5;
        if (ticks) {
            bytes32 range = bytes32((uint256(_biased(minLower)) << 128) | uint256(_biased(maxUpper)));
            r[n++] = _rule(IN_RANGE, 5, range);
            r[n++] = _rule(IN_RANGE, 6, range);
        }
        if (a0Word != 0) {
            r[n++] = _rule(LTE, a0Word, bytes32(ch.amount0 * 2));
            r[n++] = _rule(LTE, a1Word, bytes32(ch.amount1 * 2));
        }
        cfg.paramRules = ParamRules(n, r);
        return abi.encode(cfg);
    }

    function _action(bytes4 sel, bytes memory init) internal view returns (ActionData memory) {
        PolicyData[] memory p = new PolicyData[](1);
        p[0] = PolicyData(ch.uniActionPolicy, init);
        return ActionData(sel, address(executor), p);
    }

    function _grant(PoolKey memory k) internal view returns (ActionData[] memory a) {
        a = new ActionData[](4);
        // mint(key, tl, tu, liquidity, a0Max@8, a1Max@9, deadline)
        a[0] = _action(MamoruV4Executor.mint.selector, _cfg(k, true, 8, 9));
        // increase(key, tl, tu, tokenId, liquidity, a0Max@9, a1Max@10, deadline)
        a[1] = _action(MamoruV4Executor.increase.selector, _cfg(k, true, 9, 10));
        // decrease / burn: pool pinned; leaving does not depend on the range config
        a[2] = _action(MamoruV4Executor.decrease.selector, _cfg(k, false, 0, 0));
        a[3] = _action(MamoruV4Executor.burn.selector, _cfg(k, false, 0, 0));
    }

    // ---------------------------------------------------------------- calls

    function _mintCall(PoolKey memory k, int24 lo, int24 hi) internal view returns (bytes memory) {
        uint128 liq = _liquidityFor(k, lo, hi, ch.amount0, ch.amount1);
        return abi.encodeCall(
            MamoruV4Executor.mint,
            (
                _k(k),
                _biased(lo),
                _biased(hi),
                liq,
                uint128(ch.amount0 * 2),
                uint128(ch.amount1 * 2),
                block.timestamp + 600
            )
        );
    }

    function _k(PoolKey memory k) internal pure returns (PoolKey memory) {
        return k;
    }

    function _mintNow() internal returns (uint256 tokenId, int24 lo, int24 hi, uint256 gas) {
        uint256 stray0 = IERC20(key.currency0).balanceOf(address(executor));
        uint256 stray1 = IERC20(key.currency1).balanceOf(address(executor));
        (lo, hi) = _range(key, 1_000);
        tokenId = IPositionManager(ch.positionManager).nextTokenId();
        gas = _run(_single(address(executor), _mintCall(key, lo, hi)), pid);
        assertEq(IPositionManager(ch.positionManager).ownerOf(tokenId), safe);
        assertEq(IERC20(key.currency0).balanceOf(address(executor)), stray0, "executor keeps nothing of the call");
        assertEq(IERC20(key.currency1).balanceOf(address(executor)), stray1, "executor keeps nothing of the call");
    }

    function _decreaseCall(uint256 tokenId, int24 lo, int24 hi, uint256 liq) internal view returns (bytes memory) {
        return abi.encodeCall(
            MamoruV4Executor.decrease, (key, _biased(lo), _biased(hi), tokenId, liq, 0, 0, block.timestamp + 600)
        );
    }

    // ---------------------------------------------------------------- the engine's operations pass

    function test_lifecycle_mint_collect_increase_decrease_burn() public {
        (uint256 tokenId, int24 lo, int24 hi, uint256 gMint) = _mintNow();
        _log("executor mint", gMint);
        uint128 liq0 = IPositionManager(ch.positionManager).getPositionLiquidity(tokenId);

        _churn(key, ch.amount0 / 4);
        uint256 b = _bal(key.currency0) + _bal(key.currency1);
        uint256 gCollect = _run(_single(address(executor), _decreaseCall(tokenId, lo, hi, 0)), pid);
        _log("executor collect (decrease 0)", gCollect);
        assertGt(_bal(key.currency0) + _bal(key.currency1), b, "fees collected to the account");

        bytes memory inc = abi.encodeCall(
            MamoruV4Executor.increase,
            (
                key,
                _biased(lo),
                _biased(hi),
                tokenId,
                liq0 / 2,
                uint128(ch.amount0 * 2),
                uint128(ch.amount1 * 2),
                block.timestamp + 600
            )
        );
        uint256 gInc = _run(_single(address(executor), inc), pid);
        _log("executor increase", gInc);
        assertEq(IPositionManager(ch.positionManager).getPositionLiquidity(tokenId), liq0 + liq0 / 2);

        uint256 gDec = _run(_single(address(executor), _decreaseCall(tokenId, lo, hi, liq0 / 2)), pid);
        _log("executor decrease", gDec);

        bytes memory burn = abi.encodeCall(
            MamoruV4Executor.burn, (key, _biased(lo), _biased(hi), tokenId, 0, 0, block.timestamp + 600)
        );
        uint256 gBurn = _run(_single(address(executor), burn), pid);
        _log("executor burn", gBurn);
        vm.expectRevert();
        IPositionManager(ch.positionManager).ownerOf(tokenId);

        (,,, uint256 gMint2) = _mintNow();
        _log("executor mint again, warm account", gMint2);
        assertEq(IERC20(key.currency0).balanceOf(address(executor)), 0);
        assertEq(IERC20(key.currency1).balanceOf(address(executor)), 0);
    }

    // ---------------------------------------------------------------- attacks a leaked session key tries

    function test_attack_foreignPool() public {
        PoolKey memory other = PoolKey(key.currency0, key.currency1, 3000, 60, address(0));
        (int24 lo, int24 hi) = (minLower / 60 * 60 + 600, maxUpper / 60 * 60 - 600);
        bytes memory c = abi.encodeCall(
            MamoruV4Executor.mint,
            (other, _biased(lo), _biased(hi), 1e6, uint128(ch.amount0), uint128(ch.amount1), block.timestamp + 600)
        );
        assertEq(_rejected(_single(address(executor), c), pid), "AA23 reverted");
    }

    function test_attack_unallowlistedHook() public {
        PoolKey memory hk = _hookedPool(key, 1 << 11);
        (int24 lo, int24 hi) = _range(hk, 1_000);
        assertEq(_rejected(_single(address(executor), _mintCall(hk, lo, hi)), pid), "AA23 reverted");
    }

    function test_attack_outOfRangeTicks() public {
        int24 s = key.tickSpacing;
        _rejected(_single(address(executor), _mintCall(key, minLower - s, maxUpper)), pid);
        _rejected(_single(address(executor), _mintCall(key, minLower, maxUpper + s)), pid);
        // Negative ticks, positive ticks, a range across zero: biased, IN_RANGE handles all of them.
        _run(_single(address(executor), _mintCall(key, minLower, maxUpper)), pid);
    }

    function test_attack_amountOverCap() public {
        (int24 lo, int24 hi) = _range(key, 1_000);
        bytes memory c = abi.encodeCall(
            MamoruV4Executor.mint,
            (
                key,
                _biased(lo),
                _biased(hi),
                1e6,
                uint128(ch.amount0 * 2 + 1),
                uint128(ch.amount1),
                block.timestamp + 600
            )
        );
        _rejected(_single(address(executor), c), pid);
    }

    function test_attack_extraActionsAndThirdPartyRecipient() public {
        // The executor's arguments have no recipient and no program: the only way to add steps or pick a recipient
        // is to call PositionManager directly, which the session has no action for.
        (uint256 tokenId,,,) = _mintNow();
        bytes memory actions = abi.encodePacked(uint8(0x01), uint8(0x11));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(1), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, attacker);
        bytes memory direct =
            abi.encodeCall(IPositionManager.modifyLiquidities, (abi.encode(actions, params), block.timestamp + 60));
        _rejected(_single(ch.positionManager, direct), pid);
        // Nor can it call transferFrom on the NFT or the tokens.
        _rejected(
            _single(key.currency0, abi.encodeWithSignature("transfer(address,uint256)", attacker, uint256(1))), pid
        );
    }

    function test_attack_strangerCallsExecutorOnVictimPosition() public {
        // Every account that uses the executor has approved it for all its positions. A stranger (no session at all)
        // calls it directly on the victim's tokenId: the ownerOf == msg.sender check is all that stops it.
        (uint256 tokenId, int24 lo, int24 hi,) = _mintNow();
        uint128 liq = IPositionManager(ch.positionManager).getPositionLiquidity(tokenId);
        vm.prank(attacker);
        vm.expectRevert(MamoruV4Executor.NotOwner.selector);
        executor.decrease(_k(key), _biased(lo), _biased(hi), tokenId, liq, 0, 0, block.timestamp + 60);
        vm.prank(attacker);
        vm.expectRevert(MamoruV4Executor.NotOwner.selector);
        executor.burn(_k(key), _biased(lo), _biased(hi), tokenId, 0, 0, block.timestamp + 60);
    }

    function test_attack_increaseIntoAttackerPosition() public {
        // The attacker's own position, approved to the Safe. The session's rules pass (tokenId is free in them), the
        // executor refuses at execution: the userOp runs and fails, the account loses nothing but gas.
        (int24 lo, int24 hi) = _range(key, 1_000);
        deal(key.currency0, attacker, ch.amount0 * 2);
        deal(key.currency1, attacker, ch.amount1 * 2);
        uint256 theirs = IPositionManager(ch.positionManager).nextTokenId();
        vm.startPrank(attacker);
        IERC20(key.currency0).approve(address(executor), type(uint256).max);
        IERC20(key.currency1).approve(address(executor), type(uint256).max);
        IPositionManager(ch.positionManager).setApprovalForAll(address(executor), true);
        executor.mint(
            _k(key),
            _biased(lo),
            _biased(hi),
            _liquidityFor(key, lo, hi, ch.amount0, ch.amount1),
            uint128(ch.amount0 * 2),
            uint128(ch.amount1 * 2),
            block.timestamp + 60
        );
        IPositionManager(ch.positionManager).setApprovalForAll(safe, true);
        vm.stopPrank();
        assertEq(IPositionManager(ch.positionManager).ownerOf(theirs), attacker);

        uint256 b0 = _bal(key.currency0);
        uint256 b1 = _bal(key.currency1);
        uint128 l = IPositionManager(ch.positionManager).getPositionLiquidity(theirs);
        bytes memory inc = abi.encodeCall(
            MamoruV4Executor.increase,
            (
                key,
                _biased(lo),
                _biased(hi),
                theirs,
                1e6,
                uint128(ch.amount0),
                uint128(ch.amount1),
                block.timestamp + 600
            )
        );
        (bool ok,) = _submit(_op(_single(address(executor), inc), pid));
        assertFalse(ok, "execution must fail");
        assertEq(_bal(key.currency0), b0);
        assertEq(_bal(key.currency1), b1);
        assertEq(IPositionManager(ch.positionManager).getPositionLiquidity(theirs), l);
    }

    function test_attack_positionMismatch() public {
        // An account-owned position in another pool (the owner minted it outside the session), presented under the
        // allowlisted key so the session's rules pass: the executor proves the key against the position and refuses.
        PoolKey memory hk = _hookedPool(key, 1 << 11);
        (int24 lo, int24 hi) = _range(hk, 1_000);
        uint256 own = IPositionManager(ch.positionManager).nextTokenId();
        // The owner mints in the hooked pool through the executor (owner = msg.sender = the Safe).
        bytes memory m = abi.encodeCall(
            MamoruV4Executor.mint,
            (
                hk,
                _biased(lo),
                _biased(hi),
                _liquidityFor(hk, lo, hi, ch.amount0, ch.amount1),
                uint128(ch.amount0 * 2),
                uint128(ch.amount1 * 2),
                block.timestamp + 60
            )
        );
        _ownerCall(address(executor), m);
        assertEq(IPositionManager(ch.positionManager).ownerOf(own), safe);
        uint128 l = IPositionManager(ch.positionManager).getPositionLiquidity(own);

        (bool ok,) = _submit(_op(_single(address(executor), _decreaseCall(own, lo, hi, l)), pid));
        assertFalse(ok, "key mismatch must fail");
        assertEq(IPositionManager(ch.positionManager).getPositionLiquidity(own), l);
        // Lying about the ticks of an allowlisted position fails the same way.
        (uint256 tokenId, int24 lo2, int24 hi2,) = _mintNow();
        (ok,) = _submit(_op(_single(address(executor), _decreaseCall(tokenId, lo2 - 10, hi2, 1)), pid));
        assertFalse(ok, "tick mismatch must fail");
    }

    function test_attack_claimStrayBalance() public {
        // Tokens sent to the shared executor by mistake. A caller (here the attacker with its own position, and the
        // account's session) runs increase with zero liquidity and zero max amounts: the stray balance must stay put.
        (uint256 tokenId, int24 lo, int24 hi,) = _mintNow();
        deal(key.currency0, address(executor), 1_000);
        deal(key.currency1, address(executor), 2_000);

        uint256 b0 = _bal(key.currency0);
        uint256 b1 = _bal(key.currency1);
        bytes memory zero = abi.encodeCall(
            MamoruV4Executor.increase, (key, _biased(lo), _biased(hi), tokenId, 0, 0, 0, block.timestamp + 600)
        );
        _run(_single(address(executor), zero), pid);
        assertEq(_bal(key.currency0), b0, "no stray token0 to the caller");
        assertEq(_bal(key.currency1), b1, "no stray token1 to the caller");
        assertEq(IERC20(key.currency0).balanceOf(address(executor)), 1_000);
        assertEq(IERC20(key.currency1).balanceOf(address(executor)), 2_000);

        // A real increase and a mint still return exactly their own leftovers and leave the stray balance alone.
        bytes memory inc = abi.encodeCall(
            MamoruV4Executor.increase,
            (
                key,
                _biased(lo),
                _biased(hi),
                tokenId,
                1e9,
                uint128(ch.amount0 * 2),
                uint128(ch.amount1 * 2),
                block.timestamp + 600
            )
        );
        _run(_single(address(executor), inc), pid);
        _run(_single(address(executor), _mintCall(key, lo, hi)), pid);
        assertEq(IERC20(key.currency0).balanceOf(address(executor)), 1_000);
        assertEq(IERC20(key.currency1).balanceOf(address(executor)), 2_000);
    }

    function test_attack_nativeValue() public {
        (int24 lo, int24 hi) = _range(key, 1_000);
        _rejected(_singleWithValue(address(executor), 1, _mintCall(key, lo, hi)), pid);
    }
}

contract ExecutorE2EBase is ExecutorE2E {
    function _chain() internal view override returns (Net memory) {
        return Chains.base();
    }
}

contract ExecutorE2EMonad is ExecutorE2E {
    function _chain() internal view override returns (Net memory) {
        return Chains.monad();
    }
}
