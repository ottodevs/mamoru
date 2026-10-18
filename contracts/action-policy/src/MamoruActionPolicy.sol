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
 * @title MamoruActionPolicy (spec 007, otto/mamoru#151). Not deployed. T6 audit fixes applied (see
 * specs/007-onchain-action-policy/results/t6-fixes-2026-10-18.md).
 * @notice A SmartSession action policy that sits NEXT TO UniActionPolicy on every action of a Mamoru grant. It only
 * adds refusals:
 *  - price: every priced action must stay inside one range [lo, hi] built from TWO TWAPs of the pool's own oracle (a
 *    long and a short window): lo = max(long, short) - band, hi = min(long, short) + band. Moving either TWAP alone
 *    can only narrow it. Both windows must also show a harmonic-mean in-range liquidity of at least `minLiquidity`:
 *    a TWAP pushed by holding the pool in an empty tick range for a block craters it (T6 H-1, measured on a fork).
 *  - positions: decrease/collect/burn only for tokenIds admitted for this account and pool, minted through `mint`
 *    or named by the owner in the enable data (`Init.admit`).
 *  - budget: ONE value budget per account and pool, in units of one of the pool's tokens (the stable one), charged
 *    for swap `amountIn` and mint `amount*Desired` at the range edge that values them highest. A token bucket of
 *    capacity `perWindow` refilled at `perWindow / budgetWindow` per second, and a per-approval `total`.
 *  - renewal: a generation number that retires every older grant of the account.
 *
 * It is also the only way a session can mint: the grant names `MamoruActionPolicy.mint` instead of the position
 * manager's `mint`, so the policy learns the new tokenId from the manager's return value and admits it.
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

    /// Hard bounds on owner-signed Init values (T6 I-2): the owner taps a hash the operator built.
    uint32 public constant MIN_TWAP_WINDOW = 600;
    uint32 public constant MAX_TWAP_WINDOW = 86_400;
    uint32 public constant MIN_SHORT_WINDOW = 60;
    uint24 public constant MIN_BAND = 2;
    uint24 public constant MAX_BAND = 500;
    uint32 public constant MIN_BUDGET_WINDOW = 3_600;
    uint64 public constant MAX_GENERATION = type(uint32).max;
    uint256 public constant MAX_ADMIT = 64;

    address public immutable SMART_SESSION;
    INPM public immutable NPM;
    address public immutable ROUTER;
    IUniswapV3Factory public immutable FACTORY;

    /// Owner-signed init data of one session action (abi.encode of this struct). Every action of every session of a
    /// pool in one generation must carry the same values (only `admit` may differ); see `ConfigMismatch`.
    struct Init {
        address pool; // the one pool the grant covers (a Uniswap v3 factory pool)
        uint32 twapWindow; // seconds, the long TWAP (1,800 in production)
        uint32 twapShortWindow; // seconds, the short TWAP (300 in production); MIN_SHORT_WINDOW <= short < long
        uint24 bandTicks; // max distance of any execution price from the range built from both TWAPs (1 tick = 1 bp)
        uint64 generation; // approval number of the account; a higher one retires every lower one
        uint128 minLiquidity; // floor of the harmonic-mean in-range liquidity over each window (T6 H-1)
        bool budgetIn1; // budget unit: false = token0 units, true = token1 units (the pool's stable token)
        uint32 budgetWindow; // seconds for the bucket to refill from empty to `perWindow`
        uint128 perWindow; // bucket capacity, in budget units
        uint128 total; // spend over the whole approval (this generation), in budget units
        uint256[] admit; // positions the owner admits at enable (minted outside this deployment), T6 M-4
    }

    /// Per account and pool: everything `checkAction`, `mint` and the views use. Written only at enable.
    struct Config {
        uint32 twapWindow;
        uint32 twapShortWindow;
        uint24 bandTicks;
        uint64 generation;
        bool budgetIn1;
        uint32 budgetWindow;
        uint128 minLiquidity;
        uint128 perWindow;
        uint128 total;
        bytes32 initHash; // keccak of the Init without `admit`: a same-generation re-init must match it
    }

    /// Per ConfigId (one session action): which pool and generation it was enabled for.
    struct Binding {
        address pool;
        uint64 generation;
    }

    struct PoolInfo {
        address token0;
        address token1;
        uint24 fee;
    }

    /// Token-bucket state. `debt` is what is spent and not yet refilled (it carries across generations, T6 L-5);
    /// `total` is the spend of `generation` (it resets when the generation changes).
    struct Spend {
        uint64 generation;
        uint64 updatedAt;
        bool in1;
        uint128 debt;
        uint128 total;
    }

    mapping(ConfigId => mapping(address account => Binding)) internal _binding;
    mapping(address account => uint64) public generationOf;
    mapping(address account => mapping(address pool => Config)) internal _config;
    mapping(address account => mapping(address pool => Spend)) internal _spend;
    /// tokenId => pool, for positions minted through `mint` with this account as recipient, or admitted at enable.
    mapping(address account => mapping(uint256 tokenId => address pool)) public admittedPool;
    mapping(address pool => PoolInfo) internal _pool;

    uint256 private _locked = 1;

    event PolicySet(ConfigId id, address multiplexer, address account);
    event Admitted(address indexed account, address indexed pool, uint256 indexed tokenId);

    error PolicyNotInitialized(ConfigId id, address multiplexer, address account);
    error OnlySmartSession();
    error NotAFactoryPool(address pool);
    error StaleGeneration(uint64 given, uint64 current);
    error BadInit(uint256 field);
    error ConfigMismatch(address pool, uint64 generation);
    error ObservationCardinalityTooLow(uint16 cardinalityNext, uint32 twapWindow);
    error NotAdmissible(uint256 tokenId);
    error NoConfig(address account, address pool);
    error NotAdmitted(uint256 tokenId);
    error WrongRecipient();
    error OracleRefused(int24 twapLong, int24 twapShort, uint128 hmLong, uint128 hmShort);
    error SpotOutsideRange(uint160 sqrtPriceX96, int24 lo, int24 hi);
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
        // "multiplexer", unlike UniActionPolicy's purely per-multiplexer storage. SmartSession calls this only from
        // `enableSessions` (owner-executed) or an ENABLE-mode userOp (owner-signed enable data); account == msg.sender
        // of SmartSession there, so a session key can neither reach this nor add to `admit`.
        if (msg.sender != SMART_SESSION) revert OnlySmartSession();
        Init memory i = abi.decode(initData, (Init));
        PoolInfo memory p = _poolInfo(i.pool); // refuses a non-factory pool, caches token0/token1/fee
        _validate(i);

        uint64 current = generationOf[account];
        if (i.generation < current) revert StaleGeneration(i.generation, current);
        // A jump of more than one is allowed only on the first enable at this deployment (a migration carries the
        // old deployment's generation); after that, renewals step by one, so nobody can burn the number space.
        if (current != 0 && i.generation > current + 1) revert BadInit(4);
        if (i.generation > current) generationOf[account] = i.generation;

        bytes32 h = _initHash(i);
        Config storage c = _config[account][i.pool];
        if (c.twapWindow != 0 && c.generation == i.generation) {
            // T6 I-1: one config per (account, pool, generation), whatever ConfigId it arrives under.
            if (c.initHash != h) revert ConfigMismatch(i.pool, i.generation);
        } else {
            _config[account][i.pool] = Config({
                twapWindow: i.twapWindow,
                twapShortWindow: i.twapShortWindow,
                bandTicks: i.bandTicks,
                generation: i.generation,
                budgetIn1: i.budgetIn1,
                budgetWindow: i.budgetWindow,
                minLiquidity: i.minLiquidity,
                perWindow: i.perWindow,
                total: i.total,
                initHash: h
            });
            Spend storage s = _spend[account][i.pool];
            // Budget unit changed (never in practice: always the pool's stable token): spend in the old unit cannot
            // be carried, so start with an empty bucket instead of a full one.
            if (s.in1 != i.budgetIn1) {
                if (s.updatedAt != 0) (s.debt, s.updatedAt) = (i.perWindow, uint64(block.timestamp));
                s.in1 = i.budgetIn1;
            }
        }
        _binding[configId][account] = Binding({pool: i.pool, generation: i.generation});
        for (uint256 k; k < i.admit.length; k++) {
            _admitAtEnable(account, i.pool, p, i.admit[k]);
        }
        emit PolicySet(configId, msg.sender, account);
    }

    // ---------------------------------------------------------------- validation (SmartSession -> policy)

    function checkAction(ConfigId id, address account, address target, uint256 value, bytes calldata data)
        external
        returns (uint256)
    {
        if (msg.sender != SMART_SESSION) return VALIDATION_FAILED;
        Binding memory b = _binding[id][account];
        if (b.pool == address(0)) revert PolicyNotInitialized(id, msg.sender, account);
        if (b.generation != generationOf[account]) return VALIDATION_FAILED; // retired by a renewal
        if (value != 0 || data.length < 4) return VALIDATION_FAILED;
        Config memory c = _config[account][b.pool];
        PoolInfo memory p = _pool[b.pool];
        bytes4 sel = bytes4(data[:4]);

        if (target == ROUTER && sel == EXACT_INPUT_SINGLE) {
            return _checkSwap(account, b.pool, c, p, abi.decode(data[4:], (ExactInputSingleParams)));
        }
        if (target == address(this) && sel == this.mint.selector) {
            MintParams memory m = abi.decode(data[4:], (MintParams));
            if (m.token0 != p.token0 || m.token1 != p.token1 || m.fee != p.fee || m.recipient != account) {
                return VALIDATION_FAILED;
            }
            (bool ok, int24 lo, int24 hi) = _range(c, b.pool);
            if (!ok) return VALIDATION_FAILED;
            // Desired amounts are an upper bound of what the mint takes: the budget is charged conservatively.
            return _charge(account, b.pool, c, _value(c, p, lo, hi, m.amount0Desired, m.amount1Desired))
                ? VALIDATION_SUCCESS
                : VALIDATION_FAILED;
        }
        if (target == address(NPM) && sel == DECREASE) {
            DecreaseLiquidityParams memory d = abi.decode(data[4:], (DecreaseLiquidityParams));
            if (!_isAdmitted(account, b.pool, d.tokenId)) return VALIDATION_FAILED;
            (bool ok, int24 lo, int24 hi) = _range(c, b.pool);
            if (!ok) return VALIDATION_FAILED;
            (uint256 min0, uint256 min1) = _decreaseMins(lo, hi, d.tokenId, d.liquidity);
            return d.amount0Min >= min0 && d.amount1Min >= min1 ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (target == address(NPM) && sel == COLLECT) {
            CollectParams memory k = abi.decode(data[4:], (CollectParams));
            return
                _isAdmitted(account, b.pool, k.tokenId) && k.recipient == account
                    ? VALIDATION_SUCCESS
                    : VALIDATION_FAILED;
        }
        if (target == address(NPM) && sel == BURN) {
            uint256 tokenId = abi.decode(data[4:], (uint256));
            return _isAdmitted(account, b.pool, tokenId) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (sel == APPROVE && (target == p.token0 || target == p.token1)) {
            (address spender,) = abi.decode(data[4:], (address, uint256));
            // Caps on the amount stay in UniActionPolicy; here only who may pull: the router or this policy's mint.
            return spender == ROUTER || spender == address(this) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        return VALIDATION_FAILED;
    }

    function _checkSwap(
        address account,
        address pool,
        Config memory c,
        PoolInfo memory p,
        ExactInputSingleParams memory s
    ) internal returns (uint256) {
        if (s.recipient != account || s.fee != p.fee) return VALIDATION_FAILED;
        bool zeroForOne = s.tokenIn == p.token0 && s.tokenOut == p.token1;
        if (!zeroForOne && !(s.tokenIn == p.token1 && s.tokenOut == p.token0)) return VALIDATION_FAILED;
        (bool ok, int24 lo, int24 hi) = _range(c, pool);
        if (!ok) return VALIDATION_FAILED;
        (uint256 minOut, uint160 limit) = _swapBounds(p, lo, hi, zeroForOne, s.amountIn);
        if (s.amountOutMinimum < minOut) return VALIDATION_FAILED;
        // A zero limit means "no limit" to the pool: refused. zeroForOne moves the price down: the limit is a floor.
        if (s.sqrtPriceLimitX96 == 0) return VALIDATION_FAILED;
        if (zeroForOne ? s.sqrtPriceLimitX96 < limit : s.sqrtPriceLimitX96 > limit) return VALIDATION_FAILED;
        uint256 v = _value(c, p, lo, hi, zeroForOne ? s.amountIn : 0, zeroForOne ? 0 : s.amountIn);
        return _charge(account, pool, c, v) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
    }

    // ---------------------------------------------------------------- execution: the only session mint path

    /**
     * @notice Called BY THE ACCOUNT (msg.sender) inside a session batch, after approving this contract for at most the
     * desired amounts. Pulls them, mints with the account as recipient, returns everything the manager did not take,
     * admits the new tokenId. Refuses when the pool's spot price is outside the range [lo, hi], or the oracle check
     * fails, right before the manager's call.
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
        Config memory c = _config[account][pool];
        if (pool == address(0) || c.twapWindow == 0 || c.generation != generationOf[account]) {
            revert NoConfig(account, pool);
        }
        uint256 b0 = IERC20Min(m.token0).balanceOf(address(this));
        uint256 b1 = IERC20Min(m.token1).balanceOf(address(this));
        _pull(m.token0, account, m.amount0Desired);
        _pull(m.token1, account, m.amount1Desired);
        _approve(m.token0, address(NPM), m.amount0Desired);
        _approve(m.token1, address(NPM), m.amount1Desired);
        // T6 I-7: checked right before the manager's call, after every token callback of the pulls/approvals.
        _requireSpotInRange(c, pool);
        (tokenId, liquidity, amount0, amount1) = NPM.mint(m);
        _approve(m.token0, address(NPM), 0);
        _approve(m.token1, address(NPM), 0);
        // T6 I-5: refund from the balance delta, so WETH the manager funded from its own ETH comes back too.
        uint256 r0 = IERC20Min(m.token0).balanceOf(address(this)) - b0;
        uint256 r1 = IERC20Min(m.token1).balanceOf(address(this)) - b1;
        if (r0 != 0) _push(m.token0, account, r0);
        if (r1 != 0) _push(m.token1, account, r1);

        admittedPool[account][tokenId] = pool;
        emit Admitted(account, pool, tokenId);
        _locked = 1;
    }

    // ---------------------------------------------------------------- views the engine and precheck use

    /// The price range [lo, hi] (ticks) every priced action of `account` in `pool` must stay in now. Reverts
    /// `OracleRefused` when the two TWAPs are more than 2 x band apart or either window's liquidity is under the floor.
    function priceRange(address account, address pool) external view returns (int24 lo, int24 hi) {
        Config memory c = _current(account, pool);
        bool ok;
        (ok, lo, hi) = _range(c, pool);
        if (!ok) {
            (int24 tl, int24 ts, uint128 hl, uint128 hs) = _oracle(c, pool);
            revert OracleRefused(tl, ts, hl, hs);
        }
    }

    /// Smallest `amountOutMinimum` and the farthest `sqrtPriceLimitX96` the policy accepts for this swap now.
    function swapBounds(address account, address pool, address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256 minOut, uint160 sqrtPriceLimitX96)
    {
        (int24 lo, int24 hi) = this.priceRange(account, pool);
        PoolInfo memory p = _pool[pool];
        return _swapBounds(p, lo, hi, tokenIn == p.token0, amountIn);
    }

    /// Smallest amount0Min / amount1Min the policy accepts for decreasing `liquidity` of `tokenId` now.
    function decreaseMins(address account, address pool, uint256 tokenId, uint128 liquidity)
        external
        view
        returns (uint256, uint256)
    {
        if (!_isAdmitted(account, pool, tokenId)) revert NotAdmitted(tokenId);
        (int24 lo, int24 hi) = this.priceRange(account, pool);
        return _decreaseMins(lo, hi, tokenId, liquidity);
    }

    function configOf(address account, address pool) external view returns (Config memory) {
        return _config[account][pool];
    }

    function spendOf(address account, address pool) external view returns (Spend memory) {
        return _spend[account][pool];
    }

    /// What one more charge may take now: (bucket room, approval room), in budget units.
    function budgetLeft(address account, address pool) external view returns (uint256 window, uint256 total) {
        Config memory c = _config[account][pool];
        (uint256 debt, uint256 spent) = _bucket(_spend[account][pool], c);
        window = c.perWindow > debt ? c.perWindow - debt : 0;
        total = c.total > spent ? c.total - spent : 0;
    }

    // ---------------------------------------------------------------- internals: price

    /// Two TWAPs and their harmonic-mean liquidity from one `observe([long, short, 0])`, floor-rounded like
    /// `OracleLibrary.consult`. Same-block swaps cannot move any of them (observations are written per block).
    function _oracle(Config memory c, address pool) internal view returns (int24 tl, int24 ts, uint128 hl, uint128 hs) {
        uint32[] memory ago = new uint32[](3);
        ago[0] = c.twapWindow;
        ago[1] = c.twapShortWindow;
        (int56[] memory tc, uint160[] memory sl) = IUniswapV3Pool(pool).observe(ago);
        tl = _meanTick(tc[2] - tc[0], c.twapWindow);
        ts = _meanTick(tc[2] - tc[1], c.twapShortWindow);
        hl = _harmonicMean(sl[2] - sl[0], c.twapWindow);
        hs = _harmonicMean(sl[2] - sl[1], c.twapShortWindow);
    }

    /// lo = max(long, short) - band + 1, hi = min(long, short) + band. The +1: both means are floored, so the true
    /// mean of the higher one can be up to one tick above it (T6 L-7). `ok` is false when either window's
    /// harmonic-mean liquidity is under `minLiquidity` (T6 H-1) or the range is empty (the TWAPs disagree by more
    /// than about 2 x band: a fast move or a manipulation, refused either way).
    function _range(Config memory c, address pool) internal view returns (bool ok, int24 lo, int24 hi) {
        (int24 tl, int24 ts, uint128 hl, uint128 hs) = _oracle(c, pool);
        if (hl < c.minLiquidity || hs < c.minLiquidity) return (false, 0, 0);
        int24 top = tl > ts ? tl : ts;
        int24 bottom = tl > ts ? ts : tl;
        lo = _clamp(int256(top) - int256(uint256(c.bandTicks)) + 1);
        hi = _clamp(int256(bottom) + int256(uint256(c.bandTicks)));
        ok = lo <= hi;
    }

    function _swapBounds(PoolInfo memory p, int24 lo, int24 hi, bool zeroForOne, uint256 amountIn)
        internal
        pure
        returns (uint256 minOut, uint160 limit)
    {
        // Worst acceptable price: the range edge against the swapper.
        int24 worst = zeroForOne ? lo : hi;
        (address tokenIn, address tokenOut) = zeroForOne ? (p.token0, p.token1) : (p.token1, p.token0);
        uint256 quote = OracleLibrary.getQuoteAtTick(worst, _u128(amountIn), tokenIn, tokenOut);
        minOut = (quote * (1e6 - p.fee)) / 1e6;
        limit = TickMath.getSqrtRatioAtTick(worst);
    }

    /// Mins at the range edges: token0 is smallest at the top edge, token1 at the bottom edge. Any spot inside the
    /// range returns at least these; a spot outside it fails the manager's own slippage check.
    function _decreaseMins(int24 lo, int24 hi, uint256 tokenId, uint128 liquidity)
        internal
        view
        returns (uint256 min0, uint256 min1)
    {
        (int24 lower, int24 upper) = _ticksOf(tokenId);
        uint160 sa = TickMath.getSqrtRatioAtTick(lower);
        uint160 sb = TickMath.getSqrtRatioAtTick(upper);
        (min0,) = LiquidityAmounts.getAmountsForLiquidity(TickMath.getSqrtRatioAtTick(hi), sa, sb, liquidity);
        (, min1) = LiquidityAmounts.getAmountsForLiquidity(TickMath.getSqrtRatioAtTick(lo), sa, sb, liquidity);
    }

    function _requireSpotInRange(Config memory c, address pool) internal view {
        (bool ok, int24 lo, int24 hi) = _range(c, pool);
        if (!ok) {
            (int24 tl, int24 ts, uint128 hl, uint128 hs) = _oracle(c, pool);
            revert OracleRefused(tl, ts, hl, hs);
        }
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        // Compared as sqrt prices, not floored ticks (T6 L-7).
        if (sqrtPriceX96 < TickMath.getSqrtRatioAtTick(lo) || sqrtPriceX96 > TickMath.getSqrtRatioAtTick(hi)) {
            revert SpotOutsideRange(sqrtPriceX96, lo, hi);
        }
    }

    // ---------------------------------------------------------------- internals: budget

    /// Value of (a0, a1) in the budget unit, the other token converted at the range edge that values it highest:
    /// token1 -> token0 at lo (lowest price of token0 in token1), token0 -> token1 at hi. T6 M-2.
    function _value(Config memory c, PoolInfo memory p, int24 lo, int24 hi, uint256 a0, uint256 a1)
        internal
        pure
        returns (uint256)
    {
        if (c.budgetIn1) {
            return a1 + (a0 == 0 ? 0 : OracleLibrary.getQuoteAtTick(hi, _u128(a0), p.token0, p.token1));
        }
        return a0 + (a1 == 0 ? 0 : OracleLibrary.getQuoteAtTick(lo, _u128(a1), p.token1, p.token0));
    }

    /// (debt now, spend of the current generation) after the refill since the last charge. T6 M-3, L-5.
    function _bucket(Spend memory s, Config memory c) internal view returns (uint256 debt, uint256 spent) {
        debt = s.debt;
        if (debt != 0 && block.timestamp > s.updatedAt) {
            uint256 refill = (uint256(c.perWindow) * (block.timestamp - s.updatedAt)) / c.budgetWindow;
            debt = refill >= debt ? 0 : debt - refill;
        }
        spent = s.generation == c.generation ? s.total : 0;
    }

    /// Charged at validation: a later revert of the execution does not refund it (conservative by design, T6 L-2).
    function _charge(address account, address pool, Config memory c, uint256 v) internal returns (bool) {
        Spend memory s = _spend[account][pool];
        (uint256 debt, uint256 spent) = _bucket(s, c);
        debt += v;
        spent += v;
        if (debt > c.perWindow || spent > c.total) return false;
        _spend[account][pool] = Spend({
            generation: c.generation,
            updatedAt: uint64(block.timestamp),
            in1: c.budgetIn1,
            debt: uint128(debt),
            total: uint128(spent)
        });
        return true;
    }

    // ---------------------------------------------------------------- internals: init, admission

    function _validate(Init memory i) internal view {
        if (i.twapWindow < MIN_TWAP_WINDOW || i.twapWindow > MAX_TWAP_WINDOW) revert BadInit(1);
        if (i.twapShortWindow < MIN_SHORT_WINDOW || i.twapShortWindow >= i.twapWindow) revert BadInit(2);
        if (i.bandTicks < MIN_BAND || i.bandTicks > MAX_BAND) revert BadInit(3);
        if (i.generation > MAX_GENERATION) revert BadInit(4);
        if (i.minLiquidity == 0) revert BadInit(5);
        if (i.budgetWindow < MIN_BUDGET_WINDOW) revert BadInit(7);
        if (i.perWindow == 0 || i.total < i.perWindow) revert BadInit(8);
        if (i.admit.length > MAX_ADMIT) revert BadInit(10);
        // T6 L-4: at most one observation per block and blocks of at least 1 s, so the ring must hold at least
        // `twapWindow` observations for the long window to survive a dust swap in every block. Deploy step:
        // script/Deploy.s.sol raises `observationCardinalityNext` before any enable.
        (,,,, uint16 cardinalityNext,,) = IUniswapV3Pool(i.pool).slot0();
        if (cardinalityNext < i.twapWindow) revert ObservationCardinalityTooLow(cardinalityNext, i.twapWindow);
    }

    function _initHash(Init memory i) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                i.pool,
                i.twapWindow,
                i.twapShortWindow,
                i.bandTicks,
                i.generation,
                i.minLiquidity,
                i.budgetIn1,
                i.budgetWindow,
                i.perWindow,
                i.total
            )
        );
    }

    /// T6 M-4: a position the account owns in this pool, named in owner-signed enable data, becomes manageable.
    function _admitAtEnable(address account, address pool, PoolInfo memory p, uint256 tokenId) internal {
        if (NPM.ownerOf(tokenId) != account) revert NotAdmissible(tokenId);
        (,, address t0, address t1, uint24 fee,,,,,,,) = NPM.positions(tokenId);
        if (t0 != p.token0 || t1 != p.token1 || fee != p.fee) revert NotAdmissible(tokenId);
        if (admittedPool[account][tokenId] != pool) {
            admittedPool[account][tokenId] = pool;
            emit Admitted(account, pool, tokenId);
        }
    }

    function _isAdmitted(address account, address pool, uint256 tokenId) internal view returns (bool) {
        // ownerOf: an admitted position the owner later moved out of the Safe is not the session's any more.
        return admittedPool[account][tokenId] == pool && NPM.ownerOf(tokenId) == account;
    }

    function _current(address account, address pool) internal view returns (Config memory c) {
        c = _config[account][pool];
        if (c.twapWindow == 0 || c.generation != generationOf[account]) revert NoConfig(account, pool);
    }

    function _ticksOf(uint256 tokenId) internal view returns (int24 lower, int24 upper) {
        (,,,,, lower, upper,,,,,) = NPM.positions(tokenId);
    }

    function _poolInfo(address pool) internal returns (PoolInfo memory p) {
        p = _pool[pool];
        if (p.token0 != address(0)) return p;
        IUniswapV3Pool v = IUniswapV3Pool(pool);
        p = PoolInfo({token0: v.token0(), token1: v.token1(), fee: v.fee()});
        if (FACTORY.getPool(p.token0, p.token1, p.fee) != pool) revert NotAFactoryPool(pool);
        _pool[pool] = p;
    }

    // ---------------------------------------------------------------- internals: tokens, math

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

    function _meanTick(int56 delta, uint32 window) internal pure returns (int24 t) {
        t = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) t--;
    }

    /// OracleLibrary.consult's harmonic mean; a zero delta (cannot happen over >= 60 s) reads as unlimited.
    function _harmonicMean(uint160 secondsPerLiquidityDelta, uint32 window) internal pure returns (uint128) {
        if (secondsPerLiquidityDelta == 0) return type(uint128).max;
        return uint128((uint192(window) * type(uint160).max) / (uint192(secondsPerLiquidityDelta) << 32));
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
