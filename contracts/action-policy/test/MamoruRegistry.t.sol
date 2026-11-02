// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {MamoruRegistry} from "../src/MamoruRegistry.sol";

/// Spec 010 T2 (otto/mamoru#292): MamoruRegistry's timelock, guardian cancel, immediate removal and tightening, bounds,
/// route cap, and chain-independent deployment. No fork.
contract MamoruRegistryTest is Test {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C; // the canonical deterministic deployer
    uint256 constant DELAY = 72 hours;

    MamoruRegistry reg;
    address admin = makeAddr("team safe");
    address guardian = makeAddr("guardian");
    address pool = makeAddr("pool");
    address vault = makeAddr("vault");

    function setUp() public {
        reg = new MamoruRegistry(admin, guardian, DELAY);
    }

    function _poolParams(uint24 band, uint16 ratio) internal pure returns (bytes memory) {
        return abi.encode(uint32(1800), uint32(300), band, int24(0), uint24(0), ratio);
    }

    function _key(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _queue(MamoruRegistry.Kind k, bytes32 key, bytes memory p) internal returns (bytes32 id, uint256 n) {
        n = reg.nonce();
        vm.prank(admin);
        id = reg.queue(k, key, p);
    }

    function _listPool(uint24 band, uint16 ratio) internal {
        bytes memory p = _poolParams(band, ratio);
        (, uint256 n) = _queue(MamoruRegistry.Kind.Pool, _key(pool), p);
        vm.warp(block.timestamp + DELAY);
        vm.prank(admin);
        reg.execute(MamoruRegistry.Kind.Pool, _key(pool), p, n);
    }

    function test_constructorBounds() public {
        vm.expectRevert(MamoruRegistry.BadConstructor.selector);
        new MamoruRegistry(admin, guardian, 48 hours - 1);
        vm.expectRevert(MamoruRegistry.BadConstructor.selector);
        new MamoruRegistry(address(0), guardian, DELAY);
        vm.expectRevert(MamoruRegistry.BadConstructor.selector);
        new MamoruRegistry(admin, admin, DELAY);
        assertEq(new MamoruRegistry(admin, guardian, 48 hours).DELAY(), 48 hours);
    }

    function test_additionWaitsTheDelayInPublic() public {
        bytes memory p = _poolParams(100, 5_000);
        vm.recordLogs();
        (bytes32 id, uint256 n) = _queue(MamoruRegistry.Kind.Pool, _key(pool), p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], MamoruRegistry.Queued.selector, "Queued is public, with its params");
        assertEq(reg.etaOf(id), block.timestamp + DELAY);
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.TooEarly.selector, id, block.timestamp + 1));
        reg.execute(MamoruRegistry.Kind.Pool, _key(pool), p, n);
        assertFalse(reg.poolOf(pool).active);
        vm.warp(block.timestamp + 1);
        vm.prank(admin);
        reg.execute(MamoruRegistry.Kind.Pool, _key(pool), p, n);
        MamoruRegistry.PoolEntry memory e = reg.poolOf(pool);
        assertTrue(e.active);
        assertEq(e.bandTicks, 100);
        assertEq(e.ratioBps, 5_000);
        assertEq(reg.activePools().length, 1);
        // executed once: a replay is not queued any more
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.NotQueued.selector, id));
        reg.execute(MamoruRegistry.Kind.Pool, _key(pool), p, n);
    }

    function test_executeNeedsTheExactQueuedChange() public {
        (, uint256 n) = _queue(MamoruRegistry.Kind.Pool, _key(pool), _poolParams(100, 5_000));
        vm.warp(block.timestamp + DELAY);
        vm.prank(admin);
        vm.expectPartialRevert(MamoruRegistry.NotQueued.selector);
        reg.execute(MamoruRegistry.Kind.Pool, _key(pool), _poolParams(500, 10_000), n); // not what waited
    }

    function test_guardianCancelsButCannotAdd() public {
        bytes memory p = _poolParams(100, 5_000);
        vm.prank(guardian);
        vm.expectRevert(MamoruRegistry.OnlyAdmin.selector);
        reg.queue(MamoruRegistry.Kind.Pool, _key(pool), p);
        (bytes32 id, uint256 n) = _queue(MamoruRegistry.Kind.Pool, _key(pool), p);
        vm.warp(block.timestamp + DELAY);
        vm.prank(guardian);
        vm.expectRevert(MamoruRegistry.OnlyAdmin.selector);
        reg.execute(MamoruRegistry.Kind.Pool, _key(pool), p, n);
        vm.prank(guardian);
        reg.cancel(id);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.NotQueued.selector, id));
        reg.execute(MamoruRegistry.Kind.Pool, _key(pool), p, n);
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(MamoruRegistry.OnlyAdminOrGuardian.selector);
        reg.cancel(id);
        // guardian has no removal power either
        vm.prank(guardian);
        vm.expectRevert(MamoruRegistry.OnlyAdmin.selector);
        reg.removePool(pool);
    }

    function test_removalAndTighteningAreImmediate() public {
        _listPool(100, 5_000);
        vm.startPrank(admin);
        reg.tightenPool(pool, 2_000, 50);
        MamoruRegistry.PoolEntry memory e = reg.poolOf(pool);
        assertEq(e.ratioBps, 2_000);
        assertEq(e.bandTicks, 50);
        vm.expectRevert(MamoruRegistry.NotTighter.selector);
        reg.tightenPool(pool, 3_000, 50); // looser ratio: must be queued
        vm.expectRevert(MamoruRegistry.NotTighter.selector);
        reg.tightenPool(pool, 2_000, 60); // wider band: must be queued
        vm.expectRevert(MamoruRegistry.NotTighter.selector);
        reg.tightenPool(pool, 2_000, 1); // below MIN_BAND
        reg.removePool(pool);
        vm.stopPrank();
        e = reg.poolOf(pool);
        assertFalse(e.active, "removed at once");
        assertEq(e.twapWindow, 1800, "parameters kept for the exit");
        assertEq(reg.activePools().length, 0);
        vm.prank(admin);
        vm.expectRevert(MamoruRegistry.NotTighter.selector);
        reg.tightenPool(pool, 1_000, 40); // a removed pool cannot be touched except by a queued re-listing
    }

    function test_reactivationWaits() public {
        _listPool(100, 5_000);
        vm.prank(admin);
        reg.removePool(pool);
        bytes memory p = _poolParams(100, 5_000);
        (, uint256 n) = _queue(MamoruRegistry.Kind.Pool, _key(pool), p);
        assertFalse(reg.poolOf(pool).active);
        vm.warp(block.timestamp + DELAY);
        vm.prank(admin);
        reg.execute(MamoruRegistry.Kind.Pool, _key(pool), p, n);
        assertTrue(reg.poolOf(pool).active);
        assertEq(reg.activePools().length, 1, "listed once");
    }

    function test_vaults() public {
        bytes memory p = abi.encode(uint16(3_000));
        (, uint256 n) = _queue(MamoruRegistry.Kind.Vault, _key(vault), p);
        vm.warp(block.timestamp + DELAY);
        vm.prank(admin);
        reg.execute(MamoruRegistry.Kind.Vault, _key(vault), p, n);
        assertTrue(reg.vaultOf(vault).active);
        vm.startPrank(admin);
        reg.tightenVault(vault, 1_000);
        vm.expectRevert(MamoruRegistry.NotTighter.selector);
        reg.tightenVault(vault, 2_000);
        reg.removeVault(vault);
        vm.stopPrank();
        assertFalse(reg.vaultOf(vault).active);
        assertEq(reg.vaultOf(vault).ratioBps, 1_000, "entry kept: V4 still redeems");
        assertEq(reg.activeVaults().length, 0);
    }

    function test_routesCappedAtMaxChainsMinusHome() public {
        bytes memory on = abi.encode(true);
        uint256 cap = reg.MAX_CHAINS() - 1;
        for (uint32 d = 1; d <= cap + 1; d++) {
            (, uint256 n) = _queue(MamoruRegistry.Kind.Route, bytes32(uint256(d)), on);
            vm.warp(block.timestamp + DELAY);
            vm.prank(admin);
            if (d == cap + 1) vm.expectRevert(MamoruRegistry.TooManyRoutes.selector);
            reg.execute(MamoruRegistry.Kind.Route, bytes32(uint256(d)), on, n);
        }
        assertEq(reg.routeCount(), cap);
        vm.prank(admin);
        reg.removeRoute(1);
        assertFalse(reg.routeOn(1));
        assertEq(reg.routeCount(), cap - 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 20));
        reg.queue(MamoruRegistry.Kind.Route, bytes32(uint256(9)), abi.encode(false));
    }

    function test_bounds() public {
        vm.startPrank(admin);
        bytes32 k = _key(pool);
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 2));
        reg.queue(MamoruRegistry.Kind.Pool, k, abi.encode(uint32(599), uint32(60), uint24(10), int24(0), uint24(0), uint16(1)));
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 2));
        reg.queue(MamoruRegistry.Kind.Pool, k, abi.encode(uint32(86_401), uint32(60), uint24(10), int24(0), uint24(0), uint16(1)));
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 3)); // LeftClaw M-1 ratio
        reg.queue(MamoruRegistry.Kind.Pool, k, abi.encode(uint32(1800), uint32(451), uint24(10), int24(0), uint24(0), uint16(1)));
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 4));
        reg.queue(MamoruRegistry.Kind.Pool, k, abi.encode(uint32(1800), uint32(300), uint24(501), int24(0), uint24(0), uint16(1)));
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 4));
        reg.queue(MamoruRegistry.Kind.Pool, k, abi.encode(uint32(1800), uint32(300), uint24(1), int24(0), uint24(0), uint16(1)));
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 5));
        reg.queue(MamoruRegistry.Kind.Pool, k, abi.encode(uint32(1800), uint32(300), uint24(10), int24(0), uint24(501), uint16(1)));
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 6));
        reg.queue(MamoruRegistry.Kind.Pool, k, abi.encode(uint32(1800), uint32(300), uint24(10), int24(0), uint24(0), uint16(10_001)));
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 6));
        reg.queue(MamoruRegistry.Kind.Pool, k, abi.encode(uint32(1800), uint32(300), uint24(10), int24(0), uint24(0), uint16(0)));
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 11));
        reg.queue(MamoruRegistry.Kind.Vault, _key(vault), abi.encode(uint16(10_001)));
        vm.expectRevert(abi.encodeWithSelector(MamoruRegistry.BadEntry.selector, 0));
        reg.queue(MamoruRegistry.Kind.Vault, bytes32(0), abi.encode(uint16(1)));
        // the extreme admissible entry queues
        reg.queue(MamoruRegistry.Kind.Pool, k, abi.encode(uint32(86_400), uint32(60), uint24(500), int24(0), uint24(500), uint16(10_000)));
        vm.stopPrank();
    }

    /// Same constructor arguments, same CREATE2 salt, two chain ids: same address and same runtime code, because the
    /// init code reads nothing chain-specific (no chainid, no per-chain constructor argument).
    function test_initCodeIsChainIndependent() public {
        bytes memory initCode = abi.encodePacked(type(MamoruRegistry).creationCode, abi.encode(admin, guardian, DELAY));
        bytes32 salt = keccak256("mamoru.registry");
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        vm.etch(CREATE2_DEPLOYER, hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3");
        bytes32[2] memory hashes;
        uint256[2] memory ids = [uint256(8453), uint256(143)];
        for (uint256 i; i < 2; i++) {
            uint256 snap = vm.snapshotState();
            vm.chainId(ids[i]);
            (bool ok, bytes memory r) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
            assertTrue(ok);
            assertEq(address(bytes20(r)), predicted, "same address on every chain");
            hashes[i] = predicted.codehash;
            vm.revertToState(snap);
        }
        assertEq(hashes[0], hashes[1], "same runtime code on every chain");
    }
}
