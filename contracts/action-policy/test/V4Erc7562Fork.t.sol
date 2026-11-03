// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Vm, console2} from "forge-std/Test.sol";
import {V4Fixture, IERC20T, INPMT, ISmartSessionT} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, DecreaseLiquidityParams, CollectParams} from "../src/MamoruActionPolicyV4.sol";
import {PackedUserOperationV4} from "../src/SmartSessionTypes.sol";

interface IAccountT {
    function validateUserOp(PackedUserOperationV4 calldata op, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256);
}

/**
 * Spec 010 A1 T1c (otto/mamoru#315), the bundler question, on a Base fork: does the VALIDATION of a V4 session userOp
 * follow ERC-7562's rules for an unstaked account, so a standards-compliant public bundler admits it (spec 009 POL-12)?
 *
 * No bundler runs here (Alto, Rundler and Skandha need a geth-style JS or native tracer that anvil does not serve).
 * Instead the test applies the rules a bundler applies to the same trace: it records every opcode of the account's
 * `validateUserOp` (Safe -> Safe7579 -> SmartSession -> MamoruGasPolicyV2, MamoruActionPolicyV4), called as the
 * EntryPoint calls it, and checks, frame by frame:
 *  - OP-011: no TIMESTAMP, NUMBER, BLOCKHASH, COINBASE, PREVRANDAO, GASLIMIT, GASPRICE, BASEFEE, BLOBHASH, BLOBBASEFEE,
 *    ORIGIN, BALANCE, SELFBALANCE, SELFDESTRUCT, CREATE, CREATE2;
 *  - OP-012: GAS only right before a call;
 *  - OP-061: no CALL with value;
 *  - STO-010 / STO-021: every SLOAD and SSTORE is the account's own storage, or a slot associated with the account in
 *    another contract: keccak(account ‖ x) + n, n < 128 (the preimages are tracked from the trace's KECCAK256 inputs).
 * Each violation is printed with its contract, opcode and slot; V4 and MamoruGasPolicyV2 must have none. What a real
 * bundler adds (OP-041 EXTCODE on a codeless address, the paymaster's and factory's rules, the reputation system) is
 * listed in results/t1c-erc7562-*.md, with what remains to be run against a live bundler.
 *
 *   nix shell nixpkgs#foundry --command forge test --match-path test/V4Erc7562Fork.t.sol -vvv \
 *     --gas-limit 9000000000000 --memory-limit 8589934592
 * (-vvv: the debug tracer this probe reads exists only then; the limits: the trace is analysed in the EVM. Without them
 * every test here skips.)
 */
