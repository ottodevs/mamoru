// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "../src/PoolKey.sol";
import {MamoruV4LiquidityPolicy, ConfigId} from "../src/MamoruV4LiquidityPolicy.sol";

/// Decoder properties without a fork (programs that read no PositionManager state). The test contract is the
/// multiplexer, like SmartSession on chain.
contract PolicyFuzz is Test {
    MamoruV4LiquidityPolicy policy;
    ConfigId constant ID = ConfigId.wrap(bytes32(uint256(1)));
    address constant PM = address(0x7C5f5A4bBd8fD63184577525326123B519429bDc);
    address account = makeAddr("account");
    PoolKey key = PoolKey(address(0x1000), address(0x2000), 500, 10, address(0));
    int24 constant MIN = -1000;
    int24 constant MAX = 1000;
    uint128 constant CAP0 = 1e18;
    uint128 constant CAP1 = 2e9;

    function setUp() public {
        policy = new MamoruV4LiquidityPolicy();
        MamoruV4LiquidityPolicy.PoolRule[] memory r = new MamoruV4LiquidityPolicy.PoolRule[](1);
        r[0] = MamoruV4LiquidityPolicy.PoolRule(key, MIN, MAX, CAP0, CAP1);
        policy.initializeWithMultiplexer(
            account, ID, abi.encode(MamoruV4LiquidityPolicy.Init(PM, 1 hours, new address[](0), r))
        );
        vm.warp(1_800_000_000);
    }

    function _mint(int24 lo, int24 hi, uint128 a0, uint128 a1, address owner) internal view returns (bytes memory) {
        return abi.encode(key, lo, hi, uint256(1e6), a0, a1, owner, bytes(""));
    }

    function _check(bytes memory actions, bytes[] memory params) internal view returns (bool) {
        bytes memory data = abi.encodeWithSelector(0xdd46508f, abi.encode(actions, params), block.timestamp + 60);
        return policy.checkAction(ID, account, PM, 0, data) & type(uint160).max == 0;
    }

    function _program(bytes memory mint, uint8 extra, bytes memory extraParam)
        internal
        view
        returns (bytes memory a, bytes[] memory p)
    {
        a = abi.encodePacked(uint8(0x02), uint8(0x0d), extra);
        p = new bytes[](3);
        p[0] = mint;
        p[1] = abi.encode(key.currency0, key.currency1);
        p[2] = extraParam;
    }

    function test_baselinePasses() public view {
        bytes[] memory p = new bytes[](2);
        p[0] = _mint(-100, 100, CAP0, CAP1, account);
        p[1] = abi.encode(key.currency0, key.currency1);
        assertTrue(_check(abi.encodePacked(uint8(0x02), uint8(0x0d)), p));
    }

    /// Any action byte outside the admitted set is refused, whatever its parameters.
    function testFuzz_unknownActionRefused(uint8 a, bytes calldata param) public view {
        vm.assume(a != 0x0d && a != 0x11 && a != 0x12 && a > 0x03);
        (bytes memory acts, bytes[] memory p) = _program(_mint(-100, 100, 1, 1, account), a, param);
        assertFalse(_check(acts, p));
    }

    function testFuzz_ticks(int24 lo, int24 hi) public view {
        bytes[] memory p = new bytes[](2);
        p[0] = _mint(lo, hi, 1, 1, account);
        p[1] = abi.encode(key.currency0, key.currency1);
        bool expect = lo >= MIN && hi <= MAX && lo < hi;
        assertEq(_check(abi.encodePacked(uint8(0x02), uint8(0x0d)), p), expect);
    }

    function testFuzz_amounts(uint128 a0, uint128 a1) public view {
        bytes[] memory p = new bytes[](2);
        p[0] = _mint(-100, 100, a0, a1, account);
        p[1] = abi.encode(key.currency0, key.currency1);
        assertEq(_check(abi.encodePacked(uint8(0x02), uint8(0x0d)), p), a0 <= CAP0 && a1 <= CAP1);
    }

    function testFuzz_recipients(address owner, address to) public view {
        bytes[] memory p = new bytes[](3);
        p[0] = _mint(-100, 100, 1, 1, owner);
        p[1] = abi.encode(key.currency0, key.currency1);
        p[2] = abi.encode(key.currency0, key.currency1, to);
        assertEq(_check(abi.encodePacked(uint8(0x02), uint8(0x0d), uint8(0x11)), p), owner == account && to == account);
    }

    function testFuzz_foreignCurrency(address c) public view {
        vm.assume(c != key.currency0 && c != key.currency1);
        bytes[] memory p = new bytes[](2);
        p[0] = _mint(-100, 100, 1, 1, account);
        p[1] = abi.encode(c);
        assertFalse(_check(abi.encodePacked(uint8(0x02), uint8(0x12)), p));
    }

    /// Bytes after the canonical encoding (where PositionManager's decoder would not look) are refused, at every level.
    function testFuzz_trailingBytesRefused(bytes calldata extra) public view {
        vm.assume(extra.length > 0);
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encodePacked(_mint(-100, 100, 1, 1, account), extra);
        p[1] = abi.encode(key.currency0, key.currency1);
        assertFalse(_check(abi.encodePacked(uint8(0x02), uint8(0x0d)), p));

        p[0] = _mint(-100, 100, 1, 1, account);
        bytes memory unlock = abi.encodePacked(abi.encode(abi.encodePacked(uint8(0x02), uint8(0x0d)), p), extra);
        bytes memory data = abi.encodeWithSelector(0xdd46508f, unlock, block.timestamp + 60);
        assertEq(policy.checkAction(ID, account, PM, 0, data), 1);

        data = abi.encodePacked(
            abi.encodeWithSelector(
                0xdd46508f, abi.encode(abi.encodePacked(uint8(0x02), uint8(0x0d)), p), block.timestamp + 60
            ),
            extra
        );
        assertEq(policy.checkAction(ID, account, PM, 0, data), 1);
    }

    function test_refusals() public {
        bytes[] memory p = new bytes[](2);
        p[0] = _mint(-100, 100, 1, 1, account);
        p[1] = abi.encode(key.currency0, key.currency1);
        bytes memory data = abi.encodeWithSelector(
            0xdd46508f, abi.encode(abi.encodePacked(uint8(0x02), uint8(0x0d)), p), block.timestamp + 60
        );
        assertEq(policy.checkAction(ID, account, address(0xdead), 0, data), 1, "other target");
        assertEq(policy.checkAction(ID, account, PM, 1, data), 1, "native value");
        assertEq(policy.checkAction(ID, account, PM, 0, abi.encodePacked(bytes4(0xac9650d8), data)), 1, "multicall");
        bytes memory zeroDeadline =
            abi.encodeWithSelector(0xdd46508f, abi.encode(abi.encodePacked(uint8(0x02), uint8(0x0d)), p), 0);
        assertEq(policy.checkAction(ID, account, PM, 0, zeroDeadline), 1, "deadline 0 reads as no expiry");
        // a different multiplexer, or an account never initialized, has no config
        vm.prank(address(0xbad));
        vm.expectRevert();
        policy.checkAction(ID, account, PM, 0, data);
        vm.expectRevert();
        policy.checkAction(ID, address(0xbad), PM, 0, data);
        // more than MAX_ACTIONS steps
        bytes memory acts = new bytes(9);
        bytes[] memory many = new bytes[](9);
        for (uint256 i; i < 9; i++) {
            acts[i] = bytes1(0x12);
            many[i] = abi.encode(key.currency0);
        }
        assertFalse(_check(acts, many));
        assertTrue(_check(_slice(acts, 8), _slice(many, 8)));
    }

    function test_initRefusesBadPools() public {
        MamoruV4LiquidityPolicy.PoolRule[] memory r = new MamoruV4LiquidityPolicy.PoolRule[](1);
        r[0] =
            MamoruV4LiquidityPolicy.PoolRule(PoolKey(address(0), address(0x2000), 500, 10, address(0)), MIN, MAX, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(MamoruV4LiquidityPolicy.InvalidPool.selector, 0));
        policy.initializeWithMultiplexer(
            account, ID, abi.encode(MamoruV4LiquidityPolicy.Init(PM, 1, new address[](0), r))
        );
        r[0].key = PoolKey(address(0x2000), address(0x1000), 500, 10, address(0)); // unsorted
        vm.expectRevert(abi.encodeWithSelector(MamoruV4LiquidityPolicy.InvalidPool.selector, 0));
        policy.initializeWithMultiplexer(
            account, ID, abi.encode(MamoruV4LiquidityPolicy.Init(PM, 1, new address[](0), r))
        );
        r[0].key = PoolKey(address(0x1000), address(0x2000), 500, 10, address(0x0800)); // hook not allowlisted
        vm.expectRevert(abi.encodeWithSelector(MamoruV4LiquidityPolicy.InvalidPool.selector, 0));
        policy.initializeWithMultiplexer(
            account, ID, abi.encode(MamoruV4LiquidityPolicy.Init(PM, 1, new address[](0), r))
        );
    }

    function _slice(bytes memory b, uint256 n) internal pure returns (bytes memory r) {
        r = new bytes(n);
        for (uint256 i; i < n; i++) {
            r[i] = b[i];
        }
    }

    function _slice(bytes[] memory b, uint256 n) internal pure returns (bytes[] memory r) {
        r = new bytes[](n);
        for (uint256 i; i < n; i++) {
            r[i] = b[i];
        }
    }
}
