// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {V4Fixture, IERC20T, INPMT} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, SwapParams, MintParams, IncreaseLiquidityParams} from "../src/MamoruActionPolicyV4.sol";

/**
 * otto/mamoru#348 on a Base fork: the gas of every engine userOp in the A1 shape the TypeScript builder produces
 * (packages/account/one-auth `buildA1Batch`, same call order: clock, approvals, the action, each reset + assertZero;
 * checkExit right before each decrease), through the real stack and EntryPoint v0.7 handleOps, steady state (USE mode,
 * the session already enabled). For each op it logs the handleOps gas and the execution alone (the batch run by the Safe
 * from the EntryPoint), so the engine's limits (LAB_GAS_LIMITS) can be checked against MamoruGasPolicyV2's Base caps
 * (verification 3M, call 2M, preVerification 200k: GAS_CAPS_V2_BY_CHAIN / MamoruV4Chains).
 *
 *   nix shell nixpkgs#foundry --command forge test --isolate --match-path test/A1GasFork.t.sol -vv
 */
contract A1GasForkTest is V4Fixture {
    address safe;
    bytes32 pid;
    uint256 constant CAP_CALL = 2_000_000;
    uint256 constant CAP_VERIFICATION = 3_000_000;
    uint256 maxTotal;
    uint256 maxExec;
    uint256 maxRest;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), BASE_BLOCK);
        _deployStackViaModuleRegistry();
        safe = _newSafe(1);
        deal(USDC, safe, 100_000e6);
        deal(CBBTC, safe, 1e8);
        vm.deal(safe, 1 ether); // the account pays each op's prefund itself (no paymaster)
        // Eight ops back to back at the fixture's 0.05 gwei and 5.1M of limits each (0.000255 ETH charged per op) pass
        // Base's G = 0.002 ETH (MamoruGasPolicyV2's GCRA refuses the 8th): measured at a lower fee, the gas is the same.
        opMaxFee = 5_000_000;
        (pid,) = _enableV4(safe, _v4Session(C, 1, new uint256[](0), _baseCaps(), bytes32(uint256(0x4))));
    }

    /// Amounts stay small: the cbBTC class's daily sub-bucket (V4 BudgetExceeded) is shared by the swap, mint and increase.
    /// handleOps gas and the execution alone (the Safe runs the batch for the EntryPoint), both from the same state.
    function _measure(string memory what, bytes memory callData) internal returns (uint256 total, uint256 exec) {
        uint256 snap = vm.snapshotState();
        vm.prank(ENTRY_POINT);
        uint256 g = gasleft();
        (bool ok,) = safe.call(callData);
        exec = g - gasleft();
        assertTrue(ok, string.concat(what, ": execution"));
        vm.revertToState(snap);
        total = _run(safe, callData, pid);
        assertLt(exec, CAP_CALL, string.concat(what, ": execution under the call cap"));
        assertLt(total - exec, CAP_VERIFICATION, string.concat(what, ": the rest under the verification cap"));
        if (total > maxTotal) maxTotal = total;
        if (exec > maxExec) maxExec = exec;
        if (total - exec > maxRest) maxRest = total - exec;
        console2.log(what);
        console2.log("  handleOps gas", total);
        console2.log("  execution    ", exec);
        console2.log("  rest (validation + EntryPoint)", total - exec);
    }

    /// approve / use / reset / assertZero, the builder's order for one pulled token.
    function _pulled1(address token, uint256 amount, bytes memory action) internal view returns (Execution[] memory) {
        return _approved(token, amount, address(v4), action);
    }

    function _exit(uint256 tokenId, uint128 liq, bool burn) internal view returns (bytes memory) {
        (uint256 min0, uint256 min1) = lens.decreaseMins(safe, tokenId, liq);
        uint256 dl = vm.getBlockTimestamp() + 600;
        Execution[] memory xs = new Execution[](burn ? 4 : 3);
        xs[0] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.checkExit, (tokenId, liq, min0, min1)));
        xs[1] = Execution(NPM, 0, abi.encodeWithSelector(0x0c49ccbe, tokenId, liq, min0, min1, dl));
        xs[2] = Execution(NPM, 0, abi.encodeWithSelector(0xfc6f7865, tokenId, safe, type(uint128).max, type(uint128).max));
        if (burn) xs[3] = Execution(NPM, 0, abi.encodeWithSelector(0x42966c68, tokenId));
        return _batch(xs);
    }

    function _mintBatch(MintParams memory m) internal view returns (bytes memory) {
        Execution[] memory xs = new Execution[](7);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), m.amount0Desired)));
        xs[1] = Execution(CBBTC, 0, abi.encodeCall(IERC20T.approve, (address(v4), m.amount1Desired)));
        xs[2] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.mint, (m)));
        xs[3] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
        xs[4] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.assertZero, (USDC)));
        xs[5] = Execution(CBBTC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
        xs[6] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.assertZero, (CBBTC)));
        return _batch(xs);
    }

    function test_gas_engineOpsInTheA1Shape() public {
        _measure("swap 100 USDC -> cbBTC", _batch(_pulled1(USDC, 100e6, _swapCall(POOL_BTC, USDC, 100e6))));
        _measure("mint USDC/cbBTC (2 approvals, 2 resets)", _mintBatch(_mintParams(safe, 300e6, 0.003e8)));
        uint256 tokenId = INPMT(NPM).tokenOfOwnerByIndex(safe, 0);
        Execution[] memory inc = new Execution[](7);
        IncreaseLiquidityParams memory n = IncreaseLiquidityParams(tokenId, 100e6, 0.001e8, 0, 0, vm.getBlockTimestamp() + 600);
        inc[0] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), n.amount0Desired)));
        inc[1] = Execution(CBBTC, 0, abi.encodeCall(IERC20T.approve, (address(v4), n.amount1Desired)));
        inc[2] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.increase, (n)));
        inc[3] = Execution(USDC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
        inc[4] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.assertZero, (USDC)));
        inc[5] = Execution(CBBTC, 0, abi.encodeCall(IERC20T.approve, (address(v4), 0)));
        inc[6] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.assertZero, (CBBTC)));
        _measure("increase (2 approvals, 2 resets)", _batch(inc));
        Execution[] memory col = new Execution[](1);
        col[0] = Execution(NPM, 0, abi.encodeWithSelector(0xfc6f7865, tokenId, safe, type(uint128).max, type(uint128).max));
        _measure("harvest (collect)", _batch(col));
        (,,,,,,, uint128 liq,,,,) = INPMT(NPM).positions(tokenId);
        _measure("reduce half (checkExit + decrease + collect)", _exit(tokenId, liq / 2, false));
        (,,,,,,, liq,,,,) = INPMT(NPM).positions(tokenId);
        _measure("rerange exit (checkExit + decrease all + collect + burn)", _exit(tokenId, liq, true));
        // registerRemote, then readiness by a CCTP message from the remote's V4 (as V4UserOpFork), then the bridge
        address sk = makeAddr("remote session key");
        _measure("registerRemote", _single(address(v4), abi.encodeCall(MamoruActionPolicyV4.registerRemote, (DOMAIN_MONAD, sk))));
        MamoruActionPolicyV4.Remote memory r = v4.remoteOf(safe, DOMAIN_MONAD);
        vm.prank(v4.MESSAGE_TRANSMITTER());
        v4.handleReceiveFinalizedMessage(DOMAIN_MONAD, bytes32(uint256(uint160(address(v4)))), 2000, abi.encode(safe, r.remote, r.ownersHash));
        _measure("bridge 100 USDC (approve + V4.bridge + reset + assertZero)", _batch(_pulled1(USDC, 100e6, abi.encodeCall(MamoruActionPolicyV4.bridge, (DOMAIN_MONAD, USDC, 100e6, 0)))));
        console2.log("max handleOps gas of an engine op", maxTotal);
        console2.log("max execution gas of an engine op", maxExec);
        console2.log("max rest (validation + EntryPoint) of an engine op", maxRest);
    }
}