contract V4Erc7562ForkTest is V4Fixture {
    address safe;
    bytes32 pid;

    struct Violation {
        address target;
        uint8 opcode;
        uint256 slot;
    }

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), BASE_BLOCK);
        _deployStackViaModuleRegistry();
        safe = _newSafe(1);
        deal(USDC, safe, 100_000e6);
        deal(CBBTC, safe, 1e8);
        (pid,) = _enableV4(safe, _v4Session(C, 1, new uint256[](0), _baseCaps(), bytes32(uint256(0x4))));
    }

    function _banned(uint8 op) internal pure returns (bool) {
        return op == 0x42 || op == 0x43 || op == 0x40 || op == 0x41 || op == 0x44 || op == 0x45 || op == 0x3a
            || op == 0x48 || op == 0x49 || op == 0x4a || op == 0x32 || op == 0x31 || op == 0x47 || op == 0xff
            || op == 0xf0 || op == 0xf5;
    }

    /// Records the account's validation of `callData` as the EntryPoint runs it and returns the rule violations.
    function _violations(bytes memory callData) internal returns (Violation[] memory out, uint256 n) {
        PackedUserOperationV4 memory op = _op(safe, callData, pid);
        bytes32 userOpHash = _userOpHash(op);
        // the debug tracer exists only with -vvv, and analysing its trace needs far more than the default gas and
        // memory: without them this probe skips (run it as the notice says)
        if (gasleft() < 100_000_000_000) {
            vm.skip(true, "run with --gas-limit 9000000000000 --memory-limit 8589934592 -vvv");
            return (out, 0);
        }
        (bool tracing,) = address(vm).call(abi.encodeWithSignature("startDebugTraceRecording()"));
        if (!tracing) {
            vm.skip(true, "needs the debug tracer: -vvv");
            return (out, 0);
        }
        vm.prank(ENTRY_POINT);
        uint256 r = IAccountT(safe).validateUserOp(op, userOpHash, 0);
        Vm.DebugStep[] memory steps = vm.stopAndReturnDebugTraceRecording();
        assertEq(uint160(r), 0, "the op validates (no signature failure)");
        return _analyze(steps);
    }

    /// The rules of the contract notice over a recorded trace, for the account `safe`.
    function _analyze(Vm.DebugStep[] memory steps) internal view returns (Violation[] memory out, uint256 n) {
        // associated-slot bases: keccak of every KECCAK256 input that starts with the account (32-byte padded)
        bytes32[] memory bases = new bytes32[](steps.length);
        uint256 nb;
        out = new Violation[](64);
        for (uint256 i; i < steps.length; i++) {
            Vm.DebugStep memory s = steps[i];
            if (s.contractAddr == address(this)) continue; // the test's own frame around the call
            if (s.opcode == 0x20) {
                bytes memory m = s.memoryInput;
                if (m.length >= 32 && bytes32(m) == bytes32(uint256(uint160(safe)))) bases[nb++] = keccak256(m);
                continue;
            }
            bool bad = _banned(s.opcode);
            if (s.opcode == 0x5a) {
                // OP-012: GAS must be followed by a call at the same depth
                uint8 next = i + 1 < steps.length ? steps[i + 1].opcode : 0;
                bad = !(next == 0xf1 || next == 0xf2 || next == 0xf4 || next == 0xfa);
            }
            if (s.opcode == 0xf1 && s.stack.length > 2 && s.stack[2] != 0) bad = true; // OP-061
            if ((s.opcode == 0x54 || s.opcode == 0x55) && s.contractAddr != safe) {
                uint256 slot = s.stack[0];
                bool assoc;
                for (uint256 k; k < nb; k++) {
                    uint256 b = uint256(bases[k]);
                    if (slot >= b && slot - b < 128) {
                        assoc = true;
                        break;
                    }
                }
                if (!assoc) bad = true;
            }
            if (bad && n < out.length) {
                out[n++] = Violation(s.contractAddr, s.opcode, s.stack.length > 0 ? s.stack[0] : 0);
            }
        }
    }

    function _userOpHash(PackedUserOperationV4 memory op) internal view returns (bytes32) {
        (bool ok, bytes memory r) = ENTRY_POINT.staticcall(
            abi.encodeWithSignature(
                "getUserOpHash((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))", op
            )
        );
        require(ok, "getUserOpHash");
        return abi.decode(r, (bytes32));
    }

    function _report(string memory what, Violation[] memory v, uint256 n) internal view returns (uint256 mine) {
        console2.log(what, "violations:", n);
        for (uint256 i; i < n; i++) {
            string memory who = v[i].target == address(v4)
                ? "V4"
                : v[i].target == address(gasPol)
                    ? "MamoruGasPolicyV2"
                    : v[i].target == address(table)
                        ? "MamoruV4Table"
                        : v[i].target == SMART_SESSION ? "SmartSession" : "other";
            console2.log("  ", who, v[i].target);
            console2.log("    opcode / slot", v[i].opcode, v[i].slot);
            if (v[i].target == address(v4) || v[i].target == address(gasPol) || v[i].target == address(table)) mine++;
        }
    }

    /// The checker itself: a TIMESTAMP (V4.clock at execution, never in validation) and a slot not associated with
    /// the account (another address's USDC balance) are both caught.
    function test_T1c_checkerCatchesViolations() public {
        if (gasleft() < 100_000_000_000) {
            vm.skip(true, "run with --gas-limit 9000000000000 --memory-limit 8589934592 -vvv");
            return;
        }
        (bool tracing,) = address(vm).call(abi.encodeWithSignature("startDebugTraceRecording()"));
        if (!tracing) {
            vm.skip(true, "needs the debug tracer: -vvv");
            return;
        }
        v4.clock(vm.getBlockTimestamp());
        IERC20T(USDC).balanceOf(attacker);
        (Violation[] memory v, uint256 n) = _analyze(vm.stopAndReturnDebugTraceRecording());
        bool ts;
        bool foreign;
        for (uint256 i; i < n; i++) {
            if (v[i].opcode == 0x42) ts = true;
            if (v[i].opcode == 0x54 && v[i].target != address(v4)) foreign = true;
        }
        assertTrue(ts, "TIMESTAMP caught");
        assertTrue(foreign, "a foreign SLOAD caught");
    }

    function test_T1c_swapOpValidationFollowsErc7562() public {
        (Violation[] memory v, uint256 n) =
            _violations(_batch(_approved(USDC, 1_000e6, address(v4), _swapCall(POOL_BTC, USDC, 1_000e6))));
        assertEq(_report("swap batch", v, n), 0, "V4, the gas policy and the table follow ERC-7562 in validation");
        assertEq(n, 0, "the whole validation follows ERC-7562 (Safe, Safe7579, SmartSession included)");
    }

    function test_T1c_exitOpValidationFollowsErc7562() public {
        (uint256 tokenId, uint128 liq) = _mintThroughV4(safe, 1_000e6, 0.01e8);
        (uint256 min0, uint256 min1) = lens.decreaseMins(safe, tokenId, liq);
        Execution[] memory xs = new Execution[](3);
        xs[0] = Execution(address(v4), 0, abi.encodeCall(MamoruActionPolicyV4.checkExit, (tokenId, liq, min0, min1)));
        xs[1] = Execution(
            NPM,
            0,
            abi.encodeCall(
                INPMT.decreaseLiquidity, (DecreaseLiquidityParams(tokenId, liq, min0, min1, vm.getBlockTimestamp()))
            )
        );
        xs[2] = Execution(
            NPM, 0, abi.encodeCall(INPMT.collect, (CollectParams(tokenId, safe, type(uint128).max, type(uint128).max)))
        );
        (Violation[] memory v, uint256 n) = _violations(_batch(xs));
        assertEq(_report("exit batch (checkExit, decrease, collect)", v, n), 0, "V4 and the gas policy");
        assertEq(n, 0, "the whole validation");
        // and the same op executes: the price check runs at execution, right before the decrease
        _run(safe, _batch(xs), pid);
    }

    function test_T1c_bridgeAndRelayOpValidationFollowsErc7562() public {
        Execution[] memory xs =
            _approved(USDC, 1e6, address(v4), abi.encodeCall(MamoruActionPolicyV4.bridge, (DOMAIN_MONAD, USDC, 1e6, 0)));
        (Violation[] memory v, uint256 n) = _violations(_batch(xs));
        assertEq(_report("bridge batch", v, n), 0, "V4 and the gas policy");
        assertEq(n, 0, "the whole validation");
        xs = new Execution[](1);
        xs[0] =
            Execution(MESSAGE_TRANSMITTER, 0, abi.encodeWithSignature("receiveMessage(bytes,bytes)", hex"00", hex"00"));
        (v, n) = _violations(_batch(xs));
        assertEq(_report("readiness relay batch", v, n), 0, "V4 and the gas policy");
        assertEq(n, 0, "the whole validation");
    }
}
