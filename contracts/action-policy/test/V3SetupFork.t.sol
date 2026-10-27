// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {MamoruActionPolicyV3, ExactInputSingleParams, MintParams, CollectParams} from "../src/MamoruActionPolicyV3.sol";

/**
 * otto/mamoru#116 T1 on forks (anvil semantics, never a live chain): MamoruActionPolicyV3 grants enabled INSIDE the
 * Safe setup (SmartSession UNSAFE_ENABLE, design D), then real userOps through those setup-enabled sessions.
 *
 * Account: Safe 1.4.1 via SafeProxyFactory.createProxyWithNonce; `setup` delegatecalls MultiSend 1.4.1 with (1) the
 * Safe7579 launchpad's addSafe7579 with NO validators and (2) `SetupInit.init`, which installs SmartSession on the Safe
 * itself with `0x02 ‖ abi.encode(Session[])`. SetupInit is a test-only stand-in for MamoruChainInit's strict `init`
 * (spike/116-t0-setup-commit; T2 owns the real one), without the chain switch. The owner is an EOA (T0 used the passkey
 * shared signer; the owner does not take part in anything measured here).
 *
 * Sessions: the T0 "V3-shaped" layout (conservador-lab-v5's 9 grants, every action under the Mamoru policy only,
 * userOp policies TimeFramePolicy + MamoruGasPolicy), with V3 in V2's place, plus the vault and bridge-out grants.
 * Init values are the ones the TS builders produce for that policy (printed from packages/policy, 27 Oct 2026).
 */

// ---------------------------------------------------------------- the live stack, as plain interfaces (SessionFork.sol)

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

struct ModuleInit {
    address module;
    bytes initData;
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

interface ISafeSetup {
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
    function installModule(uint256 moduleType, address module, bytes calldata initData) external;
    function isModuleInstalled(uint256 moduleType, address module, bytes calldata context) external view returns (bool);
}

interface IMultiSend {
    function multiSend(bytes memory transactions) external payable;
}

interface ISmartSession {
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
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
}

interface IVault {
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
}

interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

interface IRouter {
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface INPMView {
    function collect(CollectParams calldata params) external payable returns (uint256, uint256);
    function balanceOf(address owner) external view returns (uint256);
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
}

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function tickSpacing() external view returns (int24);
    function increaseObservationCardinalityNext(uint16) external;
}

/// MamoruGasPolicy, deployed from its artifact (it compiles under the default profile, this file under V3's).
interface IGasPolicy {
    struct Caps {
        uint64 maxPriorityFeePerGas;
        uint32 maxVerificationGasLimit;
        uint32 maxCallGasLimit;
        uint32 maxPreVerificationGas;
        uint64 maxFeePerGas;
    }
}

/// Test-only stand-in for MamoruChainInit.init (strict): delegatecalled by the Safe during setup, installs SmartSession
/// on the Safe itself with UNSAFE_ENABLE and the sessions.
contract SetupInit {
    address public immutable SMART_SESSION;
    address private immutable SELF;

    constructor(address smartSession) {
        SMART_SESSION = smartSession;
        SELF = address(this);
    }

    function init(bytes calldata sessions) external {
        require(address(this) != SELF, "delegatecall only");
        // No sessions: SmartSession installed empty, as MamoruChainInit does for an unlisted chain.
        bytes memory data = sessions.length > 64 ? abi.encodePacked(bytes1(0x02), sessions) : bytes("");
        ISafe7579(address(this)).installModule(1, SMART_SESSION, data);
    }
}

abstract contract V3SetupBase is Test {
    // Same on Base and Monad (packages/registry base.json, monad.json).
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant SAFE_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762; // SafeL2_141
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE7579 = 0x7579EE8307284F293B1927136486880611F20002;
    address constant LAUNCHPAD = 0x7579011aB74c46090561ea277Ba79D510c6C00ff;
    address constant ATTESTER = 0x000000333034E9f539ce08819E12c1b8Cb29084d;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant OWNABLE_VALIDATOR = 0x2483DA3A338895199E5e538530213157e931Bf06;
    address constant TIME_FRAME = 0x8177451511dE0577b911C254E9551D981C26dc72;
    address constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526; // MultiSend 1.4.1 (delegatecalls)

    bytes4 constant APPROVE = 0x095ea7b3;
    bytes4 constant EXACT_INPUT_SINGLE = 0x04e45aaf;
    bytes4 constant MULTICALL_DEADLINE = 0x5ae401dc;
    bytes4 constant DECREASE = 0x0c49ccbe;
    bytes4 constant COLLECT = 0xfc6f7865;
    bytes4 constant BURN = 0x42966c68;
    bytes4 constant POLICY_MINT = MamoruActionPolicyV3.mint.selector;
    bytes4 constant POLICY_INCREASE = MamoruActionPolicyV3.increase.selector;

    /// Base's per-transaction cap (EIP-7825 style, 2^24), and the gasUsed budget #116 set for the setup.
    uint256 constant BASE_TX_CAP = 16_777_216;
    uint256 constant SETUP_BUDGET = 15_300_000;

    MamoruActionPolicyV3 v3;
    address gasPolicy;
    SetupInit setupInit;
    uint256 ownerKey = uint256(keccak256("mamoru.v3.owner"));
    uint256 sessionKey = uint256(keccak256("mamoru.v3.session"));
    address bundler = makeAddr("bundler");
    address attacker = makeAddr("attacker");
    uint256 nowTs;

    function _deployCommon() internal {
        gasPolicy = deployCode("out/MamoruGasPolicy.sol/MamoruGasPolicy.json");
        setupInit = new SetupInit(SMART_SESSION);
        nowTs = block.timestamp;
    }

    // ------------------------------------------------------------ sessions

    function _session(ActionData[] memory actions, bytes32 salt) internal view returns (Session memory s) {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(sessionKey);
        s.sessionValidator = OWNABLE_VALIDATOR;
        s.sessionValidatorInitData = abi.encode(uint256(1), signers);
        s.salt = salt;
        s.userOpPolicies = new PolicyData[](2);
        s.userOpPolicies[0] = PolicyData(TIME_FRAME, abi.encodePacked(uint128(nowTs + 365 days), uint128(nowTs - 60)));
        // V4_GAS_CAPS (packages/policy): 0.01 gwei priority, 3M verification, 2M call, 200k preVerification, 0.1 gwei.
        s.userOpPolicies[1] =
            PolicyData(gasPolicy, abi.encode(IGasPolicy.Caps(10_000_000, 3_000_000, 2_000_000, 200_000, 100_000_000)));
        s.actions = actions;
    }

    function _pid(Session memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(s.sessionValidator, s.sessionValidatorInitData, s.salt));
    }

