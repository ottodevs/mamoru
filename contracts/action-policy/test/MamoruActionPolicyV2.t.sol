// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {PolicyFixture, INPMFull, MamoruActionPolicyTest} from "./MamoruActionPolicy.t.sol";
import {T6FixesTest} from "./T6Fixes.t.sol";
import {
    MamoruActionPolicy,
    ConfigId,
    MintParams,
    DecreaseLiquidityParams,
    CollectParams,
    IERC20Min
} from "../src/MamoruActionPolicy.sol";
import {MamoruActionPolicyV2, IncreaseLiquidityParams} from "../src/MamoruActionPolicyV2.sol";

interface INPMIncrease {
    function increaseLiquidity(IncreaseLiquidityParams calldata)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface IAllowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

function deployV2(address smartSession, address npm, address router, address factory)
    returns (MamoruActionPolicy)
{
    // V2's ABI is a superset of V1's (same selectors, errors, Init): the V1 fixture drives it through V1's type.
    return MamoruActionPolicy(address(new MamoruActionPolicyV2(smartSession, npm, router, factory)));
}

/// Every test of MamoruActionPolicy.t.sol, against V2: nothing the deployed contract does changes.
contract MamoruActionPolicyTestOnV2 is MamoruActionPolicyTest {
    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV2(SMART_SESSION, NPM, ROUTER, FACTORY);
    }
}

/// Every T6 finding's test, against V2.
contract T6FixesTestOnV2 is T6FixesTest {
    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV2(SMART_SESSION, NPM, ROUTER, FACTORY);
    }
}

/**
 * What V2 adds (otto/mamoru#171), on the same Base fork: `increase` through the policy.
 */
