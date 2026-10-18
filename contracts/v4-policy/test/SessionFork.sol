// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {PoolKey} from "../src/PoolKey.sol";

// ---------------------------------------------------------------- the live stack, as plain interfaces

struct ModuleInit {
    address module;
    bytes initData;
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function nonce() external view returns (uint256);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

interface ISafe7579Launchpad {
    function addSafe7579(
        address safe7579,
        ModuleInit[] calldata validators,
        ModuleInit[] calldata executors,
        ModuleInit[] calldata fallbacks,
        ModuleInit[] calldata hooks,
        address[] calldata attesters,
        uint8 threshold
    ) external;
}

interface ISafe7579 {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
    function isModuleInstalled(uint256 moduleType, address module, bytes calldata context) external view returns (bool);
}

interface IMultiSend {
    function multiSend(bytes memory transactions) external payable;
}

struct AttestationRequest {
    address moduleAddress;
    uint48 expirationTime;
    bytes data;
    uint256[] moduleTypes;
}

interface IModuleRegistry {
    function registerModule(bytes32 resolverUID, address moduleAddress, bytes calldata metadata, bytes calldata ctx)
        external;
    function trustAttesters(uint8 threshold, address[] calldata attesters) external;
    function attest(bytes32 schemaUID, AttestationRequest[] calldata requests) external;
    function checkForAccount(address smartAccount, address module) external view;
}

struct PolicyData {
    address policy;
    bytes initData;
}

struct ERC7739Context {
    bytes32 appDomainSeparator;
    string[] contentName;
}

struct ERC7739Data {
    ERC7739Context[] allowedERC7739Content;
    PolicyData[] erc1271Policies;
}

struct ActionData {
    bytes4 actionTargetSelector;
    address actionTarget;
    PolicyData[] actionPolicies;
}

struct Session {
    address sessionValidator;
    bytes sessionValidatorInitData;
    bytes32 salt;
    PolicyData[] userOpPolicies;
    ERC7739Data erc7739Policies;
    ActionData[] actions;
    bool permitERC4337Paymaster;
}

interface ISmartSession {
    function enableSessions(Session[] calldata sessions) external returns (bytes32[] memory);
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
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

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function setApprovalForAll(address operator, bool approved) external;
    function poolManager() external view returns (address);
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// A minimal v4 swapper so the fork tests can accrue real fees on the test position.
contract TestSwapper {
    IPoolManager immutable pm;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    function swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified) external {
        pm.unlock(abi.encode(msg.sender, key, zeroForOne, amountSpecified));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (address payer, PoolKey memory key, bool zeroForOne, int256 amountSpecified) =
            abi.decode(data, (address, PoolKey, bool, int256));
        int256 delta = pm.swap(
            key,
            SwapParams(
                zeroForOne, amountSpecified, zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            ""
        );
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        _close(key.currency0, d0, payer);
        _close(key.currency1, d1, payer);
        return "";
    }

    function _close(address c, int128 d, address payer) internal {
        if (d < 0) {
            pm.sync(c);
            (bool ok,) = c.call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256)", payer, address(pm), uint256(uint128(-d))
                )
            );
            require(ok);
            pm.settle();
        } else if (d > 0) {
            pm.take(c, payer, uint256(uint128(d)));
        }
    }
}

/// A hook with one harmless permission (beforeAddLiquidity), deployed at a flag-mined address by the tests.
struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

contract StubHook {
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return StubHook.beforeAddLiquidity.selector;
    }
}

/**
 * Real stack on a fork: a Safe 1.4.1 with Safe7579 and Smart Sessions installed through the Safe7579 launchpad (the
 * way packages/account/safe builds Mamoru accounts), owner calls by EIP-712-signed execTransaction, session calls as
 * userOps signed by the session key through OwnableValidator and submitted to the EntryPoint v0.7 handleOps.
 */