    function _action(address target, bytes4 sel, bytes memory init) internal view returns (ActionData memory a) {
        a.actionTargetSelector = sel;
        a.actionTarget = target;
        a.actionPolicies = new PolicyData[](1);
        a.actionPolicies[0] = PolicyData(address(v3), init);
    }

    struct Pool {
        address pool;
        address token0;
        address token1;
        address usdc;
        uint24 band;
        uint24 anchorBand;
        bool in1;
        uint128 perWindow;
        uint128 total;
    }

    function _uniInit(Pool memory p) internal pure returns (bytes memory) {
        return abi.encode(
            MamoruActionPolicyV3.Init({
                pool: p.pool,
                twapWindow: 1800,
                twapShortWindow: 300,
                bandTicks: p.band,
                generation: 1,
                anchorTick: 0,
                anchorBand: p.anchorBand,
                budgetIn1: p.in1,
                budgetWindow: 86_400,
                perWindow: p.perWindow,
                total: p.total,
                admit: new uint256[](0)
            })
        );
    }

    /// enter-swap: USDC approve, exactInputSingle, the empty multicall deadline.
    function _enterSwap(Pool memory p, address router, bytes32 salt) internal view returns (Session memory) {
        bytes memory i = _uniInit(p);
        ActionData[] memory a = new ActionData[](3);
        a[0] = _action(p.usdc, APPROVE, i);
        a[1] = _action(router, EXACT_INPUT_SINGLE, i);
        a[2] = _action(router, MULTICALL_DEADLINE, i);
        return _session(a, salt);
    }

    /// enter-mint: both tokens' approve, the policy's mint.
    function _enterMint(Pool memory p, bytes32 salt) internal view returns (Session memory) {
        bytes memory i = _uniInit(p);
        ActionData[] memory a = new ActionData[](3);
        a[0] = _action(p.token0, APPROVE, i);
        a[1] = _action(p.token1, APPROVE, i);
        a[2] = _action(address(v3), POLICY_MINT, i);
        return _session(a, salt);
    }

