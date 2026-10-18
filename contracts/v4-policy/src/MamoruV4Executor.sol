// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolKey} from "./PoolKey.sol";

interface IV4PositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256 info);
}

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IERC20Calls {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
}

/**
 * @title MamoruV4Executor (otto/mamoru#182). Not audited, not deployed. Not for live funds before an external audit.
 * @notice The flat-argument alternative to MamoruV4LiquidityPolicy. The Safe calls this contract (msg.sender = the
 * account) with static arguments only, and the contract writes the v4 action program itself. Every argument sits at a
 * fixed calldata word, so the stock UniActionPolicy can pin it:
 *
 *   word  0..4  PoolKey (currency0, currency1, fee, tickSpacing, hooks)          EQUAL x5 (pins pool and hook)
 *   word  5     tickLower + 2^23 (uint24)                                      IN_RANGE
 *   word  6     tickUpper + 2^23 (uint24)                                      IN_RANGE
 *   word  7..   tokenId / liquidity / amounts / deadline, per function         LESS_THAN_OR_EQUAL on amounts
 *
 * Ticks travel biased by 2^23 because UniActionPolicy compares 32-byte words unsigned: a negative int24 is a huge word,
 * and a range across zero cannot be written. Biased, every tick is a small positive number and IN_RANGE means what it
 * says. The same (key, ticks) prefix is on every function, and on an existing tokenId the contract proves it equal to the
 * position's real pool and ticks, so the session's rules bind increase/decrease/burn too.
 *
 * What the contract fixes by construction (no argument for it exists): the NFT owner and every recipient are
 * msg.sender; the program is exactly MINT+SETTLE_PAIR, INCREASE+CLOSE+CLOSE, DECREASE+TAKE_PAIR or BURN+TAKE_PAIR;
 * hookData is empty; no native value.
 *
 * Custody: the account approves this contract for ERC-20 amounts (pulled and spent or returned in the same call) and
 * calls PositionManager.setApprovalForAll(this) once, because v4 increase/decrease/burn require the locker to be
 * approved. That approval is the systemic risk of this design: every account's positions are reachable by this one
 * contract, and the only thing standing between them is `ownerOf(tokenId) == msg.sender` below.
 */
