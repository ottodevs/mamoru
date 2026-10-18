// SPDX-License-Identifier: GPL-2.0-or-later
// GPL because it links Uniswap's TickMath, OracleLibrary and LiquidityAmounts (GPL-2.0-or-later). See spec 007, open questions.
pragma solidity ^0.8.28;

import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {OracleLibrary} from "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";

/// SmartSession's policy id type (erc7579/smartsessions DataTypes.sol).
type ConfigId is bytes32;

/// erc7579/smartsessions contracts/interfaces/IPolicy.sol, reduced to what this policy implements.
interface IActionPolicy {
    function initializeWithMultiplexer(address account, ConfigId configId, bytes calldata initData) external;
    function checkAction(ConfigId id, address account, address target, uint256 value, bytes calldata data)
        external
        returns (uint256);
}

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
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

struct IncreaseLiquidityParams {
    uint256 tokenId;
    uint256 amount0Desired;
    uint256 amount1Desired;
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

interface INPM {
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
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title MamoruActionPolicy (spec 007, otto/mamoru#151). PoC, not audited, not deployed.
 * @notice A SmartSession action policy that sits NEXT TO UniActionPolicy on every action of a Mamoru grant. It only
 * adds refusals: price bounds from the pool's own TWAP, a per-account set of admitted positions, cumulative budgets
 * per window and per approval, and a generation number that retires every older grant of the account at renewal.
 *
 * It is also the only way a session can mint: the grant names `MamoruActionPolicy.mint` instead of the position
 * manager's `mint`, so the policy learns the new tokenId from the manager's return value and admits it. A tokenId
 * never minted through here for this account cannot be decreased, collected, burned or added to by a session.
 *
 * Adding liquidity goes through `MamoruActionPolicy.increase` for the same reason (otto/mamoru#171): the manager's
 * `increaseLiquidity` does not check who owns the tokenId, so a session allowed to call it directly could push the
 * Safe's tokens into anyone's position. Through here it reaches only admitted positions the account still owns, so one
 * owner signature covers every position the engine opens later, with no grant per tokenId.
 *
 * Validation-phase reads (pool oracle, position manager, block.timestamp) break ERC-7562 public-mempool rules. Mamoru
 * bundles its own userOps (apps/mamoru-operator/src/bundler.ts); an attacker with a leaked key can call handleOps
 * directly, and the policy binds them the same way. See spec 007 "ERC-7562".
 */
contract MamoruActionPolicy is IActionPolicy {
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;

    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant EXACT_INPUT_SINGLE = 0x04e45aaf; // SwapRouter02 exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
    bytes4 internal constant DECREASE = 0x0c49ccbe; // decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))
    bytes4 internal constant COLLECT = 0xfc6f7865; // collect((uint256,address,uint128,uint128))
    bytes4 internal constant BURN = 0x42966c68; // burn(uint256)

    address public immutable SMART_SESSION;
    INPM public immutable NPM;
    address public immutable ROUTER;
    IUniswapV3Factory public immutable FACTORY;

    /// Owner-signed init data of one session action (abi.encode of this struct).
    struct Init {
        address pool; // the one pool the grant covers (a Uniswap v3 factory pool)
        uint32 twapWindow; // seconds of the pool's own oracle
        uint24 bandTicks; // max distance of any execution price from the TWAP, in ticks (1 tick = 1 bp of price)
        uint64 generation; // approval number of the account; a higher one retires every lower one
        uint32 budgetWindow; // seconds; spend of token0/token1 is summed per window...
        uint128 perWindow0;
        uint128 perWindow1;
        uint128 total0; // ...and over the whole approval (this generation)
        uint128 total1;
    }

    struct Config {
        address pool;
        uint32 twapWindow;
        uint24 bandTicks;
        uint64 generation;
    }

    struct PoolInfo {
        address token0;
        address token1;
        uint24 fee;
    }

    struct Budget {
        uint32 window;
        uint128 perWindow0;
        uint128 perWindow1;
        uint128 total0;
        uint128 total1;
    }

    struct Spend {
        uint64 epoch;
        uint64 generation;
        uint128 window0;
        uint128 window1;
        uint128 total0;
        uint128 total1;
    }

    mapping(ConfigId => mapping(address account => Config)) internal _config;
    mapping(address account => uint64) public generationOf;
    /// Account-level copy of the current config per pool: `mint` runs at execution time, where no ConfigId is known.
    mapping(address account => mapping(address pool => Config)) internal _poolConfig;
    mapping(address account => mapping(address pool => Budget)) internal _budget;
    mapping(address account => mapping(address pool => Spend)) internal _spend;
    /// tokenId => pool, for positions minted through `mint` with this account as recipient.
    mapping(address account => mapping(uint256 tokenId => address pool)) public admittedPool;
    mapping(address pool => PoolInfo) internal _pool;

    uint256 private _locked = 1;

    event PolicySet(ConfigId id, address multiplexer, address account);
    event Admitted(address indexed account, address indexed pool, uint256 indexed tokenId);

    error PolicyNotInitialized(ConfigId id, address multiplexer, address account);
    error OnlySmartSession();
    error NotAFactoryPool(address pool);
    error StaleGeneration(uint64 given, uint64 current);
    error NoConfig(address account, address pool);
    error WrongPool();
    error WrongRecipient();
    error SpotOutsideBand(int24 spot, int24 twap, uint24 band);
    error NotAdmitted(address account, uint256 tokenId);
    error Reentrancy();
    error TransferFailed();

    constructor(address smartSession, address npm, address router, address factory) {
        SMART_SESSION = smartSession;
        NPM = INPM(npm);
        ROUTER = router;
        FACTORY = IUniswapV3Factory(factory);
    }

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        return interfaceID == 0x01ffc9a7 // IERC165
            || interfaceID == IActionPolicy.checkAction.selector // SmartSession checks the action-policy selector
            || interfaceID == IActionPolicy.initializeWithMultiplexer.selector;
    }

    // ---------------------------------------------------------------- init (owner-signed, via SmartSession)

    function initializeWithMultiplexer(address account, ConfigId configId, bytes calldata initData) external {
        // Account-level state (generation, budgets, admitted set) must never be writable by an arbitrary
        // "multiplexer", unlike UniActionPolicy's purely per-multiplexer storage.
        if (msg.sender != SMART_SESSION) revert OnlySmartSession();
        Init memory i = abi.decode(initData, (Init));
        _poolInfo(i.pool); // refuses a non-factory pool, caches token0/token1/fee
        uint64 current = generationOf[account];
        if (i.generation < current) revert StaleGeneration(i.generation, current);
        if (i.generation > current) generationOf[account] = i.generation;
        Config memory c =
            Config({pool: i.pool, twapWindow: i.twapWindow, bandTicks: i.bandTicks, generation: i.generation});
        _config[configId][account] = c;
        _poolConfig[account][i.pool] = c;
        _budget[account][i.pool] = Budget({
            window: i.budgetWindow,
            perWindow0: i.perWindow0,
            perWindow1: i.perWindow1,
            total0: i.total0,
            total1: i.total1
        });
        emit PolicySet(configId, msg.sender, account);
    }

    // ---------------------------------------------------------------- validation (SmartSession -> policy)

    function checkAction(ConfigId id, address account, address target, uint256 value, bytes calldata data)
        external
        returns (uint256)
    {
        if (msg.sender != SMART_SESSION) return VALIDATION_FAILED;
        Config memory c = _config[id][account];
        if (c.pool == address(0)) revert PolicyNotInitialized(id, msg.sender, account);
        if (c.generation != generationOf[account]) return VALIDATION_FAILED; // retired by a renewal
        if (value != 0 || data.length < 4) return VALIDATION_FAILED;
        PoolInfo memory p = _pool[c.pool];
        bytes4 sel = bytes4(data[:4]);

        if (target == ROUTER && sel == EXACT_INPUT_SINGLE) {
            ExactInputSingleParams memory s = abi.decode(data[4:], (ExactInputSingleParams));
            if (!_swapOk(c, p, account, s)) return VALIDATION_FAILED;
            return
                _spendOk(
                    account, c.pool, s.tokenIn == p.token0 ? s.amountIn : 0, s.tokenIn == p.token1 ? s.amountIn : 0
                );
        }
        if (target == address(this) && sel == this.mint.selector) {
            MintParams memory m = abi.decode(data[4:], (MintParams));
            if (m.token0 != p.token0 || m.token1 != p.token1 || m.fee != p.fee || m.recipient != account) {
                return VALIDATION_FAILED;
            }
            // Desired amounts are an upper bound of what the mint takes: the budget is charged conservatively.
            return _spendOk(account, c.pool, m.amount0Desired, m.amount1Desired);
        }
        if (target == address(this) && sel == this.increase.selector) {
            IncreaseLiquidityParams memory n = abi.decode(data[4:], (IncreaseLiquidityParams));
            if (!_isAdmitted(account, c.pool, n.tokenId)) return VALIDATION_FAILED;
            // Same budget as a mint: desired amounts are an upper bound of what the manager takes.
            return _spendOk(account, c.pool, n.amount0Desired, n.amount1Desired);
        }
        if (target == address(NPM) && sel == DECREASE) {
            DecreaseLiquidityParams memory d = abi.decode(data[4:], (DecreaseLiquidityParams));
            if (!_isAdmitted(account, c.pool, d.tokenId)) return VALIDATION_FAILED;
            (uint256 min0, uint256 min1) = _decreaseMins(c, d.tokenId, d.liquidity);
            return d.amount0Min >= min0 && d.amount1Min >= min1 ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (target == address(NPM) && sel == COLLECT) {
            CollectParams memory k = abi.decode(data[4:], (CollectParams));
            return
                _isAdmitted(account, c.pool, k.tokenId) && k.recipient == account
                    ? VALIDATION_SUCCESS
                    : VALIDATION_FAILED;
        }
        if (target == address(NPM) && sel == BURN) {
            uint256 tokenId = abi.decode(data[4:], (uint256));
            return _isAdmitted(account, c.pool, tokenId) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (sel == APPROVE && (target == p.token0 || target == p.token1)) {
            (address spender,) = abi.decode(data[4:], (address, uint256));
            // Caps on the amount stay in UniActionPolicy; here only who may pull: the router or this policy's mint.
            return spender == ROUTER || spender == address(this) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        return VALIDATION_FAILED;
    }

    // ---------------------------------------------------------------- execution: the only session mint path

    /**
     * @notice Called BY THE ACCOUNT (msg.sender) inside a session batch, after approving this contract for at most the
     * desired amounts. Pulls them, mints with the account as recipient, returns what the manager did not take, admits
     * the new tokenId. Refuses when the pool's spot tick is more than `bandTicks` from its TWAP.
     */
    function mint(MintParams calldata m)
        external
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        address account = msg.sender;
        if (m.recipient != account) revert WrongRecipient();
        address pool = FACTORY.getPool(m.token0, m.token1, m.fee);
        Config memory c = _poolConfig[account][pool];
        if (pool == address(0) || c.pool != pool || c.generation != generationOf[account]) {
            revert NoConfig(account, pool);
        }
        (, int24 spot,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 twap = _twapTick(c);
        if (_absDiff(spot, twap) > c.bandTicks) revert SpotOutsideBand(spot, twap, c.bandTicks);

        _pull(m.token0, account, m.amount0Desired);
        _pull(m.token1, account, m.amount1Desired);
        _approve(m.token0, address(NPM), m.amount0Desired);
        _approve(m.token1, address(NPM), m.amount1Desired);
        (tokenId, liquidity, amount0, amount1) = NPM.mint(m);
        _approve(m.token0, address(NPM), 0);
        _approve(m.token1, address(NPM), 0);
        if (m.amount0Desired > amount0) _push(m.token0, account, m.amount0Desired - amount0);
        if (m.amount1Desired > amount1) _push(m.token1, account, m.amount1Desired - amount1);

        admittedPool[account][tokenId] = pool;
        emit Admitted(account, pool, tokenId);
        _locked = 1;
    }

    /**
     * @notice Called BY THE ACCOUNT (msg.sender) inside a session batch, after approving this contract for at most the
     * desired amounts. Adds liquidity to a position this policy admitted for the account and the account still owns,
     * at the current generation, with the pool's spot within `bandTicks` of its TWAP (the same execution check as
     * `mint`). Returns what the manager did not take. Admission does not change.
     */
    function increase(IncreaseLiquidityParams calldata n)
        external
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        address account = msg.sender;
        address pool = admittedPool[account][n.tokenId];
        if (pool == address(0) || NPM.ownerOf(n.tokenId) != account) revert NotAdmitted(account, n.tokenId);
        Config memory c = _poolConfig[account][pool];
        if (c.pool != pool || c.generation != generationOf[account]) revert NoConfig(account, pool);
        (, int24 spot,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 twap = _twapTick(c);
        if (_absDiff(spot, twap) > c.bandTicks) revert SpotOutsideBand(spot, twap, c.bandTicks);

        PoolInfo memory p = _pool[pool];
        _pull(p.token0, account, n.amount0Desired);
        _pull(p.token1, account, n.amount1Desired);
        _approve(p.token0, address(NPM), n.amount0Desired);
        _approve(p.token1, address(NPM), n.amount1Desired);
        (liquidity, amount0, amount1) = NPM.increaseLiquidity(n);
        _approve(p.token0, address(NPM), 0);
        _approve(p.token1, address(NPM), 0);
        if (n.amount0Desired > amount0) _push(p.token0, account, n.amount0Desired - amount0);
        if (n.amount1Desired > amount1) _push(p.token1, account, n.amount1Desired - amount1);
        _locked = 1;
    }

    // ---------------------------------------------------------------- views the engine uses to build calls

    /// Smallest `amountOutMinimum` and the farthest `sqrtPriceLimitX96` the policy accepts for this swap now.
    function swapBounds(address account, address pool, address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256 minOut, uint160 sqrtPriceLimitX96)
    {
        Config memory c = _poolConfig[account][pool];
        if (c.pool == address(0)) revert NoConfig(account, pool);
        PoolInfo memory p = _pool[pool];
        int24 twap = _twapTick(c);
        return _swapBounds(c, p, twap, tokenIn, amountIn);
    }

    /// Smallest amount0Min / amount1Min the policy accepts for decreasing `liquidity` of `tokenId` now.
    function decreaseMins(address account, address pool, uint256 tokenId, uint128 liquidity)
        external
        view
        returns (uint256, uint256)
    {
        Config memory c = _poolConfig[account][pool];
        if (c.pool == address(0)) revert NoConfig(account, pool);
        return _decreaseMins(c, tokenId, liquidity);
    }

    function spendOf(address account, address pool) external view returns (Spend memory) {
        return _spend[account][pool];
    }

    // ---------------------------------------------------------------- internals

    function _swapOk(Config memory c, PoolInfo memory p, address account, ExactInputSingleParams memory s)
        internal
        view
        returns (bool)
    {
        if (s.recipient != account || s.fee != p.fee) return false;
        bool pair =
            (s.tokenIn == p.token0 && s.tokenOut == p.token1) || (s.tokenIn == p.token1 && s.tokenOut == p.token0);
        if (!pair) return false;
        (uint256 minOut, uint160 limit) = _swapBounds(c, p, _twapTick(c), s.tokenIn, s.amountIn);
        if (s.amountOutMinimum < minOut) return false;
        // A zero limit means "no limit" to the pool: refused. zeroForOne moves the price down, so the limit is a floor.
        if (s.sqrtPriceLimitX96 == 0) return false;
        return s.tokenIn == p.token0 ? s.sqrtPriceLimitX96 >= limit : s.sqrtPriceLimitX96 <= limit;
    }

    function _swapBounds(Config memory c, PoolInfo memory p, int24 twap, address tokenIn, uint256 amountIn)
        internal
        pure
        returns (uint256 minOut, uint160 limit)
    {
        bool zeroForOne = tokenIn == p.token0;
        // Worst acceptable price: `bandTicks` against the swapper from the TWAP tick.
        int24 worst = zeroForOne ? _sub(twap, c.bandTicks) : _add(twap, c.bandTicks);
        address tokenOut = zeroForOne ? p.token1 : p.token0;
        uint256 quote = OracleLibrary.getQuoteAtTick(worst, _u128(amountIn), tokenIn, tokenOut);
        minOut = (quote * (1e6 - p.fee)) / 1e6;
        limit = TickMath.getSqrtRatioAtTick(worst);
    }

    /// Mins at the band edges: token0 is smallest at the top edge, token1 at the bottom edge. Any spot inside the band
    /// returns at least these; a spot outside it fails the manager's own slippage check.
    function _decreaseMins(Config memory c, uint256 tokenId, uint128 liquidity)
        internal
        view
        returns (uint256 min0, uint256 min1)
    {
        (,,,,, int24 lower, int24 upper,,,,,) = NPM.positions(tokenId);
        int24 twap = _twapTick(c);
        uint160 sa = TickMath.getSqrtRatioAtTick(lower);
        uint160 sb = TickMath.getSqrtRatioAtTick(upper);
        (min0,) = LiquidityAmounts.getAmountsForLiquidity(
            TickMath.getSqrtRatioAtTick(_add(twap, c.bandTicks)), sa, sb, liquidity
        );
        (, min1) = LiquidityAmounts.getAmountsForLiquidity(
            TickMath.getSqrtRatioAtTick(_sub(twap, c.bandTicks)), sa, sb, liquidity
        );
    }

    function _isAdmitted(address account, address pool, uint256 tokenId) internal view returns (bool) {
        // ownerOf: an admitted position the owner later moved out of the Safe is not the session's any more.
        return admittedPool[account][tokenId] == pool && NPM.ownerOf(tokenId) == account;
    }

    function _spendOk(address account, address pool, uint256 a0, uint256 a1) internal returns (uint256) {
        Budget memory b = _budget[account][pool];
        Spend memory s = _spend[account][pool];
        uint64 epoch = b.window == 0 ? 0 : uint64(block.timestamp / b.window);
        uint64 gen = generationOf[account];
        if (s.generation != gen) {
            s = Spend({epoch: epoch, generation: gen, window0: 0, window1: 0, total0: 0, total1: 0});
        }
        if (s.epoch != epoch) (s.epoch, s.window0, s.window1) = (epoch, 0, 0);
        uint256 w0 = s.window0 + a0;
        uint256 w1 = s.window1 + a1;
        uint256 t0 = s.total0 + a0;
        uint256 t1 = s.total1 + a1;
        if (w0 > b.perWindow0 || w1 > b.perWindow1 || t0 > b.total0 || t1 > b.total1) return VALIDATION_FAILED;
        // Charged at validation: a later revert of the execution does not refund it (conservative by design).
        (s.window0, s.window1, s.total0, s.total1) = (uint128(w0), uint128(w1), uint128(t0), uint128(t1));
        _spend[account][pool] = s;
        return VALIDATION_SUCCESS;
    }

    function _twapTick(Config memory c) internal view returns (int24 tick) {
        (tick,) = OracleLibrary.consult(c.pool, c.twapWindow);
    }

    function _poolInfo(address pool) internal returns (PoolInfo memory p) {
        p = _pool[pool];
        if (p.token0 != address(0)) return p;
        IUniswapV3Pool v = IUniswapV3Pool(pool);
        p = PoolInfo({token0: v.token0(), token1: v.token1(), fee: v.fee()});
        if (FACTORY.getPool(p.token0, p.token1, p.fee) != pool) revert NotAFactoryPool(pool);
        _pool[pool] = p;
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

    function _absDiff(int24 a, int24 b) internal pure returns (uint24) {
        int256 d = int256(a) - int256(b);
        return uint24(uint256(d < 0 ? -d : d));
    }

    function _add(int24 t, uint24 band) internal pure returns (int24) {
        int256 r = int256(t) + int256(uint256(band));
        return r > TickMath.MAX_TICK ? TickMath.MAX_TICK : int24(r);
    }

    function _sub(int24 t, uint24 band) internal pure returns (int24) {
        int256 r = int256(t) - int256(uint256(band));
        return r < TickMath.MIN_TICK ? TickMath.MIN_TICK : int24(r);
    }

    function _u128(uint256 x) internal pure returns (uint128) {
        require(x <= type(uint128).max, "amount");
        return uint128(x);
    }
}