    /// manage-any: decrease, collect, burn, both approves, mint, swap, increase, deadline. No tokenId anywhere: the
    /// policy's admitted set decides which positions.
    function _manageAny(Pool memory p, address npm, address router, bytes32 salt)
        internal
        view
        returns (Session memory)
    {
        bytes memory i = _uniInit(p);
        ActionData[] memory a = new ActionData[](9);
        a[0] = _action(npm, DECREASE, i);
        a[1] = _action(npm, COLLECT, i);
        a[2] = _action(npm, BURN, i);
        a[3] = _action(p.token0, APPROVE, i);
        a[4] = _action(p.token1, APPROVE, i);
        a[5] = _action(address(v3), POLICY_MINT, i);
        a[6] = _action(router, EXACT_INPUT_SINGLE, i);
        a[7] = _action(address(v3), POLICY_INCREASE, i);
        a[8] = _action(router, MULTICALL_DEADLINE, i);
        return _session(a, salt);
    }

    function _uniTriple(Pool memory p, address npm, address router, uint256 saltBase)
        internal
        view
        returns (Session[] memory s)
    {
        s = new Session[](3);
        s[0] = _enterSwap(p, router, bytes32(saltBase + 1));
        s[1] = _enterMint(p, bytes32(saltBase + 2));
        s[2] = _manageAny(p, npm, router, bytes32(saltBase + 3));
    }

    function _concat(Session[] memory a, Session[] memory b) internal pure returns (Session[] memory c) {
        c = new Session[](a.length + b.length);
        for (uint256 k; k < a.length; k++) {
            c[k] = a[k];
        }
        for (uint256 k; k < b.length; k++) {
            c[a.length + k] = b[k];
        }
    }

    function _one(Session memory s) internal pure returns (Session[] memory r) {
        r = new Session[](1);
        r[0] = s;
    }

    // ------------------------------------------------------------ account

    function _deployCall(Session[] memory sessions, uint256 saltNonce) internal view returns (bytes memory) {
        ModuleInit[] memory none = new ModuleInit[](0);
        address[] memory attesters = new address[](1);
        attesters[0] = ATTESTER;
        bytes memory launch =
            abi.encodeCall(ISafe7579Launchpad.addSafe7579, (SAFE7579, none, none, none, none, attesters, 1));
        bytes memory init = abi.encodeCall(SetupInit.init, (abi.encode(sessions)));
        bytes memory packed = abi.encodePacked(
            abi.encodePacked(uint8(1), LAUNCHPAD, uint256(0), launch.length, launch),
            abi.encodePacked(uint8(1), address(setupInit), uint256(0), init.length, init)
        );
        address[] memory owners = new address[](1);
        owners[0] = vm.addr(ownerKey);
        bytes memory initializer = abi.encodeCall(
            ISafeSetup.setup,
            (
                owners,
                1,
                MULTISEND,
                abi.encodeCall(IMultiSend.multiSend, (packed)),
                SAFE7579,
                address(0),
                0,
                payable(address(0))
            )
        );
        return abi.encodeCall(ISafeProxyFactory.createProxyWithNonce, (SAFE_SINGLETON, initializer, saltNonce));
    }

    /// Calldata intrinsic gas of a tx carrying `data`: max(EIP-2028, EIP-7623 floor), as T0 computed it.
    function _intrinsic(bytes memory data) internal pure returns (uint256) {
        uint256 z;
        uint256 nz;
        for (uint256 k; k < data.length; k++) {
            data[k] == 0 ? z++ : nz++;
        }
        uint256 standard = 21_000 + 4 * z + 16 * nz;
        uint256 floor = 21_000 + 10 * (z + 4 * nz);
        return standard > floor ? standard : floor;
    }

    /// Deploys with `gas` for the factory call; returns the Safe (0 when the call reverted) and the gas it used.
    function _deploy(bytes memory call, uint256 gas) internal returns (address safe, uint256 used) {
        uint256 g = gasleft();
        (bool ok, bytes memory r) = SAFE_FACTORY.call{gas: gas}(call);
        used = g - gasleft();
        if (ok) safe = abi.decode(r, (address));
    }

    function _allEnabled(address safe, Session[] memory sessions) internal view returns (uint256 n) {
        for (uint256 k; k < sessions.length; k++) {
            if (ISmartSession(SMART_SESSION).isPermissionEnabled(_pid(sessions[k]), safe)) n++;
        }
    }

