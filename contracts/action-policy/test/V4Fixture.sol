// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {
    MamoruActionPolicyV4,
    MamoruV4Helper,
    InitV4,
    SwapParams,
    MintParams,
    ExactInputSingleParams,
    DecreaseLiquidityParams,
    CollectParams,
    IncreaseLiquidityParams
} from "../src/MamoruActionPolicyV4.sol";
import {MamoruRegistry} from "../src/MamoruRegistry.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {ConfigIdV4, PackedUserOperationV4, Session, PolicyData, ActionData} from "../src/SmartSessionTypes.sol";

interface IERC20T {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IRouterT {
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface INPMT {
    function mint(MintParams calldata) external payable returns (uint256, uint128, uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256, uint256);
    function collect(CollectParams calldata) external payable returns (uint256, uint256);
    function burn(uint256) external payable;
    function positions(uint256)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
    function balanceOf(address) external view returns (uint256);
    function tokenOfOwnerByIndex(address, uint256) external view returns (uint256);
    function transferFrom(address, address, uint256) external;
}

interface IEntryPointT {
    function handleOps(PackedUserOperationV4[] calldata ops, address payable beneficiary) external;
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function getUserOpHash(PackedUserOperationV4 calldata op) external view returns (bytes32);

    error FailedOp(uint256 opIndex, string reason);
    error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner);
}

interface ISafeT {
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
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function addOwnerWithThreshold(address owner, uint256 threshold) external;
    function swapOwner(address prevOwner, address oldOwner, address newOwner) external;
}

interface ISmartSessionT {
    function enableSessions(Session[] calldata sessions) external returns (bytes32[] memory);
    function removeSession(bytes32 permissionId) external;
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
    function getPermissionIDs(address account) external view returns (bytes32[] memory);
}

interface IModRegT {
    struct ModuleRecord {
        bytes32 resolverUID;
        address sender;
        bytes metadata;
    }

    struct AttReq {
        address moduleAddress;
        uint48 expirationTime;
        bytes data;
        uint256[] moduleTypes;
    }