abstract contract SessionFork is Test {
    struct Net {
        string name;
        string rpc;
        uint256 forkBlock;
        address positionManager;
        address poolManager;
        address permit2;
        address entryPoint;
        address safeSingleton;
        address safeFactory;
        address safe7579;
        address launchpad;
        address registry;
        address attester;
        address smartSession;
        address ownableValidator;
        address uniActionPolicy;
        address multiSendCallOnly;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
        bool initPool; // no usable hook-less ERC-20 pool at the fork block: initialize one at the v3 price
        address v3PoolForPrice;
        uint256 amount0; // a position's worth of each token (about 2k USD)
        uint256 amount1;
    }

    // packages/account/sessions ATTESTATION_SCHEMA_UID; resolver of every module in the ERC-7484 registry.
    bytes32 constant SCHEMA_UID = 0x93d46fcca4ef7d66a413c7bde08bb1ff14bacbd04c4069bb24cd7c21729d7bf1;
    bytes32 constant RESOLVER_UID = 0xdbca873b13c783c0c9c6ddfc4280e505580bf6cc3dac83f8a0f7b44acaafca4f;

    Net internal ch;
    PoolKey internal key;
    address internal safe;
    uint256 internal ownerKey;
    uint256 internal sessionKey;
    address internal bundler = makeAddr("bundler");
    address internal attacker = makeAddr("attacker");
    TestSwapper internal swapper;

    uint256 constant VGL = 3_000_000;
    uint256 constant CGL = 3_000_000;
    uint256 constant PVG = 100_000;

    function _chain() internal view virtual returns (Net memory);

    function _setUpFork() internal {
        ch = _chain();
        vm.createSelectFork(ch.rpc, ch.forkBlock);
        vm.label(ch.positionManager, "PositionManager");
        vm.label(ch.poolManager, "PoolManager");
        vm.label(ch.smartSession, "SmartSession");
        vm.label(ch.entryPoint, "EntryPoint");
        assertEq(IPositionManager(ch.positionManager).poolManager(), ch.poolManager, "posm/poolmanager pair");
        key = PoolKey(ch.token0, ch.token1, ch.fee, ch.tickSpacing, address(0));
        if (ch.initPool) _initPoolAtV3Price(key);
        ownerKey = uint256(keccak256("mamoru.owner"));
        sessionKey = uint256(keccak256("mamoru.session"));
        safe = _deploySafe();
        vm.label(safe, "Safe");
        vm.deal(safe, 1 ether); // userOp prefund
        swapper = new TestSwapper(IPoolManager(ch.poolManager));
    }

    // ---------------------------------------------------------------- account

    function _deploySafe() internal returns (address s) {
        ModuleInit[] memory validators = new ModuleInit[](1);
        validators[0] = ModuleInit(ch.smartSession, "");
        ModuleInit[] memory none = new ModuleInit[](0);
        address[] memory attesters = new address[](1);
        attesters[0] = ch.attester;
        bytes memory launch =
            abi.encodeCall(ISafe7579Launchpad.addSafe7579, (ch.safe7579, validators, none, none, none, attesters, 1));
        address[] memory owners = new address[](1);
        owners[0] = vm.addr(ownerKey);
        bytes memory init = abi.encodeCall(
            ISafe.setup, (owners, 1, ch.launchpad, launch, ch.safe7579, address(0), 0, payable(address(0)))
        );
        s = ISafeProxyFactory(ch.safeFactory).createProxyWithNonce(ch.safeSingleton, init, 7579);
        assertTrue(ISafe7579(s).isModuleInstalled(1, ch.smartSession, ""), "SmartSession installed");
    }

    struct Call {
        address to;
        bytes data;
    }

    /// One owner-signed Safe transaction delegatecalling MultiSendCallOnly with `calls`.
    function _ownerBatch(Call[] memory calls) internal {
        bytes memory packed;
        for (uint256 i; i < calls.length; i++) {
            packed = abi.encodePacked(packed, uint8(0), calls[i].to, uint256(0), calls[i].data.length, calls[i].data);
        }
        bytes memory data = abi.encodeCall(IMultiSend.multiSend, (packed));
        bytes memory sig = _ownerSig(data);
        bool ok = ISafe(safe)
            .execTransaction(ch.multiSendCallOnly, 0, data, 1, 0, 0, 0, address(0), payable(address(0)), sig);
        assertTrue(ok, "owner batch");
    }

    function _ownerSig(bytes memory data) internal view returns (bytes memory) {
        uint256 n = ISafe(safe).nonce();
        bytes32 h = ISafe(safe).getTransactionHash(ch.multiSendCallOnly, 0, data, 1, 0, 0, 0, address(0), address(0), n);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, h);
        return abi.encodePacked(r, s, v);
    }

    function _ownerCall(address to, bytes memory data) internal {
        Call[] memory c = new Call[](1);
        c[0] = Call(to, data);
        _ownerBatch(c);
    }

    /// The account trusts the Rhinestone attester and itself, and self-attests `module` (packages/account/sessions
    /// registryTrustCalls does the same for TimeFramePolicy/UsageLimitPolicy). The module is registered first.
    function _trustAndSelfAttest(address module) internal {
        IModuleRegistry(ch.registry).registerModule(RESOLVER_UID, module, "", "");
        address[] memory att = new address[](2);
        (att[0], att[1]) = ch.attester < safe ? (ch.attester, safe) : (safe, ch.attester);
        AttestationRequest[] memory req = new AttestationRequest[](1);
        req[0] = AttestationRequest(module, 0, "", new uint256[](0));
        Call[] memory c = new Call[](2);
        c[0] = Call(ch.registry, abi.encodeCall(IModuleRegistry.trustAttesters, (1, att)));
        c[1] = Call(ch.registry, abi.encodeCall(IModuleRegistry.attest, (SCHEMA_UID, req)));
        _ownerBatch(c);
        IModuleRegistry(ch.registry).checkForAccount(safe, module);
    }

    function _session(ActionData[] memory actions, bytes32 salt) internal view returns (Session memory s) {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(sessionKey);
        s.sessionValidator = ch.ownableValidator;
        s.sessionValidatorInitData = abi.encode(uint256(1), signers);
        s.salt = salt;
        s.actions = actions;
    }

    function _permissionId(Session memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(s.sessionValidator, s.sessionValidatorInitData, s.salt));
    }

    function _enable(Session memory s) internal returns (bytes32 pid) {
        Session[] memory ss = new Session[](1);
        ss[0] = s;
        _ownerCall(ch.smartSession, abi.encodeCall(ISmartSession.enableSessions, (ss)));
        pid = _permissionId(s);
        assertTrue(ISmartSession(ch.smartSession).isPermissionEnabled(pid, safe), "session enabled");
    }

    // ---------------------------------------------------------------- userOps signed by the session key

    function _single(address target, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(ISafe7579.execute, (bytes32(0), abi.encodePacked(target, uint256(0), data)));
    }

    function _singleWithValue(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(ISafe7579.execute, (bytes32(0), abi.encodePacked(target, value, data)));
    }

    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    function _batch(Execution[] memory xs) internal pure returns (bytes memory) {
        return abi.encodeCall(ISafe7579.execute, (bytes32(uint256(1) << 248), abi.encode(xs)));
    }

    function _op(bytes memory callData, bytes32 pid) internal view returns (PackedUserOperation memory op) {
        uint192 nonceKey = uint192(uint256(uint160(ch.smartSession)) << 32);
        op.sender = safe;
        op.nonce = IEntryPoint(ch.entryPoint).getNonce(safe, nonceKey);
        op.callData = callData;
        op.accountGasLimits = bytes32((VGL << 128) | CGL);
        op.preVerificationGas = PVG;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 1 gwei);
        bytes32 h = IEntryPoint(ch.entryPoint).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sessionKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        op.signature = abi.encodePacked(bytes1(0x00), pid, r, s, v);
    }

    bytes32 constant USER_OP_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");

    /// Submits as a bundler would. Returns whether the execution succeeded and the gas the whole handleOps call
    /// consumed (EntryPoint + Safe7579 + Smart Sessions validation + execution; the EntryPoint's 10% unused-gas
    /// penalty is not counted, it depends on the gas limits). Reverts if validation rejects the op.
    function _submit(PackedUserOperation memory op) internal returns (bool success, uint256 gasUsed) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.recordLogs();
        vm.prank(bundler, bundler);
        uint256 g = gasleft();
        IEntryPoint(ch.entryPoint).handleOps(ops, payable(bundler));
        gasUsed = g - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == USER_OP_EVENT && logs[i].emitter == ch.entryPoint) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                return (success, gasUsed);
            }
        }
        revert("no UserOperationEvent");
    }

    function _run(bytes memory callData, bytes32 pid) internal returns (uint256 gasUsed) {
        bool ok;
        (ok, gasUsed) = _submit(_op(callData, pid));
        assertTrue(ok, "userOp execution failed");
    }

    /// The EntryPoint must refuse the op during validation (FailedOp / FailedOpWithRevert): nothing executes, no nonce
    /// is spent. Returns the EntryPoint's reason string (AA23 = a policy said no, AA22 = outside its time window).
    function _rejected(bytes memory callData, bytes32 pid) internal returns (string memory reason) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _op(callData, pid);
        vm.prank(bundler, bundler);
        (bool ok, bytes memory err) = ch.entryPoint.call(abi.encodeCall(IEntryPoint.handleOps, (ops, payable(bundler))));
        assertFalse(ok, "op must be rejected at validation");
        bytes4 sel = bytes4(err);
        assertTrue(
            sel == IEntryPoint.FailedOp.selector || sel == IEntryPoint.FailedOpWithRevert.selector,
            "rejection must come from validation"
        );
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; i++) {
            body[i] = err[i + 4];
        }
        (, reason) = abi.decode(body, (uint256, string));
    }

    // ---------------------------------------------------------------- pool helpers

    function _slot0(PoolKey memory k) internal view returns (uint160 sqrtPriceX96, int24 tick) {
        bytes32 id = keccak256(abi.encode(k));
        bytes32 data = IPoolManager(ch.poolManager).extsload(keccak256(abi.encode(id, uint256(6))));
        sqrtPriceX96 = uint160(uint256(data));
        tick = int24(int256(uint256(data) >> 160));
    }

    function _initPoolAtV3Price(PoolKey memory k) internal {
        (bool ok, bytes memory r) = ch.v3PoolForPrice.staticcall(abi.encodeWithSignature("slot0()"));
        require(ok, "v3 slot0");
        uint160 p = abi.decode(r, (uint160));
        IPoolManager(ch.poolManager).initialize(k, p);
    }

    /// A range of +-`width` ticks around spot, aligned to the spacing.
    function _range(PoolKey memory k, int24 width) internal view returns (int24 lower, int24 upper) {
        (, int24 t) = _slot0(k);
        int24 s = k.tickSpacing;
        lower = ((t - width) / s) * s;
        upper = ((t + width) / s) * s;
    }

    function _liquidityFor(PoolKey memory k, int24 lower, int24 upper, uint256 a0, uint256 a1)
        internal
        view
        returns (uint128)
    {
        (uint160 sp,) = _slot0(k);
        return LiquidityAmounts.getLiquidityForAmounts(
            sp, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), a0, a1
        );
    }

    /// A third party trades through the pool both ways so the test position earns fees.
    function _churn(PoolKey memory k, uint256 amount0) internal {
        address trader = makeAddr("trader");
        deal(k.currency0, trader, amount0);
        vm.startPrank(trader);
        IERC20(k.currency0).approve(address(swapper), type(uint256).max);
        IERC20(k.currency1).approve(address(swapper), type(uint256).max);
        swapper.swap(k, true, -int256(amount0)); // exact in token0
        swapper.swap(k, false, -int256(IERC20(k.currency1).balanceOf(trader))); // and all the token1 back
        vm.stopPrank();
    }

    function _bal(address token) internal view returns (uint256) {
        return IERC20(token).balanceOf(safe);
    }

    /// A hook-less copy of `k` with a hook stub at a flag-mined address (BEFORE_ADD_LIQUIDITY only).
    function _hookedPool(PoolKey memory k, uint160 flags) internal returns (PoolKey memory h) {
        address hook = address(uint160(uint256(keccak256(abi.encode("stub-hook", flags)))) & ~uint160(0x3fff) | flags);
        deployCodeTo("SessionFork.sol:StubHook", hook);
        h = PoolKey(k.currency0, k.currency1, k.fee, k.tickSpacing, hook);
        (uint160 sp,) = _slot0(k);
        IPoolManager(ch.poolManager).initialize(h, sp);
    }

    function _log(string memory what, uint256 gas) internal view {
        console2.log(string.concat("[", ch.name, "] gas ", what), gas);
    }
}