    /// Smallest call gas that deploys a fully configured Safe, by bisection on snapshots (T0's sweep, as a search).
    /// Every probe below it must have reverted as a whole: a deployed Safe with fewer sessions would be a partial setup.
    function _minGas(bytes memory call, Session[] memory sessions, uint256 hi) internal returns (uint256) {
        uint256 lo = 1_000_000;
        while (hi - lo > 2_000) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (address safe,) = _deploy(call, mid);
            bool full = safe != address(0) && _allEnabled(safe, sessions) == sessions.length;
            assertTrue(safe == address(0) || full, "partial setup");
            vm.revertToState(snap);
            if (full) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    /// Measures one set: gasUsed (execution + calldata intrinsic), and the tx gas limit it needs.
    function _measure(string memory label, Session[] memory sessions, uint256 saltNonce, bool sweep)
        internal
        returns (uint256 gasUsed, uint256 limit)
    {
        bytes memory call = _deployCall(sessions, saltNonce);
        uint256 intrinsic = _intrinsic(call);
        if (sweep) limit = _minGas(call, sessions, 40_000_000) + intrinsic;
        (address safe, uint256 exec) = _deploy(call, 40_000_000);
        assertTrue(safe != address(0), "deploy reverted");
        assertEq(_allEnabled(safe, sessions), sessions.length, "every session enabled at setup");
        gasUsed = exec + intrinsic;
        console2.log(label);
        console2.log("  sessions", sessions.length);
        console2.log("  calldata bytes", call.length);
        console2.log("  gasUsed (exec + intrinsic)", gasUsed);
        if (sweep) console2.log("  tx gas limit needed", limit);
    }

    // ------------------------------------------------------------ userOps signed by the session key (SessionFork.sol)

    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    function _single(address target, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(ISafe7579.execute, (bytes32(0), abi.encodePacked(target, uint256(0), data)));
    }

    function _batch(Execution[] memory xs) internal pure returns (bytes memory) {
        return abi.encodeCall(ISafe7579.execute, (bytes32(uint256(1) << 248), abi.encode(xs)));
    }

    function _op(address safe, bytes memory callData, bytes32 pid)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        uint192 nonceKey = uint192(uint256(uint160(SMART_SESSION)) << 32);
        op.sender = safe;
        op.nonce = IEntryPoint(ENTRY_POINT).getNonce(safe, nonceKey);
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(3_000_000) << 128) | 2_000_000);
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32((uint256(1_000_000) << 128) | 50_000_000); // within MamoruGasPolicy's caps
        bytes32 h = IEntryPoint(ENTRY_POINT).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sessionKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        op.signature = abi.encodePacked(bytes1(0x00), pid, r, s, v);
    }

    bytes32 constant USER_OP_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");

    function _run(address safe, bytes memory callData, bytes32 pid) internal returns (uint256 gasUsed) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _op(safe, callData, pid);
        vm.recordLogs();
        vm.prank(bundler, bundler);
        uint256 g = gasleft();
        IEntryPoint(ENTRY_POINT).handleOps(ops, payable(bundler));
        gasUsed = g - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == USER_OP_EVENT && logs[i].emitter == ENTRY_POINT) {
                (, bool success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                assertTrue(success, "userOp execution failed");
                return gasUsed;
            }
        }
        revert("no UserOperationEvent");
    }

    /// The EntryPoint must refuse the op at validation: nothing executes.
    function _rejected(address safe, bytes memory callData, bytes32 pid) internal returns (string memory reason) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _op(safe, callData, pid);
        vm.prank(bundler, bundler);
        (bool ok, bytes memory err) = ENTRY_POINT.call(abi.encodeCall(IEntryPoint.handleOps, (ops, payable(bundler))));
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
}

// ================================================================ Base

