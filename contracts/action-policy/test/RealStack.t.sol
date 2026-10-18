// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {LibZip} from "solady/utils/LibZip.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {
    MamoruActionPolicy,
    MintParams,
    ExactInputSingleParams,
    DecreaseLiquidityParams,
    IncreaseLiquidityParams,
    CollectParams,
    IERC20Min
} from "../src/MamoruActionPolicy.sol";

// ---------------------------------------------------------------- deployed-stack types
// SmartSession DataTypes.sol of the deployed 0x00000000002B0eCfbD0496EE71e01257dA0E37DE (Sourcify, solc 0.8.28).

struct PolicyData {
    address policy;
    bytes initData;
}

struct ActionData {
    bytes4 actionTargetSelector;
    address actionTarget;
    PolicyData[] actionPolicies;
}

struct ERC7739Context {
    bytes32 appDomainSeparator;
    string[] contentNames;
}

struct ERC7739Data {
    ERC7739Context[] allowedERC7739Content;
    PolicyData[] erc1271Policies;
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

struct ChainDigest {
    uint64 chainId;
    bytes32 sessionDigest;
}

struct EnableSession {
    uint8 chainDigestIndex;
    ChainDigest[] hashesAndChainIds;
    Session sessionToEnable;
    bytes permissionEnableSig;
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

struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

// UniActionPolicy ActionConfig (packages/account/sessions uniActionInitData)
struct UsageLimit {
    uint256 limit;
    uint256 used;
}

struct ParamRule {
    uint8 condition;
    uint64 offset;
    bool isLimited;
    bytes32 ref;
    UsageLimit usage;
}

struct ParamRules {
    uint256 length;
    ParamRule[16] rules;
}

struct ActionConfig {
    uint256 valueLimitPerUse;
    ParamRules paramRules;
}

struct AttestationRequest {
    address moduleAddress;
    uint48 expirationTime;
    bytes data;
    uint256[] moduleTypes;
}

struct ModuleInit {
    address module;
    bytes initData;
}

interface ISmartSessionLite {
    function enableSessions(Session[] calldata sessions) external returns (bytes32[] memory);
    function removeSession(bytes32 permissionId) external;
    function getSessionDigest(bytes32 permissionId, address account, Session calldata data, uint8 mode)
        external
        view
        returns (bytes32);
    function getPermissionId(Session calldata session) external pure returns (bytes32);
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external returns (uint256);

    error PolicyViolation(bytes32 permissionId, address policy);
    error NoPoliciesSet(bytes32 permissionId);
    error PolicyCheckReverted(bytes32 reason);
    error ChainIdMismatch(uint64 providedChainId);
    error UnsupportedPolicy(address policy);
}

interface IEntryPointV07 {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);

    error FailedOp(uint256 opIndex, string reason);
    error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner);

    event UserOperationEvent(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed paymaster,
        uint256 nonce,
        bool success,
        uint256 actualGasCost,
        uint256 actualGasUsed
    );
}