contract MamoruV4Executor {
    // v4-periphery src/libraries/Actions.sol
    uint8 internal constant INCREASE_LIQUIDITY = 0x00;
    uint8 internal constant DECREASE_LIQUIDITY = 0x01;
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant BURN_POSITION = 0x03;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    uint8 internal constant TAKE_PAIR = 0x11;
    uint8 internal constant CLOSE_CURRENCY = 0x12;

    uint256 public constant TICK_BIAS = 1 << 23;
    /// v4-core Hooks.sol: AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG.
    uint160 internal constant LIQUIDITY_DELTA_FLAGS = (1 << 1) | (1 << 0);

    IV4PositionManager public immutable POSITION_MANAGER;
    address public immutable PERMIT2;

    /// Transient reentrancy lock.
    bytes32 internal constant LOCK_SLOT = keccak256("mamoru.v4executor.lock");

    error Reentrancy();
    error NotOwner();
    error PositionMismatch();
    error NativeCurrency();
    error LiquidityDeltaHook();
    error TransferFailed();
    error MintedToWrongOwner();

    constructor(address positionManager, address permit2) {
        POSITION_MANAGER = IV4PositionManager(positionManager);
        PERMIT2 = permit2;
    }

    modifier nonReentrant() {
        bytes32 slot = LOCK_SLOT;
        uint256 locked;
        assembly {
            locked := tload(slot)
        }
        if (locked != 0) revert Reentrancy();
        assembly {
            tstore(slot, 1)
        }
        _;
        assembly {
            tstore(slot, 0)
        }
    }

    // ------------------------------------------------------------------ entry points (msg.sender = the account)

    /// Mints a position owned by msg.sender. Pulls at most amount0Max/amount1Max, returns what the pool did not take.
    function mint(
        PoolKey calldata key,
        uint24 tickLowerBiased,
        uint24 tickUpperBiased,
        uint256 liquidity,
        uint128 amount0Max,
        uint128 amount1Max,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokenId) {
        _checkKey(key);
        tokenId = POSITION_MANAGER.nextTokenId();
        _pull(key.currency0, amount0Max);
        _pull(key.currency1, amount1Max);

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            _tick(tickLowerBiased),
            _tick(tickUpperBiased),
            liquidity,
            amount0Max,
            amount1Max,
            msg.sender,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params), deadline);

        _refund(key.currency0);
        _refund(key.currency1);
        if (POSITION_MANAGER.ownerOf(tokenId) != msg.sender) revert MintedToWrongOwner();
    }

    /// Adds liquidity to msg.sender's position. Accrued fees come back with the refund (CLOSE_CURRENCY takes a credit).
    function increase(
        PoolKey calldata key,
        uint24 tickLowerBiased,
        uint24 tickUpperBiased,
        uint256 tokenId,
        uint256 liquidity,
        uint128 amount0Max,
        uint128 amount1Max,
        uint256 deadline
    ) external nonReentrant {
        _checkKey(key);
        _checkPosition(key, tickLowerBiased, tickUpperBiased, tokenId);
        _pull(key.currency0, amount0Max);
        _pull(key.currency1, amount1Max);

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(tokenId, liquidity, amount0Max, amount1Max, bytes(""));
        params[1] = abi.encode(key.currency0);
        params[2] = abi.encode(key.currency1);
        POSITION_MANAGER.modifyLiquidities(
            abi.encode(abi.encodePacked(INCREASE_LIQUIDITY, CLOSE_CURRENCY, CLOSE_CURRENCY), params), deadline
        );

        _refund(key.currency0);
        _refund(key.currency1);
    }

    /// Removes liquidity (0 = collect fees only). Both currencies go straight to msg.sender.
    function decrease(
        PoolKey calldata key,
        uint24 tickLowerBiased,
        uint24 tickUpperBiased,
        uint256 tokenId,
        uint256 liquidity,
        uint128 amount0Min,
        uint128 amount1Min,
        uint256 deadline
    ) external nonReentrant {
        _checkKey(key);
        _checkPosition(key, tickLowerBiased, tickUpperBiased, tokenId);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, liquidity, amount0Min, amount1Min, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, msg.sender);
        POSITION_MANAGER.modifyLiquidities(
            abi.encode(abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR), params), deadline
        );
    }

    /// Burns msg.sender's position (removing what liquidity is left). Both currencies go straight to msg.sender.
    function burn(
        PoolKey calldata key,
        uint24 tickLowerBiased,
        uint24 tickUpperBiased,
        uint256 tokenId,
        uint128 amount0Min,
        uint128 amount1Min,
        uint256 deadline
    ) external nonReentrant {
        _checkKey(key);
        _checkPosition(key, tickLowerBiased, tickUpperBiased, tokenId);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, amount0Min, amount1Min, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, msg.sender);
        POSITION_MANAGER.modifyLiquidities(abi.encode(abi.encodePacked(BURN_POSITION, TAKE_PAIR), params), deadline);
    }

    // ------------------------------------------------------------------ internals

    function _checkKey(PoolKey calldata key) internal pure {
        if (key.currency0 == address(0)) revert NativeCurrency();
        if (uint160(key.hooks) & LIQUIDITY_DELTA_FLAGS != 0) revert LiquidityDeltaHook();
    }

    /// The critical check of this design: the caller owns the position (an operator approval to the caller is not
    /// enough), and the (key, ticks) the session's rules saw are the position's real ones.
    function _checkPosition(PoolKey calldata key, uint24 lowerBiased, uint24 upperBiased, uint256 tokenId)
        internal
        view
    {
        if (POSITION_MANAGER.ownerOf(tokenId) != msg.sender) revert NotOwner();
        (PoolKey memory real, uint256 info) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
        if (keccak256(abi.encode(real)) != keccak256(abi.encode(key))) revert PositionMismatch();
        // v4-periphery PositionInfoLibrary: tickLower at bit 8, tickUpper at bit 32, 24 bits each, signed.
        // forge-lint: disable-next-line(unsafe-typecast) -- truncation to the packed 24-bit fields is the decoding
        if (int24(uint24(info >> 8)) != _tick(lowerBiased) || int24(uint24(info >> 32)) != _tick(upperBiased)) {
            revert PositionMismatch();
        }
    }

    function _tick(uint24 biased) internal pure returns (int24) {
        // forge-lint: disable-next-line(unsafe-typecast) -- uint24 minus 2^23 always fits int24
        return int24(int256(uint256(biased)) - int256(TICK_BIAS));
    }

    /// Pulls `amount` from the account and lets PositionManager take it through Permit2, for this block only.
    function _pull(address token, uint256 amount) internal {
        if (amount == 0) return;
        _call(token, abi.encodeCall(IERC20Calls.transferFrom, (msg.sender, address(this), amount)));
        if (IERC20Calls(token).allowance(address(this), PERMIT2) < amount) {
            _call(token, abi.encodeCall(IERC20Calls.approve, (PERMIT2, type(uint256).max)));
        }
        // expiration 0 = block.timestamp in Permit2: the allowance dies with this block.
        // forge-lint: disable-next-line(unsafe-typecast) -- amount comes from a uint128 argument
        IPermit2Approve(PERMIT2).approve(token, address(POSITION_MANAGER), uint160(amount), 0);
    }

    /// The contract holds nothing between calls; whatever it holds after a step belongs to the caller.
    function _refund(address token) internal {
        uint256 bal = IERC20Calls(token).balanceOf(address(this));
        if (bal != 0) _call(token, abi.encodeCall(IERC20Calls.transfer, (msg.sender, bal)));
    }

    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || (ret.length == 0 && token.code.length == 0)) {
            revert TransferFailed();
        }
    }
}