abstract contract BaseV3Fixture is V3SetupBase {
    uint256 constant FORK_BLOCK = 53_140_000; // T0's Base block
    address constant NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant POOL_STABLE = 0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1;
    address constant POOL_BTC = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address constant POOL_ETH = 0x6c561B446416E1A00E8E93E221854d6eA4171372;
    address constant GT_USDCP = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61;
    address constant WA_BAS_USDC = 0xC768c589647798a6EE01A91FdE98EF2ed046DBD6;
    /// steakUSDC: a real USDC MetaMorpho vault that is NOT on V3's list (the wrong-vault test).
    address constant STEAK_USDC = 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183;
    address constant TOKEN_MESSENGER = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    uint32 constant DOMAIN_MONAD = 15;
    address constant GUARDIAN = address(0x6A2d1A9);

    function _setUpBase() internal {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), FORK_BLOCK);
        address[] memory vaults = new address[](2);
        (vaults[0], vaults[1]) = (GT_USDCP, WA_BAS_USDC);
        v3 = new MamoruActionPolicyV3(
            SMART_SESSION, NPM, ROUTER, FACTORY, GUARDIAN, vaults, TOKEN_MESSENGER, USDC, DOMAIN_MONAD
        );
        _deployCommon();
    }

    function _stable() internal pure returns (Pool memory) {
        return Pool(POOL_STABLE, USDC, USDT, USDC, 10, 40, false, 2_500e6, 5_000e6);
    }

    function _btc() internal pure returns (Pool memory) {
        return Pool(POOL_BTC, USDC, CBBTC, USDC, 100, 0, false, 800e6, 4_000e6);
    }

    function _eth() internal pure returns (Pool memory) {
        return Pool(POOL_ETH, WETH, USDC, USDC, 100, 0, true, 300e6, 1_000e6);
    }

    /// The vault grant: one USDC approve (the policy sends it only to a listed vault whose asset is USDC), deposit,
    /// withdraw and redeem on each listed vault. `withUnlisted` adds a deposit action on steakUSDC, which the grant
    /// names and V3 refuses (the allowlist is the policy's, not the grant's).
    function _vaultSession(bytes32 salt, bool withUnlisted) internal view returns (Session memory) {
        bytes memory i = abi.encode(v3.FAMILY_VAULTS(), uint64(1));
        ActionData[] memory a = new ActionData[](withUnlisted ? 8 : 7);
        a[0] = _action(USDC, APPROVE, i);
        a[1] = _action(GT_USDCP, IVault.deposit.selector, i);
        a[2] = _action(GT_USDCP, bytes4(0xb460af94), i); // withdraw
        a[3] = _action(GT_USDCP, IVault.redeem.selector, i);
        a[4] = _action(WA_BAS_USDC, IVault.deposit.selector, i);
        a[5] = _action(WA_BAS_USDC, bytes4(0xb460af94), i);
        a[6] = _action(WA_BAS_USDC, IVault.redeem.selector, i);
        if (withUnlisted) a[7] = _action(STEAK_USDC, IVault.deposit.selector, i);
        return _session(a, salt);
    }

    function _bridgeSession(bytes32 salt) internal view returns (Session memory) {
        bytes memory i = abi.encode(v3.FAMILY_BRIDGE(), uint64(1));
        ActionData[] memory a = new ActionData[](2);
        a[0] = _action(USDC, APPROVE, i);
        a[1] = _action(TOKEN_MESSENGER, ITokenMessengerV2.depositForBurn.selector, i);
        return _session(a, salt);
    }

    /// T0's 9 (3 pools x enter-swap, enter-mint, manage-any).
    function _uniNine() internal view returns (Session[] memory s) {
        s = _concat(_uniTriple(_stable(), NPM, ROUTER, 0x10), _uniTriple(_btc(), NPM, ROUTER, 0x20));
        s = _concat(s, _uniTriple(_eth(), NPM, ROUTER, 0x30));
    }

    function _vaultAndBridge(bool withUnlisted) internal view returns (Session[] memory s) {
        s = _concat(
            _one(_vaultSession(bytes32(uint256(0x40)), withUnlisted)), _one(_bridgeSession(bytes32(uint256(0x50))))
        );
    }
}

