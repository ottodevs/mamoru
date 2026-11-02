// SPDX-License-Identifier: GPL-2.0-or-later
// GPL because it links Uniswap's TickMath, OracleLibrary and LiquidityAmounts (GPL-2.0-or-later). See spec 007, open questions.
pragma solidity ^0.8.28;

import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {OracleLibrary} from "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import {ConfigIdV4, PolicyData, ERC7739Data, ActionData, Session} from "./SmartSessionTypes.sol";
import {MamoruV4Chains} from "./MamoruV4Chains.sol";
import {MamoruV4Classes} from "./MamoruV4Classes.sol";
import {IMamoruV4Table} from "./MamoruV4Table.sol";
import {MamoruRemoteSafe, MamoruRemoteInit, ISharedSignerV4} from "./MamoruRemoteSafe.sol";
import {MamoruGasPolicyV2} from "./MamoruGasPolicyV2.sol";

// ---------------------------------------------------------------- shared types (ABI-identical to V3's where named alike)

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

/// SwapRouter02 IV3SwapRouter.ExactInputSingleParams (no deadline field).
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}

struct DecreaseLiquidityParams {
    uint256 tokenId;
    uint128 liquidity;
    uint256 amount0Min;
    uint256 amount1Min;
    uint256 deadline;
}

struct CollectParams {
    uint256 tokenId;
    address recipient;
    uint128 amount0Max;
    uint128 amount1Max;
}

struct IncreaseLiquidityParams {
    uint256 tokenId;
    uint256 amount0Desired;
    uint256 amount1Desired;
    uint256 amount0Min;
    uint256 amount1Min;
    uint256 deadline;
}

/// V4.swap's argument: SwapRouter02's exactInputSingle without the fields V4 fixes (tokenOut and fee follow from the
/// pool, the recipient is the account), plus the engine's deadline (V3's empty `multicall(deadline, [])`, #140).
struct SwapParams {
    address pool;
    address tokenIn;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
    uint256 deadline;
}

/// Owner-signed init data of the account's one V4 session (spec 010 "Init (owner-signed, account-wide)").
struct InitV4 {
    uint128 capUsd; // C: the account's value bucket on this chain, USD units (6 decimals, the pinned stables' unit)
    uint64 generation; // approval number; a higher one retires every lower binding of the account (V3)
    address home; // address(0) on the home chain; on a remote Safe, the home account (bridge-back target, I4); on a
    // sibling (#307: the account's own address on another chain of the table), the account itself
    uint32 homeDomain; // CCTP domain of `home` when home != address(0) (0 is Ethereum's); 0 when home == address(0)
    uint256[] admit; // positions admitted at enable (migration), V3 T6 M-4; REVOKE_FLAG entries revoke
}

/// A pool's identity, cached by V4 once checked (immutable once the pool exists).
struct PoolInfoV4 {
    address token0;
    address token1;
    uint24 fee;
    bool in1; // budget unit: false = token0 (a pinned stable), true = token1
    bool stablePair; // both pinned stables: the class carries the parity anchor
}

/// A pool class's price parameters (MamoruV4Classes.Class), in the shape V3's price checks take.
struct PoolEntryV4 {
    uint32 twapWindow;
    uint32 twapShortWindow;
    uint24 bandTicks;
    int24 anchorTick;
    uint24 anchorBand;
    uint16 ratioBps;
    bool active;
}