contract MamoruActionPolicyV2Test is PolicyFixture {
    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV2(SMART_SESSION, NPM, ROUTER, FACTORY);
    }

    function v2() internal view returns (MamoruActionPolicyV2) {
        return MamoruActionPolicyV2(address(policy));
    }

    function setUp() public {
        _fork();
        deal(USDC, safe, 100_000e6);
        deal(CBBTC, safe, 1e8);
        _initBtc(ID, 1, 60_000e6, 180_000e6);
    }

    function test_v2FitsEip170() public view {
        console2.log("MamoruActionPolicyV2 runtime bytes:", address(policy).code.length);
        assertLe(address(policy).code.length, 24_576);
    }

    // ------------------------------------------------------------ increase (#171): no grant per tokenId

    function _increaseData(uint256 tokenId, uint256 usdc, uint256 btc) internal view returns (bytes memory) {
        return abi.encodeCall(
            MamoruActionPolicyV2.increase, (IncreaseLiquidityParams(tokenId, usdc, btc, 0, 0, block.timestamp))
        );
    }

    function _approvePolicy(uint256 usdc, uint256 btc) internal {
        _exec(USDC, abi.encodeCall(IERC20Min.approve, (address(policy), usdc)));
        _exec(CBBTC, abi.encodeCall(IERC20Min.approve, (address(policy), btc)));
    }

    function _increase(uint256 tokenId, uint256 usdc, uint256 btc) internal {
        vm.prank(safe);
        v2().increase(IncreaseLiquidityParams(tokenId, usdc, btc, 0, 0, block.timestamp));
    }

    function test_increaseAdmittedPositionPasses() public {
        (uint256 tokenId, uint128 liq0) = _mintThroughPolicy(20_000e6, 0.2e8);
        bytes memory inc = _increaseData(tokenId, 10_000e6, 0.1e8);
        (uint256 r, uint256 gas) = _checkGas(address(policy), inc);
        assertEq(r, 0, "increase of an admitted, owned position must pass");
        console2.log("gas checkAction(increase):", gas);
        _approvePolicy(10_000e6, 0.1e8);
        uint256 u0 = IERC20Min(USDC).balanceOf(safe);
        uint256 b0 = IERC20Min(CBBTC).balanceOf(safe);
        uint256 g = gasleft();
        (uint128 added, uint256 a0, uint256 a1) = abi.decode(_exec(address(policy), inc), (uint128, uint256, uint256));
        console2.log("gas policy.increase (exec only):", g - gasleft());
        (,,,,,,, uint128 liq1,,,,) = INPMFull(NPM).positions(tokenId);
        assertEq(liq1, liq0 + added, "liquidity lands on the same NFT");
        assertGt(added, 0);
        // The account paid exactly what the manager took: the rest came back, nothing stays in the policy.
        assertEq(u0 - IERC20Min(USDC).balanceOf(safe), a0);
        assertEq(b0 - IERC20Min(CBBTC).balanceOf(safe), a1);
        assertEq(IERC20Min(USDC).balanceOf(address(policy)), 0);
        assertEq(IERC20Min(CBBTC).balanceOf(address(policy)), 0);
        assertEq(IAllowance(USDC).allowance(address(policy), NPM), 0, "manager approval reset");
        assertEq(IAllowance(CBBTC).allowance(address(policy), NPM), 0, "manager approval reset");
        assertEq(policy.admittedPool(safe, tokenId), POOL_BTC, "admission unchanged");
    }

    function test_directManagerIncreaseRefused() public {
        (uint256 tokenId,) = _mintThroughPolicy(20_000e6, 0.2e8);
        bytes memory direct = abi.encodeCall(
            INPMIncrease.increaseLiquidity, (IncreaseLiquidityParams(tokenId, 1_000e6, 0.01e8, 0, 0, block.timestamp))
        );
        assertEq(_check(NPM, direct), 1, "the manager's increaseLiquidity is never a session action");
        // Nor may a session approve the manager to pull the Safe's tokens.
        assertEq(_check(USDC, abi.encodeCall(IERC20Min.approve, (NPM, 1_000e6))), 1);
    }

    function test_increaseUnadmittedOrForeignRefused() public {
        // A position the Safe holds that was minted outside the policy and not admitted at enable.
        (uint256 own,) = _mintDirect(safe, 1_000e6, 0.01e8);
        assertEq(_check(address(policy), _increaseData(own, 1_000e6, 0.01e8)), 1, "unadmitted: refused at validation");
        _approvePolicy(1_000e6, 0.01e8);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.NotAdmitted.selector, own));
        v2().increase(IncreaseLiquidityParams(own, 1_000e6, 0.01e8, 0, 0, block.timestamp));

        // Someone else's position: the leaked-key attack #171 is about (the manager would fund it from the Safe).
        (uint256 theirs,) = _mintDirect(makeAddr("other"), 1_000e6, 0.01e8);
        assertEq(_check(address(policy), _increaseData(theirs, 1_000e6, 0.01e8)), 1, "foreign: refused");
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.NotAdmitted.selector, theirs));
        v2().increase(IncreaseLiquidityParams(theirs, 1_000e6, 0.01e8, 0, 0, block.timestamp));
    }

    function test_increaseOfAPositionAdmittedAtEnablePasses() public {
        // The move from the deployed V1 (or v2/v3 grants): the renewal names the Safe's positions in Init.admit.
        (uint256 own,) = _mintDirect(safe, 1_000e6, 0.01e8);
        uint256[] memory admit = new uint256[](1);
        admit[0] = own;
        ConfigId fresh = ConfigId.wrap(bytes32(uint256(2)));
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(
            safe, fresh, _initData(POOL_BTC, BAND, NO_ANCHOR, false, 2, 60_000e6, 180_000e6, admit)
        );
        assertEq(_checkId(fresh, address(policy), _increaseData(own, 1_000e6, 0.01e8)), 0);
        _approvePolicy(1_000e6, 0.01e8);
        _increase(own, 1_000e6, 0.01e8);
    }

    function test_increaseRefusedUnderAnotherPoolsGrant() public {
        (uint256 tokenId,) = _mintThroughPolicy(20_000e6, 0.2e8);
        ConfigId eth = ConfigId.wrap(bytes32(uint256(7)));
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(
            safe, eth, _initData(POOL_ETH, BAND, NO_ANCHOR, true, 1, 60_000e6, 180_000e6, new uint256[](0))
        );
        assertEq(_checkId(eth, address(policy), _increaseData(tokenId, 1_000e6, 0.01e8)), 1, "btc position, eth grant");
    }

    function test_increaseRefusedAfterPositionLeavesTheSafe() public {
        (uint256 tokenId,) = _mintThroughPolicy(20_000e6, 0.2e8);
        _exec(NPM, abi.encodeCall(INPMIncrease.transferFrom, (safe, makeAddr("elsewhere"), tokenId)));
        assertEq(_check(address(policy), _increaseData(tokenId, 1_000e6, 0.01e8)), 1, "moved out: not the session's");
        _approvePolicy(1_000e6, 0.01e8);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.NotAdmitted.selector, tokenId));
        v2().increase(IncreaseLiquidityParams(tokenId, 1_000e6, 0.01e8, 0, 0, block.timestamp));
    }

    function test_increaseRefusedWhenSpotManipulated() public {
        (uint256 tokenId,) = _mintThroughPolicy(20_000e6, 0.2e8);
        _push(POOL_BTC, USDC, CBBTC, 500, -300);
        _approvePolicy(10_000e6, 0.1e8);
        vm.prank(safe);
        vm.expectPartialRevert(MamoruActionPolicy.SpotOutsideRange.selector);
        v2().increase(IncreaseLiquidityParams(tokenId, 10_000e6, 0.1e8, 0, 0, block.timestamp));
    }

    function test_increaseDrawsOnTheSameBudget() public {
        (uint256 tokenId,) = _mintThroughPolicy(20_000e6, 0.2e8);
        (uint256 window,) = policy.budgetLeft(safe, POOL_BTC);
        assertGt(window, 0);
        assertEq(_check(address(policy), _increaseData(tokenId, window, 0)), 0, "exactly the bucket left");
        assertEq(_check(address(policy), _increaseData(tokenId, 1, 0)), 1, "increase over the bucket");
    }

    function test_increaseRetiredByRenewal() public {
        (uint256 tokenId,) = _mintThroughPolicy(20_000e6, 0.2e8);
        bytes memory inc = _increaseData(tokenId, 1_000e6, 0.01e8);
        ConfigId fresh = ConfigId.wrap(bytes32(uint256(2)));
        _initBtc(fresh, 2, 60_000e6, 180_000e6);
        assertEq(_check(address(policy), inc), 1, "generation-1 config dead after renewal");
        assertEq(_checkId(fresh, address(policy), inc), 0);
        // Admission survives the renewal: positions opened under the old approval stay manageable.
        _approvePolicy(1_000e6, 0.01e8);
        _exec(address(policy), inc);
    }

    function test_increaseNeedsTheCurrentConfig() public {
        (uint256 tokenId,) = _mintThroughPolicy(20_000e6, 0.2e8);
        // A renewal that does not re-enable the btc pool leaves its config at the old generation.
        vm.prank(SMART_SESSION);
        policy.initializeWithMultiplexer(
            safe,
            ConfigId.wrap(bytes32(uint256(9))),
            _initData(POOL_ETH, BAND, NO_ANCHOR, true, 2, 60_000e6, 180_000e6, new uint256[](0))
        );
        _approvePolicy(1_000e6, 0.01e8);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicy.NoConfig.selector, safe, POOL_BTC));
        v2().increase(IncreaseLiquidityParams(tokenId, 1_000e6, 0.01e8, 0, 0, block.timestamp));
    }
}