/// Per-session enable cost at setup, Base. Each set in its own test so no set runs on another's warm state.
contract V3SetupGasBase is BaseV3Fixture {
    function setUp() public {
        _setUpBase();
    }

    function test_gas_emptyInit() public {
        // Same initializer shape, no sessions: the setup's fixed cost.
        _measure("Base: SmartSession installed empty (0 sessions)", new Session[](0), 1, false);
    }

    function test_gas_t0Parity_uniswapNine() public {
        // T0's V3-shaped 9, with V3 in V2's place (T0: 13,053,503 gasUsed, limit 15,338,113, with V2).
        _measure("Base: T0 V3-shaped 9 (Uniswap only), V3", _uniNine(), 2, true);
    }

    function test_gas_t0Parity_uniswapNine_V2() public {
        // Harness check: the same 9 with V2 in the policy's place, as T0 ran them (T0: 13,053,503 / 15,338,113). The
        // grants only use selectors V2 and V3 share, and V2's Init is the same encoding.
        v3 = MamoruActionPolicyV3(
            deployCode(
                "out/MamoruActionPolicyV2.sol/MamoruActionPolicyV2.json",
                abi.encode(SMART_SESSION, NPM, ROUTER, FACTORY, GUARDIAN)
            )
        );
        _measure("Base: T0 V3-shaped 9 (Uniswap only), V2 (harness check)", _uniNine(), 12, true);
    }

    function test_gas_fullBaseSet() public {
        // The 9 Uniswap grants + vault + bridge-out: 11 sessions.
        (uint256 used, uint256 limit) = _measure(
            "Base: full set, 9 Uniswap + vault + bridge-out", _concat(_uniNine(), _vaultAndBridge(false)), 3, true
        );
        console2.log("  fits 15.3M gasUsed budget", used <= SETUP_BUDGET);
        console2.log("  limit fits Base 2^24", limit <= BASE_TX_CAP);
    }

    function test_gas_201Set() public {
        // #201's Base buckets: Stable in the vaults, Balance in WETH/USDC (cbBTC dropped), Growth bridged to Monad.
        Session[] memory s = _concat(_uniTriple(_eth(), NPM, ROUTER, 0x30), _vaultAndBridge(false));
        (uint256 used, uint256 limit) = _measure("Base: #201 set, WETH/USDC x3 + vault + bridge-out", s, 4, true);
        assertLe(used, SETUP_BUDGET, "#201 set under the 15.3M budget");
        assertLe(limit, BASE_TX_CAP, "#201 set limit under Base's cap");
    }

    function test_gas_201BothBalancePools() public {
        // #201 with both Balance candidates granted (WETH/USDC and cbBTC/USDC, the engine picks one): 8 sessions.
        Session[] memory s = _concat(_uniTriple(_eth(), NPM, ROUTER, 0x30), _uniTriple(_btc(), NPM, ROUTER, 0x20));
        s = _concat(s, _vaultAndBridge(false));
        (uint256 used, uint256 limit) =
            _measure("Base: #201 set, WETH/USDC x3 + cbBTC/USDC x3 + vault + bridge-out", s, 10, true);
        assertLe(used, SETUP_BUDGET, "under the 15.3M budget");
        assertLe(limit, BASE_TX_CAP, "limit under Base's cap");
    }

    function test_gas_manageAnyOnlyAllPools() public {
        // With V3 as the only action policy, manage-any's actions are a superset of enter-swap's and enter-mint's, so
        // one manage-any per pool covers what the three grants do (a grant-design question for T2, measured here).
        Session[] memory s = _concat(
            _one(_manageAny(_stable(), NPM, ROUTER, bytes32(uint256(0x13)))),
            _one(_manageAny(_btc(), NPM, ROUTER, bytes32(uint256(0x23))))
        );
        s = _concat(s, _one(_manageAny(_eth(), NPM, ROUTER, bytes32(uint256(0x33)))));
        s = _concat(s, _vaultAndBridge(false));
        (uint256 used, uint256 limit) = _measure("Base: manage-any x3 pools + vault + bridge-out", s, 11, true);
        assertLe(used, SETUP_BUDGET, "under the 15.3M budget");
        assertLe(limit, BASE_TX_CAP, "limit under Base's cap");
    }

    function test_gas_vaultAndBridgeOnly() public {
        _measure("Base: vault + bridge-out", _vaultAndBridge(false), 5, false);
    }

    function test_gas_oneOfEach() public {
        _measure("Base: one enter-swap (WETH/USDC)", _one(_enterSwap(_eth(), ROUTER, bytes32(uint256(1)))), 6, false);
    }

    function test_gas_oneManageAny() public {
        _measure(
            "Base: one manage-any (WETH/USDC)", _one(_manageAny(_eth(), NPM, ROUTER, bytes32(uint256(1)))), 7, false
        );
    }

    function test_gas_oneVault() public {
        _measure("Base: one vault grant", _one(_vaultSession(bytes32(uint256(1)), false)), 8, false);
    }

    function test_gas_oneBridge() public {
        _measure("Base: one bridge-out grant", _one(_bridgeSession(bytes32(uint256(1)))), 9, false);
    }
}