interface IERC20V4 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface INPMV4 {
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function positions(uint256 tokenId)
        external
        view
        returns (uint96, address, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128, uint256, uint256, uint128, uint128);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IRouterV4 {
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IERC4626V4 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function previewMint(uint256 shares) external view returns (uint256 assets);
    function balanceOf(address owner) external view returns (uint256);
}

interface ITokenMessengerV2V4 {
    function localMinter() external view returns (address);
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

interface ITokenMinterV4 {
    function burnLimitsPerMessage(address token) external view returns (uint256);
}

/// CCTP V2 MessageTransmitterV2: the canonical proxy, the same address (and code hash) on every chain Circle supports.
interface IMessageTransmitterV2V4 {
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external;
}

/// The reads of MamoruActionPolicyV4 that MamoruV4Lens makes.
interface IPolicyV4 {
    function admittedPool(address account, uint256 tokenId) external view returns (address);
    function remoteOf(address account, uint32 domain) external view returns (address, uint96, bytes32, address);
}

interface ISafeOwnersV4 {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isModuleEnabled(address module) external view returns (bool);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

interface ISmartSessionV4 {
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
}

interface IERC7579AccountV4 {
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext)
        external
        view
        returns (bool);
}

/**
 * @title MamoruV4Helper (spec 010, otto/mamoru#292): the views of MamoruActionPolicyV4 that would put it over EIP-170.
 * @notice Created by V4's constructor (CREATE from V4's address), so its address and code follow from V4's own
 * init code, the same on every chain. No owner, no state but immutables set from V4's constructor (themselves
 * chain-independent). Views only:
 *  - V3's price checks (oracle range, anchor, spot, swap bounds, mint/increase minimums, decrease minimums), moved
 *    here unchanged from MamoruActionPolicyV3, which V4 runs at execution of its own actions.
 *  - `depthIn`: V3's LeftClaw M-5 tick walk, run at EVERY priced use (I2), with a step cap.
 *  - `priced`: spec 010 A1's eligibility rules for an entry (factory, pinned tokens, class and fee set, agreement with
 *    the pair's reference pool), from MamoruV4Classes; no registry, no list anyone edits.
 *  - `ownerState`: the account's CURRENT owners, threshold and passkey (I4, r2 P0).
 *  - `remote`: the canonical remote Safe of an account on a domain, its owners hash and the relayer's factory call (I4).
 *  - `readBack`: what `announceReady` reads of a Safe on its own chain (I4, A1: what the guardian used to read).
 */
contract MamoruV4Helper {
    // The engine's views over these checks (priceRange, swapBounds, decreaseMins, remoteDeployment) are in
    // MamoruV4Lens, for EIP-170.
    /// I2: a cap on the walk per direction. What it returns is then the depth over the ticks walked, a LOWER bound of
    /// the depth over the whole band (the sum only grows along the walk), so a capped walk can only refuse more.
    uint256 public constant MAX_DEPTH_STEPS = 64;
    /// I2 (r3 P1): the pool's in-band depth must cover this many times the value of the call, at every priced use.
    uint256 public constant DEPTH_MULTIPLE = 20;
    /// The remote session's salt (one per account, as SmartSession derives the permission id per account).
    bytes32 public constant REMOTE_SESSION_SALT = keccak256("mamoru.v4.remote-session");
    address public constant OWNABLE_VALIDATOR = 0x2483DA3A338895199E5e538530213157e931Bf06;
    address public constant FALLBACK_TARGET = address(1); // SmartSession FALLBACK_TARGET_FLAG
    bytes4 public constant FALLBACK_SELECTOR = 0x00000001; // SmartSession FALLBACK_TARGET_SELECTOR_FLAG

    address public immutable POLICY;
    address public immutable GAS_POLICY;
    address public immutable REMOTE_INIT;
    /// The per-chain table (MamoruV4Table), V4's.
    IMamoruV4Table public immutable TABLE;

    error UnknownDomain(uint32 domain);

    constructor(address gasPolicy, address remoteInit, IMamoruV4Table table) {
        POLICY = msg.sender;
        GAS_POLICY = gasPolicy;
        REMOTE_INIT = remoteInit;
        TABLE = table;
    }

    // ---------------------------------------------------------------- I2: depth

    /// LeftClaw M-5 (V3 `_depthIn`): the smaller, in the budget unit, of what moving `pool`'s price `band` ticks takes
    /// in either direction. The other token's depth is valued at the band edge that values it lowest.
    function depthIn(address pool, address token0, address token1, uint24 band, bool in1)
        public
        view
        returns (uint256)
    {
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 up = _depth(pool, band, true); // token1 sold
        uint256 down = _depth(pool, band, false); // token0 sold
        if (in1) {
            down = OracleLibrary.getQuoteAtTick(_clamp(int256(tick) - int256(uint256(band))), _u128(down), token0, token1);
        } else {
            up = OracleLibrary.getQuoteAtTick(_clamp(int256(tick) + int256(uint256(band))), _u128(up), token1, token0);
        }
        return up < down ? up : down;
    }

    /// V3 `_depth`, unchanged but for the step cap: walks every tick boundary between the spot and spot +- band,
    /// applying each one's liquidityNet as the pool's own swap would.
    function _depth(address pool, uint24 band, bool up) internal view returns (uint256 d) {
        IUniswapV3Pool v = IUniswapV3Pool(pool);
        (uint160 sp, int24 tick,,,,,) = v.slot0();
        int256 liq = int256(uint256(v.liquidity()));
        int24 spacing = v.tickSpacing();
        int24 end = _clamp(up ? int256(tick) + int256(uint256(band)) : int256(tick) - int256(uint256(band)));
        int24 b = tick / spacing * spacing; // the boundary at or below the spot
        if (tick < 0 && tick % spacing != 0) b -= spacing;
        if (up) b += spacing;
        for (uint256 steps;; steps++) {
            bool last = up ? b >= end : b <= end;
            uint160 sb = TickMath.getSqrtRatioAtTick(last ? end : b);
            uint128 l = liq > 0 ? uint128(uint256(liq)) : 0;
            d += up ? LiquidityAmounts.getAmount1ForLiquidity(sp, sb, l) : LiquidityAmounts.getAmount0ForLiquidity(sb, sp, l);
            if (last || steps + 1 >= MAX_DEPTH_STEPS) return d;
            (, int128 net,,,,,,) = v.ticks(b);
            liq = up ? liq + net : liq - net;
            sp = sb;
            b = up ? b + spacing : b - spacing;
        }
    }

    // ---------------------------------------------------------------- pinned identities (spec 010 "Pinned in V4")

    address public constant TOKEN_MESSENGER = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address public constant MESSAGE_TRANSMITTER = 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64;
    address public constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    // The Safe stack (spec 010 "Pinned in V4"): same address and runtime code hash on Base and Monad (base.json,
    // monad.json, read again at the fork blocks). Checked at every enable on the local chain.
    address internal constant SAFE7579_LAUNCHPAD = 0x7579011aB74c46090561ea277Ba79D510c6C00ff;
    bytes32 internal constant H_SAFE_SINGLETON = 0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff;
    bytes32 internal constant H_SAFE_FACTORY = 0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    bytes32 internal constant H_MULTISEND = 0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77;
    bytes32 internal constant H_SAFE7579 = 0xe03f1efc4aa74c91a87731397278a9c32d81f593263931fc94ff867aa09b83ac;
    bytes32 internal constant H_LAUNCHPAD = 0xe15c7413325ecf9e9fe60a315a0c9b49ad3003f3e6c254b9fa841dff8a8a32a5;
    bytes32 internal constant H_SHARED_SIGNER = 0xeaa32d0280053e2feea48a7c3fa15a535cd07c23ff60c9469cfa1999533e9332;
    bytes32 internal constant H_SMART_SESSION = 0xf2817b8943b9fc813ad3602de2f0b973dc6b7e190f1b77dc9eb02b8d3022ab0c;
    bytes32 internal constant H_OWNABLE_VALIDATOR = 0xd9ad90a204447aec1a1528d764e1d80212c8011dc0125b3995875e58ec9a43bf;
    // TokenMessengerV2 and MessageTransmitterV2 are both Circle's AdminUpgradableProxy: the same runtime code hash.
    bytes32 internal constant H_TOKEN_MESSENGER = 0xd2c8d48075d832fb7d07f6db5545a1bee37fdf886325c441a8dd1cef4c9dae99;
    /// SafeProxy 1.4.1's runtime code (SafeProxyFactory 1.4.1), the same for every Safe it deploys.
    bytes32 internal constant H_SAFE_PROXY = 0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c;

    error BadStack(uint256 which);
    error NotPinned(address token);
    error NotAFactoryPool(address pool);
    error BadVault(address vault);
    error NotAdmissible(uint256 tokenId);
    error NotEligible(address pool, uint256 rule);
    error NotASafe(address safe, uint256 check);

    /// The stack V4 trusts has the expected code on this chain. V4 runs it at every enable.
    function checkStack() external view {
        if (MamoruRemoteSafe.SAFE_SINGLETON.codehash != H_SAFE_SINGLETON) revert BadStack(1);
        if (MamoruRemoteSafe.SAFE_FACTORY.codehash != H_SAFE_FACTORY) revert BadStack(2);
        if (MamoruRemoteSafe.MULTISEND.codehash != H_MULTISEND) revert BadStack(3);
        if (MamoruRemoteSafe.SAFE7579.codehash != H_SAFE7579) revert BadStack(4);
        if (SAFE7579_LAUNCHPAD.codehash != H_LAUNCHPAD) revert BadStack(5);
        if (MamoruRemoteSafe.SHARED_SIGNER.codehash != H_SHARED_SIGNER) revert BadStack(6);
        if (SMART_SESSION.codehash != H_SMART_SESSION) revert BadStack(7);
        if (OWNABLE_VALIDATOR.codehash != H_OWNABLE_VALIDATOR) revert BadStack(8);
        if (TOKEN_MESSENGER.codehash != H_TOKEN_MESSENGER) revert BadStack(9);
        if (MESSAGE_TRANSMITTER.codehash != H_TOKEN_MESSENGER) revert BadStack(10);
    }

    /// A pool's identity, if V4 may price it at all: a factory pool of the chain's table whose two tokens are pinned,
    /// at least one a pinned stable (the budget unit; r2 P1: tokens are V4's, never the registry's).
    function poolInfo(address pool) external view returns (PoolInfoV4 memory p) {
        MamoruV4Chains.Chain memory ch = TABLE.chain(block.chainid);
        if (pool.code.length == 0) revert NotAFactoryPool(pool);
        IUniswapV3Pool v = IUniswapV3Pool(pool);
        (p.token0, p.token1, p.fee) = (v.token0(), v.token1(), v.fee());
        if (IUniswapV3Factory(ch.factory).getPool(p.token0, p.token1, p.fee) != pool) revert NotAFactoryPool(pool);
        bool s0 = MamoruV4Chains.isStable(ch, p.token0);
        bool s1 = MamoruV4Chains.isStable(ch, p.token1);
        if (!MamoruV4Chains.isPinned(ch, p.token0)) revert NotPinned(p.token0);
        if (!MamoruV4Chains.isPinned(ch, p.token1)) revert NotPinned(p.token1);
        if (!s0 && !s1) revert NotPinned(address(0)); // one side must be a pinned stable: the budget unit
        p.in1 = !s0;
        p.stablePair = s0 && s1;
    }

    /// Spec 010 A1 "Vaults": only the exact vault addresses of the chain's table (MamoruV4Classes), each with a
    /// pinned stable as `asset()` and its ratio. A factory check alone is not enough without an admin to vet a vault.
    /// The ONE place V4 decides whether a vault may be used (deposit through `vaultExposure`, redeem directly): the
    /// vault eligibility model (exact list today; rules or an automatic exit are under study) changes here only.
    function vaultEntry(address vault) public view returns (address asset, uint16 ratioBps) {
        MamoruV4Classes.Vault memory v = TABLE.vaultOf(block.chainid, vault);
        if (v.asset == address(0) || IERC4626V4(vault).asset() != v.asset) revert BadVault(vault);
        return (v.asset, v.ratioBps);
    }

    /// Review r1 of #200 (P1): what `account` holds in `vault` now, by the vault's own accounting, rounded UP (against
    /// the depositor): `previewMint` of its shares is the assets the vault would ask to mint them. V4 caps it, plus the
    /// new deposit, at the vault's ratio of C, so the funds at risk in one vault never pass ratio x C.
    function vaultExposure(address vault, address account)
        external
        view
        returns (address asset, uint16 ratioBps, uint256 held)
    {
        (asset, ratioBps) = vaultEntry(vault);
        uint256 shares = IERC4626V4(vault).balanceOf(account);
        if (shares != 0) held = IERC4626V4(vault).previewMint(shares);
    }

    /// T6 M-4: the pool of a position `account` owns, when it is a factory pool of pinned tokens with a class (V4
    /// admits it; its class prices every later exit, whatever the pool's eligibility then).
    function admissiblePool(address account, uint256 tokenId) external view returns (address pool) {
        MamoruV4Chains.Chain memory ch = TABLE.chain(block.chainid);
        if (INPMV4(ch.npm).ownerOf(tokenId) != account) revert NotAdmissible(tokenId);
        (,, address t0, address t1, uint24 fee,,,,,,,) = INPMV4(ch.npm).positions(tokenId);
        pool = IUniswapV3Factory(ch.factory).getPool(t0, t1, fee);
        if (
            pool == address(0) || !MamoruV4Chains.isPinned(ch, t0) || !MamoruV4Chains.isPinned(ch, t1)
                || TABLE.classOf(block.chainid, t0, t1).ref == address(0)
        ) revert NotAdmissible(tokenId);
    }

    // ---------------------------------------------------------------- spec 010 A1: eligibility by rule

    /// The class of a pool's pair as V3's price checks take it (anchor at parity for a stable pair), its sub-bucket
    /// key, reference pool and fee set. Reverts when the pair has no class.
    function classEntry(address token0, address token1)
        public
        view
        returns (PoolEntryV4 memory e, address key, address ref, uint8 feeMask)
    {
        MamoruV4Classes.Class memory c = TABLE.classOf(block.chainid, token0, token1);
        if (c.ref == address(0)) revert NotEligible(address(0), 2);
        e = PoolEntryV4(c.twapWindow, c.twapShortWindow, c.bandTicks, 0, c.anchorBand, c.ratioBps, true);
        return (e, c.key, c.ref, c.feeMask);
    }

    /**
     * Spec 010 A1 "Eligibility rules" for an ENTRY (swap, mint, increase): (1) a pool of the chain's pinned factory,
     * (2) both tokens pinned with a pinned stable as the budget side (`poolInfo`), the pair has a class, (3) its fee is
     * in the class's fee set, (4) its observation ring holds at least the class's long window (`observe` must also serve
     * it, or every price check reverts), (7) it agrees with the pair's reference pool: its long TWAP within the class's
     * band of the reference's long TWAP over the same window, and its spot within the band of the reference's spot. (5)
     * depth and (6) the parity anchor are checked by the price checks at the priced use. Returns the pool's identity,
     * its class entry and its sub-bucket key.
     */
    function priced(address pool) external view returns (PoolInfoV4 memory p, PoolEntryV4 memory e, address key) {
        p = this.poolInfo(pool);
        address ref;
        uint8 mask;
        (e, key, ref, mask) = classEntry(p.token0, p.token1);
        if (MamoruV4Classes.feeBit(p.fee) & mask == 0) revert NotEligible(pool, 3);
        // Rule 4 (T6 L-4, kept from V3): an observation ring at least the long window's length, so the window is served
        // at block granularity, not interpolated across a sparse ring (review r1 of #228).
        (,,,, uint16 next,,) = IUniswapV3Pool(pool).slot0();
        if (next < e.twapWindow) revert NotEligible(pool, 4);
        if (pool != ref) {
            int24 band = int24(e.bandTicks);
            int24 d = _longTwap(pool, e.twapWindow) - _longTwap(ref, e.twapWindow);
            if (d > band || d < -band) revert NotEligible(pool, 7);
            (, int24 a,,,,,) = IUniswapV3Pool(pool).slot0();
            (, int24 b,,,,,) = IUniswapV3Pool(ref).slot0();
            if (a - b > band || b - a > band) revert NotEligible(pool, 7);
        }
    }

    /// The class entry that prices an EXIT of a position in `pool` (spec 010 A1 "Exits are never gated by
    /// eligibility"): only the pair's class, never the fee set, the reference pool or the anchor.
    function exitEntry(address pool) public view returns (PoolEntryV4 memory e) {
        (e,,,) = classEntry(IUniswapV3Pool(pool).token0(), IUniswapV3Pool(pool).token1());
    }

    function _longTwap(address pool, uint32 window) internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory tc,) = IUniswapV3Pool(pool).observe(ago);
        return _meanTick(tc[1] - tc[0], window);
    }

    // ---------------------------------------------------------------- I2: V3's price checks, for V4's actions

    error RangeEmpty(int24 twapLong, int24 twapShort);
    error SpotOutsideRange(uint160 sqrtPriceX96, int24 lo, int24 hi);
    error SwapBounds();
    error Slippage();
    error TooThin(uint256 depth, uint256 value);
    error ZeroValue();