/// Chain constants. Base: packages/registry/base.json plus the v4 deployments checked on chain (otto/mamoru#182).
library Chains {
    function base() internal view returns (SessionFork.Net memory c) {
        c.name = "base";
        c.rpc = _env("BASE_FORK_RPC_URL", "https://mainnet.base.org");
        c.forkBlock = 52_767_000;
        c.positionManager = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
        c.poolManager = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
        c.permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        c.entryPoint = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
        c.safeSingleton = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
        c.safeFactory = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
        c.safe7579 = 0x7579EE8307284F293B1927136486880611F20002;
        c.launchpad = 0x7579011aB74c46090561ea277Ba79D510c6C00ff;
        c.registry = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
        c.attester = 0x000000333034E9f539ce08819E12c1b8Cb29084d;
        c.smartSession = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
        c.ownableValidator = 0x2483DA3A338895199E5e538530213157e931Bf06;
        c.uniActionPolicy = 0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F;
        c.multiSendCallOnly = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
        c.token0 = 0x4200000000000000000000000000000000000006; // WETH
        c.token1 = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC
        c.fee = 500; // live hook-less WETH/USDC 0.05% v4 pool
        c.tickSpacing = 10;
        c.amount0 = 0.5e18;
        c.amount1 = 2_000e6;
    }

    /// Monad: packages/registry/monad.json. No hook-less WMON/USDC v4 pool with liquidity at the fork block (the 0.3%
    /// one sits at the minimum price, empty), so the test initializes the 0.05% one at the v3 pool's price.
    function monad() internal view returns (SessionFork.Net memory c) {
        c.name = "monad";
        c.rpc = _env("MONAD_FORK_RPC_URL", "https://rpc.monad.xyz");
        c.forkBlock = 114_460_000;
        c.positionManager = 0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016;
        c.poolManager = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
        c.permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        c.entryPoint = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
        c.safeSingleton = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
        c.safeFactory = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
        c.safe7579 = 0x7579EE8307284F293B1927136486880611F20002;
        c.launchpad = 0x7579011aB74c46090561ea277Ba79D510c6C00ff;
        c.registry = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
        c.attester = 0x000000333034E9f539ce08819E12c1b8Cb29084d;
        c.smartSession = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
        c.ownableValidator = 0x2483DA3A338895199E5e538530213157e931Bf06;
        c.uniActionPolicy = 0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F;
        c.multiSendCallOnly = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
        c.token0 = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A; // WMON
        c.token1 = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603; // USDC
        c.fee = 500;
        c.tickSpacing = 10;
        c.initPool = true;
        c.v3PoolForPrice = 0x659bD0BC4167BA25c62E05656F78043E7eD4a9da; // WMON/USDC 0.3% v3
        c.amount0 = 50_000e18;
        c.amount1 = 2_000e6;
    }

    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _env(string memory name, string memory dflt) private view returns (string memory) {
        return vm.envOr(name, dflt);
    }
}