/// Real userOps through sessions that were enabled inside the Safe setup, one per action family, and the refusals.
contract V3SetupUserOpsBase is BaseV3Fixture {
    address safe;
    bytes32 pidSwapEth;
    bytes32 pidMintEth;
    bytes32 pidManageEth;
    bytes32 pidVault;
    bytes32 pidBridge;

    function setUp() public {
        _setUpBase();
        Session[] memory s = _concat(_uniNine(), _vaultAndBridge(true));
        (safe,) = _deploy(_deployCall(s, 77), 40_000_000);
        assertTrue(safe != address(0), "deploy");
        assertTrue(ISafe7579(safe).isModuleInstalled(1, SMART_SESSION, ""), "SmartSession installed at setup");
        assertEq(_allEnabled(safe, s), s.length, "every session enabled at setup");
        pidSwapEth = _pid(s[6]);
        pidMintEth = _pid(s[7]);
        pidManageEth = _pid(s[8]);
        pidVault = _pid(s[9]);
        pidBridge = _pid(s[10]);
        vm.deal(safe, 1 ether); // userOp prefund
        deal(USDC, safe, 10_000e6);
        deal(WETH, safe, 1e18);
    }

    function _bal(address token) internal view returns (uint256) {
        return IERC20(token).balanceOf(safe);
    }

    function _swapData(address recipient) internal view returns (bytes memory) {
        (uint256 minOut, uint160 limit) = v3.swapBounds(safe, POOL_ETH, USDC, 100e6);
        return abi.encodeCall(
            IRouter.exactInputSingle, (ExactInputSingleParams(USDC, WETH, 3000, recipient, 100e6, minOut, limit))
        );
    }

    // ------------------------------------------------------------ swap

    function test_swapThroughSetupEnabledSession() public {
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20.approve, (ROUTER, 100e6)));
        xs[1] = Execution(ROUTER, 0, _swapData(safe));
        uint256 w0 = _bal(WETH);
        uint256 gas = _run(safe, _batch(xs), pidSwapEth);
        console2.log("userOp swap (approve + exactInputSingle), handleOps gas", gas);
        assertGt(_bal(WETH), w0, "WETH arrived at the account");
    }

    function test_swapWrongRecipientRejected() public {
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20.approve, (ROUTER, 100e6)));
        xs[1] = Execution(ROUTER, 0, _swapData(attacker));
        _rejected(safe, _batch(xs), pidSwapEth);
    }

    // ------------------------------------------------------------ mint, then manage-any with no per-position grant

    function test_mintThenCollectWithoutPerPositionGrant() public {
        (, int24 tick,,,,,) = IPool(POOL_ETH).slot0();
        int24 sp = IPool(POOL_ETH).tickSpacing();
        int24 lower = (tick / sp - 10) * sp;
        int24 upper = (tick / sp + 10) * sp;
        Execution[] memory xs = new Execution[](3);
        xs[0] = Execution(WETH, 0, abi.encodeCall(IERC20.approve, (address(v3), 0.01e18)));
        xs[1] = Execution(USDC, 0, abi.encodeCall(IERC20.approve, (address(v3), 40e6)));
        xs[2] = Execution(
            address(v3),
            0,
            abi.encodeCall(
                MamoruActionPolicyV3.mint,
                (MintParams(WETH, USDC, 3000, lower, upper, 0.01e18, 40e6, 0, 0, safe, block.timestamp))
            )
        );
        uint256 gas = _run(safe, _batch(xs), pidMintEth);
        console2.log("userOp mint through the policy, handleOps gas", gas);
        assertEq(INPMView(NPM).balanceOf(safe), 1, "position minted to the account");
        uint256 tokenId = INPMView(NPM).tokenOfOwnerByIndex(safe, 0);
        assertEq(v3.admittedPool(safe, tokenId), POOL_ETH, "admitted by the policy");

        // manage-any names no tokenId: the admitted set is the policy's.
        bytes memory collect =
            abi.encodeCall(INPMView.collect, (CollectParams(tokenId, safe, type(uint128).max, type(uint128).max)));
        gas = _run(safe, _single(NPM, collect), pidManageEth);
        console2.log("userOp collect (manage-any, no per-position grant), handleOps gas", gas);
        bytes memory collectAway =
            abi.encodeCall(INPMView.collect, (CollectParams(tokenId, attacker, type(uint128).max, type(uint128).max)));
        _rejected(safe, _single(NPM, collectAway), pidManageEth);
    }

    // ------------------------------------------------------------ ERC-4626

    function _depositOp(address vault, uint256 assets, address receiver) internal pure returns (bytes memory) {
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20.approve, (vault, assets)));
        xs[1] = Execution(vault, 0, abi.encodeCall(IVault.deposit, (assets, receiver)));
        return _batch(xs);
    }

    function test_vaultDepositAndRedeem() public {
        address[2] memory vaults = [GT_USDCP, WA_BAS_USDC];
        for (uint256 k; k < 2; k++) {
            address v = vaults[k];
            uint256 u0 = _bal(USDC);
            uint256 gas = _run(safe, _depositOp(v, 1_000e6, safe), pidVault);
            console2.log("userOp 4626 approve + deposit, handleOps gas", gas);
            uint256 shares = IVault(v).balanceOf(safe);
            assertGt(shares, 0, "shares at the account");
            assertEq(u0 - _bal(USDC), 1_000e6);
            gas = _run(safe, _single(v, abi.encodeCall(IVault.redeem, (shares, safe, safe))), pidVault);
            console2.log("userOp 4626 redeem, handleOps gas", gas);
            assertEq(IVault(v).balanceOf(safe), 0);
            assertApproxEqAbs(_bal(USDC), u0, 2, "USDC back at the account (rounding)");
        }
    }

    function test_vaultWrongReceiverRejected() public {
        _rejected(safe, _depositOp(GT_USDCP, 1_000e6, attacker), pidVault);
    }

    function test_vaultRedeemOwnerNotAccountRejected() public {
        _run(safe, _depositOp(GT_USDCP, 1_000e6, safe), pidVault);
        uint256 shares = IVault(GT_USDCP).balanceOf(safe);
        _rejected(safe, _single(GT_USDCP, abi.encodeCall(IVault.redeem, (shares, safe, attacker))), pidVault);
        _rejected(safe, _single(GT_USDCP, abi.encodeCall(IVault.redeem, (shares, attacker, safe))), pidVault);
    }

    function test_unlistedVaultRejected() public {
        // The grant names steakUSDC.deposit; V3's list does not have it.
        _rejected(safe, _depositOp(STEAK_USDC, 1_000e6, safe), pidVault);
    }

    // ------------------------------------------------------------ CCTP bridge-out

    function _burnOp(uint256 amount, uint32 domain, bytes32 recipient) internal pure returns (bytes memory) {
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(USDC, 0, abi.encodeCall(IERC20.approve, (TOKEN_MESSENGER, amount)));
        xs[1] = Execution(
            TOKEN_MESSENGER,
            0,
            abi.encodeCall(ITokenMessengerV2.depositForBurn, (amount, domain, recipient, USDC, bytes32(0), 0, 2000))
        );
        return _batch(xs);
    }

    function test_bridgeBurnToSameAccountOnMonad() public {
        uint256 u0 = _bal(USDC);
        uint256 gas = _run(safe, _burnOp(100e6, DOMAIN_MONAD, bytes32(uint256(uint160(safe)))), pidBridge);
        console2.log("userOp CCTP approve + depositForBurn, handleOps gas", gas);
        assertEq(u0 - _bal(USDC), 100e6, "USDC burned from the account");
    }

    function test_bridgeWrongDomainRejected() public {
        _rejected(safe, _burnOp(100e6, 6, bytes32(uint256(uint160(safe)))), pidBridge);
    }

    function test_bridgeWrongMintRecipientRejected() public {
        _rejected(safe, _burnOp(100e6, DOMAIN_MONAD, bytes32(uint256(uint160(attacker)))), pidBridge);
    }

    // ------------------------------------------------------------ families do not cross

    function test_vaultSessionCannotBridgeOrSwap() public {
        // The bridge and swap targets are not actions of the vault grant: SmartSession refuses before any policy.
        _rejected(safe, _burnOp(100e6, DOMAIN_MONAD, bytes32(uint256(uint160(safe)))), pidVault);
        _rejected(safe, _single(ROUTER, _swapData(safe)), pidVault);
    }
}