interface ISafe141 {
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
        uint256 _nonce
    ) external view returns (bytes32);
    function nonce() external view returns (uint256);
    function domainSeparator() external view returns (bytes32);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ILaunchpad {
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

interface IRegistryLite {
    function trustAttesters(uint8 threshold, address[] calldata attesters) external;
    function attest(bytes32 schemaUID, AttestationRequest[] calldata requests) external;
    function registerModule(bytes32 resolverUID, address moduleAddress, bytes calldata metadata, bytes calldata ctx)
        external;
    function checkForAccount(address smartAccount, address module) external view;
}

interface IMultiSend {
    function multiSend(bytes memory transactions) external payable;
}

interface INPMLite {
    function mint(MintParams calldata)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function increaseLiquidity(IncreaseLiquidityParams calldata) external payable returns (uint128, uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256, uint256);
    function collect(CollectParams calldata) external payable returns (uint256, uint256);
    function burn(uint256) external payable;
    function balanceOf(address) external view returns (uint256);
    function tokenOfOwnerByIndex(address, uint256) external view returns (uint256);
    function positions(uint256)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
}

interface IRouter02Lite {
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface ISafe7579Exec {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256);
    error ExecutionFailed();
}

/**
 * Spec 007 T1 (otto/mamoru#151): MamoruActionPolicy through the REAL deployed stack on a Base mainnet fork. A fresh
 * Safe 1.4.1 + Safe7579 adapter + SmartSession, set up exactly as packages/account/safe `safeInitializer` does (launchpad
 * addSafe7579 delegatecall, SmartSession as validator, Rhinestone attester, Safe7579 as fallback handler); the owner is
 * a test EOA instead of the passkey (SafeWebAuthnSharedSigner), so owner signatures are plain Safe ECDSA. The owner's
 * activation is an execTransaction + MultiSendCallOnly from a relayer, as in the operator; session userOps go through
 * EntryPoint v0.7 handleOps from the relayer EOA, as in apps/mamoru-operator/src/bundler.ts.
 */
contract RealStackTest is Test {
    uint256 constant FORK_BLOCK = 52_700_000;
    uint256 constant BASE_TX_GAS_CAP = 16_777_216; // 2^24, EIP-7825

    // packages/registry/base.json
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE7579 = 0x7579EE8307284F293B1927136486880611F20002;
    address constant LAUNCHPAD = 0x7579011aB74c46090561ea277Ba79D510c6C00ff;
    address constant REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    address constant ATTESTER = 0x000000333034E9f539ce08819E12c1b8Cb29084d;
    address constant GUARDIAN = address(0x6A2D);
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant OWNABLE = 0x2483DA3A338895199E5e538530213157e931Bf06;
    address constant TIMEFRAME = 0x8177451511dE0577b911C254E9551D981C26dc72;
    address constant USAGE = 0x1F34eF8311345A3A4a4566aF321b313052F51493;
    address constant UNI = 0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F;
    address constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    address constant NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant POOL_BTC = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef; // USDC/cbBTC 0.05%
    address constant POOL_ETH = 0x6c561B446416E1A00E8E93E221854d6eA4171372; // WETH/USDC 0.3%
    address constant POOL_STABLE = 0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1; // USDC/USDT 0.01%

    /// packages/account/sessions ATTESTATION_SCHEMA_UID
    bytes32 constant SCHEMA = 0x93d46fcca4ef7d66a413c7bde08bb1ff14bacbd04c4069bb24cd7c21729d7bf1;
    /// The resolver TimeFramePolicy, UniActionPolicy and OwnableValidator are registered under (Registry.findModule).
    bytes32 constant RESOLVER = 0xdbca873b13c783c0c9c6ddfc4280e505580bf6cc3dac83f8a0f7b44acaafca4f;
    bytes32 constant SAFE_MSG_TYPEHASH = 0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca;
    // smartsessions HashLib
    bytes32 constant CHAIN_SESSION_TYPEHASH = 0x1ea7e4bc398fa0ccd68d92b5d8931a3fd93eebe1cf0391b4ba28935801af7c80;
    bytes32 constant MULTICHAIN_SESSION_TYPEHASH = 0x0c9d02fb89a1da34d66ea2088dc9ee6a58efee71cef6f1bb849ed74fc6003d98;
    bytes32 constant MULTICHAIN_DOMAIN_SEPARATOR = 0x057501e891776d1482927e5f094ae44049a4d893ba2d7b334dd7db8d38d3a0e1;

    bytes4 constant APPROVE = 0x095ea7b3;
    bytes4 constant EXACT_INPUT_SINGLE = 0x04e45aaf;
    bytes4 constant MINT = 0x88316456;
    bytes4 constant DECREASE = 0x0c49ccbe;
    bytes4 constant COLLECT = 0xfc6f7865;
    bytes4 constant BURN = 0x42966c68;

    // PARAM_CONDITIONS order (packages/policy/src/types.ts)
    uint8 constant EQ = 0;
    uint8 constant GT = 1;
    uint8 constant LTE = 4;

    struct Pool {
        address pool;
        address token0;
        address token1;
        uint24 fee;
        uint24 band;
        uint128 w0;
        uint128 w1;
    }

    struct Rule {
        uint8 cond;
        uint64 index;
        bytes32 ref;
    }

    MamoruActionPolicy policy;
    address relayer = makeAddr("relayer");
    uint256 ownerPk = 0xA11CE;
    address owner;
    address safe;
    uint256 sessionPk = 0x5E55;
    address sessionKey;
    bytes32 pidBtc;
    Pool btc;
    Pool eth;
    Pool stable;
    uint256 saltNonce = 1;
    uint192 lane;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), FORK_BLOCK);
        owner = vm.addr(ownerPk);
        sessionKey = vm.addr(sessionPk);
        policy = new MamoruActionPolicy(SMART_SESSION, NPM, ROUTER, FACTORY, GUARDIAN);
        // ERC-7484: the registry refuses an attestation for an unregistered module (ModuleNotFoundInRegistry), so the
        // policy is registered first, permissionless, under the same resolver as the published Rhinestone policies.
        IRegistryLite(REGISTRY).registerModule(RESOLVER, address(policy), "", "");
        btc = Pool(POOL_BTC, USDC, CBBTC, 500, 100, 60_000e6, 0.6e8);
        eth = Pool(POOL_ETH, WETH, USDC, 3000, 100, 5e18, 15_000e6);
        stable = Pool(POOL_STABLE, USDC, USDT, 100, 10, 50_000e6, 50_000e6);
        vm.deal(relayer, 10 ether);
    }

    // ================================================================ account, owner path

    function _deploySafe() internal returns (address s) {
        ModuleInit[] memory validators = new ModuleInit[](1);
        validators[0] = ModuleInit(SMART_SESSION, "");
        address[] memory attesters = new address[](1);
        attesters[0] = ATTESTER;
        bytes memory launch = abi.encodeCall(
            ILaunchpad.addSafe7579,
            (SAFE7579, validators, new ModuleInit[](0), new ModuleInit[](0), new ModuleInit[](0), attesters, 1)
        );
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory init = abi.encodeCall(
            ISafe141.setup, (owners, 1, LAUNCHPAD, launch, SAFE7579, address(0), 0, payable(address(0)))
        );
        vm.prank(relayer, relayer);
        s = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, init, saltNonce++);
        vm.deal(s, 1 ether);
        deal(USDC, s, 200_000e6);
        deal(CBBTC, s, 2e8);
    }

    /// registryTrustCalls: trust the Rhinestone attester and the account itself (threshold 1), self-attest policies.
    function _trustCalls(address account, bool) internal pure returns (Execution[] memory xs) {
        address[] memory a = new address[](2);
        (a[0], a[1]) = ATTESTER < account ? (ATTESTER, account) : (account, ATTESTER);
        xs = new Execution[](2);
        xs[0] = Execution(REGISTRY, 0, abi.encodeCall(IRegistryLite.trustAttesters, (1, a)));
        xs[1] = Execution(REGISTRY, 0, "");
        return xs;
    }

    function _attestCall(address[] memory modules) internal pure returns (Execution memory) {
        AttestationRequest[] memory r = new AttestationRequest[](modules.length);
        for (uint256 i; i < modules.length; i++) {
            r[i] = AttestationRequest(modules[i], 0, "", new uint256[](0));
        }
        return Execution(REGISTRY, 0, abi.encodeCall(IRegistryLite.attest, (SCHEMA, r)));
    }

    function _activationTrust(address account) internal view returns (Execution[] memory xs) {
        xs = _trustCalls(account, true);
        address[] memory m = new address[](3);
        (m[0], m[1], m[2]) = (TIMEFRAME, USAGE, address(policy));
        xs[1] = _attestCall(m);
    }

    struct TxGas {
        uint256 exec; // gas used by execTransaction, measured inside the EVM call
        uint256 calldataBytes;
        uint256 total; // exec + intrinsic (21k + calldata, EIP-7623 floor applied)
    }

    /// Owner batch: Safe execTransaction delegatecalling MultiSendCallOnly, signed by the owner, sent by the relayer.
    function _ownerBatch(address s, Execution[] memory calls) internal returns (TxGas memory g) {
        bytes memory packed;
        for (uint256 i; i < calls.length; i++) {
            packed = abi.encodePacked(
                packed, uint8(0), calls[i].target, calls[i].value, calls[i].callData.length, calls[i].callData
            );
        }
        bytes memory data = abi.encodeCall(IMultiSend.multiSend, (packed));
        uint256 n = ISafe141(s).nonce();
        bytes32 h = ISafe141(s).getTransactionHash(MULTISEND_CALL_ONLY, 0, data, 1, 0, 0, 0, address(0), address(0), n);
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(ownerPk, h);
        bytes memory signatures = abi.encodePacked(r, sig, v);
        bytes memory txData = abi.encodeCall(
            ISafe141.execTransaction,
            (MULTISEND_CALL_ONLY, 0, data, 1, 0, 0, 0, address(0), payable(address(0)), signatures)
        );
        _coolAll(s);
        vm.prank(relayer, relayer);
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = s.call(txData);
        g.exec = g0 - gasleft();
        require(ok && abi.decode(ret, (bool)), "owner execTransaction failed");
        g.calldataBytes = txData.length;
        g.total = g.exec + _intrinsic(txData);
    }

    function _intrinsic(bytes memory data) internal pure returns (uint256) {
        uint256 zeros;
        for (uint256 i; i < data.length; i++) {
            if (data[i] == 0) zeros++;
        }
        uint256 tokens = zeros + 4 * (data.length - zeros);
        uint256 standard = 21_000 + 4 * tokens;
        uint256 floor = 21_000 + 10 * tokens; // EIP-7623 floor (the floor applies to the whole tx; approximated here)
        return standard > floor ? standard : floor;
    }

    function _coolAll(address s) internal {
        address[22] memory a = [
            s,
            SAFE_L2,
            SAFE7579,
            SMART_SESSION,
            address(policy),
            UNI,
            TIMEFRAME,
            USAGE,
            OWNABLE,
            REGISTRY,
            NPM,
            ROUTER,
            FACTORY,
            POOL_BTC,
            POOL_ETH,
            POOL_STABLE,
            USDC,
            CBBTC,
            USDT,
            WETH,
            EP,
            MULTISEND_CALL_ONLY
        ];
        for (uint256 i; i < a.length; i++) {
            vm.cool(a[i]);
        }
    }

    // ================================================================ grants

    function _uniInit(Rule[] memory rules) internal pure returns (bytes memory) {
        ActionConfig memory c;
        c.paramRules.length = rules.length;
        for (uint256 i; i < rules.length; i++) {
            c.paramRules.rules[i] = ParamRule(rules[i].cond, rules[i].index * 32, false, rules[i].ref, UsageLimit(0, 0));
        }
        return abi.encode(c);
    }

    function _mamInit(Pool memory p, uint64 gen) internal pure returns (bytes memory) {
        return abi.encode(
            MamoruActionPolicy.Init({
                pool: p.pool,
                twapWindow: 1800,
                bandTicks: p.band,
                generation: gen,
                budgetWindow: 1 days,
                perWindow0: p.w0,
                perWindow1: p.w1,
                total0: 3 * p.w0,
                total1: 3 * p.w1
            })
        );
    }

    function _act(address target, bytes4 sel, Rule[] memory rules, bytes memory mam)
        internal
        view
        returns (ActionData memory a)
    {
        bool both = mam.length != 0;
        a.actionTargetSelector = sel;
        a.actionTarget = target;
        a.actionPolicies = new PolicyData[](both ? 2 : 1);
        a.actionPolicies[0] = PolicyData(UNI, _uniInit(rules));
        if (both) a.actionPolicies[1] = PolicyData(address(policy), mam);
    }

    function _r1(uint8 c, uint64 i, uint256 ref) internal pure returns (Rule[] memory r) {
        r = new Rule[](1);
        r[0] = Rule(c, i, bytes32(ref));
    }

    function _r2(uint8 c0, uint64 i0, uint256 ref0, uint8 c1, uint64 i1, uint256 ref1)
        internal
        pure
        returns (Rule[] memory r)
    {
        r = new Rule[](2);
        r[0] = Rule(c0, i0, bytes32(ref0));
        r[1] = Rule(c1, i1, bytes32(ref1));
    }

    function _a(address x) internal pure returns (uint256) {
        return uint256(uint160(x));
    }

    /**
     * The v4 grant of spec 007 T2 for one pool, merged into ONE session (manage-any + convert-any + enter): 8 actions,
     * each with UniActionPolicy and (when `mam` is set) MamoruActionPolicy. Approvals carry only the amount cap in
     * UniActionPolicy (the spender is the router OR the policy: MamoruActionPolicy pins it), the swap has no
     * `sqrtPriceLimitX96 EQUAL 0` rule, mint and increase name the policy, decrease/collect/burn take any tokenId.
     */
    function _v4Actions(Pool memory p, address account, bytes memory mam)
        internal
        view
        returns (ActionData[] memory a)
    {
        uint256 cap = p.w0 > p.w1 ? p.w0 : p.w1;
        a = new ActionData[](8);
        a[0] = _act(p.token0, APPROVE, _r1(LTE, 1, p.w0), mam);
        a[1] = _act(p.token1, APPROVE, _r1(LTE, 1, p.w1), mam);
        Rule[] memory sw = new Rule[](4);
        sw[0] = Rule(EQ, 2, bytes32(uint256(p.fee)));
        sw[1] = Rule(EQ, 3, bytes32(_a(account)));
        sw[2] = Rule(LTE, 4, bytes32(cap));
        sw[3] = Rule(GT, 5, bytes32(0));
        a[2] = _act(ROUTER, EXACT_INPUT_SINGLE, sw, mam);
        Rule[] memory mi = new Rule[](8);
        mi[0] = Rule(EQ, 0, bytes32(_a(p.token0)));
        mi[1] = Rule(EQ, 1, bytes32(_a(p.token1)));
        mi[2] = Rule(EQ, 2, bytes32(uint256(p.fee)));
        mi[3] = Rule(LTE, 5, bytes32(uint256(p.w0)));
        mi[4] = Rule(LTE, 6, bytes32(uint256(p.w1)));
        mi[5] = Rule(GT, 7, bytes32(0));
        mi[6] = Rule(GT, 8, bytes32(0));
        mi[7] = Rule(EQ, 9, bytes32(_a(account)));
        a[3] = _act(address(policy), MINT, mi, mam);
        Rule[] memory inc = new Rule[](3);
        inc[0] = Rule(GT, 0, bytes32(0));
        inc[1] = Rule(LTE, 1, bytes32(uint256(p.w0)));
        inc[2] = Rule(LTE, 2, bytes32(uint256(p.w1)));
        // increase(IncreaseLiquidityParams) = 0x4110c363, not the manager's increaseLiquidity 0x219f5d17
        a[4] = _act(address(policy), MamoruActionPolicy.increase.selector, inc, mam);
        a[5] = _act(NPM, DECREASE, _r1(GT, 0, 0), mam);
        a[6] = _act(NPM, COLLECT, _r1(EQ, 1, _a(account)), mam);
        a[7] = _act(NPM, BURN, _r1(GT, 0, 0), mam);
    }

    /// Today's v2/v3 layout for one pool (grants.ts pairGrants enter-swap/enter-mint + manageAnyGrants): 4 sessions,
    /// 2 + 3 + 6 + 3 = 14 actions, rule counts as in the live grants.
    function _todaySessions(Pool memory p, address account, bytes memory mam, uint256 keySeed)
        internal
        view
        returns (Session[] memory s)
    {
        s = new Session[](4);
        s[0] = _session(_todayEnterSwap(p, account, mam), vm.addr(keySeed), bytes32(keySeed));
        s[1] = _session(_todayEnterMint(p, account, mam), vm.addr(keySeed + 1), bytes32(keySeed + 1));
        s[2] = _session(_todayManageAny(p, account, mam), vm.addr(keySeed + 2), bytes32(keySeed + 2));
        s[3] = _session(_todayConvertAny(p, account, mam), vm.addr(keySeed + 3), bytes32(keySeed + 3));
    }

    function _todaySwapRules(Pool memory p, address account) internal pure returns (Rule[] memory sw) {
        sw = new Rule[](7);
        sw[0] = Rule(EQ, 0, bytes32(_a(p.token0)));
        sw[1] = Rule(EQ, 1, bytes32(_a(p.token1)));
        sw[2] = Rule(EQ, 2, bytes32(uint256(p.fee)));
        sw[3] = Rule(EQ, 3, bytes32(_a(account)));
        sw[4] = Rule(LTE, 4, bytes32(uint256(p.w0)));
        sw[5] = Rule(GT, 5, bytes32(0));
        sw[6] = Rule(EQ, 6, bytes32(0));
    }

    /// enter-mint mint rules (8); manage-any has the first 5 plus recipient (6).
    function _todayMintRules(Pool memory p, address account, bool withMins) internal pure returns (Rule[] memory mi) {
        mi = new Rule[](withMins ? 8 : 6);
        mi[0] = Rule(EQ, 0, bytes32(_a(p.token0)));
        mi[1] = Rule(EQ, 1, bytes32(_a(p.token1)));
        mi[2] = Rule(EQ, 2, bytes32(uint256(p.fee)));
        mi[3] = Rule(LTE, 5, bytes32(uint256(p.w0)));
        mi[4] = Rule(LTE, 6, bytes32(uint256(p.w1)));
        if (withMins) {
            mi[5] = Rule(GT, 7, bytes32(0));
            mi[6] = Rule(GT, 8, bytes32(0));
        }
        mi[withMins ? 7 : 5] = Rule(EQ, 9, bytes32(_a(account)));
    }

    function _todayEnterSwap(Pool memory p, address account, bytes memory mam)
        internal
        view
        returns (ActionData[] memory a)
    {
        a = new ActionData[](2);
        a[0] = _act(p.token0, APPROVE, _r2(EQ, 0, _a(ROUTER), LTE, 1, p.w0), mam);
        a[1] = _act(ROUTER, EXACT_INPUT_SINGLE, _todaySwapRules(p, account), mam);
    }

    function _todayEnterMint(Pool memory p, address account, bytes memory mam)
        internal
        view
        returns (ActionData[] memory a)
    {
        a = new ActionData[](3);
        a[0] = _act(p.token0, APPROVE, _r2(EQ, 0, _a(NPM), LTE, 1, p.w0), mam);
        a[1] = _act(p.token1, APPROVE, _r2(EQ, 0, _a(NPM), LTE, 1, p.w1), mam);
        a[2] = _act(NPM, MINT, _todayMintRules(p, account, true), mam);
    }

    function _todayManageAny(Pool memory p, address account, bytes memory mam)
        internal
        view
        returns (ActionData[] memory a)
    {
        a = new ActionData[](6);
        a[0] = _act(NPM, DECREASE, _r1(GT, 0, 0), mam);
        a[1] = _act(NPM, COLLECT, _r1(EQ, 1, _a(account)), mam);
        a[2] = _act(NPM, BURN, _r1(GT, 0, 0), mam);
        a[3] = _act(p.token0, APPROVE, _r2(EQ, 0, _a(NPM), LTE, 1, p.w0), mam);
        a[4] = _act(p.token1, APPROVE, _r2(EQ, 0, _a(NPM), LTE, 1, p.w1), mam);
        a[5] = _act(NPM, MINT, _todayMintRules(p, account, false), mam);
    }

    function _todayConvertAny(Pool memory p, address account, bytes memory mam)
        internal
        view
        returns (ActionData[] memory a)
    {
        a = new ActionData[](3);
        a[0] = _act(NPM, COLLECT, _r1(EQ, 1, _a(account)), mam);
        a[1] = _act(p.token1, APPROVE, _r2(EQ, 0, _a(ROUTER), LTE, 1, p.w1), mam);
        a[2] = _act(ROUTER, EXACT_INPUT_SINGLE, _todaySwapRules(p, account), mam);
    }

    function _session(ActionData[] memory actions, address key, bytes32 salt) internal view returns (Session memory s) {
        address[] memory keys = new address[](1);
        keys[0] = key;
        s.sessionValidator = OWNABLE;
        s.sessionValidatorInitData = abi.encode(uint256(1), keys);
        s.salt = salt;
        s.userOpPolicies = new PolicyData[](2);
        s.userOpPolicies[0] =
            PolicyData(TIMEFRAME, abi.encodePacked(uint128(block.timestamp + 365 days), uint128(block.timestamp - 1)));
        s.userOpPolicies[1] = PolicyData(USAGE, abi.encodePacked(uint128(10_000)));
        s.actions = actions;
    }

    function _enableCall(Session[] memory s) internal pure returns (Execution memory) {
        return Execution(SMART_SESSION, 0, abi.encodeCall(ISmartSessionLite.enableSessions, (s)));
    }

    function _one(Session memory s) internal pure returns (Session[] memory a) {
        a = new Session[](1);
        a[0] = s;
    }

    function _with(Execution[] memory xs, Execution memory x) internal pure returns (Execution[] memory r) {
        r = new Execution[](xs.length + 1);
        for (uint256 i; i < xs.length; i++) {
            r[i] = xs[i];
        }
        r[xs.length] = x;
    }

    // ================================================================ session userOps

    function _callData(Execution[] memory xs) internal pure returns (bytes memory) {
        if (xs.length == 1) {
            return abi.encodeCall(
                ISafe7579Exec.execute, (bytes32(0), abi.encodePacked(xs[0].target, xs[0].value, xs[0].callData))
            );
        }
        return abi.encodeCall(ISafe7579Exec.execute, (bytes32(uint256(1) << 248), abi.encode(xs)));
    }

    function _draft(address s, Execution[] memory xs, uint256 verif)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        uint192 key = (uint192(uint160(SMART_SESSION)) << 32) | lane;
        op.sender = s;
        op.nonce = IEntryPointV07(EP).getNonce(s, key);
        op.callData = _callData(xs);
        op.accountGasLimits = bytes32((verif << 128) | 3_000_000);
        op.preVerificationGas = 100_000;
        uint256 maxFee = block.basefee + 1e6;
        op.gasFees = bytes32((uint256(1e6) << 128) | maxFee);
    }

    function _sessionSig(bytes32 h, uint256 pk) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        return abi.encodePacked(r, s, v);
    }

    function _useOp(address s, bytes32 pid, Execution[] memory xs, uint256 pk)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = _draft(s, xs, 2_000_000);
        bytes32 h = IEntryPointV07(EP).getUserOpHash(op);
        op.signature = abi.encodePacked(uint8(0), pid, _sessionSig(h, pk));
    }

    struct OpResult {
        bool included; // handleOps did not revert
        bool success; // UserOperationEvent.success (execution did not revert)
        bytes revertData; // handleOps revert data
        bytes reason; // SmartSession.validateUserOp revert data, called as the account (diagnosis)
        uint256 validation; // gas of Safe.validateUserOp (Safe -> Safe7579 -> SmartSession -> policies), cold
        uint256 execution; // gas of Safe.execute right after it
        uint256 handleOps; // gas of the whole handleOps call (relayer), cold
        uint256 actualGasUsed; // UserOperationEvent.actualGasUsed
    }

    function _run(PackedUserOperation memory op, string memory label) internal returns (OpResult memory r) {
        bytes32 h = IEntryPointV07(EP).getUserOpHash(op);
        // 1. split validation / execution gas, then roll back
        uint256 snap = vm.snapshotState();
        _coolAll(op.sender);
        vm.prank(EP);
        uint256 g0 = gasleft();
        (bool vok,) = op.sender.call(abi.encodeCall(ISafe7579Exec.validateUserOp, (op, h, 0)));
        r.validation = g0 - gasleft();
        if (vok) {
            vm.prank(EP);
            g0 = gasleft();
            (bool eok,) = op.sender.call(op.callData);
            r.execution = g0 - gasleft();
            eok;
        }
        vm.revertToState(snap);
        // 2. why SmartSession refuses: Safe7579 hides it (ExecutionFailed), so ask SmartSession as the account
        snap = vm.snapshotState();
        vm.prank(op.sender);
        (bool sok, bytes memory sret) = SMART_SESSION.call(abi.encodeCall(ISmartSessionLite.validateUserOp, (op, h)));
        if (!sok) r.reason = sret;
        vm.revertToState(snap);
        // 3. the real thing: handleOps from the relayer EOA
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        _coolAll(op.sender);
        vm.recordLogs();
        vm.prank(relayer, relayer);
        g0 = gasleft();
        try IEntryPointV07(EP).handleOps(ops, payable(relayer)) {
            r.handleOps = g0 - gasleft();
            r.included = true;
            (r.success, r.actualGasUsed) = _opEvent();
        } catch (bytes memory e) {
            r.revertData = e;
        }
        console2.log("----", label);
        console2.log("  included / success:", r.included, r.success);
        console2.log("  gas validation / execution:", r.validation, r.execution);
        console2.log("  gas handleOps / actualGasUsed:", r.handleOps, r.actualGasUsed);
        if (r.reason.length != 0) console2.logBytes(r.reason);
    }

    function _opEvent() internal returns (bool success, uint256 used) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == EP && logs[i].topics[0] == IEntryPointV07.UserOperationEvent.selector) {
                (, success,, used) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    function _expectPass(OpResult memory r) internal pure {
        require(r.included && r.success, "op must pass");
    }

    /// Refused in validation: handleOps reverts AA23 with Safe7579's ExecutionFailed, SmartSession says why.
    function _expectRefused(OpResult memory r, bytes memory reason) internal pure {
        require(!r.included, "op must be refused");
        bytes memory aa23 = abi.encodeWithSelector(
            IEntryPointV07.FailedOpWithRevert.selector,
            0,
            "AA23 reverted",
            abi.encodeWithSelector(ISafe7579Exec.ExecutionFailed.selector)
        );
        require(keccak256(r.revertData) == keccak256(aa23), "handleOps: expected AA23 ExecutionFailed");
        require(keccak256(r.reason) == keccak256(reason), "SmartSession: unexpected reason");
    }

    function _x(address t, bytes memory d) internal pure returns (Execution memory) {
        return Execution(t, 0, d);
    }

    function _xs(Execution memory a) internal pure returns (Execution[] memory r) {
        r = new Execution[](1);
        r[0] = a;
    }

    function _xs(Execution memory a, Execution memory b) internal pure returns (Execution[] memory r) {
        r = new Execution[](2);
        (r[0], r[1]) = (a, b);
    }

    function _xs(Execution memory a, Execution memory b, Execution memory c)
        internal
        pure
        returns (Execution[] memory r)
    {
        r = new Execution[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _approve(address token, address spender, uint256 amount) internal pure returns (Execution memory) {
        return _x(token, abi.encodeCall(IERC20Min.approve, (spender, amount)));
    }

    function _swap(address tIn, address tOut, uint24 fee, uint256 amountIn, uint256 minOut, uint160 limit)
        internal
        view
        returns (Execution memory)
    {
        return _x(
            ROUTER,
            abi.encodeCall(
                IRouter02Lite.exactInputSingle, (ExactInputSingleParams(tIn, tOut, fee, safe, amountIn, minOut, limit))
            )
        );
    }

    function _spot(address pool) internal view returns (int24 t) {
        (, t,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    function _violation(bytes32 pid, address p) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ISmartSessionLite.PolicyViolation.selector, pid, p);
    }

    // ================================================================ 1-3: the engine's ops and the attacks

    /// Activates the account the way a new Mamoru account would be: trust + self-attest + enableSessions, one owner tx.
    function _activateBtc() internal returns (TxGas memory g) {
        safe = _deploySafe();
        Session memory s = _session(_v4Actions(btc, safe, _mamInit(btc, 1)), sessionKey, bytes32(uint256(1)));
        pidBtc = ISmartSessionLite(SMART_SESSION).getPermissionId(s);
        g = _ownerBatch(safe, _with(_activationTrust(safe), _enableCall(_one(s))));
        assertTrue(ISmartSessionLite(SMART_SESSION).isPermissionEnabled(pidBtc, safe));
        IRegistryLite(REGISTRY).checkForAccount(safe, address(policy)); // reverts if not attested for the account
    }

    uint256 tokenId;
    MintParams mintParams;

    function test_realStack_engineOpsPassAndAttacksRefused() public {
        TxGas memory g = _activateBtc();
        console2.log("activation (trust + attest 3 + enable 1 v4 session, 8 actions x 2 policies): exec", g.exec);
        console2.log("  tx total", g.total);
        _stepSwap();
        _stepMint();
        _stepIncrease();
        _attackLooseSwap();
        _attackForeignIncrease();
        _attackDirectIncrease();
        _attackBatchOverBudget();
        _exitDecreaseCollect();
        _expectPass(
            _run(_useOp(safe, pidBtc, _xs(_x(NPM, abi.encodeCall(INPMLite.burn, (tokenId)))), sessionPk), "burn")
        );
        assertEq(INPMLite(NPM).balanceOf(safe), 0);
    }

    function _stepSwap() internal {
        uint256 amountIn = 10_000e6;
        (uint256 minOut, uint160 limit) = policy.swapBounds(safe, POOL_BTC, USDC, amountIn);
        Execution[] memory xs = _xs(_approve(USDC, ROUTER, amountIn), _swap(USDC, CBBTC, 500, amountIn, minOut, limit));
        _expectPass(_run(_useOp(safe, pidBtc, xs, sessionPk), "approve + swap (policy bounds)"));
    }

    function _stepMint() internal {
        int24 sp = _spot(POOL_BTC);
        mintParams = MintParams(
            USDC,
            CBBTC,
            500,
            ((sp - 600) / 10) * 10,
            ((sp + 600) / 10) * 10,
            20_000e6,
            0.2e8,
            1,
            1,
            safe,
            block.timestamp + 600
        );
        Execution[] memory xs = _xs(
            _approve(USDC, address(policy), 20_000e6),
            _approve(CBBTC, address(policy), 0.2e8),
            _x(address(policy), abi.encodeCall(MamoruActionPolicy.mint, (mintParams)))
        );
        _expectPass(_run(_useOp(safe, pidBtc, xs, sessionPk), "approve x2 + policy.mint"));
        tokenId = INPMLite(NPM).tokenOfOwnerByIndex(safe, INPMLite(NPM).balanceOf(safe) - 1);
        assertEq(policy.admittedPool(safe, tokenId), POOL_BTC, "minted NFT admitted");
    }

    function _increaseX(uint256 id, uint256 a0, uint256 a1) internal view returns (Execution[] memory) {
        return _xs(
            _approve(USDC, address(policy), a0),
            _approve(CBBTC, address(policy), a1),
            _x(
                address(policy),
                abi.encodeCall(
                    MamoruActionPolicy.increase, (IncreaseLiquidityParams(id, a0, a1, 0, 0, block.timestamp + 600))
                )
            )
        );
    }

    function _liq(uint256 id) internal view returns (uint128 l) {
        (,,,,,,, l,,,,) = INPMLite(NPM).positions(id);
    }

    function _stepIncrease() internal {
        uint128 liq0 = _liq(tokenId);
        _expectPass(
            _run(
                _useOp(safe, pidBtc, _increaseX(tokenId, 5_000e6, 0.05e8), sessionPk),
                "approve x2 + policy.increase (admitted NFT)"
            )
        );
        assertGt(_liq(tokenId), liq0, "liquidity added to the same NFT");
        assertEq(IERC20Min(USDC).balanceOf(address(policy)), 0);
        assertEq(IERC20Min(CBBTC).balanceOf(address(policy)), 0);
    }

    /// (A1) today's loose swap: min 1, limit 0. UniActionPolicy (v4 rules) lets it through; MamoruActionPolicy refuses.
    function _attackLooseSwap() internal {
        Execution[] memory xs = _xs(_approve(USDC, ROUTER, 10_000e6), _swap(USDC, CBBTC, 500, 10_000e6, 1, 0));
        _expectRefused(
            _run(_useOp(safe, pidBtc, xs, sessionPk), "ATTACK loose swap (min 1, limit 0)"),
            _violation(pidBtc, address(policy))
        );
    }

    /// (A2) policy.increase on a foreign NFT (an attacker's position)
    function _attackForeignIncrease() internal {
        uint256 theirs = _attackerPosition(mintParams);
        _expectRefused(
            _run(
                _useOp(safe, pidBtc, _increaseX(theirs, 1_000e6, 0.01e8), sessionPk),
                "ATTACK policy.increase on a foreign NFT"
            ),
            _violation(pidBtc, address(policy))
        );
    }

    /// (A3) direct NPM.increaseLiquidity on the admitted NFT, and the approval it needs
    function _attackDirectIncrease() internal {
        Execution[] memory xs = _xs(
            _x(
                NPM,
                abi.encodeCall(
                    INPMLite.increaseLiquidity,
                    (IncreaseLiquidityParams(tokenId, 1_000e6, 0.01e8, 0, 0, block.timestamp + 600))
                )
            )
        );
        // not an action of the grant and no fallback policy: SmartSession itself refuses (NoPoliciesSet)
        _expectRefused(
            _run(_useOp(safe, pidBtc, xs, sessionPk), "ATTACK direct NPM.increaseLiquidity"),
            abi.encodeWithSelector(ISmartSessionLite.NoPoliciesSet.selector, pidBtc)
        );
        // approving the manager, which the direct path needs, is refused by MamoruActionPolicy
        _expectRefused(
            _run(
                _useOp(safe, pidBtc, _xs(_approve(USDC, NPM, 1_000e6)), sessionPk),
                "ATTACK approve(NPM) for a direct increase"
            ),
            _violation(pidBtc, address(policy))
        );
    }

    /// (A4) batch over budget: window 60k USDC, 35k already charged (swap 10k, mint 20k, increase 5k desired).
    /// Two 15k swaps, each under UniActionPolicy's per-call cap: the second one is refused.
    function _attackBatchOverBudget() internal {
        assertEq(policy.spendOf(safe, POOL_BTC).window0, 35_000e6);
        (uint256 min15, uint160 lim15) = policy.swapBounds(safe, POOL_BTC, USDC, 15_000e6);
        Execution[] memory xs = _xs(
            _approve(USDC, ROUTER, 30_000e6),
            _swap(USDC, CBBTC, 500, 15_000e6, min15, lim15),
            _swap(USDC, CBBTC, 500, 15_000e6, min15, lim15)
        );
        _expectRefused(
            _run(_useOp(safe, pidBtc, xs, sessionPk), "ATTACK batch over budget (2 x 15k, 25k left)"),
            _violation(pidBtc, address(policy))
        );
        assertEq(policy.spendOf(safe, POOL_BTC).window0, 35_000e6, "a refused op charges nothing (validation reverted)");
        // one 15k swap alone still fits
        _expectPass(_run(_useOp(safe, pidBtc, _xs(xs[0], xs[1]), sessionPk), "one 15k swap (fits the window)"));
    }

    function _exitDecreaseCollect() internal {
        uint128 liq = _liq(tokenId);
        (uint256 min0, uint256 min1) = policy.decreaseMins(safe, POOL_BTC, tokenId, liq);
        Execution[] memory xs = _xs(
            _x(
                NPM,
                abi.encodeCall(
                    INPMLite.decreaseLiquidity,
                    (DecreaseLiquidityParams(tokenId, liq, min0, min1, block.timestamp + 600))
                )
            ),
            _x(
                NPM,
                abi.encodeCall(INPMLite.collect, (CollectParams(tokenId, safe, type(uint128).max, type(uint128).max)))
            )
        );
        _expectPass(_run(_useOp(safe, pidBtc, xs, sessionPk), "decrease (policy mins) + collect"));
    }

    function _attackerPosition(MintParams memory m) internal returns (uint256 id) {
        address other = makeAddr("other");
        deal(USDC, other, 1_000e6);
        deal(CBBTC, other, 0.01e8);
        vm.startPrank(other);
        IERC20Min(USDC).approve(NPM, 1_000e6);
        IERC20Min(CBBTC).approve(NPM, 0.01e8);
        m.recipient = other;
        m.amount0Desired = 1_000e6;
        m.amount1Desired = 0.01e8;
        (id,,,) = INPMLite(NPM).mint(m);
        vm.stopPrank();
    }

    /// Control: the same loose swap through a session with today's enter-swap rules (UniActionPolicy only) passes.
    function test_realStack_controlTodaysGrantAcceptsLooseSwap() public {
        safe = _deploySafe();
        Session[] memory today = _todaySessions(btc, safe, "", 0xBEEF);
        bytes32 pid = ISmartSessionLite(SMART_SESSION).getPermissionId(today[0]);
        _ownerBatch(safe, _with(_activationTrust(safe), _enableCall(_one(today[0]))));
        OpResult memory r = _run(
            _useOp(safe, pid, _xs(_approve(USDC, ROUTER, 10_000e6), _swap(USDC, CBBTC, 500, 10_000e6, 1, 0)), 0xBEEF),
            "CONTROL today's enter-swap grant: loose swap"
        );
        _expectPass(r);
    }

    // ================================================================ 2: ERC-165 and ERC-7484 on the deployed version

    function test_realStack_unattestedPolicyRefusedAtEnable() public {
        safe = _deploySafe();
        // trust + attest only TimeFrame/Usage (today's registryTrustCalls), not MamoruActionPolicy
        Execution[] memory xs = _trustCalls(safe, true);
        address[] memory m = new address[](2);
        (m[0], m[1]) = (TIMEFRAME, USAGE);
        xs[1] = _attestCall(m);
        _ownerBatch(safe, xs);
        Session memory s = _session(_v4Actions(btc, safe, _mamInit(btc, 1)), sessionKey, bytes32(uint256(1)));
        // the deployed SmartSession's enableSessions runs registry.checkForAccount on ACTION policies too
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSignature("InsufficientAttestations()"));
        ISmartSessionLite(SMART_SESSION).enableSessions(_one(s));
        // with the self-attestation it enables
        _ownerBatch(safe, _xs(_attestCall(_arr(address(policy)))));
        vm.prank(safe);
        ISmartSessionLite(SMART_SESSION).enableSessions(_one(s));
    }

    function test_realStack_unregisteredPolicyCannotBeAttested() public {
        MamoruActionPolicy fresh = new MamoruActionPolicy(SMART_SESSION, NPM, ROUTER, FACTORY, GUARDIAN);
        safe = _deploySafe();
        Execution[] memory xs = _trustCalls(safe, true);
        xs[1] = _attestCall(_arr(address(fresh)));
        // the registry refuses an attestation of an unregistered module...
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSignature("ModuleNotFoundInRegistry(address)", address(fresh)));
        (bool ok,) = REGISTRY.call(xs[1].callData);
        ok;
        // ...so the whole owner batch (registryTrustCalls + enable) reverts (Safe GS013 inside _ownerBatch)
        vm.expectRevert(bytes("owner execTransaction failed"));
        this.ownerBatchExternal(safe, xs);
    }

    function ownerBatchExternal(address s, Execution[] memory xs) external {
        _ownerBatch(s, xs);
    }

    function _arr(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    // ================================================================ 4: gas

    function test_realStack_gasEnable() public {
        // Per action: the same v4 session (8 actions) with UniActionPolicy only, and with both policies.
        safe = _deploySafe();
        _ownerBatch(safe, _activationTrust(safe));
        uint256 snap = vm.snapshotState();
        TxGas memory uniOnly = _ownerBatch(
            safe, _xs(_enableCall(_one(_session(_v4Actions(btc, safe, ""), sessionKey, bytes32(uint256(1))))))
        );
        vm.revertToState(snap);
        TxGas memory both = _ownerBatch(
            safe,
            _xs(_enableCall(_one(_session(_v4Actions(btc, safe, _mamInit(btc, 1)), sessionKey, bytes32(uint256(1))))))
        );
        console2.log("enable 1 v4 session (8 actions), UniActionPolicy only: exec / tx", uniOnly.exec, uniOnly.total);
        console2.log("enable 1 v4 session (8 actions), both policies:       exec / tx", both.exec, both.total);
        console2.log("  MamoruActionPolicy per action (first enable, cold):", (both.exec - uniOnly.exec) / 8);
        console2.log("  calldata bytes Uni only / both:", uniOnly.calldataBytes, both.calldataBytes);

        // Renewal of the same pool at generation 2, new key (warm policy slots: budget/poolConfig/pool info exist)
        Session memory s2 = _session(_v4Actions(btc, safe, _mamInit(btc, 2)), vm.addr(0x5E56), bytes32(uint256(2)));
        Session memory s2u = _session(_v4Actions(btc, safe, ""), vm.addr(0x5E56), bytes32(uint256(2)));
        snap = vm.snapshotState();
        TxGas memory renU = _ownerBatch(safe, _xs(_enableCall(_one(s2u))));
        vm.revertToState(snap);
        TxGas memory renB = _ownerBatch(safe, _xs(_enableCall(_one(s2))));
        console2.log("renewal enable 1 v4 session: Uni only / both (exec)", renU.exec, renB.exec);
        console2.log("  MamoruActionPolicy per action (renewal):", (renB.exec - renU.exec) / 8);
    }

    function test_realStack_gasActivationThreePools() public {
        // A realistic new-account activation: trust + attest + 3 v4 sessions (BTC, ETH, stables), one owner tx.
        safe = _deploySafe();
        Session[] memory s = new Session[](3);
        s[0] = _session(_v4Actions(btc, safe, _mamInit(btc, 1)), vm.addr(0x51), bytes32(uint256(0x51)));
        s[1] = _session(_v4Actions(eth, safe, _mamInit(eth, 1)), vm.addr(0x52), bytes32(uint256(0x52)));
        s[2] = _session(_v4Actions(stable, safe, _mamInit(stable, 1)), vm.addr(0x53), bytes32(uint256(0x53)));
        uint256 snap = vm.snapshotState();
        TxGas memory g = _ownerBatch(safe, _with(_activationTrust(safe), _enableCall(s)));
        console2.log(
            "ACTIVATION v4, 3 pools x 8 actions x 2 policies: exec / tx total / calldata bytes",
            g.exec,
            g.total,
            g.calldataBytes
        );
        console2.log("  vs 2^24 cap, headroom:", BASE_TX_GAS_CAP - g.total);
        assertLt(g.total, BASE_TX_GAS_CAP, "v4 3-pool activation fits one Base tx");
        vm.revertToState(snap);
        Session[] memory su = new Session[](3);
        su[0] = _session(_v4Actions(btc, safe, ""), vm.addr(0x51), bytes32(uint256(0x51)));
        su[1] = _session(_v4Actions(eth, safe, ""), vm.addr(0x52), bytes32(uint256(0x52)));
        su[2] = _session(_v4Actions(stable, safe, ""), vm.addr(0x53), bytes32(uint256(0x53)));
        TxGas memory gu = _ownerBatch(safe, _with(_activationTrust(safe), _enableCall(su)));
        console2.log("  same, UniActionPolicy only: exec / tx total", gu.exec, gu.total);

        // Renewal of the three pools at generation 2 with a new key, revoking the three old sessions, one owner tx.
        vm.revertToState(snap);
        _ownerBatch(safe, _with(_activationTrust(safe), _enableCall(s)));
        Session[] memory n = new Session[](3);
        n[0] = _session(_v4Actions(btc, safe, _mamInit(btc, 2)), vm.addr(0x61), bytes32(uint256(0x61)));
        n[1] = _session(_v4Actions(eth, safe, _mamInit(eth, 2)), vm.addr(0x62), bytes32(uint256(0x62)));
        n[2] = _session(_v4Actions(stable, safe, _mamInit(stable, 2)), vm.addr(0x63), bytes32(uint256(0x63)));
        Execution[] memory ren = _xs(_enableCall(n));
        for (uint256 i; i < 3; i++) {
            ren = _with(
                ren,
                Execution(
                    SMART_SESSION,
                    0,
                    abi.encodeCall(
                        ISmartSessionLite.removeSession, (ISmartSessionLite(SMART_SESSION).getPermissionId(s[i]))
                    )
                )
            );
        }
        TxGas memory gr = _ownerBatch(safe, ren);
        console2.log("RENEWAL v4, 3 pools (enable gen 2 + remove 3): exec / tx total", gr.exec, gr.total);
        console2.log("  calldata bytes:", gr.calldataBytes);
        assertLt(gr.total, BASE_TX_GAS_CAP);
    }

    function test_realStack_gasTodayLayoutWithBothPolicies() public {
        // Today's layout (4 grants x 3 pools = 12 sessions, 42 actions) with UniActionPolicy only, then with both.
        safe = _deploySafe();
        uint256 snap = vm.snapshotState();
        TxGas memory u = _ownerBatch(safe, _with(_activationTrust(safe), _enableCall(_today3(""))));
        console2.log("TODAY layout 12 sessions / 42 actions, Uni only: exec / tx", u.exec, u.total);
        vm.revertToState(snap);
        TxGas memory b = _ownerBatch(safe, _with(_activationTrust(safe), _enableCall(_today3("x"))));
        console2.log("TODAY layout 12 sessions / 42 actions, both:     exec / tx", b.exec, b.total);
        console2.log("  over the 2^24 cap:", b.total > BASE_TX_GAS_CAP);
        console2.log("  calldata bytes Uni only / both:", u.calldataBytes, b.calldataBytes);
    }

    function _today3(bytes memory flag) internal view returns (Session[] memory all) {
        all = new Session[](12);
        Pool[3] memory ps = [btc, eth, stable];
        for (uint256 i; i < 3; i++) {
            bytes memory mam = flag.length == 0 ? bytes("") : _mamInit(ps[i], 1);
            Session[] memory s = _todaySessions(ps[i], safe, mam, 0x1000 + i * 16);
            for (uint256 j; j < 4; j++) {
                all[i * 4 + j] = s[j];
            }
        }
    }

    // ================================================================ 5: multichain ENABLE mode

    function _multichainDigest(ChainDigest[] memory d) internal pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](d.length);
        for (uint256 i; i < d.length; i++) {
            h[i] = keccak256(abi.encode(CHAIN_SESSION_TYPEHASH, d[i].chainId, d[i].sessionDigest));
        }
        bytes32 structHash = keccak256(abi.encode(MULTICHAIN_SESSION_TYPEHASH, keccak256(abi.encodePacked(h))));
        return keccak256(abi.encodePacked("\x19\x01", MULTICHAIN_DOMAIN_SEPARATOR, structHash));
    }

    /// Owner signature for SmartSession's IERC1271(account).isValidSignature: Safe7579 with validator address(0) falls
    /// back to Safe.checkSignatures over the SafeMessage of the hash.
    function _ownerEnableSig(address s, bytes32 hash) internal view returns (bytes memory) {
        bytes32 msgHash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                ISafe141(s).domainSeparator(),
                keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(hash))))
            )
        );
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(ownerPk, msgHash);
        return abi.encodePacked(address(0), r, sig, v);
    }

    function _enableOp(
        address s,
        Session memory sess,
        ChainDigest[] memory d,
        uint8 idx,
        bytes memory ownerSig,
        uint256 pk,
        Execution[] memory xs
    ) internal view returns (PackedUserOperation memory op, uint256 rawLen) {
        op = _draft(s, xs, 8_000_000);
        bytes32 h = IEntryPointV07(EP).getUserOpHash(op);
        bytes memory raw = abi.encode(EnableSession(idx, d, sess, ownerSig), _sessionSig(h, pk));
        rawLen = raw.length;
        op.signature = abi.encodePacked(uint8(1), LibZip.flzCompress(raw));
    }

    function test_realStack_multichainEnableMode() public {
        safe = _deploySafe();
        _ownerBatch(safe, _activationTrust(safe)); // registry trust + self-attest, as before the first activation
        // One envelope: the three Base pools and one Ethereum session, ONE owner signature.
        Session[3] memory s = [
            _session(_v4Actions(btc, safe, _mamInit(btc, 1)), vm.addr(0x71), bytes32(uint256(0x71))),
            _session(_v4Actions(eth, safe, _mamInit(eth, 1)), vm.addr(0x72), bytes32(uint256(0x72))),
            _session(_v4Actions(stable, safe, _mamInit(stable, 1)), vm.addr(0x73), bytes32(uint256(0x73)))
        ];
        ChainDigest[] memory d = new ChainDigest[](4);
        for (uint256 i; i < 3; i++) {
            bytes32 pid = ISmartSessionLite(SMART_SESSION).getPermissionId(s[i]);
            d[i] = ChainDigest(8453, ISmartSessionLite(SMART_SESSION).getSessionDigest(pid, safe, s[i], 1));
        }
        d[3] = ChainDigest(1, keccak256("an Ethereum session digest, checked on Ethereum only"));
        bytes memory ownerSig = _ownerEnableSig(safe, _multichainDigest(d));

        // wrong index (the Ethereum entry) on Base: ChainIdMismatch
        {
            (PackedUserOperation memory bad,) =
                _enableOp(safe, s[0], d, 3, ownerSig, 0x71, _xs(_approve(USDC, ROUTER, 0)));
            OpResult memory rb = _run(bad, "ENABLE with the chain-1 entry on Base");
            require(!rb.included, "must be refused");
            assertEq(rb.reason, abi.encodeWithSelector(ISmartSessionLite.ChainIdMismatch.selector, uint64(1)), "reason");
        }

        Pool[3] memory ps = [btc, eth, stable];
        for (uint256 i; i < 3; i++) {
            lane = uint192(i + 1); // one nonce lane per session, as the operator does
            (PackedUserOperation memory op, uint256 rawLen) =
                _enableOp(safe, s[i], d, uint8(i), ownerSig, 0x71 + i, _xs(_approve(ps[i].token0, ROUTER, 0)));
            OpResult memory r = _run(op, "ENABLE mode (multichain digest, 4 entries) + first op");
            _expectPass(r);
            console2.log("  enable signature bytes: raw abi / flz-compressed", rawLen, op.signature.length);
            assertTrue(
                ISmartSessionLite(SMART_SESSION)
                    .isPermissionEnabled(ISmartSessionLite(SMART_SESSION).getPermissionId(s[i]), safe)
            );
        }
        lane = 0;
    }
}

