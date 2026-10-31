// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";

/**
 * otto/mamoru#251 on a Monad fork (anvil semantics, never a live chain): the account's own Safe on Monad, exactly as the
 * TypeScript builds it (`remoteSafe`, packages/account/remote). test/fixtures/remote-safe-monad.json is that code's output
 * (packages/account/remote/remote.test.ts fails while it is stale): the factory call the relayer sends, the address the
 * Base bridge-out grant commits to, and the permission ids of the sessions committed in the setup.
 *
 * MamoruActionPolicyV3 sits at its pinned Monad address (DeployV3.s.sol `expected(143)`) with the Monad constructor
 * arguments; everything else is the live Monad stack, MamoruGasPolicy included. Checked: the relayer's call deploys at the
 * committed address, with the owner's keys as its owners, SmartSession installed, every session enabled with no owner
 * signature, and V3's config of the account at generation 1 (setup mode ran).
 */

interface IFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

interface ISafeView {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

interface ISafe7579View {
    function isModuleInstalled(uint256 moduleType, address module, bytes calldata context) external view returns (bool);
}

interface ISmartSessionView {
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
}

interface IV3View {
    function generationOf(address account) external view returns (uint64);
    function swapBounds(address account, address pool, address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256 minOut, uint160 limit);
}

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}

struct MintParams {
    address token0;
    address token1;
    uint24 fee;
    int24 tickLower;
    int24 tickUpper;
    uint256 amount0Desired;
    uint256 amount1Desired;
    uint256 amount0Min;
    uint256 amount1Min;
    address recipient;
    uint256 deadline;
}

interface IMintPolicy {
    function mint(MintParams calldata params) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function admittedPool(address account, uint256 tokenId) external view returns (address);
}

interface IPoolView {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function tickSpacing() external view returns (int24);
}

interface INPMEnum {
    function balanceOf(address) external view returns (uint256);
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
}

interface IRouter {
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface ISafe7579Exec {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
}

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPoint {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function getUserOpHash(PackedUserOperation calldata op) external view returns (bytes32);
    error FailedOp(uint256 opIndex, string reason);
    error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner);
}