// ================================================================ Monad

/// Monad set: what enabling at setup costs on Monad (anvil's Ethereum gas schedule: indicative only, Monad reprices
/// cold state). V3 on Monad: Uniswap only (no vault list, no bridge family).
contract V3SetupGasMonad is V3SetupBase {
    uint256 constant FORK_BLOCK = 116_980_000; // T0's Monad block
    address constant NPM = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
    address constant ROUTER = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
    address constant FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant POOL = 0x659bD0BC4167BA25c62E05656F78043E7eD4a9da; // WMON/USDC 0.3%

    function setUp() public {
        vm.createSelectFork(vm.envOr("MONAD_FORK_RPC_URL", string("https://rpc.monad.xyz")), FORK_BLOCK);
        v3 = new MamoruActionPolicyV3(
            SMART_SESSION, NPM, ROUTER, FACTORY, address(0x6A2d1A9), new address[](0), address(0), address(0), 0
        );
        _deployCommon();
        // DeployMonad.s.sol (PR #139) raises the ring to 1,800 before any enable; the fork block predates it.
        (,,,, uint16 next,,) = IPool(POOL).slot0();
        while (next < 1800) {
            next = next + 500 > 1800 ? 1800 : next + 500;
            IPool(POOL).increaseObservationCardinalityNext(next);
        }
    }

    function _wmon() internal pure returns (Pool memory) {
        // token0 WMON, token1 USDC: the budget in USDC (token1).
        return Pool(POOL, WMON, USDC, USDC, 100, 0, true, 100e6, 500e6);
    }

    function test_gas_monadSet() public {
        _measure(
            "Monad: WMON/USDC enter-swap + enter-mint (T0's Monad pair)",
            _concat(
                _one(_enterSwap(_wmon(), ROUTER, bytes32(uint256(1)))), _one(_enterMint(_wmon(), bytes32(uint256(2))))
            ),
            1,
            true
        );
    }

    function test_gas_monadTriple() public {
        _measure(
            "Monad: WMON/USDC x3 (enter-swap, enter-mint, manage-any)", _uniTriple(_wmon(), NPM, ROUTER, 0x10), 2, true
        );
    }
}