    function findModule(address m) external view returns (ModuleRecord memory);
    function deployModule(bytes32 salt, bytes32 resolverUID, bytes calldata initCode, bytes calldata md, bytes calldata rc)
        external
        payable
        returns (address);
    function attest(bytes32 schemaUID, AttReq[] calldata requests) external;
    function trustAttesters(uint8 threshold, address[] calldata attesters) external;
}

/**
 * Spec 010 T4 (otto/mamoru#292): the shared fork fixture of MamoruActionPolicyV4's tests. Anvil semantics on a public
 * archive RPC at a pinned block, never a live chain. The stack is deployed the way T7 will: MamoruRegistry and
 * MamoruGasPolicyV2 through the canonical deterministic deployer (CREATE2, chain-independent init code), then V4 with
 * the same arguments, so the same salts give the same addresses on every fork.
 */
abstract contract V4Fixture is Test {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant TOKEN_MESSENGER = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address constant SAFE_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE7579 = 0x7579EE8307284F293B1927136486880611F20002;
    address constant LAUNCHPAD = 0x7579011aB74c46090561ea277Ba79D510c6C00ff;
    address constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;
    address constant SHARED_SIGNER = 0x94a4F6affBd8975951142c3999aEAB7ecee555c2;
    address constant OWNABLE_VALIDATOR = 0x2483DA3A338895199E5e538530213157e931Bf06;
    address constant MODULE_REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    address constant RHINESTONE_ATTESTER = 0x000000333034E9f539ce08819E12c1b8Cb29084d;
    address constant TIME_FRAME = 0x8177451511dE0577b911C254E9551D981C26dc72;
    bytes32 constant SCHEMA = 0x93d46fcca4ef7d66a413c7bde08bb1ff14bacbd04c4069bb24cd7c21729d7bf1;
    uint256 constant DELAY = 72 hours;

    // Base (packages/registry/base.json)
    uint256 constant BASE_BLOCK = 53_140_000;
    address constant NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant EURC = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42; // a real token V4 does not pin
    address constant POOL_STABLE = 0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1; // USDC/USDT 0.01 %
    address constant POOL_BTC = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef; // USDC/cbBTC 0.05 %
    address constant POOL_ETH = 0x6c561B446416E1A00E8E93E221854d6eA4171372; // WETH/USDC 0.3 %
    address constant POOL_EURC = 0x7279c08A36333e12c3Fc81747963264c100D66fB; // EURC/USDC 0.05 %
    address constant GT_USDCP = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61; // MetaMorpho v1.0
    address constant STEAK_USDC = 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183; // MetaMorpho v1.0
    address constant WA_BAS_USDC = 0xC768c589647798a6EE01A91FdE98EF2ed046DBD6; // Aave static aToken: not admissible

    // Monad (packages/registry/monad.json)
    uint256 constant MONAD_BLOCK = 116_980_000;
    address constant M_USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant M_WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant M_POOL = 0x659bD0BC4167BA25c62E05656F78043E7eD4a9da; // WMON/USDC 0.3 %
    address constant M_ROUTER = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
    address constant M_NPM = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;

    uint32 constant DOMAIN_BASE = 6;
    uint32 constant DOMAIN_MONAD = 15;

    MamoruRegistry reg;
    MamoruGasPolicyV2 gasPol;
    MamoruActionPolicyV4 v4;
    MamoruV4Helper helper;
    address admin = makeAddr("team safe 2-of-2");
    address guardian = makeAddr("guardian watchdog");
    address acct = makeAddr("account");
    address attacker = makeAddr("attacker");
    ConfigIdV4 constant ID = ConfigIdV4.wrap(bytes32(uint256(0xC0)));
    uint128 constant C = 10_000e6; // the owner-signed cap

    // ------------------------------------------------------------ deployment (T7 shape)

    function _forkBase() internal {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), BASE_BLOCK);
        _deployStack();
    }

    function _forkMonad() internal {
        vm.createSelectFork(vm.envOr("MONAD_FORK_RPC_URL", string("https://rpc.monad.xyz")), MONAD_BLOCK);
        _deployStack();
    }

    function _create2(bytes memory initCode, bytes32 salt) internal returns (address a) {
        a = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        if (a.code.length != 0) return a;
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && a.code.length != 0, "create2");
    }

    function _deployStack() internal {
        reg = MamoruRegistry(
            _create2(abi.encodePacked(type(MamoruRegistry).creationCode, abi.encode(admin, guardian, DELAY)), "mamoru.registry")
        );
        gasPol = MamoruGasPolicyV2(_create2(abi.encodePacked(type(MamoruGasPolicyV2).creationCode, abi.encode(guardian)), "mamoru.gas.v2"));
        v4 = MamoruActionPolicyV4(
            _create2(
                abi.encodePacked(type(MamoruActionPolicyV4).creationCode, abi.encode(address(reg), address(gasPol), guardian)),
                "mamoru.v4"
            )
        );
        helper = v4.HELPER();
    }

    // ------------------------------------------------------------ registry (admin, through the delay)

    function _execAfterDelay(MamoruRegistry.Kind k, bytes32 key, bytes memory params) internal {
        uint256 n = reg.nonce();
        vm.prank(admin);
        reg.queue(k, key, params);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.roll(vm.getBlockNumber() + DELAY / 2);
        vm.prank(admin);
        reg.execute(k, key, params, n);
    }

    function _listPool(address pool, uint24 band, int24 anchorTick, uint24 anchorBand, uint16 ratio) internal {
        _execAfterDelay(
            MamoruRegistry.Kind.Pool,
            bytes32(uint256(uint160(pool))),
            abi.encode(uint32(1800), uint32(300), band, anchorTick, anchorBand, ratio)
        );
    }

    function _listVault(address vault, uint16 ratio) internal {
        _execAfterDelay(MamoruRegistry.Kind.Vault, bytes32(uint256(uint160(vault))), abi.encode(ratio));
    }

    function _route(uint32 domain) internal {
        _execAfterDelay(MamoruRegistry.Kind.Route, bytes32(uint256(domain)), abi.encode(true));
    }

    /// The production lists on Base: stables (band 10, parity anchor 40), BTC and ETH (band 100), V6's ratios.
    function _listBase() internal {
        _listPool(POOL_STABLE, 10, 0, 40, 5_000);
        _listPool(POOL_BTC, 100, 0, 0, 3_500);
        _listPool(POOL_ETH, 100, 0, 0, 1_500);
    }

    // ------------------------------------------------------------ the account

    function _init(address account, ConfigIdV4 id, uint128 cap, uint64 gen, uint256[] memory admit) internal {
        vm.prank(SMART_SESSION);
        v4.initializeWithMultiplexer(account, id, abi.encode(InitV4(cap, gen, address(0), 0, admit)));
    }

    function _init(address account) internal {
        _init(account, ID, C, 1, new uint256[](0));
    }

    function _check(address account, address target, bytes memory data) internal returns (uint256 r) {
        vm.prank(SMART_SESSION);
        r = v4.checkAction(ID, account, target, 0, data);
    }

    function _approveV4(address account, address token, uint256 amount) internal {
        vm.prank(account);
        IERC20T(token).approve(address(v4), amount);
    }

    function _swapParams(address pool, address tokenIn, uint256 amountIn) internal view returns (SwapParams memory s) {
        (uint256 minOut, uint160 limit) = helper.swapBounds(pool, tokenIn, amountIn);
        s = SwapParams(pool, tokenIn, amountIn, minOut, limit, vm.getBlockTimestamp());
    }

    /// The account swaps through V4 (approve V4, V4.swap), as a session batch does.
    function _swap(address account, address pool, address tokenIn, uint256 amountIn) internal returns (uint256 out) {
        SwapParams memory s = _swapParams(pool, tokenIn, amountIn);
        _approveV4(account, tokenIn, amountIn);
        vm.prank(account);
        out = v4.swap(s);
    }

    function _swapCall(address pool, address tokenIn, uint256 amountIn) internal view returns (bytes memory) {
        return abi.encodeCall(MamoruActionPolicyV4.swap, (_swapParams(pool, tokenIn, amountIn)));
    }

    // ------------------------------------------------------------ market

    function _spot(address pool) internal view returns (int24 t) {
        (, t,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    function _routerOf() internal view returns (address) {
        return block.chainid == 143 ? M_ROUTER : ROUTER;
    }

    /// The attacker moves `pool` by `ticks` with its own capital (positive: price of token0 in token1 up).
    function _push(address pool, address tokenIn, address tokenOut, uint24 fee, int24 ticks)
        internal
        returns (uint256 spent, uint256 got)
    {
        int24 target = _spot(pool) + ticks;
        deal(tokenIn, attacker, 1e30);
        vm.startPrank(attacker);
        IERC20T(tokenIn).approve(_routerOf(), type(uint256).max);
        uint256 before = IERC20T(tokenIn).balanceOf(attacker);
        uint256 o0 = IERC20T(tokenOut).balanceOf(attacker);
        IRouterT(_routerOf()).exactInputSingle(
            ExactInputSingleParams(tokenIn, tokenOut, fee, attacker, 1e29, 0, TickMath.getSqrtRatioAtTick(target))
        );
        spent = before - IERC20T(tokenIn).balanceOf(attacker);
        got = IERC20T(tokenOut).balanceOf(attacker) - o0;
        vm.stopPrank();
    }

    function _nextBlock(uint256 secs) internal {
        vm.roll(vm.getBlockNumber() + secs / 2 + 1);
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    /// A USDC/cbBTC position minted straight at the manager, +-600 ticks around the spot.
    function _mintDirect(address owner, uint256 usdc, uint256 btc) internal returns (uint256 id, uint128 liq) {
        int24 s = _spot(POOL_BTC);
        MintParams memory m = MintParams(
            USDC, CBBTC, 500, ((s - 600) / 10) * 10, ((s + 600) / 10) * 10, usdc, btc, 0, 0, owner, vm.getBlockTimestamp()
        );
        deal(USDC, owner, IERC20T(USDC).balanceOf(owner) + usdc);
        deal(CBBTC, owner, IERC20T(CBBTC).balanceOf(owner) + btc);
        vm.startPrank(owner);
        IERC20T(USDC).approve(NPM, usdc);
        IERC20T(CBBTC).approve(NPM, btc);
        (id, liq,,) = INPMT(NPM).mint(m);
        vm.stopPrank();
    }

    function _mintParams(address owner, uint256 usdc, uint256 btc) internal view returns (MintParams memory) {
        int24 s = _spot(POOL_BTC);
        return MintParams(
            USDC, CBBTC, 500, ((s - 600) / 10) * 10, ((s + 600) / 10) * 10, usdc, btc, 0, 0, owner, vm.getBlockTimestamp()
        );
    }

    function _mintThroughV4(address owner, uint256 usdc, uint256 btc) internal returns (uint256 tokenId, uint128 liq) {
        MintParams memory m = _mintParams(owner, usdc, btc); // before the prank: it reads the pool
        _approveV4(owner, USDC, usdc);
        _approveV4(owner, CBBTC, btc);
        vm.prank(owner);
        (tokenId, liq,,) = v4.mint(m);
    }

    // ------------------------------------------------------------ real Safes and userOps (production flow)

    uint256 ownerKey = uint256(keccak256("mamoru.v4.owner"));
    uint256 sessionKey = uint256(keccak256("mamoru.v4.session"));
    address bundler = makeAddr("bundler");

    /// A Safe 1.4.1 like Mamoru's: the passkey (shared signer) and an EOA owner, threshold 1, Safe7579 with
    /// SmartSession installed empty and the Rhinestone attester (packages/account/safe `setupDelegate`).
    function _newSafe(uint256 saltNonce) internal returns (address safe) {
        ModuleInitT[] memory validators = new ModuleInitT[](1);
        validators[0] = ModuleInitT(SMART_SESSION, "");
        ModuleInitT[] memory none = new ModuleInitT[](0);
        address[] memory attesters = new address[](1);
        attesters[0] = RHINESTONE_ATTESTER;
        bytes memory launch = abi.encodeWithSignature(
            "addSafe7579(address,(address,bytes)[],(address,bytes)[],(address,bytes)[],(address,bytes)[],address[],uint8)",
            SAFE7579, validators, none, none, none, attesters, uint8(1)
        );
        bytes memory cfg = abi.encodeWithSignature(
            "configure((uint256,uint256,uint176))", uint256(0x1234), uint256(0x5678), uint176(uint256(0x100) << 160)
        );
        bytes memory packed = abi.encodePacked(
            abi.encodePacked(uint8(1), LAUNCHPAD, uint256(0), launch.length, launch),
            abi.encodePacked(uint8(1), SHARED_SIGNER, uint256(0), cfg.length, cfg)
        );
        address[] memory owners = new address[](2);
        (owners[0], owners[1]) = (SHARED_SIGNER, vm.addr(ownerKey));
        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners, uint256(1), MULTISEND, abi.encodeWithSignature("multiSend(bytes)", packed), SAFE7579, address(0), 0, address(0)
        );
        (bool ok, bytes memory r) = SAFE_FACTORY.call(
            abi.encodeWithSignature("createProxyWithNonce(address,bytes,uint256)", SAFE_SINGLETON, initializer, saltNonce)
        );
        require(ok, "safe deploy");
        safe = abi.decode(r, (address));
        vm.deal(safe, 1 ether);
    }

    struct ModuleInitT {
        address module;
        bytes initData;
    }

    function _ownerTx(address safe, address to, bytes memory data, uint8 op) internal returns (bool ok) {
        address o = vm.addr(ownerKey);
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(o))), bytes32(0), uint8(1)); // pre-validated (msg.sender)
        vm.prank(o);
        ok = ISafeT(safe).execTransaction(to, 0, data, op, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    function _ownerTxGas(address safe, address to, bytes memory data, uint8 op) internal returns (uint256) {
        _ownerTx(safe, to, data, op);
        return vm.lastCallGas().gasTotalUsed;
    }

    function _ms(uint8 op, address to, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(op, to, uint256(0), data.length, data);
    }

    function _multiSend(bytes memory packed) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("multiSend(bytes)", packed);
    }

    /// The production enable flow's first step (T1): trust the Rhinestone attester and the Safe itself, self-attest.
    function _trustAndAttest(address safe, address[] memory modules) internal pure returns (bytes memory) {
        address[] memory att = new address[](2);
        (att[0], att[1]) = uint160(RHINESTONE_ATTESTER) < uint160(safe) ? (RHINESTONE_ATTESTER, safe) : (safe, RHINESTONE_ATTESTER);
        IModRegT.AttReq[] memory reqs = new IModRegT.AttReq[](modules.length);
        for (uint256 i; i < modules.length; i++) {
            reqs[i] = IModRegT.AttReq(modules[i], 0, "", new uint256[](0));
        }
        return abi.encodePacked(
            _ms(0, MODULE_REGISTRY, abi.encodeCall(IModRegT.trustAttesters, (1, att))),
            _ms(0, MODULE_REGISTRY, abi.encodeCall(IModRegT.attest, (SCHEMA, reqs)))
        );
    }

    /// The account's one V4 session: a fallback action whose only policy is V4, MamoruGasPolicyV2 as the only userOp
    /// policy (spec 010 "One session per account and chain").
    function _v4Session(uint128 cap, uint64 gen, uint256[] memory admit, MamoruGasPolicyV2.Caps memory caps, bytes32 salt)
        internal
        view
        returns (Session memory s)
    {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(sessionKey);
        s.sessionValidator = OWNABLE_VALIDATOR;
        s.sessionValidatorInitData = abi.encode(uint256(1), signers);
        s.salt = salt;
        s.userOpPolicies = new PolicyData[](1);
        s.userOpPolicies[0] = PolicyData(address(gasPol), abi.encode(caps));
        s.actions = new ActionData[](1);
        s.actions[0].actionTarget = address(1);
        s.actions[0].actionTargetSelector = 0x00000001;
        s.actions[0].actionPolicies = new PolicyData[](1);
        s.actions[0].actionPolicies[0] = PolicyData(address(v4), abi.encode(InitV4(cap, gen, address(0), 0, admit)));
    }

    function _baseCaps() internal pure returns (MamoruGasPolicyV2.Caps memory) {
        return MamoruGasPolicyV2.Caps(10_000_000, 3_000_000, 2_000_000, 200_000, 100_000_000, 0, 0.002 ether, 1 days);
    }

    function _pid(Session memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(s.sessionValidator, s.sessionValidatorInitData, s.salt));
    }

    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    function _single(address target, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("execute(bytes32,bytes)", bytes32(0), abi.encodePacked(target, uint256(0), data));
    }

    function _batch(Execution[] memory xs) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("execute(bytes32,bytes)", bytes32(uint256(1) << 248), abi.encode(xs));
    }

    /// Gas fields of the userOps the tests send: verification 3M, call 2M, preVerification 100k, 0.05 gwei max fee.
    uint256 opVerification = 3_000_000;
    uint256 opCall = 2_000_000;
    uint256 opPre = 100_000;
    uint256 opMaxFee = 50_000_000;

    function _op(address safe, bytes memory callData, bytes32 pid) internal view returns (PackedUserOperationV4 memory op) {
        uint192 nonceKey = uint192(uint256(uint160(SMART_SESSION)) << 32);
        op.sender = safe;
        op.nonce = IEntryPointT(ENTRY_POINT).getNonce(safe, nonceKey);
        op.callData = callData;
        op.accountGasLimits = bytes32((opVerification << 128) | opCall);
        op.preVerificationGas = opPre;
        op.gasFees = bytes32((uint256(1_000_000) << 128) | opMaxFee);
        bytes32 h = IEntryPointT(ENTRY_POINT).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        op.signature = abi.encodePacked(bytes1(0x00), pid, r, s, v);
    }

    bytes32 constant USER_OP_EVENT = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");

    /// Runs one userOp; returns whether its execution succeeded and the handleOps gas.
    function _runOp(address safe, bytes memory callData, bytes32 pid) internal returns (bool success, uint256 gasUsed) {
        PackedUserOperationV4[] memory ops = new PackedUserOperationV4[](1);
        ops[0] = _op(safe, callData, pid);
        vm.recordLogs();
        vm.prank(bundler, bundler);
        uint256 g = gasleft();
        IEntryPointT(ENTRY_POINT).handleOps(ops, payable(bundler));
        gasUsed = g - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _watch(logs);
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == USER_OP_EVENT && logs[i].emitter == ENTRY_POINT) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                return (success, gasUsed);
            }
        }
        revert("no UserOperationEvent");
    }

    /// A 32-byte word to look for in the data of `watchEmitter`'s logs during the next `_runOp`.
    address watchEmitter;
    bytes32 watchWord;
    bool watchSeen;

    function _watch(Vm.Log[] memory logs) internal {
        if (watchEmitter == address(0)) return;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != watchEmitter) continue;
            bytes memory d = logs[i].data;
            for (uint256 o; o + 32 <= d.length; o += 32) {
                bytes32 x;
                assembly {
                    x := mload(add(add(d, 32), o))
                }
                if (x == watchWord) watchSeen = true;
            }
        }
    }

    function _run(address safe, bytes memory callData, bytes32 pid) internal returns (uint256 gasUsed) {
        bool ok;
        (ok, gasUsed) = _runOp(safe, callData, pid);
        assertTrue(ok, "userOp execution failed");
    }

    /// The EntryPoint must refuse the op at validation: nothing executes.
    function _rejected(address safe, bytes memory callData, bytes32 pid) internal returns (string memory reason) {
        PackedUserOperationV4[] memory ops = new PackedUserOperationV4[](1);
        ops[0] = _op(safe, callData, pid);
        vm.prank(bundler, bundler);
        (bool ok, bytes memory err) = ENTRY_POINT.call(abi.encodeCall(IEntryPointT.handleOps, (ops, payable(bundler))));
        assertFalse(ok, "op must be rejected at validation");
        bytes4 sel = bytes4(err);
        assertTrue(sel == IEntryPointT.FailedOp.selector || sel == IEntryPointT.FailedOpWithRevert.selector, "rejected at validation");
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; i++) {
            body[i] = err[i + 4];
        }
        (, reason) = abi.decode(body, (uint256, string));
    }

    /// Enables the V4 session on `safe` by an owner Safe tx (trust + self-attest V4 and the gas policy, enable). Returns
    /// the permission id and the gas of the enable tx alone.
    function _enableV4(address safe, Session memory s) internal returns (bytes32 pid, uint256 enableGas) {
        address[] memory mods = new address[](2);
        (mods[0], mods[1]) = (address(v4), address(gasPol));
        assertTrue(_ownerTx(safe, MULTISEND, _multiSend(_trustAndAttest(safe, mods)), 1), "trust + attest");
        Session[] memory ss = new Session[](1);
        ss[0] = s;
        enableGas = _ownerTxGas(safe, SMART_SESSION, abi.encodeCall(ISmartSessionT.enableSessions, (ss)), 0);
        pid = _pid(s);
        assertTrue(ISmartSessionT(SMART_SESSION).isPermissionEnabled(pid, safe), "V4 session enabled");
    }

    /// The stack deployed through ModuleRegistry.deployModule (CREATE2 from the module registry), so V4 and the gas
    /// policy have module records and a Safe can self-attest them for the production enable flow (T7's path on the
    /// home chain). Single-chain tests only; the cross-chain tests use the deterministic deployer (`_deployStack`).
    function _deployStackViaModuleRegistry() internal {
        bytes32 resolverUID = IModRegT(MODULE_REGISTRY).findModule(TIME_FRAME).resolverUID;
        vm.startPrank(makeAddr("deployer"));
        reg = MamoruRegistry(
            IModRegT(MODULE_REGISTRY).deployModule(
                bytes32(uint256(1)), resolverUID, abi.encodePacked(type(MamoruRegistry).creationCode, abi.encode(admin, guardian, DELAY)), "", ""
            )
        );
        gasPol = MamoruGasPolicyV2(
            IModRegT(MODULE_REGISTRY).deployModule(
                bytes32(uint256(2)), resolverUID, abi.encodePacked(type(MamoruGasPolicyV2).creationCode, abi.encode(guardian)), "", ""
            )
        );
        v4 = MamoruActionPolicyV4(
            IModRegT(MODULE_REGISTRY).deployModule(
                bytes32(uint256(3)),
                resolverUID,
                abi.encodePacked(type(MamoruActionPolicyV4).creationCode, abi.encode(address(reg), address(gasPol), guardian)),
                "",
                ""
            )
        );
        vm.stopPrank();
        helper = v4.HELPER();
    }
}