contract RemoteSafeForkMonad is Test {
    uint256 constant FORK_BLOCK = 118_163_000;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant SAFE7579 = 0x7579EE8307284F293B1927136486880611F20002;
    // DeployV3.s.sol argsFor(143) and PINNED_GUARDIAN.
    address constant NPM = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
    address constant ROUTER = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
    address constant FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant GUARDIAN = 0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD;
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant POOL = 0x659bD0BC4167BA25c62E05656F78043E7eD4a9da; // WMON/USDC 0.3%

    address factory;
    bytes createProxy;
    address expected;
    address[] owners;
    address v3;
    address gasPolicy;
    bytes32[] permissionIds;
    uint256 sessionKey;
    address bundler = makeAddr("bundler");

    function setUp() public {
        vm.createSelectFork(vm.envOr("MONAD_FORK_RPC_URL", string("https://rpc.monad.xyz")), FORK_BLOCK);
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/remote-safe-monad.json"));
        factory = vm.parseJsonAddress(j, ".factory");
        createProxy = vm.parseJsonBytes(j, ".createProxy");
        expected = vm.parseJsonAddress(j, ".expected");
        owners = vm.parseJsonAddressArray(j, ".owners");
        v3 = vm.parseJsonAddress(j, ".actionPolicy");
        gasPolicy = vm.parseJsonAddress(j, ".gasPolicy");
        permissionIds = vm.parseJsonBytes32Array(j, ".permissionIds");
        sessionKey = vm.parseJsonUint(j, ".sessionKeyPrivate");
        assertGe(block.timestamp, vm.parseJsonUint(j, ".validAfter"), "fork block inside the sessions' validity");
        assertLt(block.timestamp, vm.parseJsonUint(j, ".validUntil"), "fork block inside the sessions' validity");
        assertEq(v3.code.length, 0, "V3 is not on Monad yet at this block: placed by the test");
        assertGt(gasPolicy.code.length, 0, "MamoruGasPolicy is live on Monad");
        deployCodeTo(
            "MamoruActionPolicyV3.sol:MamoruActionPolicyV3",
            abi.encode(SMART_SESSION, NPM, ROUTER, FACTORY, GUARDIAN, new address[](0), address(0), address(0), uint32(0)),
            v3
        );
    }

    function _deploy() internal returns (address safe) {
        (bool ok, bytes memory ret) = factory.call(createProxy);
        assertTrue(ok, "the relayer's createProxyWithNonce");
        safe = abi.decode(ret, (address));
    }

    function test_deploysAtTheCommittedAddressWithEverySessionEnabled() public {
        assertEq(permissionIds.length, 1, "one manage-any: every action of the pool");
        address safe = _deploy();
        assertEq(safe, expected, "the address the Base approval commits to");
        assertEq(ISafeView(safe).getOwners(), owners, "the owner's own keys");
        assertEq(ISafeView(safe).getThreshold(), 1);
        assertTrue(ISafe7579View(safe).isModuleInstalled(1, SMART_SESSION, ""), "SmartSession installed");
        for (uint256 i; i < permissionIds.length; i++) {
            assertTrue(ISmartSessionView(SMART_SESSION).isPermissionEnabled(permissionIds[i], safe), "enabled at setup");
        }
        assertEq(IV3View(v3).generationOf(safe), 1, "V3 config at generation 1 (setup mode)");
    }

    /// Anyone may send the deploy (the relayer pays the gas); a second send cannot change what is there.
    function test_anySenderSameResultAndNoRedeploy() public {
        vm.prank(makeAddr("anyone"));
        assertEq(_deploy(), expected);
        (bool ok,) = factory.call(createProxy);
        assertFalse(ok, "a second deploy at the same address reverts");
    }

    /// Without V3 on chain the setup reverts: nothing is ever deployed half-provisioned at the committed address.
    function test_setupRevertsWithoutV3() public {
        vm.etch(v3, "");
        (bool ok,) = factory.call(createProxy);
        assertFalse(ok, "no V3, no Safe");
        assertEq(expected.code.length, 0);
    }

    // ------------------------------------------------------------ userOps through the setup-enabled sessions

    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    function _batch(Execution[] memory xs) internal pure returns (bytes memory) {
        return abi.encodeCall(ISafe7579Exec.execute, (bytes32(uint256(1) << 248), abi.encode(xs)));
    }

    function _op(address safe, bytes memory callData, bytes32 pid) internal view returns (PackedUserOperation memory op) {
        uint192 nonceKey = uint192(uint256(uint160(SMART_SESSION)) << 32);
        op.sender = safe;
        op.nonce = IEntryPoint(ENTRY_POINT).getNonce(safe, nonceKey);
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(3_000_000) << 128) | 2_000_000);
        op.preVerificationGas = 100_000;
        // Inside MONAD_GAS_CAPS (packages/policy): priority 1 gwei, max fee 1,000 gwei.
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 300 gwei);
        bytes32 h = IEntryPoint(ENTRY_POINT).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        op.signature = abi.encodePacked(bytes1(0x00), pid, r, s, v);
    }

    bytes32 constant USER_OP_EVENT = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");

    function _run(address safe, bytes memory callData, bytes32 pid) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _op(safe, callData, pid);
        vm.recordLogs();
        vm.prank(bundler, bundler);
        IEntryPoint(ENTRY_POINT).handleOps(ops, payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == USER_OP_EVENT && logs[i].emitter == ENTRY_POINT) {
                (, bool success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                assertTrue(success, "userOp execution failed");
                return;
            }
        }
        revert("no UserOperationEvent");
    }

    function _rejected(address safe, bytes memory callData, bytes32 pid) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _op(safe, callData, pid);
        vm.prank(bundler, bundler);
        (bool ok, bytes memory err) = ENTRY_POINT.call(abi.encodeCall(IEntryPoint.handleOps, (ops, payable(bundler))));
        assertFalse(ok, "op must be rejected at validation");
        bytes4 sel = bytes4(err);
        assertTrue(sel == IEntryPoint.FailedOp.selector || sel == IEntryPoint.FailedOpWithRevert.selector, "rejected at validation");
    }

    function _funded() internal returns (address safe) {
        safe = _deploy();
        vm.deal(safe, 10 ether); // MON for the userOp prefund
        deal(USDC, safe, 100e6); // what a CCTP mint lands
    }

    function _swap(address safe, address recipient, uint256 amountIn) internal view returns (bytes memory) {
        (uint256 minOut, uint160 limit) = IV3View(v3).swapBounds(safe, POOL, USDC, amountIn);
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20Min.approve, (ROUTER, amountIn)));
        xs[1] = Execution(ROUTER, 0, abi.encodeCall(IRouter.exactInputSingle, (ExactInputSingleParams(USDC, WMON, 3000, recipient, amountIn, minOut, limit))));
        return _batch(xs);
    }

    /// The bridged USDC is put to work with no owner signature on Monad: enter-swap runs under V3 alone.
    function test_enterSwapRunsThroughTheSetupSession() public {
        address safe = _funded();
        uint256 w0 = IERC20Min(WMON).balanceOf(safe);
        _run(safe, _swap(safe, safe, 10e6), permissionIds[0]);
        assertGt(IERC20Min(WMON).balanceOf(safe), w0, "WMON arrived at the Safe");
        assertEq(IERC20Min(USDC).balanceOf(safe), 90e6, "exactly the amount swapped left");
    }

    /// A leaked session key cannot send the swap's output anywhere but the Safe (V3 alone, no UniActionPolicy).
    function test_swapToAnotherRecipientIsRefused() public {
        address safe = _funded();
        _rejected(safe, _swap(safe, makeAddr("thief"), 10e6), permissionIds[0]);
        assertEq(IERC20Min(USDC).balanceOf(safe), 100e6, "nothing moved");
    }

    /// Nor approve the position manager (its increaseLiquidity funds any tokenId), nor move USDC with a plain transfer.
    function test_otherCallsAreRefused() public {
        address safe = _funded();
        Execution[] memory xs = new Execution[](1);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20Min.approve, (NPM, 10e6)));
        _rejected(safe, _batch(xs), permissionIds[0]);
        xs[0] = Execution(USDC, 0, abi.encodeWithSignature("transfer(address,uint256)", makeAddr("thief"), 10e6));
        _rejected(safe, _batch(xs), permissionIds[0]);
        assertEq(IERC20Min(USDC).balanceOf(safe), 100e6, "nothing moved");
    }

    /// And it opens the Growth position: enter-mint through V3 (the policy mints and admits the position for the Safe).
    function test_enterMintOpensThePosition() public {
        address safe = _funded();
        deal(WMON, safe, 2_000e18);
        (, int24 tick,,,,,) = IPoolView(POOL).slot0();
        int24 sp = IPoolView(POOL).tickSpacing();
        int24 lower = (tick / sp - 10) * sp;
        int24 upper = (tick / sp + 10) * sp;
        Execution[] memory xs = new Execution[](3);
        xs[0] = Execution(WMON, 0, abi.encodeCall(IERC20Min.approve, (v3, 2_000e18)));
        xs[1] = Execution(USDC, 0, abi.encodeCall(IERC20Min.approve, (v3, 50e6)));
        xs[2] = Execution(v3, 0, abi.encodeCall(IMintPolicy.mint, (MintParams(WMON, USDC, 3000, lower, upper, 2_000e18, 50e6, 0, 0, safe, block.timestamp))));
        _run(safe, _batch(xs), permissionIds[0]);
        assertEq(INPMEnum(NPM).balanceOf(safe), 1, "position minted to the Safe");
        assertEq(IMintPolicy(v3).admittedPool(safe, INPMEnum(NPM).tokenOfOwnerByIndex(safe, 0)), POOL, "admitted by V3");
    }
}
