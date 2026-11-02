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
    address home; // address(0) on the home chain; on a remote Safe, the home account (bridge-back target, I4)
    uint32 homeDomain; // CCTP domain of `home`; 0 when home == address(0)
    uint256[] admit; // positions admitted at enable (migration), V3 T6 M-4; REVOKE_FLAG entries revoke
}

/// A pool's identity, cached by V4 once checked (immutable once the pool exists).
struct PoolInfoV4 {
    address token0;
    address token1;
    uint24 fee;
    bool in1; // budget unit: false = token0 (a pinned stable), true = token1
    bool stablePair; // both pinned stables: the registry entry must carry the parity anchor
}

/// MamoruRegistry.PoolEntry, field for field (one slot).
struct PoolEntryV4 {
    uint32 twapWindow;
    uint32 twapShortWindow;
    uint24 bandTicks;
    int24 anchorTick;
    uint24 anchorBand;
    uint16 ratioBps;
    bool active;
}

struct VaultEntryV4 {
    uint16 ratioBps;
    bool active;
}

interface IMamoruRegistryV4 {
    function poolOf(address pool) external view returns (PoolEntryV4 memory);
    function vaultOf(address vault) external view returns (VaultEntryV4 memory);
    function routeOn(uint32 domain) external view returns (bool);
}

interface IERC20V4 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
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
}