    /// MamoruActionPolicyV4.swap's checks (V3's `_checkSwap` without the charge): the anchored range and the spot in it
    /// (M-2), amountOutMinimum and the price limit no looser than the range edge, the limit strictly past the spot
    /// (M-2), then I2's depth. Returns the swap's value in the budget unit, which V4 charges.
    function swapValue(address pool, PoolInfoV4 calldata p, PoolEntryV4 calldata e, bool zeroForOne, uint256 amountIn, uint256 minOutIn, uint160 limitIn)
        external
        view
        returns (uint256 v)
    {
        (int24 lo, int24 hi) = _rangeOrRevert(e, pool, true);
        _requireSpotIn(pool, lo, hi);
        (uint256 minOut, uint160 limit) = _swapBounds(p, lo, hi, zeroForOne, amountIn);
        if (minOutIn < minOut || limitIn == 0) revert SwapBounds(); // a zero limit means "no limit" to the pool
        if (zeroForOne ? limitIn < limit : limitIn > limit) revert SwapBounds();
        (uint160 spot,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (zeroForOne ? limitIn >= spot : limitIn <= spot) revert SwapBounds();
        v = _value(p, lo, hi, zeroForOne ? amountIn : 0, zeroForOne ? 0 : amountIn);
        _requireDepth(pool, p, e.bandTicks, v);
    }

    /// V3's `_checkProvide` without the charge (mint and increase): the anchored range and the spot in it, what the
    /// manager takes at the spot meeting the minimums (LeftClaw M-2), then I2's depth. Returns the value V4 charges.
    function provideValue(
        address pool,
        PoolInfoV4 calldata p,
        PoolEntryV4 calldata e,
        uint256 a0,
        uint256 a1,
        int24 lower,
        int24 upper,
        uint256 min0,
        uint256 min1
    ) external view returns (uint256 v) {
        (int24 lo, int24 hi) = _rangeOrRevert(e, pool, true);
        _requireSpotIn(pool, lo, hi);
        (uint160 spot,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint160 sa = TickMath.getSqrtRatioAtTick(lower);
        uint160 sb = TickMath.getSqrtRatioAtTick(upper);
        (uint256 u0, uint256 u1) =
            LiquidityAmounts.getAmountsForLiquidity(spot, sa, sb, LiquidityAmounts.getLiquidityForAmounts(spot, sa, sb, a0, a1));
        if (u0 < min0 || u1 < min1) revert Slippage();
        v = _value(p, lo, hi, a0, a1);
        if (v == 0) revert ZeroValue();
        _requireDepth(pool, p, e.bandTicks, v);
    }

    /// T6 I-7: the spot inside the anchored range, right before the manager's call.
    function requireSpotInRange(address pool, PoolEntryV4 calldata e) external view {
        (int24 lo, int24 hi) = _rangeOrRevert(e, pool, true);
        _requireSpotIn(pool, lo, hi);
    }

    /// V3's decrease check: minimums at the edges of the TWAP range WITHOUT the anchor (LeftClaw M-6). `ok` false when
    /// that range is empty.
    function exitMins(address pool, PoolEntryV4 calldata e, address npm, uint256 tokenId, uint128 liquidity)
        external
        view
        returns (bool ok, uint256 min0, uint256 min1)
    {
        int24 lo;
        int24 hi;
        (ok, lo, hi) = _range(e, pool, false);
        if (!ok) return (false, 0, 0);
        (,,,,, int24 lower, int24 upper,,,,,) = INPMV4(npm).positions(tokenId);
        uint160 sa = TickMath.getSqrtRatioAtTick(lower);
        uint160 sb = TickMath.getSqrtRatioAtTick(upper);
        (min0,) = LiquidityAmounts.getAmountsForLiquidity(TickMath.getSqrtRatioAtTick(hi), sa, sb, liquidity);
        (, min1) = LiquidityAmounts.getAmountsForLiquidity(TickMath.getSqrtRatioAtTick(lo), sa, sb, liquidity);
    }

    function priceRangeAt(address pool, PoolEntryV4 calldata e) external view returns (int24 lo, int24 hi) {
        return _rangeOrRevert(e, pool, true);
    }

    function swapBoundsAt(address pool, PoolInfoV4 calldata p, PoolEntryV4 calldata e, bool zeroForOne, uint256 amountIn)
        external
        view
        returns (uint256 minOut, uint160 sqrtPriceLimitX96)
    {
        (int24 lo, int24 hi) = _rangeOrRevert(e, pool, true);
        return _swapBounds(p, lo, hi, zeroForOne, amountIn);
    }

    /// I2 (r3 P1): at every priced use, the pool's in-band depth covers DEPTH_MULTIPLE times the call's value.
    function _requireDepth(address pool, PoolInfoV4 calldata p, uint24 band, uint256 v) internal view {
        uint256 d = depthIn(pool, p.token0, p.token1, band, p.in1);
        if (d < DEPTH_MULTIPLE * v) revert TooThin(d, v);
    }

    /// Two TWAPs from one `observe([long, short, 0])`, floor-rounded like `OracleLibrary.consult` (V3 `_oracle`).
    function _oracle(PoolEntryV4 calldata e, address pool) internal view returns (int24 tl, int24 ts) {
        uint32[] memory ago = new uint32[](3);
        ago[0] = e.twapWindow;
        ago[1] = e.twapShortWindow;
        (int56[] memory tc,) = IUniswapV3Pool(pool).observe(ago);
        tl = _meanTick(tc[2] - tc[0], e.twapWindow);
        ts = _meanTick(tc[2] - tc[1], e.twapShortWindow);
    }

    /// V3 `_range`: lo = max(long, short) - band + 1, hi = min(long, short) + band, clipped to the anchor when
    /// `anchored` (every action but decrease: LeftClaw M-6). `ok` false when empty.
    function _range(PoolEntryV4 calldata e, address pool, bool anchored) internal view returns (bool ok, int24 lo, int24 hi) {
        (int24 tl, int24 ts) = _oracle(e, pool);
        int24 top = tl > ts ? tl : ts;
        int24 bottom = tl > ts ? ts : tl;
        int256 l = int256(top) - int256(uint256(e.bandTicks)) + 1;
        int256 h = int256(bottom) + int256(uint256(e.bandTicks));
        if (anchored && e.anchorBand != 0) {
            int256 al = int256(e.anchorTick) - int256(uint256(e.anchorBand));
            int256 ah = int256(e.anchorTick) + int256(uint256(e.anchorBand));
            if (l < al) l = al;
            if (h > ah) h = ah;
        }
        lo = _clamp(l);
        hi = _clamp(h);
        ok = lo <= hi;
    }

    function _rangeOrRevert(PoolEntryV4 calldata e, address pool, bool anchored) internal view returns (int24 lo, int24 hi) {
        bool ok;
        (ok, lo, hi) = _range(e, pool, anchored);
        if (!ok) {
            (int24 tl, int24 ts) = _oracle(e, pool);
            revert RangeEmpty(tl, ts);
        }
    }

    /// The spot inside [lo, hi], compared as sqrt prices, not floored ticks (T6 L-7).
    function _requireSpotIn(address pool, int24 lo, int24 hi) internal view {
        (uint160 sp,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (sp < TickMath.getSqrtRatioAtTick(lo) || sp > TickMath.getSqrtRatioAtTick(hi)) revert SpotOutsideRange(sp, lo, hi);
    }

    /// V3 `_swapBounds`: the worst acceptable price is the range edge against the swapper.
    function _swapBounds(PoolInfoV4 calldata p, int24 lo, int24 hi, bool zeroForOne, uint256 amountIn)
        internal
        pure
        returns (uint256 minOut, uint160 limit)
    {
        int24 worst = zeroForOne ? lo : hi;
        (address tokenIn, address tokenOut) = zeroForOne ? (p.token0, p.token1) : (p.token1, p.token0);
        uint256 quote = OracleLibrary.getQuoteAtTick(worst, _u128(amountIn), tokenIn, tokenOut);
        minOut = (quote * (1e6 - p.fee)) / 1e6;
        limit = TickMath.getSqrtRatioAtTick(worst);
    }

    /// V3 `_value` (T6 M-2): the other token converted at the range edge that values it highest.
    function _value(PoolInfoV4 calldata p, int24 lo, int24 hi, uint256 a0, uint256 a1) internal pure returns (uint256) {
        if (p.in1) return a1 + (a0 == 0 ? 0 : OracleLibrary.getQuoteAtTick(hi, _u128(a0), p.token0, p.token1));
        return a0 + (a1 == 0 ? 0 : OracleLibrary.getQuoteAtTick(lo, _u128(a1), p.token1, p.token0));
    }

    function _meanTick(int56 delta, uint32 window) internal pure returns (int24 t) {
        t = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) t--;
    }

    // ---------------------------------------------------------------- I4: the remote Safe

    /// The account's owners as they are NOW (never the original initializer, r2 P0), and the passkey that
    /// SafeWebAuthnSharedSigner holds for it when the shared signer is one of them.
    function ownerState(address account) public view returns (MamoruRemoteSafe.OwnerState memory o) {
        o.owners = ISafeOwnersV4(account).getOwners();
        o.threshold = ISafeOwnersV4(account).getThreshold();
        if (MamoruRemoteSafe.ownsWithPasskey(o)) {
            ISharedSignerV4.Signer memory s = ISharedSignerV4(MamoruRemoteSafe.SHARED_SIGNER).getConfiguration(account);
            (o.x, o.y, o.verifiers) = (s.x, s.y, s.verifiers);
        }
    }

    function ownersHashOf(address account) external view returns (bytes32) {
        return MamoruRemoteSafe.ownersHash(ownerState(account));
    }

    /**
     * The remote Safe of `account` on `domain`: the canonical initializer (MamoruRemoteSafe) over the account's
     * current owner state, with ONE session: a fallback action whose only policy is V4 (this helper's POLICY, the same
     * address on the remote chain), Init {capUsd, generation 1, home = account, homeDomain}, and MamoruGasPolicyV2 with
     * the destination chain's pinned caps as the only userOp policy. Address salt: keccak(account, domain, ownersHash).
     * The registry has no say in any of it.
     */
    function remote(address account, uint32 domain, address sessionKey, uint128 capUsd, uint32 homeDomain)
        external
        view
        returns (address at, bytes32 ownersHash, bytes memory createCall)
    {
        return _remote(ownerState(account), account, domain, sessionKey, capUsd, homeDomain);
    }

    /**
     * I4, A1 (`announceReady` on a remote's chain): the canonical remote of `home` on `domain` computed from the owner
     * state `safe` holds now, on this chain. A remote is deployed with its home's owners, so for the genuine remote this
     * gives back its own address; a look-alike Safe with the victim's owners but another initializer does not.
     */
    function remoteFor(address safe, address home, uint32 domain, address sessionKey, uint128 capUsd, uint32 homeDomain)
        external
        view
        returns (address at, bytes32 ownersHash)
    {
        (at, ownersHash,) = _remote(ownerState(safe), home, domain, sessionKey, capUsd, homeDomain);
    }

    function _remote(
        MamoruRemoteSafe.OwnerState memory o,
        address account,
        uint32 domain,
        address sessionKey,
        uint128 capUsd,
        uint32 homeDomain
    ) internal view returns (address at, bytes32 ownersHash, bytes memory createCall) {
        MamoruV4Chains.Chain memory dst = TABLE.chain(TABLE.chainOf(domain));
        if (dst.chainId == 0) revert UnknownDomain(domain);
        ownersHash = MamoruRemoteSafe.ownersHash(o);
        bytes memory init = MamoruRemoteSafe.initializer(o, REMOTE_INIT, sessions(account, sessionKey, capUsd, homeDomain, dst));
        uint256 salt = uint256(keccak256(abi.encode(account, domain, ownersHash)));
        at = MamoruRemoteSafe.proxyAddress(init, salt);
        createCall = MamoruRemoteSafe.createProxyCall(init, salt);
    }

    /**
     * I4, A1: what `announceReady` reads of `safe` on its own chain before it tells another chain that `safe` is ready
     * (what the guardian's watcher used to read off chain): a SafeProxy 1.4.1 of the pinned singleton, Safe7579 enabled
     * as a module with SmartSession installed as a validator. Returns its owners hash.
     */
    function readBack(address safe) external view returns (bytes32) {
        if (safe.codehash != H_SAFE_PROXY) revert NotASafe(safe, 1);
        if (abi.decode(ISafeOwnersV4(safe).getStorageAt(0, 1), (address)) != MamoruRemoteSafe.SAFE_SINGLETON) {
            revert NotASafe(safe, 2);
        }
        if (!ISafeOwnersV4(safe).isModuleEnabled(MamoruRemoteSafe.SAFE7579)) revert NotASafe(safe, 3);
        if (!IERC7579AccountV4(safe).isModuleInstalled(1, SMART_SESSION, "")) revert NotASafe(safe, 4);
        return MamoruRemoteSafe.ownersHash(ownerState(safe));
    }

    /// `abi.encode(Session[1])`, SmartSession's install payload of the remote (after the UNSAFE_ENABLE byte).
    function sessions(
        address account,
        address sessionKey,
        uint128 capUsd,
        uint32 homeDomain,
        MamoruV4Chains.Chain memory dst
    ) public view returns (bytes memory) {
        Session[] memory ss = new Session[](1);
        Session memory s = ss[0];
        address[] memory signers = new address[](1);
        signers[0] = sessionKey;
        s.sessionValidator = OWNABLE_VALIDATOR;
        s.sessionValidatorInitData = abi.encode(uint256(1), signers);
        s.salt = REMOTE_SESSION_SALT;
        s.userOpPolicies = new PolicyData[](1);
        s.userOpPolicies[0] = PolicyData(GAS_POLICY, abi.encode(dst.remoteCaps));
        s.actions = new ActionData[](1);
        s.actions[0].actionTargetSelector = FALLBACK_SELECTOR;
        s.actions[0].actionTarget = FALLBACK_TARGET;
        s.actions[0].actionPolicies = new PolicyData[](1);
        s.actions[0].actionPolicies[0] =
            PolicyData(POLICY, abi.encode(InitV4(capUsd, 1, account, homeDomain, new uint256[](0))));
        return abi.encode(ss);
    }

    function _clamp(int256 t) internal pure returns (int24) {
        if (t > TickMath.MAX_TICK) return TickMath.MAX_TICK;
        if (t < TickMath.MIN_TICK) return TickMath.MIN_TICK;
        return int24(t);
    }

    function _u128(uint256 x) internal pure returns (uint128) {
        require(x <= type(uint128).max, "amount");
        return uint128(x);
    }
}

/// I5: a rolling sum over the last `n` periods (the current one included), with amortized O(1) updates. Each slot
/// keeps (period index << 192 | amount); `sum` counts exactly the slots whose index is in (head - n, head].
library RollingSum {
    struct Ring {
        uint64 head;
        uint192 sum;
        mapping(uint256 => uint256) slots;
    }

    /// The sum over the periods (idx - n, idx]. Covers at least (n - 1) whole periods before `idx` plus the current
    /// one, so with n = 25 hourly periods it counts at least the last 24 h, and with n = 31 daily ones the last 30 days.
    function total(Ring storage r, uint256 idx, uint256 n) internal view returns (uint256 s) {
        uint256 head = r.head;
        s = r.sum;
        if (idx <= head) return s;
        if (idx - head >= n) return 0;
        for (uint256 j = head + 1; j <= idx; j++) {
            uint256 w = r.slots[j % n];
            if (w >> 192 == j - n) s -= uint192(w); // the slot of period j - n leaves the window
        }
    }

    function add(Ring storage r, uint256 idx, uint256 n, uint256 v) internal {
        uint256 s = total(r, idx, n) + v;
        uint256 k = idx % n;
        uint256 w = r.slots[k];
        r.slots[k] = w >> 192 == idx ? w + v : (idx << 192) | v;
        (r.head, r.sum) = (uint64(idx), uint192(s));
    }
}

/**
 * @title MamoruActionPolicyV4 (spec 010 "one authorization" + A1, otto/mamoru#292, #316). Not deployed.
 * @notice The ONLY action policy of a Mamoru account's ONE long-lived SmartSession session: a single fallback action
 * (`FALLBACK_TARGET_FLAG`, T1), so `checkAction` sees every call of every session userOp. The owner signs the rules
 * once (InitV4: the cap C, the generation, and for a remote Safe its home). Which pools, vaults and chains the engine may
 * use follow from rules and tables in code (MamoruV4Chains, MamoruV4Classes): no registry, no guardian, no owner, no
 * upgrade, no pause. Nobody holds a key over V4 after deployment (spec 010 I7, I8; spec 009 C2-C6).
 *
 * What changed from MamoruActionPolicyV3 (each change is commented where it is made, with the invariant it implements):
 *  - I1, approvals only to V4. Every spending action is a V4 function the session calls (`swap`, `mint`, `increase`,
 *    `deposit`, `redeem`, `bridge`). Each pulls the exact amount from msg.sender (the account), approves the pinned
 *    router / position manager / listed vault / messenger for exactly that amount, acts with the account as recipient,
 *    sets the allowance back to 0 and returns any rest. `checkAction` admits only: V4's own functions; `approve(V4, x)`
 *    on any token but the position manager; the position manager's decrease, collect and burn of admitted positions
 *    (they move no tokens out of the account); `receiveMessage` on the pinned CCTP transmitter; wrap and unwrap of the
 *    native coin. Everything else is refused, direct router, position manager, messenger and vault calls included.
 *  - I9, ERC-7562-compliant validation (spec 009 POL-12): `checkAction` reads only storage keyed by the account (every
 *    mapping has the account as its last key) and makes no external call. The price, depth, budget and position checks
 *    run at execution, inside V4's own functions, and an exit's price check in `checkExit`, which MamoruGasPolicyV2
 *    requires right before every `decreaseLiquidity` of the batch. So any standard bundler can take a session op.
 *  - Eligibility by rule (A1): pools of the pinned factory, pinned tokens, the class's fee set, depth, the parity anchor
 *    for stable pairs, and agreement with the pair's reference pool (MamoruV4Helper.priced). Vaults by exact address.
 *  - I2: V3's two-TWAP band and anchor, with the class's parameters, and the M-5 depth check at EVERY priced use.
 *  - I4: `registerRemote` computes the account's remote Safe on a domain from its current owners; `bridge` burns only to
 *    a remote proven ready for the account's current owners hash, or, on a remote Safe, only back to its home.
 *    Readiness is proven by a CCTP message from the same V4 on the remote's chain (`announceReady`, A1), not by a key.
 *  - I5: one bucket per account (capacity C per day), a sub-bucket per volatile asset, per stable class and per vault
 *    (ratioBps of C), a rolling 30-day cap of 3C and a rolling 24 h cap of C. A call that would pass any of them is
 *    refused; nothing pauses, so the next window works again by itself (A1).
 *  - V3's per-pool Init and per-generation `total` are gone (no lifetime total, spec 010 Decision).
 * Kept from V3: the oracle range, anchor, swap bounds, mint/increase minimums at the spot, decrease minimums without the
 * anchor (M-6), admitted positions (minted here or admitted at enable, M-4 revocation), generation steps (H-1),
 * `initializeWithMultiplexer` only from SMART_SESSION, an enable that reads no live market state (setup mode: an
 * account's enable never depends on state that can change, so a remote initializer embeds it safely). Threat model:
 * contracts/action-policy/SECURITY.md ("MamoruActionPolicyV4").
 *
 * Deployment (T7): CREATE2 through the canonical deterministic deployer: MamoruV4Table (no argument), MamoruGasPolicyV2
 * (the table), then V4 (the gas policy and the table), the same arguments on every chain, so V4 and what its
 * constructor creates (MamoruV4Helper, MamoruRemoteInit) have the same addresses and code everywhere; nothing in the
 * runtime code depends on the chain but the table lookups, which happen at call time.
 */
contract MamoruActionPolicyV4 {
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;

    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant DECREASE = 0x0c49ccbe; // decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))
    bytes4 internal constant COLLECT = 0xfc6f7865; // collect((uint256,address,uint128,uint128))
    bytes4 internal constant BURN = 0x42966c68; // burn(uint256)
    bytes4 internal constant WRAP = 0xd0e30db0; // deposit() on the chain's wrapped native (#307)
    bytes4 internal constant UNWRAP = 0x2e1a7d4d; // withdraw(uint256) on the chain's wrapped native (#307)
    /// MessageTransmitterV2.receiveMessage(bytes,bytes): the account relays a readiness message itself (I4, A1).
    bytes4 internal constant RECEIVE_MESSAGE = 0x57ecfd28;
    /// SmartSession's ActionId of the fallback action: keccak(FALLBACK_TARGET_FLAG ‖ FALLBACK_TARGET_SELECTOR_FLAG).
    bytes32 internal constant FALLBACK_ACTION_ID = keccak256(abi.encodePacked(address(1), bytes4(0x00000001)));

    address public constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    /// CCTP V2 TokenMessengerV2, the same proxy (same code hash) on every chain Circle supports; checked on Base and
    /// Monad (spec 010 T1). The burn token is checked against its own `localMinter()`.
    address public constant TOKEN_MESSENGER = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    /// CCTP V2 MessageTransmitterV2 (`localDomain()` 6 on Base, 15 on Monad, 0 on Ethereum; read on chain 2 Nov).
    address public constant MESSAGE_TRANSMITTER = 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64;
    /// CCTP V2 Standard (attested at finality, no fee), for burns and readiness messages; Fast (1000) never.
    uint32 public constant CCTP_MIN_FINALITY = 2000;
    /// S: how far `clock(T)` may be from the block's time (MamoruGasPolicyV2.CLOCK_SLACK).
    uint256 public constant CLOCK_SLACK = 5 minutes;

    // Hard bounds on class parameters: V3's, unchanged (MamoruV4Classes is checked against them by a unit test).
    uint32 public constant MIN_TWAP_WINDOW = 600;
    uint32 public constant MAX_TWAP_WINDOW = 86_400;
    uint32 public constant MIN_SHORT_WINDOW = 60;
    uint32 public constant MIN_WINDOW_RATIO = 4; // LeftClaw M-1
    uint24 public constant MIN_BAND = 2;
    uint24 public constant MAX_BAND = 500;
    uint16 public constant MAX_RATIO_BPS = 10_000;
    /// Review r1 of #200 (P1): at most half of C in any one vault (the planned Stable bucket is 50 % in a vault).
    uint16 public constant MAX_VAULT_RATIO_BPS = 5_000;
    // I5 (r1 P1-7, r2 P1): the account's limits per chain, as multiples of the owner-signed C.
    uint256 public constant BUCKET_WINDOW = 1 days; // the bucket and sub-buckets refill C (resp. ratio x C) per day
    uint256 public constant BREAKER_PERIODS = 25; // hourly periods: at least the last 24 h
    uint256 public constant CAP30_PERIODS = 31; // daily periods: at least the last 30 days
    uint256 public constant CAP30_MULTIPLE = 3; // rolling 30-day cap: 3C
    uint128 public constant MAX_CAP_USD = 1e15; // C <= 1e9 USD, far from every overflow below

    uint64 public constant MAX_GENERATION = type(uint32).max;
    uint64 public constant MAX_FIRST_GENERATION = type(uint16).max; // LeftClaw H-1
    uint256 public constant MAX_ADMIT = 64;
    uint256 public constant REVOKE_FLAG = 1 << 255; // LeftClaw M-4
    address internal constant REVOKED = address(1);

    MamoruV4Helper public immutable HELPER;
    MamoruGasPolicyV2 public immutable GAS_POLICY;
    /// The per-chain table (MamoruV4Table, CREATE2): a new chain, token, class or vault is a new table, so a new V4
    /// address with this same code (contracts/action-policy/ADD-A-CHAIN.md).
    IMamoruV4Table public immutable TABLE;
    MamoruRemoteInit public immutable REMOTE_INIT;

    /// Per account: the owner-signed Init (without `admit`), written only at enable.
    struct Config {
        uint128 capUsd;
        uint64 generation;
        uint32 homeDomain;
        bool set;
        address home;
        bytes32 initHash;
    }

    /// Token bucket: `debt` spent and not yet refilled, refilled at `cap` per BUCKET_WINDOW, where `cap` is the
    /// capacity in force at the last update (LeftClaw M-3: a capacity change settles the refill at the old rate first).
    struct Bucket {
        uint128 debt;
        uint64 updatedAt;
        uint64 cap;
    }

    /// I4: a registered remote, bound to the owner state, C and session key it was computed from.
    struct Remote {
        address remote;
        uint96 capUsd; // C embedded in the remote's Init (a later renewal of the home does not move the address)
        bytes32 ownersHash;
        address sessionKey;
    }

    struct Ready {
        address remote;
        bytes32 ownersHash;
    }

    // I9 (ERC-7562): every mapping `checkAction` reads has the account as its LAST key, so each slot is keccak(account ‖
    // x): storage associated with the sender.
    mapping(ConfigIdV4 => mapping(address account => uint64)) internal _binding; // generation + 1; 0 = none
    mapping(address account => uint64) public generationOf;
    mapping(address account => Config) internal _config;
    mapping(uint256 tokenId => mapping(address account => address pool)) internal _admitted;
    mapping(address account => Bucket) internal _accountBucket;
    mapping(address key => mapping(address account => Bucket)) internal _subBucket; // key = asset, stable class or vault
    mapping(address account => RollingSum.Ring) internal _spent24h;
    mapping(address account => RollingSum.Ring) internal _spent30d;
    mapping(uint32 domain => mapping(address account => Remote)) internal _remote;
    mapping(uint32 domain => mapping(address account => Ready)) internal _ready;

    uint256 private _locked = 1;

    event PolicySet(ConfigIdV4 id, address multiplexer, address account);
    event Admitted(address indexed account, address indexed pool, uint256 indexed tokenId);
    event Revoked(address indexed account, address indexed pool, uint256 indexed tokenId);
    event Spent(address indexed account, address indexed key, uint256 value);
    event Swapped(address indexed account, address indexed pool, address tokenIn, uint256 amountIn, uint256 amountOut);
    event Deposited(address indexed account, address indexed vault, uint256 assets, uint256 shares);
    event Redeemed(address indexed account, address indexed vault, uint256 shares, uint256 assets);
    event Bridged(address indexed account, uint32 indexed domain, address indexed recipient, address token, uint256 amount);
    event RemoteRegistered(address indexed account, uint32 indexed domain, address remote, bytes32 ownersHash, address sessionKey);
    event RemoteReady(address indexed account, uint32 indexed domain, address remote, bytes32 ownersHash);
    event ReadyAnnounced(address indexed home, address indexed safe, uint32 indexed toDomain, bytes32 ownersHash);

    error PolicyNotInitialized(ConfigIdV4 id, address multiplexer, address account);
    error OnlySmartSession();
    error BadInit(uint256 field);
    error UnsupportedChain(uint256 chainId);
    error StaleGeneration(uint64 given, uint64 current);
    error ConfigMismatch(address account, uint64 generation);
    error NoConfig(address account);
    error NotAdmitted(uint256 tokenId);
    error NotPinned(address token);
    error NotAFactoryPool(address pool);
    error BudgetExceeded(address key, uint256 value);
    error Cap30Exceeded(uint256 spent, uint256 value);
    error Cap24hExceeded(uint256 spent, uint256 value);
    error ClockSkew(uint256 claimed);
    error ExitBelowBand();
    error AllowanceLeft(address token);
    error BadAnnounce(uint256 field);
    error BadMessage(uint256 field);
    error WrongRecipient();
    error ZeroAmount();
    error VaultExposure(address vault, uint256 held);
    error Expired();
    error BadBridge(uint256 field);
    error RemoteNotReady(uint32 domain);
    error Reentrancy();
    error TransferFailed();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @param gasPolicy MamoruGasPolicyV2 and @param table MamoruV4Table, both CREATE2 at the same address on every
    /// chain (contract notice); the gas policy reads the same table. Nothing else: no registry, no guardian, no owner
    /// (spec 010 I7).
    constructor(address gasPolicy, IMamoruV4Table table) {
        if (address(table).code.length == 0 || MamoruGasPolicyV2(gasPolicy).TABLE() != table) revert BadInit(0);
        GAS_POLICY = MamoruGasPolicyV2(gasPolicy);
        TABLE = table;
        // Created here so their addresses and code follow from V4's own init code (CREATE from V4, nonces 1 and 2):
        // the remote initializer V4 computes names them, and they exist at the same address wherever V4 does.
        REMOTE_INIT = new MamoruRemoteInit();
        HELPER = new MamoruV4Helper(gasPolicy, address(REMOTE_INIT), table);
    }

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        return interfaceID == 0x01ffc9a7 // IERC165
            || interfaceID == this.checkAction.selector // SmartSession checks the action-policy selector
            || interfaceID == this.initializeWithMultiplexer.selector;
    }

    // ---------------------------------------------------------------- init (owner-signed, via SmartSession)

    /// Account-wide Init (spec 010): C, the generation, the home of a remote, positions to admit. Like V3, only
    /// SmartSession calls it (owner-executed enable, owner-signed ENABLE mode, or the Safe's own setup in
    /// UNSAFE_ENABLE), so a session key can neither reach it nor add to `admit`. It reads no live market state: only
    /// code hashes and, when `admit` is not empty, the position manager (V3's setup mode, kept for every enable), so a
    /// remote Safe's initializer that embeds it deploys the same way on any later day.
    function initializeWithMultiplexer(address account, ConfigIdV4 configId, bytes calldata initData) external {
        if (msg.sender != SMART_SESSION) revert OnlySmartSession();
        InitV4 memory i = abi.decode(initData, (InitV4));
        MamoruV4Chains.Chain memory ch = _chain();
        // Spec 010 "Pinned in V4": the stack V4 trusts has the expected code on this chain, at every enable.
        HELPER.checkStack();
        if (i.capUsd == 0 || i.capUsd > MAX_CAP_USD) revert BadInit(1);
        if (i.generation > MAX_GENERATION) revert BadInit(2);
        if (i.admit.length > MAX_ADMIT) revert BadInit(3);
        // A remote Safe's home is a Mamoru account on another chain of V4's table (I4: bridge-back only there).
        // #307: `home == account` is a SIBLING, the account's own address on this chain when the owner holds funds
        // here at the address of their home account (the same SafeProxyFactory CREATE2 address on both chains means
        // the same initializer, so the same initial owners). Before #307 it was refused because a canonical remote
        // (MamoruV4Helper.remote) never has its home's address, so `home == account` could only be a mistake. A
        // sibling bridges home only once the home chain's V4 has proven the home address ready (`announceReady`, A1).
        if (i.home == address(0) ? i.homeDomain != 0 : (i.homeDomain == ch.domain
                    || TABLE.chainOf(i.homeDomain) == 0)) revert BadInit(4);
        _stepGeneration(account, i.generation);
        bytes32 h = keccak256(abi.encode(i.capUsd, i.generation, i.home, i.homeDomain));
        Config storage c = _config[account];
        if (c.set && c.generation == i.generation) {
            if (c.initHash != h) revert ConfigMismatch(account, i.generation); // T6 I-1 / L-4
        } else {
            (c.capUsd, c.generation, c.homeDomain, c.set, c.home, c.initHash) =
                (i.capUsd, i.generation, i.homeDomain, true, i.home, h);
        }
        _binding[configId][account] = i.generation + 1;
        for (uint256 k; k < i.admit.length; k++) {
            uint256 id = i.admit[k];
            if (id & REVOKE_FLAG == 0) {
                _admitAtEnable(account, id);
            } else {
                // LeftClaw M-4: an owner-signed revocation, for good. V4's Init is account-wide, so it revokes the
                // position whatever pool it was admitted under.
                id ^= REVOKE_FLAG;
                address was = _admitted[id][account];
                if (was != REVOKED) {
                    _admitted[id][account] = REVOKED;
                    emit Revoked(account, was, id);
                }
            }
        }
        emit PolicySet(configId, msg.sender, account);
    }

    function _stepGeneration(address account, uint64 g) internal {
        uint64 current = generationOf[account];
        if (g < current) revert StaleGeneration(g, current);
        if (current != 0 && g > current + 1) revert BadInit(2);
        if (current == 0 && g > MAX_FIRST_GENERATION) revert BadInit(2); // LeftClaw H-1
        if (g > current) generationOf[account] = g;
    }

    // ---------------------------------------------------------------- validation (SmartSession -> policy)

    /// I1: the fallback action's only policy. Admits V4's own functions, approvals to V4, the position manager's exits
    /// of admitted positions, a CCTP readiness message relayed by the account, and wrap/unwrap; refuses every other
    /// call. I9: reads only the account's own storage and the code-pinned table, no external call (ERC-7562).
    function checkAction(ConfigIdV4 id, address account, address target, uint256 value, bytes calldata data)
        external
        view
        returns (uint256)
    {
        if (msg.sender != SMART_SESSION) return VALIDATION_FAILED;
        uint64 b = _binding[id][account];
        if (b == 0) revert PolicyNotInitialized(id, msg.sender, account);
        if (b - 1 != generationOf[account]) return VALIDATION_FAILED; // retired by a renewal
        if (data.length < 4) return VALIDATION_FAILED; // no empty call (I6)
        bytes4 sel = bytes4(data[:4]);
        MamoruV4Chains.Chain memory ch = _chain();
        // #307: the account wraps its own native coin into the pinned wrapped native, or unwraps it back to itself
        // (WETH9 credits and pays msg.sender, the account). Value never leaves the account, so it is not charged. This
        // is the only call that may carry native value.
        if (target == ch.wrapped) {
            if (sel == WRAP) return data.length == 4 && value != 0 ? VALIDATION_SUCCESS : VALIDATION_FAILED;
            if (sel == UNWRAP) return data.length == 36 && value == 0 ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (value != 0) return VALIDATION_FAILED; // no native value anywhere else (I6)
        if (target == address(this)) {
            // Each of these acts on msg.sender (the account) only and runs every check itself, at execution.
            return sel == this.swap.selector || sel == this.mint.selector || sel == this.increase.selector
                || sel == this.deposit.selector || sel == this.redeem.selector || sel == this.bridge.selector
                || sel == this.registerRemote.selector || sel == this.clock.selector || sel == this.checkExit.selector
                || sel == this.assertZero.selector || sel == this.announceReady.selector ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (target == ch.npm) return _checkExit(account, sel, data);
        // I4, A1: the account relays a readiness message to its own V4 (the user pays, spec 009 G5/G6).
        if (target == MESSAGE_TRANSMITTER) return sel == RECEIVE_MESSAGE ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        // I1 (r3 P1): an approval only to V4, whose allowance only V4's own functions spend, for the account that
        // calls them. Never on the position manager (its `approve(to, tokenId)` shares the selector).
        if (sel == APPROVE && data.length == 68) {
            (address spender,) = abi.decode(data[4:], (address, uint256));
            return spender == address(this) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        return VALIDATION_FAILED;
    }

    /// The position manager's decrease / collect / burn, for positions admitted for the account (I9: static, from the
    /// account's own storage). The decrease's price check is `checkExit`, which MamoruGasPolicyV2 requires right before
    /// it in the batch with the same arguments; ownership is the manager's own check at execution. Exits are never
    /// gated by eligibility (A1).
    function _checkExit(address account, bytes4 sel, bytes calldata data) internal view returns (uint256) {
        if (sel == DECREASE) {
            DecreaseLiquidityParams memory d = abi.decode(data[4:], (DecreaseLiquidityParams));
            return _isAdmitted(_admitted[d.tokenId][account]) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (sel == COLLECT) {
            CollectParams memory k = abi.decode(data[4:], (CollectParams));
            return _isAdmitted(_admitted[k.tokenId][account]) && k.recipient == account
                ? VALIDATION_SUCCESS
                : VALIDATION_FAILED;
        }
        if (sel == BURN) {
            uint256 tokenId = abi.decode(data[4:], (uint256));
            return _isAdmitted(_admitted[tokenId][account]) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        return VALIDATION_FAILED; // never mint, increaseLiquidity (it funds any tokenId, #171) or transfers
    }

    // ---------------------------------------------------------------- I6, I9: the batch's clock and exit checks

    /// The leading call of every session batch (MamoruGasPolicyV2): the claimed time T is within S of the block's.
    function clock(uint256 t) external view {
        if (t + CLOCK_SLACK < block.timestamp || t > block.timestamp + CLOCK_SLACK) revert ClockSkew(t);
    }

    /// I9: the price check of an exit, at execution, right before the position manager's `decreaseLiquidity` with the
    /// same arguments (MamoruGasPolicyV2 checks the pairing). As V3's decrease check: a position admitted for the
    /// account that it owns; the minimums at the edges of the pool's TWAP range WITHOUT the anchor (LeftClaw M-6), with
    /// the pair's class, never its eligibility, so a crash or a depeg does not block the exit.
    function checkExit(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min) external view {
        address account = msg.sender;
        address pool = _admitted[tokenId][account];
        address npm = _chain().npm;
        if (!_isAdmitted(pool) || INPMV4(npm).ownerOf(tokenId) != account) revert NotAdmitted(tokenId);
        (bool ok, uint256 min0, uint256 min1) = HELPER.exitMins(pool, HELPER.exitEntry(pool), npm, tokenId, liquidity);
        if (!ok || amount0Min < min0 || amount1Min < min1) revert ExitBelowBand();
    }

    /// Spec 009 POL-07: after an approval's reset, the account's allowance to V4 on `token` is zero.
    function assertZero(address token) external view {
        if (IERC20V4(token).allowance(msg.sender, address(this)) != 0) revert AllowanceLeft(token);
    }

    // ---------------------------------------------------------------- I1: the account's spending actions

    /// A swap on an eligible pool through the pinned SwapRouter02, single hop, with the account as recipient. V3's
    /// validation-time swap checks, here at execution: recipient (fixed), fee (from the pool), amountIn != 0 (L-7), the
    /// anchored range and the spot inside it (M-2), amountOutMinimum and the price limit no looser than the range edge,
    /// the limit strictly past the spot (M-2), then I2's depth and I5's charge to the asset's sub-bucket.
    function swap(SwapParams calldata s) external nonReentrant returns (uint256 amountOut) {
        address account = msg.sender;
        if (block.timestamp > s.deadline) revert Expired(); // V3's `multicall(deadline, [])`, now an argument
        Config memory c = _live(account);
        (PoolInfoV4 memory p, PoolEntryV4 memory e, address key) = HELPER.priced(s.pool);
        if (s.amountIn == 0) revert ZeroAmount(); // LeftClaw L-7
        bool zeroForOne = s.tokenIn == p.token0;
        if (!zeroForOne && s.tokenIn != p.token1) revert NotPinned(s.tokenIn);
        // V3's swap checks and I2's depth (MamoruV4Helper.swapValue); reverts when any fails.
        uint256 v = HELPER.swapValue(s.pool, p, e, zeroForOne, s.amountIn, s.amountOutMinimum, s.sqrtPriceLimitX96);
        _charge(account, c, key, e.ratioBps, v);
        address router = _chain().router;
        uint256 before = IERC20V4(s.tokenIn).balanceOf(address(this));
        _pull(s.tokenIn, account, s.amountIn);
        _approve(s.tokenIn, router, s.amountIn); // I1: exact, then back to 0
        amountOut = IRouterV4(router).exactInputSingle(
            ExactInputSingleParams(
                s.tokenIn, zeroForOne ? p.token1 : p.token0, p.fee, account, s.amountIn, s.amountOutMinimum, s.sqrtPriceLimitX96
            )
        );
        _approve(s.tokenIn, router, 0);
        uint256 rest = IERC20V4(s.tokenIn).balanceOf(address(this)) - before; // a price limit hit: the rest goes back
        if (rest != 0) _push(s.tokenIn, account, rest);
        emit Swapped(account, s.pool, s.tokenIn, s.amountIn, amountOut);
    }

    /**
     * @notice Called BY THE ACCOUNT (msg.sender) inside a session batch, after approving V4 for at most the desired
     * amounts. As V3's `mint`, with V3's validation-time checks (`_checkProvide`) moved here: an eligible pool (A1), the
     * anchored range non-empty with the spot inside it, the manager's take at the spot meeting the minimums (M-2), then
     * I2's depth and I5's charge; after the pulls, the spot again right before the manager's call (T6 I-7). The new
     * position is admitted for the account.
     */
    function mint(MintParams calldata m)
        external
        nonReentrant
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        address account = msg.sender;
        if (m.recipient != account) revert WrongRecipient();
        Config memory c = _live(account);
        MamoruV4Chains.Chain memory ch = _chain();
        address pool = IUniswapV3Factory(ch.factory).getPool(m.token0, m.token1, m.fee);
        (PoolInfoV4 memory p, PoolEntryV4 memory e, address key) = HELPER.priced(pool);
        if (m.token0 != p.token0) revert NotAFactoryPool(pool); // the manager takes the tokens in pool order
        _provide(account, c, pool, p, e, key, m.amount0Desired, m.amount1Desired, m.tickLower, m.tickUpper, m.amount0Min, m.amount1Min);
        (uint256 b0, uint256 b1) = _fund(ch.npm, account, p.token0, p.token1, m.amount0Desired, m.amount1Desired);
        HELPER.requireSpotInRange(pool, e);
        (tokenId, liquidity, amount0, amount1) = INPMV4(ch.npm).mint(m);
        _settle(ch.npm, account, p.token0, p.token1, b0, b1);
        _admitted[tokenId][account] = pool;
        emit Admitted(account, pool, tokenId);
    }

    /// As V3's `increase` (#171), with the same checks as `mint`, on a position admitted for the account that it
    /// still owns, in a pool that is eligible now (one that is not stays exit-only, A1).
    function increase(IncreaseLiquidityParams calldata n)
        external
        nonReentrant
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        address account = msg.sender;
        address pool = _admitted[n.tokenId][account];
        address npm = _chain().npm;
        if (!_isAdmitted(pool) || INPMV4(npm).ownerOf(n.tokenId) != account) revert NotAdmitted(n.tokenId);
        Config memory c = _live(account);
        (PoolInfoV4 memory p, PoolEntryV4 memory e, address key) = HELPER.priced(pool);
        (int24 lower, int24 upper) = _ticksOf(npm, n.tokenId);
        _provide(account, c, pool, p, e, key, n.amount0Desired, n.amount1Desired, lower, upper, n.amount0Min, n.amount1Min);
        (uint256 b0, uint256 b1) = _fund(npm, account, p.token0, p.token1, n.amount0Desired, n.amount1Desired);
        HELPER.requireSpotInRange(pool, e);
        (liquidity, amount0, amount1) = INPMV4(npm).increaseLiquidity(n);
        _settle(npm, account, p.token0, p.token1, b0, b1);
    }

    /// V3's `_checkProvide`, at execution, charged to the pair's sub-bucket.
    function _provide(
        address account,
        Config memory c,
        address pool,
        PoolInfoV4 memory p,
        PoolEntryV4 memory e,
        address key,
        uint256 a0,
        uint256 a1,
        int24 lower,
        int24 upper,
        uint256 min0,
        uint256 min1
    ) internal {
        uint256 v = HELPER.provideValue(pool, p, e, a0, a1, lower, upper, min0, min1);
        _charge(account, c, key, e.ratioBps, v);
    }

    /**
     * I1 + spec 010 A1 "Vaults": a deposit into a vault of the chain's table (exact address, asset a pinned stable),
     * for exactly `assets`, shares to the account. The account's whole position in the vault after it is at most
     * ratioBps x C (ratioBps <= MAX_VAULT_RATIO_BPS, a unit test checks the table); the deposit is also charged to the
     * bucket and the vault's sub-bucket (I5).
     */
    function deposit(address vault, uint256 assets) external nonReentrant returns (uint256 shares) {
        address account = msg.sender;
        Config memory c = _live(account);
        if (assets == 0) revert ZeroAmount();
        // Review r1 of #200 (P1): a live cap on what is AT RISK in this vault, not only on the deposit rate: the
        // account's current position (the vault's own accounting, rounded against the depositor) plus this deposit
        // stays within ratioBps of C. Four deposits spaced past every window can no longer pile up 4C in one vault.
        (address asset, uint16 ratioBps, uint256 held) = HELPER.vaultExposure(vault, account);
        if (held + assets > uint256(c.capUsd) * ratioBps / MAX_RATIO_BPS) revert VaultExposure(vault, held);
        _charge(account, c, vault, ratioBps, assets);
        uint256 before = IERC20V4(asset).balanceOf(address(this));
        _pull(asset, account, assets);
        _approve(asset, vault, assets);
        shares = IERC4626V4(vault).deposit(assets, account);
        _approve(asset, vault, 0);
        if (shares == 0) revert ZeroAmount();
        uint256 rest = IERC20V4(asset).balanceOf(address(this)) - before;
        if (rest != 0) _push(asset, account, rest);
        emit Deposited(account, vault, assets, shares);
    }

    /// The account's own shares back into assets, to the account. Not charged (value returns to the account). The
    /// vault list is a constant of this V4, so a listed vault stays redeemable for as long as V4 is used (A1).
    function redeem(address vault, uint256 shares) external nonReentrant returns (uint256 assets) {
        address account = msg.sender;
        _live(account);
        HELPER.vaultEntry(vault);
        if (shares == 0) revert ZeroAmount();
        _pull(vault, account, shares);
        assets = IERC4626V4(vault).redeem(shares, account, address(this));
        emit Redeemed(account, vault, shares, assets);
    }

    /**
     * I4: a CCTP V2 Standard burn of a pinned stable that the canonical messenger's own `localMinter` accepts, minted
     * only to (a) the account's remote on `domain` (a chain of the table), proven ready for the account's CURRENT owners
     * hash by a message from that chain's V4 (A1), the owners unchanged since; or (b) on a remote Safe, the home account
     * on its home domain, always (bridge-back); on a sibling, its own address on the home domain once proven ready.
     * Open destinationCaller, no fee, as V3. Not charged: the value stays the user's (the remote's own V4 bounds it).
     */
    function bridge(uint32 domain, address token, uint256 amount) external nonReentrant {
        address account = msg.sender;
        Config memory c = _live(account);
        MamoruV4Chains.Chain memory ch = _chain();
        if (amount == 0) revert ZeroAmount();
        if (!MamoruV4Chains.isStable(ch, token)) revert NotPinned(token);
        if (ITokenMinterV4(ITokenMessengerV2V4(TOKEN_MESSENGER).localMinter()).burnLimitsPerMessage(token) == 0) {
            revert BadBridge(1);
        }
        address recipient;
        if (c.home != address(0)) {
            if (domain != c.homeDomain) revert BadBridge(2); // a remote's V4 sends funds only home
            // #307: a sibling sends to its own address on the home chain only once the home chain's V4 proved it ready.
            if (c.home == account && !isReady(account, domain)) revert RemoteNotReady(domain);
            recipient = c.home;
        } else {
            if (domain == ch.domain || TABLE.chainOf(domain) == 0) revert BadBridge(3);
            // r4 P0, A1: readiness is proven on chain, for this remote and these owners; r3 P0-1: any owner change since
            // (a rotation in progress) stops every burn until the remote is re-registered and announced again.
            if (!isReady(account, domain)) revert RemoteNotReady(domain);
            recipient = _remote[domain][account].remote;
        }
        _pull(token, account, amount);
        _approve(token, TOKEN_MESSENGER, amount);
        ITokenMessengerV2V4(TOKEN_MESSENGER).depositForBurn(
            amount, domain, bytes32(uint256(uint160(recipient))), token, bytes32(0), 0, CCTP_MIN_FINALITY
        );
        _approve(token, TOKEN_MESSENGER, 0);
        emit Bridged(account, domain, recipient, token, amount);
    }

    /**
     * I4: the account's remote Safe on `domain`, computed here from its CURRENT owners (MamoruV4Helper.remote), never
     * from anything the caller supplies but the session key the remote's session will carry. msg.sender is the
     * account, so it is only callable through the account's own session (or its owners): another account's state can
     * never be named. Any new registration clears the domain's readiness; the remote's own V4 proves it ready again
     * once it is deployed (`announceReady` there, a CCTP message here).
     */
    function registerRemote(uint32 domain, address sessionKey) external nonReentrant returns (address remote) {
        address account = msg.sender;
        Config memory c = _live(account);
        MamoruV4Chains.Chain memory ch = _chain();
        if (c.home != address(0)) revert BadBridge(4); // a remote has no remotes of its own
        if (sessionKey == address(0) || domain == ch.domain) revert BadBridge(5);
        bytes32 oh;
        (remote, oh,) = HELPER.remote(account, domain, sessionKey, c.capUsd, ch.domain);
        _remote[domain][account] = Remote(remote, uint96(c.capUsd), oh, sessionKey);
        delete _ready[domain][account];
        emit RemoteRegistered(account, domain, remote, oh, sessionKey);
    }

    // ---------------------------------------------------------------- I4, A1: readiness proven by CCTP, not by a key

    /**
     * On the chain where `safe` lives, anyone may prove to another chain of the table that `safe` is ready (A1; replaces
     * the guardian's `setReady`). V4 reads `safe` back here (MamoruV4Helper.readBack: a SafeProxy 1.4.1 of the pinned
     * singleton, Safe7579 and SmartSession installed, its owners hash) and requires a live V4 session bound for it, then
     * sends `(home, safe, ownersHash)` through the pinned MessageTransmitterV2 to the same V4 on `toDomain`, at finality
     * 2000, open destinationCaller. The destination is fixed, never free:
     *  - a remote Safe announces only to its recorded home domain, and only when `safe` is the canonical remote of its
     *    home recomputed here from its own owners and `sessionKey` (a look-alike Safe with the victim's owners and
     *    another initializer cannot announce);
     *  - a home Safe announces to a sibling, on any other chain of the table;
     *  - a sibling announces nothing (it has no remotes).
     * `permissionId` names the Safe's V4 session, which must be enabled and bound at the current generation. Moves
     * nothing. What it costs is the caller's gas.
     */
    function announceReady(address safe, uint32 toDomain, address sessionKey, bytes32 permissionId) external nonReentrant {
        Config memory c = _config[safe];
        if (!c.set || c.generation != generationOf[safe]) revert NoConfig(safe);
        // A V4 session bound for `safe` NOW (review r1 of #228): `permissionId` is enabled in SmartSession, and its
        // fallback action's config is bound to this V4 at the current generation (SmartSession IdLib: ConfigId =
        // keccak(account ‖ keccak(permissionId ‖ keccak(FALLBACK_TARGET ‖ FALLBACK_SELECTOR)))). A Stop removes the
        // session, so a stopped Safe cannot be announced.
        bytes32 actionPolicyId = keccak256(abi.encodePacked(permissionId, FALLBACK_ACTION_ID));
        ConfigIdV4 cfg = ConfigIdV4.wrap(keccak256(abi.encodePacked(safe, actionPolicyId)));
        if (_binding[cfg][safe] != c.generation + 1 || !ISmartSessionV4(SMART_SESSION).isPermissionEnabled(permissionId, safe)) {
            revert BadAnnounce(5);
        }
        bytes32 oh = HELPER.readBack(safe);
        uint32 local = _chain().domain;
        address home = safe;
        if (c.home == address(0)) {
            if (toDomain == local || TABLE.chainOf(toDomain) == 0) revert BadAnnounce(1);
        } else {
            if (c.home == safe) revert BadAnnounce(2);
            if (toDomain != c.homeDomain) revert BadAnnounce(3);
            (address at, bytes32 h) = HELPER.remoteFor(safe, c.home, local, sessionKey, c.capUsd, c.homeDomain);
            if (at != safe || h != oh) revert BadAnnounce(4);
            home = c.home;
        }
        IMessageTransmitterV2V4(MESSAGE_TRANSMITTER).sendMessage(
            toDomain, bytes32(uint256(uint160(address(this)))), bytes32(0), CCTP_MIN_FINALITY, abi.encode(home, safe, oh)
        );
        emit ReadyAnnounced(home, safe, toDomain, oh);
    }

    /**
     * CCTP V2 IMessageHandlerV2, finalized messages only: the readiness `announceReady` sent from the same V4 on another
     * chain of the table. Anyone may relay it (`receiveMessage` is permissionless; the user's session does it as a
     * userOp). Accepted only from the pinned transmitter, from `address(this)` on a table domain other than this one,
     * at finality 2000 or more; then, for the account's CURRENT owners hash only:
     *  - `home == safe`: the home chain says the home Safe is ready; written only on that account's sibling here, from
     *    the home domain of its Init;
     *  - otherwise: the remote's chain says `safe` is ready; written only when `safe` is the remote registered here for
     *    `home` on that domain, with the same owners hash.
     * A forged message (only Circle could forge one) passes only for the address V4 itself computed, the user's own
     * deterministic Safe (spec 010 I4 "Trust added").
     */
    function handleReceiveFinalizedMessage(uint32 sourceDomain, bytes32 sender, uint32 finality, bytes calldata body)
        external
        returns (bool)
    {
        if (msg.sender != MESSAGE_TRANSMITTER) revert BadMessage(0);
        if (sender != bytes32(uint256(uint160(address(this))))) revert BadMessage(1);
        if (finality < CCTP_MIN_FINALITY) revert BadMessage(2);
        if (sourceDomain == _chain().domain || TABLE.chainOf(sourceDomain) == 0) revert BadMessage(3);
        (address home, address safe, bytes32 oh) = abi.decode(body, (address, address, bytes32));
        if (home == safe) {
            Config memory c = _config[home];
            if (!c.set || c.generation != generationOf[home] || c.home != home || c.homeDomain != sourceDomain) {
                revert BadMessage(4);
            }
        } else {
            Remote memory r = _remote[sourceDomain][home];
            if (r.remote == address(0) || r.remote != safe || r.ownersHash != oh) revert BadMessage(5);
        }
        if (HELPER.ownersHashOf(home) != oh) revert BadMessage(6);
        _ready[sourceDomain][home] = Ready(safe, oh);
        emit RemoteReady(home, sourceDomain, safe, oh);
        return true;
    }

    /// Unfinalized (Fast) messages never prove readiness.
    function handleReceiveUnfinalizedMessage(uint32, bytes32, uint32, bytes calldata) external pure returns (bool) {
        revert BadMessage(2);
    }

    // ---------------------------------------------------------------- I5: the account's bucket, caps and breaker

    /**
     * Charges `v` (USD units) to the account on this chain. Reverts (nothing written, nothing moved) when the account
     * bucket, the key's sub-bucket (ratioBps of C), the rolling 30-day cap (3C) or the rolling 24 h cap (C) would be
     * passed. Nothing pauses: a refused call is a refusal of that call, and the next window works again by itself (A1).
     */
    function _charge(address account, Config memory c, address key, uint16 ratioBps, uint256 v) internal {
        uint256 cap = c.capUsd;
        Bucket memory a = _accountBucket[account];
        uint256 da = _debtNow(a, cap) + v;
        if (da > cap) revert BudgetExceeded(address(0), v);
        uint256 kcap = cap * ratioBps / MAX_RATIO_BPS;
        Bucket memory k = _subBucket[key][account];
        uint256 dk = _debtNow(k, kcap) + v;
        if (dk > kcap) revert BudgetExceeded(key, v);
        uint256 day = block.timestamp / 1 days;
        uint256 s30 = RollingSum.total(_spent30d[account], day, CAP30_PERIODS);
        if (s30 + v > CAP30_MULTIPLE * cap) revert Cap30Exceeded(s30, v);
        uint256 hour = block.timestamp / 1 hours;
        uint256 s24 = RollingSum.total(_spent24h[account], hour, BREAKER_PERIODS);
        if (s24 + v > cap) revert Cap24hExceeded(s24, v);
        _accountBucket[account] = Bucket(uint128(da), uint64(block.timestamp), uint64(cap));
        _subBucket[key][account] = Bucket(uint128(dk), uint64(block.timestamp), uint64(kcap));
        RollingSum.add(_spent30d[account], day, CAP30_PERIODS, v);
        RollingSum.add(_spent24h[account], hour, BREAKER_PERIODS, v);
        emit Spent(account, key, v);
    }

    /// Debt after the refill since the last charge, at the capacity then in force (LeftClaw M-3: settled at the old
    /// rate first), then clamped to the capacity now (a lower capacity never carries more than a full bucket).
    function _debtNow(Bucket memory b, uint256 capNow) internal view returns (uint256 d) {
        d = b.debt;
        if (d != 0 && block.timestamp > b.updatedAt) {
            uint256 refill = (uint256(b.cap) * (block.timestamp - b.updatedAt)) / BUCKET_WINDOW;
            d = refill >= d ? 0 : d - refill;
        }
        if (d > capNow) d = capNow;
    }

    // ---------------------------------------------------------------- views the engine and precheck use

    function configOf(address account) external view returns (Config memory) {
        return _config[account];
    }

    function admittedPool(address account, uint256 tokenId) external view returns (address) {
        return _admitted[tokenId][account];
    }

    /// Room now, in USD units: the account bucket, `key`'s sub-bucket at its current ratio, the 30-day cap and the
    /// 24 h cap.
    function budgetLeft(address account, address key, uint16 ratioBps)
        external
        view
        returns (uint256 bucket, uint256 sub, uint256 cap30, uint256 cap24h)
    {
        uint256 cap = _config[account].capUsd;
        bucket = cap - _debtNow(_accountBucket[account], cap);
        uint256 kcap = cap * ratioBps / MAX_RATIO_BPS;
        sub = kcap - _debtNow(_subBucket[key][account], kcap);
        cap30 = _room(CAP30_MULTIPLE * cap, RollingSum.total(_spent30d[account], block.timestamp / 1 days, CAP30_PERIODS));
        cap24h = _room(cap, RollingSum.total(_spent24h[account], block.timestamp / 1 hours, BREAKER_PERIODS));
    }

    function remoteOf(address account, uint32 domain) external view returns (Remote memory) {
        return _remote[domain][account];
    }

    function readyOf(address account, uint32 domain) external view returns (Ready memory) {
        return _ready[domain][account];
    }

    /// Whether `bridge` would burn to the account's remote on `domain` now: registered, proven ready by a message from
    /// that chain's V4 for the same owners hash, and the account's owners unchanged since (any owner change clears it).
    function isReady(address account, uint32 domain) public view returns (bool) {
        Ready memory y = _ready[domain][account];
        if (_isSibling(account)) {
            // #307: the sibling's own address on its home domain, for the owners the home chain's V4 read back.
            return domain == _config[account].homeDomain && y.remote == account && y.ownersHash != bytes32(0)
                && HELPER.ownersHashOf(account) == y.ownersHash;
        }
        Remote memory r = _remote[domain][account];
        return r.remote != address(0) && y.remote == r.remote && y.ownersHash == r.ownersHash
            && HELPER.ownersHashOf(account) == r.ownersHash;
    }

    // ---------------------------------------------------------------- internals: chain, entries, pools

    function _chain() internal view returns (MamoruV4Chains.Chain memory ch) {
        ch = TABLE.chain(block.chainid);
        if (ch.chainId == 0) revert UnsupportedChain(block.chainid);
    }

    /// #307: the account's Init names itself as home (its own address on another chain of the table).
    function _isSibling(address account) internal view returns (bool) {
        address h = _config[account].home;
        return h != address(0) && h == account;
    }

    function _live(address account) internal view returns (Config memory c) {
        c = _config[account];
        if (!c.set || c.generation != generationOf[account]) revert NoConfig(account);
    }

    // ---------------------------------------------------------------- internals: admission (V3)

    /// T6 M-4 at enable: a position the account owns, in a factory pool of pinned tokens, becomes manageable.
    function _admitAtEnable(address account, uint256 tokenId) internal {
        if (_admitted[tokenId][account] == REVOKED) return; // the owner revoked it: never again (M-4)
        address pool = HELPER.admissiblePool(account, tokenId);
        if (_admitted[tokenId][account] != pool) {
            _admitted[tokenId][account] = pool;
            emit Admitted(account, pool, tokenId);
        }
    }

    /// A position V4 admitted for the account and the owner did not revoke (ownership is checked where it matters: at
    /// execution, or by the position manager itself).
    function _isAdmitted(address pool) internal pure returns (bool) {
        return pool != address(0) && pool != REVOKED;
    }

    function _ticksOf(address npm, uint256 tokenId) internal view returns (int24 lower, int24 upper) {
        (,,,,, lower, upper,,,,,) = INPMV4(npm).positions(tokenId);
    }

    // ---------------------------------------------------------------- internals: tokens, math (V3)

    function _fund(address npm, address account, address t0, address t1, uint256 a0, uint256 a1)
        internal
        returns (uint256 b0, uint256 b1)
    {
        b0 = IERC20V4(t0).balanceOf(address(this));
        b1 = IERC20V4(t1).balanceOf(address(this));
        _pull(t0, account, a0);
        _pull(t1, account, a1);
        _approve(t0, npm, a0);
        _approve(t1, npm, a1);
    }

    function _settle(address npm, address account, address t0, address t1, uint256 b0, uint256 b1) internal {
        _approve(t0, npm, 0);
        _approve(t1, npm, 0);
        uint256 r0 = IERC20V4(t0).balanceOf(address(this)) - b0;
        uint256 r1 = IERC20V4(t1).balanceOf(address(this)) - b1;
        if (r0 != 0) _push(t0, account, r0);
        if (r1 != 0) _push(t1, account, r1);
    }

    function _pull(address token, address from, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        if (!ok || (r.length != 0 && !abi.decode(r, (bool)))) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (r.length != 0 && !abi.decode(r, (bool)))) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(APPROVE, spender, amount));
        if (!ok || (r.length != 0 && !abi.decode(r, (bool)))) revert TransferFailed();
    }

    function _room(uint256 cap, uint256 used) internal pure returns (uint256) {
        return cap > used ? cap - used : 0;
    }

}