interface IMetaMorphoFactoryV4 {
    function isMetaMorpho(address target) external view returns (bool);
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

/// The two reads of MamoruActionPolicyV4 its helper's engine views make.
interface IPolicyRegistryV4 {
    function REGISTRY() external view returns (address);
    function admittedPool(address account, uint256 tokenId) external view returns (address);
}

interface ISafeOwnersV4 {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

/**
 * @title MamoruV4Helper (spec 010, otto/mamoru#292): the views of MamoruActionPolicyV4 that would put it over EIP-170.
 * @notice Created by V4's constructor (CREATE from V4's address), so its address and code follow from V4's own
 * init code, the same on every chain. No owner, no state but immutables set from V4's constructor (themselves
 * chain-independent). Views only:
 *  - V3's price checks (oracle range, anchor, spot, swap bounds, mint/increase minimums, decrease minimums), moved
 *    here unchanged from MamoruActionPolicyV3, which V4 runs at execution of its own actions.
 *  - `depthIn`: V3's LeftClaw M-5 tick walk, run at EVERY priced use (I2), with a step cap.
 *  - `ownerState`: the account's CURRENT owners, threshold and passkey (I4, r2 P0).
 *  - `remote`: the canonical remote Safe of an account on a domain, its owners hash and the relayer's factory call (I4).
 */
contract MamoruV4Helper {
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

    error UnknownDomain(uint32 domain);

    constructor(address gasPolicy, address remoteInit) {
        POLICY = msg.sender;
        GAS_POLICY = gasPolicy;
        REMOTE_INIT = remoteInit;
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
    bytes32 internal constant H_TOKEN_MESSENGER = 0xd2c8d48075d832fb7d07f6db5545a1bee37fdf886325c441a8dd1cef4c9dae99;

    error BadStack(uint256 which);
    error NotPinned(address token);
    error NotAFactoryPool(address pool);
    error BadVault(address vault);
    error NotAdmissible(uint256 tokenId);

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
    }

    /// A pool's identity, if V4 may price it at all: a factory pool of the chain's table whose two tokens are pinned,
    /// at least one a pinned stable (the budget unit; r2 P1: tokens are V4's, never the registry's).
    function poolInfo(address pool) external view returns (PoolInfoV4 memory p) {
        MamoruV4Chains.Chain memory ch = MamoruV4Chains.byChainId(block.chainid);
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

    /// Spec 010 "Vaults": its asset() is a pinned stable and a pinned MetaMorpho factory created it. Aave's wrapper
    /// is not admissible (no verified membership view).
    function vaultAsset(address vault) external view returns (address asset) {
        MamoruV4Chains.Chain memory ch = MamoruV4Chains.byChainId(block.chainid);
        if (vault.code.length == 0) revert BadVault(vault);
        bool member;
        for (uint256 i; i < 2; i++) {
            address f = ch.vaultFactories[i];
            if (f != address(0) && IMetaMorphoFactoryV4(f).isMetaMorpho(vault)) member = true;
        }
        if (!member) revert BadVault(vault);
        asset = IERC4626V4(vault).asset();
        if (!MamoruV4Chains.isStable(ch, asset)) revert NotPinned(asset);
    }

    /// T6 M-4: the pool of a position `account` owns, when it is a factory pool of pinned tokens (V4 admits it).
    function admissiblePool(address account, uint256 tokenId) external view returns (address pool) {
        MamoruV4Chains.Chain memory ch = MamoruV4Chains.byChainId(block.chainid);
        if (INPMV4(ch.npm).ownerOf(tokenId) != account) revert NotAdmissible(tokenId);
        (,, address t0, address t1, uint24 fee,,,,,,,) = INPMV4(ch.npm).positions(tokenId);
        pool = IUniswapV3Factory(ch.factory).getPool(t0, t1, fee);
        if (pool == address(0) || !MamoruV4Chains.isPinned(ch, t0) || !MamoruV4Chains.isPinned(ch, t1)) {
            revert NotAdmissible(tokenId);
        }
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

    // Views for the engine and precheck over the registry entry V4 reads now (V3's `priceRange`, `swapBounds` and
    // `decreaseMins`, which V4 itself does not carry, for EIP-170).

    /// The price range [lo, hi] every priced action in `pool` must stay in now.
    function priceRange(address pool) external view returns (int24 lo, int24 hi) {
        return this.priceRangeAt(pool, IMamoruRegistryV4(IPolicyRegistryV4(POLICY).REGISTRY()).poolOf(pool));
    }

    /// Smallest `amountOutMinimum` and the farthest `sqrtPriceLimitX96` V4.swap accepts now.
    function swapBounds(address pool, address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256 minOut, uint160 sqrtPriceLimitX96)
    {
        PoolInfoV4 memory p = this.poolInfo(pool);
        PoolEntryV4 memory e = IMamoruRegistryV4(IPolicyRegistryV4(POLICY).REGISTRY()).poolOf(pool);
        return this.swapBoundsAt(pool, p, e, tokenIn == p.token0, amountIn);
    }

    /// Smallest amount0Min / amount1Min V4's checkAction accepts for decreasing `liquidity` of `tokenId` now.
    function decreaseMins(address account, uint256 tokenId, uint128 liquidity) external view returns (uint256, uint256) {
        address pool = IPolicyRegistryV4(POLICY).admittedPool(account, tokenId);
        PoolEntryV4 memory e = IMamoruRegistryV4(IPolicyRegistryV4(POLICY).REGISTRY()).poolOf(pool);
        (bool ok, uint256 min0, uint256 min1) =
            this.exitMins(pool, e, MamoruV4Chains.byChainId(block.chainid).npm, tokenId, liquidity);
        if (!ok) revert RangeEmpty(0, 0);
        return (min0, min1);
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
        MamoruV4Chains.Chain memory dst = MamoruV4Chains.byDomain(domain);
        if (dst.chainId == 0) revert UnknownDomain(domain);
        MamoruRemoteSafe.OwnerState memory o = ownerState(account);
        ownersHash = MamoruRemoteSafe.ownersHash(o);
        bytes memory init = MamoruRemoteSafe.initializer(o, REMOTE_INIT, sessions(account, sessionKey, capUsd, homeDomain, dst));
        uint256 salt = uint256(keccak256(abi.encode(account, domain, ownersHash)));
        at = MamoruRemoteSafe.proxyAddress(init, salt);
        createCall = MamoruRemoteSafe.createProxyCall(init, salt);
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
 * @title MamoruActionPolicyV4 (spec 010 "one authorization", otto/mamoru#292). Not deployed.
 * @notice The ONLY action policy of a Mamoru account's ONE long-lived SmartSession session: a single fallback action
 * (`FALLBACK_TARGET_FLAG`, T1), so `checkAction` sees every call of every session userOp. The owner signs the rules
 * once (InitV4: the cap C, the generation, and for a remote Safe its home); which pools, vaults and chain routes the
 * engine may use come from MamoruRegistry (timelocked, I8), always inside V4's own constants and hard bounds.
 *
 * What changed from MamoruActionPolicyV3 (each change is commented where it is made, with the invariant it implements):
 *  - I1, approvals only to V4. Every spending action is a V4 function the session calls (`swap`, `mint`, `increase`,
 *    `deposit`, `redeem`, `bridge`). Each pulls the exact amount from msg.sender (the account), approves the pinned
 *    router / position manager / listed vault / messenger for exactly that amount, acts with the account as recipient,
 *    sets the allowance back to 0 and returns any rest. `checkAction` admits only: those V4 functions and
 *    `registerRemote`; `approve(V4, x)` on any token but the position manager; and the position manager's decrease,
 *    collect and burn of admitted positions (they move no tokens out of the account). Everything else is refused,
 *    direct router, position manager, messenger and vault calls included. All the checks of V3's validation-time
 *    swap / mint / increase / vault / bridge paths run INSIDE those functions, at execution, with msg.sender as the
 *    account: there is no window between the check and the action, and a failed check reverts the action instead of
 *    charging a budget for it (LeftClaw M-2's concern disappears; its checks stay).
 *  - Pinned per chain (MamoruV4Chains, keyed by block.chainid): factory, position manager, router, stables, assets,
 *    MetaMorpho factories, CCTP domain. Pools must be factory pools of pinned tokens with a pinned stable as the budget
 *    side; vaults MetaMorpho-factory vaults of a pinned stable; burn tokens pinned stables the canonical messenger's
 *    `localMinter` accepts. The Safe stack is checked by EXTCODEHASH at every enable.
 *  - I2: V3's two-TWAP band and anchor, with the registry entry's parameters (refused outside V3's hard bounds, never
 *    clamped), and the M-5 depth check at EVERY priced use: in-band depth >= DEPTH_MULTIPLE (20) x the call's value.
 *  - I4: `registerRemote` computes the account's remote Safe on a domain from its current owners (MamoruV4Helper);
 *    `bridge` burns only to a remote the guardian marked ready for the account's current owners hash, or, on a remote
 *    Safe, only back to its `home`.
 *  - I5: one bucket per account (capacity C per day), a sub-bucket per pool and per vault (ratioBps of C), a rolling
 *    30-day cap of 3C, a circuit breaker at C per 24 h and a review threshold at 10C since the guardian's last review;
 *    the last two pause the account by themselves (V4 holds the pause; no PauseGate).
 *  - V3's per-pool Init and per-generation `total` are gone (the registry and the 30-day cap replace them).
 * Kept from V3: the oracle range, anchor, swap bounds, mint/increase minimums at the spot, decrease minimums without the
 * anchor (M-6), admitted positions (minted here or admitted at enable, M-4 revocation), generation steps (H-1),
 * `initializeWithMultiplexer` only from SMART_SESSION, an enable that reads no live market state (setup mode: an
 * account's enable never depends on state that can change, so a remote initializer embeds it safely), the guardian's
 * revoke-only pause. Threat model: contracts/action-policy/SECURITY.md ("MamoruActionPolicyV4").
 *
 * Deployment (T7): CREATE2 through the canonical deterministic deployer, MamoruRegistry and MamoruGasPolicyV2 first,
 * then V4 with constructor arguments (registry, gas policy, guardian) that are the same on every chain, so V4 and what
 * its constructor creates (MamoruV4Helper, MamoruRemoteInit) have the same addresses and the same code everywhere;
 * nothing in the runtime code depends on the chain but the table lookups, which happen at call time.
 *
 * Validation-phase reads (registry, pool oracle, position manager) break ERC-7562 rules for unstaked entities; Mamoru
 * bundles its own userOps, as spec 007 accepts. V4's own validation reads are keyed by account where it can.
 */
contract MamoruActionPolicyV4 {
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;

    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant DECREASE = 0x0c49ccbe; // decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))
    bytes4 internal constant COLLECT = 0xfc6f7865; // collect((uint256,address,uint128,uint128))
    bytes4 internal constant BURN = 0x42966c68; // burn(uint256)

    address public constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    /// CCTP V2 TokenMessengerV2, the same proxy (same code hash) on every chain Circle supports; checked on Base and
    /// Monad (spec 010 T1). The burn token is checked against its own `localMinter()`, never taken from the registry.
    address public constant TOKEN_MESSENGER = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    /// CCTP V2 Standard transfer (attested at finality, no fee), as V3; Fast (1000) never.
    uint32 public constant CCTP_MIN_FINALITY = 2000;

    // Hard bounds on registry parameters: V3's, unchanged (a registry entry outside them is refused at use).
    uint32 public constant MIN_TWAP_WINDOW = 600;
    uint32 public constant MAX_TWAP_WINDOW = 86_400;
    uint32 public constant MIN_SHORT_WINDOW = 60;
    uint32 public constant MIN_WINDOW_RATIO = 4; // LeftClaw M-1
    uint24 public constant MIN_BAND = 2;
    uint24 public constant MAX_BAND = 500;
    uint16 public constant MAX_RATIO_BPS = 10_000;
    // I5 (r1 P1-7, r2 P1): the account's limits per chain, as multiples of the owner-signed C.
    uint256 public constant BUCKET_WINDOW = 1 days; // the bucket and sub-buckets refill C (resp. ratio x C) per day
    uint256 public constant BREAKER_PERIODS = 25; // hourly periods: at least the last 24 h
    uint256 public constant CAP30_PERIODS = 31; // daily periods: at least the last 30 days
    uint256 public constant CAP30_MULTIPLE = 3; // rolling 30-day cap: 3C
    uint256 public constant REVIEW_MULTIPLE = 10; // cumulative review threshold: 10C
    uint128 public constant MAX_CAP_USD = 1e15; // C <= 1e9 USD, far from every overflow below

    uint64 public constant MAX_GENERATION = type(uint32).max;
    uint64 public constant MAX_FIRST_GENERATION = type(uint16).max; // LeftClaw H-1
    uint256 public constant MAX_ADMIT = 64;
    uint256 public constant REVOKE_FLAG = 1 << 255; // LeftClaw M-4
    address internal constant REVOKED = address(1);

    uint8 public constant PAUSE_GUARDIAN = 1;
    uint8 public constant PAUSE_BREAKER = 2;
    uint8 public constant PAUSE_REVIEW = 4;

    IMamoruRegistryV4 public immutable REGISTRY;
    /// Revoke-only watchdog key, a separate process with no operator code path (I4, I7): pause, unpause, review, and
    /// mark a remote ready after reading it back on its chain. It can never enable, widen, or move a token.
    address public immutable GUARDIAN;
    MamoruV4Helper public immutable HELPER;
    MamoruGasPolicyV2 public immutable GAS_POLICY;
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

    struct Pause {
        uint64 at; // generation + 1 at the pause; a renewal (a higher generation) ends it, as in V3
        uint8 reasons; // PAUSE_* bits
    }

    /// I4: a registered remote, bound to the owner state it was computed from.
    struct Remote {
        address remote;
        bytes32 ownersHash;
        address sessionKey;
    }

    struct Ready {
        address remote;
        bytes32 ownersHash;
    }

    mapping(ConfigIdV4 => mapping(address account => uint64)) internal _binding; // generation + 1; 0 = none
    mapping(address account => uint64) public generationOf;
    mapping(address account => Config) internal _config;
    mapping(address account => mapping(uint256 tokenId => address pool)) public admittedPool;
    mapping(address pool => PoolInfoV4) internal _pool;
    mapping(address account => Pause) internal _pause;
    mapping(address account => Bucket) internal _accountBucket;
    mapping(address key => mapping(address account => Bucket)) internal _subBucket; // key = pool or vault
    mapping(address account => RollingSum.Ring) internal _spent24h;
    mapping(address account => RollingSum.Ring) internal _spent30d;
    mapping(address account => uint256) public spentSinceReview;
    mapping(uint32 domain => mapping(address account => Remote)) internal _remote;
    mapping(uint32 domain => mapping(address account => Ready)) internal _ready;

    uint256 private _locked = 1;

    event PolicySet(ConfigIdV4 id, address multiplexer, address account);
    event Admitted(address indexed account, address indexed pool, uint256 indexed tokenId);
    event Revoked(address indexed account, address indexed pool, uint256 indexed tokenId);
    event Paused(address indexed account, uint8 reasons, uint64 generation);
    event Unpaused(address indexed account);
    event Reviewed(address indexed account, uint256 spent);
    event Spent(address indexed account, address indexed key, uint256 value);
    event Swapped(address indexed account, address indexed pool, address tokenIn, uint256 amountIn, uint256 amountOut);
    event Deposited(address indexed account, address indexed vault, uint256 assets, uint256 shares);
    event Redeemed(address indexed account, address indexed vault, uint256 shares, uint256 assets);
    event Bridged(address indexed account, uint32 indexed domain, address indexed recipient, address token, uint256 amount);
    event RemoteRegistered(address indexed account, uint32 indexed domain, address remote, bytes32 ownersHash, address sessionKey);
    event RemoteReady(address indexed account, uint32 indexed domain, address remote, bytes32 ownersHash);

    error PolicyNotInitialized(ConfigIdV4 id, address multiplexer, address account);
    error OnlySmartSession();
    error OnlyGuardian();
    error BadInit(uint256 field);
    error UnsupportedChain(uint256 chainId);
    error StaleGeneration(uint64 given, uint64 current);
    error ConfigMismatch(address account, uint64 generation);
    error NoConfig(address account);
    error AccountPaused(address account);
    error NotAdmitted(uint256 tokenId);
    error NotListed(address key);
    error BadEntry(address key, uint256 field);
    error NotPinned(address token);
    error NotAFactoryPool(address pool);
    error ObservationCardinalityTooLow(uint16 cardinalityNext, uint32 twapWindow);
    error BudgetExceeded(address key, uint256 value);
    error Cap30Exceeded(uint256 spent, uint256 value);
    error WrongRecipient();
    error ZeroAmount();
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

    /// @param registry MamoruRegistry, @param gasPolicy MamoruGasPolicyV2, both CREATE2 at the same address on every
    /// chain; @param guardian the watchdog key (the gas policy's too). All the same on every chain (contract notice).
    constructor(address registry, address gasPolicy, address guardian) {
        if (registry == address(0) || guardian == address(0) || MamoruGasPolicyV2(gasPolicy).GUARDIAN() != guardian) {
            revert BadInit(0);
        }
        REGISTRY = IMamoruRegistryV4(registry);
        GUARDIAN = guardian;
        GAS_POLICY = MamoruGasPolicyV2(gasPolicy);
        // Created here so their addresses and code follow from V4's own init code (CREATE from V4, nonces 1 and 2):
        // the remote initializer V4 computes names them, and they exist at the same address wherever V4 does.
        REMOTE_INIT = new MamoruRemoteInit();
        HELPER = new MamoruV4Helper(gasPolicy, address(REMOTE_INIT));
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
        if (i.home == address(0) ? i.homeDomain != 0 : (i.home == account || i.homeDomain == ch.domain
                    || MamoruV4Chains.byDomain(i.homeDomain).chainId == 0)) revert BadInit(4);
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
                address was = admittedPool[account][id];
                if (was != REVOKED) {
                    admittedPool[account][id] = REVOKED;
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

    /// I1: the fallback action's only policy. Admits the V4 entry points, approvals to V4, and the position manager's
    /// exits of admitted positions; refuses every other call.
    function checkAction(ConfigIdV4 id, address account, address target, uint256 value, bytes calldata data)
        external
        returns (uint256)
    {
        if (msg.sender != SMART_SESSION) return VALIDATION_FAILED;
        uint64 b = _binding[id][account];
        if (b == 0) revert PolicyNotInitialized(id, msg.sender, account);
        if (b - 1 != generationOf[account]) return VALIDATION_FAILED; // retired by a renewal
        if (isPaused(account)) return VALIDATION_FAILED; // guardian, breaker or review (I5, I7)
        if (value != 0 || data.length < 4) return VALIDATION_FAILED; // no native value, no empty call (I6)
        bytes4 sel = bytes4(data[:4]);
        if (target == address(this)) {
            // Each of these acts on msg.sender (the account) only and runs every check itself, at execution.
            return sel == this.swap.selector || sel == this.mint.selector || sel == this.increase.selector
                || sel == this.deposit.selector || sel == this.redeem.selector || sel == this.bridge.selector
                || sel == this.registerRemote.selector ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        address npm = _chain().npm;
        if (target == npm) return _checkExit(account, npm, sel, data);
        // I1 (r3 P1): an approval only to V4, whose allowance only V4's own functions spend, for the account that
        // calls them. Never on the position manager (its `approve(to, tokenId)` shares the selector).
        if (sel == APPROVE && data.length == 68) {
            (address spender,) = abi.decode(data[4:], (address, uint256));
            return spender == address(this) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        return VALIDATION_FAILED;
    }

    /// V3's decrease / collect / burn checks, for positions admitted for the account that it still owns. A position in
    /// a pool the registry removed stays exit-only (I8): its entry's parameters still price the decrease.
    function _checkExit(address account, address npm, bytes4 sel, bytes calldata data) internal view returns (uint256) {
        if (sel == DECREASE) {
            DecreaseLiquidityParams memory d = abi.decode(data[4:], (DecreaseLiquidityParams));
            address pool = admittedPool[account][d.tokenId];
            if (!_isAdmitted(account, pool, d.tokenId)) return VALIDATION_FAILED;
            (PoolEntryV4 memory e, bool ok) = _entry(pool, false);
            if (!ok) return VALIDATION_FAILED;
            // LeftClaw M-6: the anchor never locks an exit.
            (bool inRange, uint256 min0, uint256 min1) = HELPER.exitMins(pool, e, npm, d.tokenId, d.liquidity);
            if (!inRange) return VALIDATION_FAILED;
            return d.amount0Min >= min0 && d.amount1Min >= min1 ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (sel == COLLECT) {
            CollectParams memory k = abi.decode(data[4:], (CollectParams));
            return _isAdmitted(account, admittedPool[account][k.tokenId], k.tokenId) && k.recipient == account
                ? VALIDATION_SUCCESS
                : VALIDATION_FAILED;
        }
        if (sel == BURN) {
            uint256 tokenId = abi.decode(data[4:], (uint256));
            return _isAdmitted(account, admittedPool[account][tokenId], tokenId) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        return VALIDATION_FAILED; // never mint, increaseLiquidity (it funds any tokenId, #171) or transfers
    }

    // ---------------------------------------------------------------- I1: the account's spending actions

    /// A swap on a listed pool through the pinned SwapRouter02, with the account as recipient. V3's validation-time
    /// swap checks, here at execution: recipient (fixed), fee (from the pool), amountIn != 0 (L-7), the anchored range
    /// and the spot inside it (M-2), amountOutMinimum and the price limit no looser than the range edge, the limit
    /// strictly past the spot (M-2), then I2's depth and I5's charge.
    function swap(SwapParams calldata s) external nonReentrant returns (uint256 amountOut) {
        address account = msg.sender;
        if (block.timestamp > s.deadline) revert Expired(); // V3's `multicall(deadline, [])`, now an argument
        Config memory c = _live(account);
        (PoolInfoV4 memory p, PoolEntryV4 memory e) = _priced(s.pool);
        if (s.amountIn == 0) revert ZeroAmount(); // LeftClaw L-7
        bool zeroForOne = s.tokenIn == p.token0;
        if (!zeroForOne && s.tokenIn != p.token1) revert NotPinned(s.tokenIn);
        // V3's swap checks and I2's depth (MamoruV4Helper.swapValue); reverts when any fails.
        uint256 v = HELPER.swapValue(s.pool, p, e, zeroForOne, s.amountIn, s.amountOutMinimum, s.sqrtPriceLimitX96);
        if (!_charge(account, c, s.pool, e.ratioBps, v)) return 0; // I5 breaker / review: paused, nothing moved
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
     * amounts. As V3's `mint`, with V3's validation-time checks (`_checkProvide`) moved here: a listed pool of pinned
     * tokens, the anchored range non-empty with the spot inside it, the manager's take at the spot meeting the
     * minimums (M-2), then I2's depth and I5's charge; after the pulls, the spot again right before the manager's call
     * (T6 I-7). The new position is admitted for the account.
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
        (PoolInfoV4 memory p, PoolEntryV4 memory e) = _priced(pool);
        if (m.token0 != p.token0) revert NotAFactoryPool(pool); // the manager takes the tokens in pool order
        if (!_provide(account, c, pool, p, e, m.amount0Desired, m.amount1Desired, m.tickLower, m.tickUpper, m.amount0Min, m.amount1Min)) {
            return (0, 0, 0, 0);
        }
        (uint256 b0, uint256 b1) = _fund(ch.npm, account, p.token0, p.token1, m.amount0Desired, m.amount1Desired);
        HELPER.requireSpotInRange(pool, e);
        (tokenId, liquidity, amount0, amount1) = INPMV4(ch.npm).mint(m);
        _settle(ch.npm, account, p.token0, p.token1, b0, b1);
        admittedPool[account][tokenId] = pool;
        emit Admitted(account, pool, tokenId);
    }

    /// As V3's `increase` (#171), with the same checks as `mint`, on a position admitted for the account that it
    /// still owns, in a pool the registry still lists (a removed pool is exit-only, I8).
    function increase(IncreaseLiquidityParams calldata n)
        external
        nonReentrant
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        address account = msg.sender;
        address pool = admittedPool[account][n.tokenId];
        if (!_isAdmitted(account, pool, n.tokenId)) revert NotAdmitted(n.tokenId);
        Config memory c = _live(account);
        (PoolInfoV4 memory p, PoolEntryV4 memory e) = _priced(pool);
        address npm = _chain().npm;
        (int24 lower, int24 upper) = _ticksOf(npm, n.tokenId);
        if (!_provide(account, c, pool, p, e, n.amount0Desired, n.amount1Desired, lower, upper, n.amount0Min, n.amount1Min)) {
            return (0, 0, 0);
        }
        (uint256 b0, uint256 b1) = _fund(npm, account, p.token0, p.token1, n.amount0Desired, n.amount1Desired);
        HELPER.requireSpotInRange(pool, e);
        (liquidity, amount0, amount1) = INPMV4(npm).increaseLiquidity(n);
        _settle(npm, account, p.token0, p.token1, b0, b1);
    }

    /// V3's `_checkProvide`, at execution: false only when I5's breaker or review threshold tripped.
    function _provide(
        address account,
        Config memory c,
        address pool,
        PoolInfoV4 memory p,
        PoolEntryV4 memory e,
        uint256 a0,
        uint256 a1,
        int24 lower,
        int24 upper,
        uint256 min0,
        uint256 min1
    ) internal returns (bool) {
        uint256 v = HELPER.provideValue(pool, p, e, a0, a1, lower, upper, min0, min1);
        return _charge(account, c, pool, e.ratioBps, v);
    }

    /**
     * I1 + spec 010 "Vaults" (r1 finding 3): a deposit into a vault the registry lists, whose asset is a pinned stable
     * and which a pinned MetaMorpho factory created, for exactly `assets`, shares to the account. Charged to the
     * bucket and capped by the vault's ratio (I5).
     */
    function deposit(address vault, uint256 assets) external nonReentrant returns (uint256 shares) {
        address account = msg.sender;
        Config memory c = _live(account);
        VaultEntryV4 memory e = REGISTRY.vaultOf(vault);
        if (!e.active) revert NotListed(vault);
        if (e.ratioBps == 0 || e.ratioBps > MAX_RATIO_BPS) revert BadEntry(vault, 6);
        address asset = HELPER.vaultAsset(vault);
        if (assets == 0) revert ZeroAmount();
        if (!_charge(account, c, vault, e.ratioBps, assets)) return 0;
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

    /// The account's own shares back into assets, to the account. Not charged (value returns to the account); allowed
    /// for a vault the registry removed (exit-only, I8) as long as it passes the factory and asset checks.
    function redeem(address vault, uint256 shares) external nonReentrant returns (uint256 assets) {
        address account = msg.sender;
        _live(account);
        if (REGISTRY.vaultOf(vault).ratioBps == 0) revert NotListed(vault); // never listed
        HELPER.vaultAsset(vault);
        if (shares == 0) revert ZeroAmount();
        _pull(vault, account, shares);
        assets = IERC4626V4(vault).redeem(shares, account, address(this));
        emit Redeemed(account, vault, shares, assets);
    }

    /**
     * I4: a CCTP V2 Standard burn of a pinned stable that the canonical messenger's own `localMinter` accepts, minted
     * only to (a) the account's remote on `domain`, when the registry routes it, the guardian marked that remote ready
     * for the account's CURRENT owners hash, and the owners did not change since; or (b) on a remote Safe, the home
     * account on its home domain, always (bridge-back). Open destinationCaller, no fee, as V3. Not charged: the value
     * stays the user's (the remote's own V4 bounds it there).
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
            recipient = c.home;
        } else {
            if (domain == ch.domain || MamoruV4Chains.byDomain(domain).chainId == 0) revert BadBridge(3);
            if (!REGISTRY.routeOn(domain)) revert NotListed(address(uint160(domain)));
            // r4 P0: readiness is the guardian's, for this remote and these owners; r3 P0-1: any owner change since
            // (a rotation in progress) stops every burn until the remote is re-registered and read back again.
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
     * never be named. Any new registration clears the domain's readiness; the guardian marks it ready again after the
     * remote is deployed and read back.
     */
    function registerRemote(uint32 domain, address sessionKey) external nonReentrant returns (address remote) {
        address account = msg.sender;
        Config memory c = _live(account);
        MamoruV4Chains.Chain memory ch = _chain();
        if (c.home != address(0)) revert BadBridge(4); // a remote has no remotes of its own
        if (sessionKey == address(0) || domain == ch.domain) revert BadBridge(5);
        if (!REGISTRY.routeOn(domain)) revert NotListed(address(uint160(domain)));
        bytes32 oh;
        (remote, oh,) = HELPER.remote(account, domain, sessionKey, c.capUsd, ch.domain);
        _remote[domain][account] = Remote(remote, oh, sessionKey);
        delete _ready[domain][account];
        emit RemoteRegistered(account, domain, remote, oh, sessionKey);
    }

    // ---------------------------------------------------------------- guardian: revoke-only, plus readiness (I4, I7)

    /// Marks `remote` ready for `account` on `domain`, after the guardian read it back on its chain (code at the
    /// address, owners, threshold, passkey, Safe7579, SmartSession and the session bound to V4). Only the registered
    /// remote, and only while the account's owners are still those it was computed from. Moves nothing.
    function setReady(address account, uint32 domain, address remote) external {
        if (msg.sender != GUARDIAN) revert OnlyGuardian();
        Remote memory r = _remote[domain][account];
        if (r.remote == address(0) || r.remote != remote) revert RemoteNotReady(domain);
        if (HELPER.ownersHashOf(account) != r.ownersHash) revert RemoteNotReady(domain);
        _ready[domain][account] = Ready(remote, r.ownersHash);
        emit RemoteReady(account, domain, remote, r.ownersHash);
    }

    function clearReady(address account, uint32 domain) external {
        if (msg.sender != GUARDIAN) revert OnlyGuardian();
        delete _ready[domain][account];
        emit RemoteReady(account, domain, address(0), bytes32(0));
    }

    function pause(address account) external {
        if (msg.sender != GUARDIAN) revert OnlyGuardian();
        _trip(account, PAUSE_GUARDIAN);
    }

    /// Ends every pause reason (guardian, breaker, review); it never widens the owner-signed envelope.
    function unpause(address account) external {
        if (msg.sender != GUARDIAN) revert OnlyGuardian();
        _pause[account].reasons = 0;
        emit Unpaused(account);
    }

    /// I5 (r2 P1): the guardian checked the account's ledger. Resets the cumulative counter and ends a review pause.
    function review(address account) external {
        if (msg.sender != GUARDIAN) revert OnlyGuardian();
        emit Reviewed(account, spentSinceReview[account]);
        spentSinceReview[account] = 0;
        _pause[account].reasons &= ~PAUSE_REVIEW;
    }

    function isPaused(address account) public view returns (bool) {
        Pause memory p = _pause[account];
        return p.reasons != 0 && p.at == generationOf[account] + 1;
    }

    // ---------------------------------------------------------------- I5: the account's bucket, caps and breaker

    /**
     * Charges `v` (USD units) to the account on this chain. Reverts (nothing written) when the account bucket, the
     * key's sub-bucket (ratioBps of C) or the rolling 30-day cap (3C) would be passed. Returns false, after pausing the
     * account, when the spend over the last 24 h would pass C (the breaker) or the spend since the guardian's last
     * review would pass 10C: the crossing call is never executed, so neither bound is ever passed, and the pause holds
     * until the guardian (`unpause`, `review`) or the owner (a renewal) ends it.
     */
    function _charge(address account, Config memory c, address key, uint16 ratioBps, uint256 v) internal returns (bool) {
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
        if (RollingSum.total(_spent24h[account], hour, BREAKER_PERIODS) + v > cap) {
            _trip(account, PAUSE_BREAKER);
            return false;
        }
        if (spentSinceReview[account] + v > REVIEW_MULTIPLE * cap) {
            _trip(account, PAUSE_REVIEW);
            return false;
        }
        _accountBucket[account] = Bucket(uint128(da), uint64(block.timestamp), uint64(cap));
        _subBucket[key][account] = Bucket(uint128(dk), uint64(block.timestamp), uint64(kcap));
        RollingSum.add(_spent30d[account], day, CAP30_PERIODS, v);
        RollingSum.add(_spent24h[account], hour, BREAKER_PERIODS, v);
        spentSinceReview[account] += v;
        emit Spent(account, key, v);
        return true;
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

    function _trip(address account, uint8 reason) internal {
        Pause storage p = _pause[account];
        uint64 g = generationOf[account];
        if (p.at != g + 1) (p.at, p.reasons) = (g + 1, 0); // a pause of an older generation is over
        p.reasons |= reason;
        emit Paused(account, p.reasons, g);
    }

    // ---------------------------------------------------------------- views the engine, precheck and guardian use

    function configOf(address account) external view returns (Config memory) {
        return _config[account];
    }

    function pauseOf(address account) external view returns (Pause memory) {
        return _pause[account];
    }

    /// Room now, in USD units: the account bucket, `key`'s sub-bucket at its current ratio, the 30-day cap, the 24 h
    /// breaker and the review threshold.
    function budgetLeft(address account, address key, uint16 ratioBps)
        external
        view
        returns (uint256 bucket, uint256 sub, uint256 cap30, uint256 breaker, uint256 untilReview)
    {
        uint256 cap = _config[account].capUsd;
        bucket = cap - _debtNow(_accountBucket[account], cap);
        uint256 kcap = cap * ratioBps / MAX_RATIO_BPS;
        sub = kcap - _debtNow(_subBucket[key][account], kcap);
        cap30 = _room(CAP30_MULTIPLE * cap, RollingSum.total(_spent30d[account], block.timestamp / 1 days, CAP30_PERIODS));
        breaker = _room(cap, RollingSum.total(_spent24h[account], block.timestamp / 1 hours, BREAKER_PERIODS));
        untilReview = _room(REVIEW_MULTIPLE * cap, spentSinceReview[account]);
    }

    function remoteOf(address account, uint32 domain) external view returns (Remote memory) {
        return _remote[domain][account];
    }

    function readyOf(address account, uint32 domain) external view returns (Ready memory) {
        return _ready[domain][account];
    }

    /// Whether `bridge` would burn to the account's remote on `domain` now: registered, marked ready by the guardian
    /// for the same owners hash, and the account's owners unchanged since (any owner change clears it, I4).
    function isReady(address account, uint32 domain) public view returns (bool) {
        Remote memory r = _remote[domain][account];
        Ready memory y = _ready[domain][account];
        return r.remote != address(0) && y.remote == r.remote && y.ownersHash == r.ownersHash
            && HELPER.ownersHashOf(account) == r.ownersHash;
    }

    /// The relayer's permissionless deployment of the registered remote, from the account's current owners (equal to
    /// the registered address only while they have not changed: the guardian compares before `setReady`).
    function remoteDeployment(address account, uint32 domain) external view returns (address at, bytes memory createCall) {
        Remote memory r = _remote[domain][account];
        if (r.remote == address(0)) revert RemoteNotReady(domain);
        (at,, createCall) = HELPER.remote(account, domain, r.sessionKey, _config[account].capUsd, _chain().domain);
    }

    // ---------------------------------------------------------------- internals: chain, entries, pools

    function _chain() internal view returns (MamoruV4Chains.Chain memory ch) {
        ch = MamoruV4Chains.byChainId(block.chainid);
        if (ch.chainId == 0) revert UnsupportedChain(block.chainid);
    }

    function _live(address account) internal view returns (Config memory c) {
        c = _config[account];
        if (!c.set || c.generation != generationOf[account]) revert NoConfig(account);
        if (isPaused(account)) revert AccountPaused(account);
    }

    /// The registry entry of `pool`, checked against V4's hard bounds (refused, never clamped: an entry outside them
    /// is as good as unlisted). `needActive` false: a removed pool's entry, for exits (I8).
    function _entry(address pool, bool needActive) internal view returns (PoolEntryV4 memory e, bool ok) {
        e = REGISTRY.poolOf(pool);
        if (e.twapWindow == 0 || (needActive && !e.active)) return (e, false);
        ok = e.twapWindow >= MIN_TWAP_WINDOW && e.twapWindow <= MAX_TWAP_WINDOW && e.twapShortWindow >= MIN_SHORT_WINDOW
            && uint256(e.twapShortWindow) * MIN_WINDOW_RATIO <= e.twapWindow && e.bandTicks >= MIN_BAND
            && e.bandTicks <= MAX_BAND && e.anchorBand <= MAX_BAND && e.ratioBps != 0 && e.ratioBps <= MAX_RATIO_BPS;
    }

    /// A pool every priced action may use now: listed and active, within bounds, a factory pool of pinned tokens with a
    /// pinned stable as the budget side (r2 P1: tokens are V4's, never the registry's), a stable pair anchored at parity,
    /// and an observation ring long enough for the window (T6 L-4, at every use).
    function _priced(address pool) internal returns (PoolInfoV4 memory p, PoolEntryV4 memory e) {
        bool ok;
        (e, ok) = _entry(pool, true);
        if (!ok) revert NotListed(pool);
        p = _poolInfo(pool);
        if (p.stablePair && (e.anchorBand == 0 || e.anchorTick != 0)) revert BadEntry(pool, 5);
        (,,,, uint16 next,,) = IUniswapV3Pool(pool).slot0();
        if (next < e.twapWindow) revert ObservationCardinalityTooLow(next, e.twapWindow);
    }

    function _poolInfo(address pool) internal returns (PoolInfoV4 memory p) {
        p = _pool[pool];
        if (p.token0 != address(0)) return p;
        p = HELPER.poolInfo(pool);
        _pool[pool] = p;
    }

    // ---------------------------------------------------------------- internals: admission (V3)

    /// T6 M-4 at enable: a position the account owns, in a factory pool of pinned tokens, becomes manageable.
    function _admitAtEnable(address account, uint256 tokenId) internal {
        if (admittedPool[account][tokenId] == REVOKED) return; // the owner revoked it: never again (M-4)
        address pool = HELPER.admissiblePool(account, tokenId);
        if (admittedPool[account][tokenId] != pool) {
            admittedPool[account][tokenId] = pool;
            emit Admitted(account, pool, tokenId);
        }
    }

    function _isAdmitted(address account, address pool, uint256 tokenId) internal view returns (bool) {
        return pool != address(0) && pool != REVOKED && admittedPool[account][tokenId] == pool
            && INPMV4(_chain().npm).ownerOf(tokenId) == account;
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
