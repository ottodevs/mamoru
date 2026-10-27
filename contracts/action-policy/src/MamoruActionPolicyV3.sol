// SPDX-License-Identifier: GPL-2.0-or-later
// GPL because it links Uniswap's TickMath, OracleLibrary and LiquidityAmounts (GPL-2.0-or-later). See spec 007, open questions.
pragma solidity ^0.8.28;

import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {OracleLibrary} from "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";

/// SmartSession's policy id type (erc7579/smartsessions DataTypes.sol). These types repeat V2's on purpose: importing
/// V2's file would compile this one under V2's compiler profile (foundry.toml).
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

struct IncreaseLiquidityParams {
    uint256 tokenId;
    uint256 amount0Desired;
    uint256 amount1Desired;
    uint256 amount0Min;
    uint256 amount1Min;
    uint256 deadline;
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

/// ERC-4626, reduced to what the constructor reads.
interface IERC4626Asset {
    function asset() external view returns (address);
}

/**
 * @title MamoruActionPolicyV3 (otto/mamoru#116 T1). Not deployed.
 * @notice MamoruActionPolicyV2, unchanged on every Uniswap path, plus two action families, so that every grant of a
 * Mamoru account can carry this policy as its ONLY action policy and be enabled inside the Safe setup
 * (SmartSession UNSAFE_ENABLE, design D of #116), before the account address exists:
 *  - every recipient check is `== account`, the account SmartSession validates for (the Safe itself), decided here.
 *    No grant needs a param rule naming the account address (UniActionPolicy's ACCOUNT refs, circular at setup).
 *  - ERC-4626 vaults (`FAMILY_VAULTS`): deposit / mint / withdraw / redeem on a vault of this deployment's allowlist
 *    (constructor only, no setter), with receiver == account and, on the way out, owner == account; an approval of
 *    a listed vault's asset only to that vault.
 *  - CCTP V2 bridge-out (`FAMILY_BRIDGE`): `depositForBurn` of the pinned burn token, to the pinned destination
 *    domain, minted to bytes32(account) (design D: the account has the same address on the other chain), open
 *    destinationCaller, no fee, Standard finality; an approval of the burn token only to the TokenMessenger.
 * No new amount limit: the vault and bridge families add none (the cross-chain total cap lives in the engine and in
 * the user-signed cap, #201), and the Uniswap families keep V2's budget (per pool, token bucket + total) as it is.
 * The generation (renewal) and the guardian's pause apply to the new families exactly as to the Uniswap ones.
 *
 * Init (owner-signed, per session action): the Uniswap families take V2's `Init` unchanged (abi.encode of a struct
 * with a dynamic member, so its first word is always 0x20); the new families take `abi.encode(uint256 family,
 * uint64 generation)` with family FAMILY_VAULTS (1) or FAMILY_BRIDGE (2). The first word tells them apart.
 * Threat model of every check: contracts/action-policy/SECURITY.md.
 *
 * What follows is V2's description, which still holds for the Uniswap paths.
 *
 * MamoruActionPolicyV2 (spec 007, otto/mamoru#151, #171). MamoruActionPolicy as deployed on Base
 * at 0x0083A9ca619f22A4f29704F97981dfFe8CD35215 (T6 audit fixes applied, see
 * specs/007-onchain-action-policy/results/t6-fixes-2026-10-18.md), plus three additions, each only a refusal or a
 * path a session could not take before:
 *  - `increase` (#171): the only way a session adds liquidity to a position. The position manager's
 *    `increaseLiquidity` does not check who owns the tokenId, so it is never a session action; through here it
 *    reaches only positions admitted for the account that the account still owns, with the same spot check and the
 *    same budget charge as `mint`.
 *  - a revoke-only guardian (immutable `GUARDIAN`, address(0) = none): `pause(account)` refuses every session action
 *    of the account (checkAction, `mint`, `increase`) until `unpause` or the owner's next renewal. It cannot enable,
 *    widen, or move a token.
 *  - the engine's swap deadline, `SwapRouter02.multicall(deadline, [])` (#140), in its exact empty encoding only, so
 *    a grant can carry this policy on that action too and a pause or a renewal stops it like any other.
 *  - the LeftClaw audit's fixes (job #1041 on d9e53b8; test/LeftClawV2.t.sol): a first enable jumps at most to
 *    MAX_FIRST_GENERATION (H-1); the long TWAP window is at least MIN_WINDOW_RATIO short ones (M-1); swap, mint and
 *    increase check the spot at validation, before the charge, and a swap's submitted price limit must be strictly
 *    past the spot in its direction, as the pool requires (M-2); a renewal clamps the carried debt to the new
 *    perWindow (M-3); an admitted position stays manageable across renewals until an owner-signed Init revokes it
 *    (`admit` entry with REVOKE_FLAG, M-4); an enable needs the pool's in-range depth over the band to cover the
 *    window budget (M-5); decrease uses the TWAP range without the stable anchor, so a depeg does not lock exits
 *    (M-6); a swap of amountIn 0 is refused (L-7).
 * Everything else is the deployed contract's logic; mint's pull, approve and refund steps moved, in the same order, into
 * `_fund` and `_settle`, which increase shares (with `_checkProvide` at validation), and the file compiles at 1,000
 * optimizer runs instead of 10,000 to fit EIP-170 (foundry.toml).
 * @notice A SmartSession action policy that sits NEXT TO UniActionPolicy on every action of a Mamoru grant. It only
 * adds refusals:
 *  - price: every priced action must stay inside one range [lo, hi] built from TWO TWAPs of the pool's own oracle (a
 *    long and a short window): lo = max(long, short) - band + 1, hi = min(long, short) + band, and refused when that
 *    is empty. Moving either TWAP alone can only narrow it; a recent one-block push moves the short one ~6x more
 *    and empties it (T6 H-1, M-1, measured on a fork). A pool may also carry a fixed anchor (the stables pool:
 *    parity): the range is clipped to [anchorTick - anchorBand, anchorTick + anchorBand], which no amount of TWAP
 *    manipulation moves.
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
contract MamoruActionPolicyV3 is IActionPolicy {
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;

    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant EXACT_INPUT_SINGLE = 0x04e45aaf; // SwapRouter02 exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
    bytes4 internal constant DECREASE = 0x0c49ccbe; // decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))
    bytes4 internal constant COLLECT = 0xfc6f7865; // collect((uint256,address,uint128,uint128))
    bytes4 internal constant BURN = 0x42966c68; // burn(uint256)
    bytes4 internal constant MULTICALL_DEADLINE = 0x5ae401dc; // SwapRouter02 multicall(uint256,bytes[])
    bytes4 internal constant VAULT_DEPOSIT = 0x6e553f65; // ERC-4626 deposit(uint256,address)
    bytes4 internal constant VAULT_MINT = 0x94bf804d; // ERC-4626 mint(uint256,address)
    bytes4 internal constant VAULT_WITHDRAW = 0xb460af94; // ERC-4626 withdraw(uint256,address,address)
    bytes4 internal constant VAULT_REDEEM = 0xba087652; // ERC-4626 redeem(uint256,address,address)
    /// CCTP V2 TokenMessengerV2 depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)
    bytes4 internal constant DEPOSIT_FOR_BURN = 0x8e0250ee;

    /// First word of a non-Uniswap Init: `abi.encode(uint256 family, uint64 generation)`.
    uint256 public constant FAMILY_VAULTS = 1;
    uint256 public constant FAMILY_BRIDGE = 2;
    /// `Binding.pool` of a session action of the vault and bridge families: never a pool (no code), never REVOKED.
    address internal constant VAULTS = address(2);
    address internal constant BRIDGE = address(3);
    /// CCTP V2 Standard transfer (attested at finality, no fee), as #213's bridge-out grant; Fast (1000) never.
    uint32 public constant CCTP_MIN_FINALITY = 2000;

    /// Hard bounds on owner-signed Init values (T6 I-2): the owner taps a hash the operator built.
    uint32 public constant MIN_TWAP_WINDOW = 600;
    uint32 public constant MAX_TWAP_WINDOW = 86_400;
    uint32 public constant MIN_SHORT_WINDOW = 60;
    uint24 public constant MIN_BAND = 2;
    uint24 public constant MAX_BAND = 500;
    uint32 public constant MIN_BUDGET_WINDOW = 3_600;
    uint64 public constant MAX_GENERATION = type(uint32).max;
    /// LeftClaw H-1: the first enable at this deployment may jump (a migration carries the old generation), but only
    /// this far, so no Init can park an account at MAX_GENERATION and freeze every later renewal.
    uint64 public constant MAX_FIRST_GENERATION = type(uint16).max;
    /// LeftClaw M-1: the long window is at least this many short windows (production: 1800 s / 300 s = 6), so the two
    /// TWAPs keep apart enough for the range to empty under a held push.
    uint32 public constant MIN_WINDOW_RATIO = 4;
    uint256 public constant MAX_ADMIT = 64;
    /// LeftClaw M-4: an `Init.admit` entry with this bit set revokes the tokenId in the low bits (NPM tokenIds never
    /// reach it), so the Init struct and its encoding stay those of the deployed policy.
    uint256 public constant REVOKE_FLAG = 1 << 255;
    /// `admittedPool` of a revoked tokenId: never a pool, so it never matches, and a later `admit` of it is skipped (an
    /// operator that still lists it cannot undo the owner's revocation, nor block a renewal by naming it).
    address internal constant REVOKED = address(1);

    address public immutable SMART_SESSION;
    /// Revoke-only watchdog key: may pause and unpause an account's session actions, nothing else. It cannot enable or
    /// widen an envelope, move a token or touch a position; a compromised guardian can only stop the engine, and the
    /// owner's next renewal ends any pause. address(0) = no guardian.
    address public immutable GUARDIAN;
    INPM public immutable NPM;
    address public immutable ROUTER;
    IUniswapV3Factory public immutable FACTORY;
    /// CCTP V2 TokenMessengerV2 of this chain; address(0) = no bridge family on this deployment.
    address public immutable TOKEN_MESSENGER;
    /// The only token the bridge family burns (native USDC of this chain).
    address public immutable BURN_TOKEN;
    /// The only CCTP domain the bridge family mints on (Monad: 15, read by #213 from MessageTransmitterV2.localDomain()).
    uint32 public immutable DESTINATION_DOMAIN;

    /// ERC-4626 vaults a session may use, with their asset, written by the constructor only: no owner, no setter. A new
    /// vault or chain is a new deployment with a new list (a new address), and grants move to it at the owner's
    /// renewal; a listed vault cannot be removed from a deployment, only left out of the next one.
    mapping(address vault => address asset) public vaultAsset;

    /// Owner-signed init data of one session action (abi.encode of this struct). Every action of every session of a
    /// pool in one generation must carry the same values (only `admit` may differ); see `ConfigMismatch`.
    struct Init {
        address pool; // the one pool the grant covers (a Uniswap v3 factory pool)
        uint32 twapWindow; // seconds, the long TWAP (1,800 in production)
        uint32 twapShortWindow; // seconds, the short TWAP (300 in production); MIN_SHORT_WINDOW <= short < long
        uint24 bandTicks; // max distance of any execution price from the range built from both TWAPs (1 tick = 1 bp)
        uint64 generation; // approval number of the account; a higher one retires every lower one
        int24 anchorTick; // fixed reference the range is clipped to (T6 H-1; parity for a stable pair)...
        uint24 anchorBand; // ...+- this many ticks; 0 = no anchor (volatile pools)
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
        int24 anchorTick;
        uint24 anchorBand;
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
    /// It survives renewals (a position minted while a renewal was being prepared stays manageable); an owner-signed
    /// Init revokes one explicitly and for good (REVOKE_FLAG, LeftClaw M-4): it is then REVOKED.
    mapping(address account => mapping(uint256 tokenId => address pool)) public admittedPool;
    mapping(address pool => PoolInfo) internal _pool;
    /// generation + 1 at the time of the pause; 0 = not paused. A renewal (a higher generation) ends it by itself.
    mapping(address account => uint64) public pausedAt;

    uint256 private _locked = 1;

    event PolicySet(ConfigId id, address multiplexer, address account);
    event Admitted(address indexed account, address indexed pool, uint256 indexed tokenId);
    event Revoked(address indexed account, address indexed pool, uint256 indexed tokenId);
    event Paused(address indexed account, uint64 generation);
    event Unpaused(address indexed account);

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
    error RangeEmpty(int24 twapLong, int24 twapShort);
    error SpotOutsideRange(uint160 sqrtPriceX96, int24 lo, int24 hi);
    error Reentrancy();
    error TransferFailed();
    error OnlyGuardian();
    error AccountPaused(address account);
    error BadVault(address vault);
    error BadBridge();

    event VaultListed(address indexed vault, address indexed asset);

    /// @param vaults this chain's ERC-4626 allowlist (may be empty); each one's asset is read here and fixed.
    /// @param tokenMessenger CCTP V2 TokenMessengerV2, or address(0) for a deployment without the bridge family (then
    /// `burnToken` and `destinationDomain` must be 0).
    constructor(
        address smartSession,
        address npm,
        address router,
        address factory,
        address guardian,
        address[] memory vaults,
        address tokenMessenger,
        address burnToken,
        uint32 destinationDomain
    ) {
        SMART_SESSION = smartSession;
        GUARDIAN = guardian;
        NPM = INPM(npm);
        ROUTER = router;
        FACTORY = IUniswapV3Factory(factory);
        for (uint256 k; k < vaults.length; k++) {
            address v = vaults[k];
            address a = IERC4626Asset(v).asset();
            // A vault is never one of the addresses the other checks name (a pool token, the router, the manager,
            // this policy): an approval or a call to it must mean "the vault family" and nothing else.
            if (
                a == address(0) || vaultAsset[v] != address(0) || v == router || v == npm || v == address(this)
                    || v == tokenMessenger
            ) revert BadVault(v);
            vaultAsset[v] = a;
            emit VaultListed(v, a);
        }
        if (tokenMessenger == address(0) ? burnToken != address(0) || destinationDomain != 0 : burnToken == address(0))
        {
            revert BadBridge();
        }
        TOKEN_MESSENGER = tokenMessenger;
        BURN_TOKEN = burnToken;
        DESTINATION_DOMAIN = destinationDomain;
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
        if (initData.length >= 32 && uint256(bytes32(initData[:32])) != 0x20) {
            _initFamily(account, configId, initData);
            return;
        }
        Init memory i = abi.decode(initData, (Init));
        PoolInfo memory p = _poolInfo(i.pool); // refuses a non-factory pool, caches token0/token1/fee
        _validate(i);
        _stepGeneration(account, i.generation);

        bytes32 h = _initHash(i);
        Config storage c = _config[account][i.pool];
        if (c.twapWindow != 0 && c.generation == i.generation) {
            // T6 I-1: one config per (account, pool, generation), whatever ConfigId it arrives under.
            if (c.initHash != h) revert ConfigMismatch(i.pool, i.generation);
        } else {
            // LeftClaw M-5, once per (account, pool, generation): selling `perWindow` of the budget unit into the pool
            // must not move its price `bandTicks`, so the session's own spend cannot walk the pool across its band
            // and the oracle is not a thin pool's.
            if (_depthIn(i.pool, p, i.bandTicks, i.budgetIn1) < i.perWindow) revert BadInit(11);
            Config memory old = c;
            _config[account][i.pool] = Config({
                twapWindow: i.twapWindow,
                twapShortWindow: i.twapShortWindow,
                bandTicks: i.bandTicks,
                generation: i.generation,
                budgetIn1: i.budgetIn1,
                budgetWindow: i.budgetWindow,
                anchorTick: i.anchorTick,
                anchorBand: i.anchorBand,
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
            } else if (old.budgetWindow != 0 && s.debt != 0) {
                // Settle the refill so far at the old rate, so the clamp below compares the debt as it is now.
                (uint256 d,) = _bucket(s, old);
                (s.debt, s.updatedAt) = (uint128(d), uint64(block.timestamp));
            }
            // LeftClaw M-3: a renewal that lowers perWindow carries at most a full bucket, refilling from now, never
            // a debt above the new capacity (which would refuse every charge for weeks).
            if (s.debt > i.perWindow) (s.debt, s.updatedAt) = (i.perWindow, uint64(block.timestamp));
        }
        _binding[configId][account] = Binding({pool: i.pool, generation: i.generation});
        for (uint256 k; k < i.admit.length; k++) {
            uint256 id = i.admit[k];
            if (id & REVOKE_FLAG == 0) {
                _admitAtEnable(account, i.pool, p, id);
            } else {
                id ^= REVOKE_FLAG;
                address was = admittedPool[account][id];
                if (was != REVOKED) {
                    // Admitted under another pool: that pool's Init revokes it, never this one silently.
                    if (was != i.pool && was != address(0)) revert NotAdmissible(id);
                    admittedPool[account][id] = REVOKED;
                    emit Revoked(account, i.pool, id);
                }
            }
        }
        emit PolicySet(configId, msg.sender, account);
    }

    /// The vault and bridge families: `abi.encode(uint256 family, uint64 generation)`. Nothing else to configure: the
    /// vault list, the bridge's messenger, token and domain are this deployment's immutables, and the grant's own
    /// actions (target + selector) name which vaults the session may call at all.
    function _initFamily(address account, ConfigId configId, bytes calldata initData) internal {
        (uint256 family, uint64 generation) = abi.decode(initData, (uint256, uint64));
        address kind;
        if (family == FAMILY_VAULTS) kind = VAULTS;
        else if (family == FAMILY_BRIDGE && TOKEN_MESSENGER != address(0)) kind = BRIDGE;
        else revert BadInit(12);
        if (generation > MAX_GENERATION) revert BadInit(4);
        _stepGeneration(account, generation);
        _binding[configId][account] = Binding({pool: kind, generation: generation});
        emit PolicySet(configId, msg.sender, account);
    }

    function _stepGeneration(address account, uint64 g) internal {
        uint64 current = generationOf[account];
        if (g < current) revert StaleGeneration(g, current);
        // A jump of more than one is allowed only on the first enable at this deployment (a migration carries the
        // old deployment's generation); after that, renewals step by one, so nobody can burn the number space.
        if (current != 0 && g > current + 1) revert BadInit(4);
        if (current == 0 && g > MAX_FIRST_GENERATION) revert BadInit(4); // LeftClaw H-1
        if (g > current) generationOf[account] = g;
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
        if (isPaused(account)) return VALIDATION_FAILED; // the guardian stopped this account's session actions
        if (value != 0 || data.length < 4) return VALIDATION_FAILED;
        bytes4 sel = bytes4(data[:4]);
        if (b.pool == VAULTS) return _checkVault(account, target, sel, data);
        if (b.pool == BRIDGE) return _checkBridge(account, target, sel, data);
        Config memory c = _config[account][b.pool];
        PoolInfo memory p = _pool[b.pool];

        if (target == ROUTER && sel == EXACT_INPUT_SINGLE) {
            return _checkSwap(account, b.pool, c, p, abi.decode(data[4:], (ExactInputSingleParams)));
        }
        if (target == address(this) && sel == this.mint.selector) {
            MintParams memory m = abi.decode(data[4:], (MintParams));
            if (m.token0 != p.token0 || m.token1 != p.token1 || m.fee != p.fee || m.recipient != account) {
                return VALIDATION_FAILED;
            }
            return _checkProvide(
                account,
                b.pool,
                c,
                p,
                m.amount0Desired,
                m.amount1Desired,
                m.tickLower,
                m.tickUpper,
                m.amount0Min,
                m.amount1Min
            );
        }
        if (target == address(this) && sel == this.increase.selector) {
            IncreaseLiquidityParams memory n = abi.decode(data[4:], (IncreaseLiquidityParams));
            // #171: only a position admitted for this account and pool that the account still owns.
            if (!_isAdmitted(account, b.pool, n.tokenId)) return VALIDATION_FAILED;
            (int24 lower, int24 upper) = _ticksOf(n.tokenId);
            return _checkProvide(
                account, b.pool, c, p, n.amount0Desired, n.amount1Desired, lower, upper, n.amount0Min, n.amount1Min
            );
        }
        if (target == address(NPM) && sel == DECREASE) {
            DecreaseLiquidityParams memory d = abi.decode(data[4:], (DecreaseLiquidityParams));
            if (!_isAdmitted(account, b.pool, d.tokenId)) return VALIDATION_FAILED;
            (bool ok, int24 lo, int24 hi) = _range(c, b.pool, false); // LeftClaw M-6: the anchor never locks an exit
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
        if (target == ROUTER && sel == MULTICALL_DEADLINE) {
            // The engine's swap deadline (#140): multicall(deadline, []) executes nothing and reverts once the block is
            // past `deadline`. Only the exact empty encoding passes (selector, deadline, offset 0x40, length 0: 100
            // bytes); it is here, after the generation and pause checks, so a retired or paused grant cannot spend uses
            // on it either.
            return data.length == 100 && uint256(bytes32(data[36:68])) == 0x40 && uint256(bytes32(data[68:100])) == 0
                ? VALIDATION_SUCCESS
                : VALIDATION_FAILED;
        }
        if (sel == APPROVE && (target == p.token0 || target == p.token1)) {
            (address spender,) = abi.decode(data[4:], (address, uint256));
            // Caps on the amount stay in UniActionPolicy; here only who may pull: the router or this policy's mint and
            // increase. Never the position manager: its increaseLiquidity would fund any tokenId (#171).
            return spender == ROUTER || spender == address(this) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        return VALIDATION_FAILED;
    }

    /// ERC-4626 on a listed vault: shares and assets only ever land on the account, and only the account's own shares
    /// leave. An approval of a listed vault's asset only to that vault (the amount is not capped here, as V2 leaves
    /// approval amounts to the grant: a listed vault pulls only from its caller, the account, inside deposit/mint).
    function _checkVault(address account, address target, bytes4 sel, bytes calldata data)
        internal
        view
        returns (uint256)
    {
        if (sel == APPROVE) {
            (address spender,) = abi.decode(data[4:], (address, uint256));
            address a = vaultAsset[spender];
            return a != address(0) && a == target ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (vaultAsset[target] == address(0)) return VALIDATION_FAILED;
        if (sel == VAULT_DEPOSIT || sel == VAULT_MINT) {
            (, address receiver) = abi.decode(data[4:], (uint256, address));
            return receiver == account ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (sel == VAULT_WITHDRAW || sel == VAULT_REDEEM) {
            (, address receiver, address owner) = abi.decode(data[4:], (uint256, address, address));
            return receiver == account && owner == account ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        return VALIDATION_FAILED;
    }

    /// CCTP V2 `depositForBurn` to this same account on the pinned domain: every word of the call is fixed but the
    /// amount (#213's bridge-out grant, the same rules, decided here instead of in UniActionPolicy param rules).
    function _checkBridge(address account, address target, bytes4 sel, bytes calldata data)
        internal
        view
        returns (uint256)
    {
        if (sel == APPROVE) {
            (address spender,) = abi.decode(data[4:], (address, uint256));
            return target == BURN_TOKEN && spender == TOKEN_MESSENGER ? VALIDATION_SUCCESS : VALIDATION_FAILED;
        }
        if (target != TOKEN_MESSENGER || sel != DEPOSIT_FOR_BURN) return VALIDATION_FAILED;
        (
            uint256 amount,
            uint32 domain,
            bytes32 mintRecipient,
            address burnToken,
            bytes32 destinationCaller,
            uint256 maxFee,
            uint32 minFinality
        ) = abi.decode(data[4:], (uint256, uint32, bytes32, address, bytes32, uint256, uint32));
        return amount != 0 && domain == DESTINATION_DOMAIN && mintRecipient == bytes32(uint256(uint160(account)))
            && burnToken == BURN_TOKEN && destinationCaller == bytes32(0) && maxFee == 0
            && minFinality >= CCTP_MIN_FINALITY
            ? VALIDATION_SUCCESS
            : VALIDATION_FAILED;
    }

    function _checkSwap(
        address account,
        address pool,
        Config memory c,
        PoolInfo memory p,
        ExactInputSingleParams memory s
    ) internal returns (uint256) {
        if (s.recipient != account || s.fee != p.fee || s.amountIn == 0) return VALIDATION_FAILED; // 0: LeftClaw L-7
        bool zeroForOne = s.tokenIn == p.token0 && s.tokenOut == p.token1;
        if (!zeroForOne && !(s.tokenIn == p.token1 && s.tokenOut == p.token0)) return VALIDATION_FAILED;
        (bool ok, int24 lo, int24 hi) = _range(c, pool, true);
        if (!ok || !_spotIn(pool, lo, hi)) return VALIDATION_FAILED;
        (uint256 minOut, uint160 limit) = _swapBounds(p, lo, hi, zeroForOne, s.amountIn);
        if (s.amountOutMinimum < minOut) return VALIDATION_FAILED;
        // A zero limit means "no limit" to the pool: refused. zeroForOne moves the price down: the limit is a floor.
        if (s.sqrtPriceLimitX96 == 0) return VALIDATION_FAILED;
        if (zeroForOne ? s.sqrtPriceLimitX96 < limit : s.sqrtPriceLimitX96 > limit) return VALIDATION_FAILED;
        // LeftClaw M-2: the pool reverts (SPL) unless the submitted limit is strictly past the spot in the swap's
        // direction. A spot pushed to between the limit and the range edge would pass the checks above, be charged,
        // and revert at execution; refused here before the charge instead.
        (uint160 spot,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (zeroForOne ? s.sqrtPriceLimitX96 >= spot : s.sqrtPriceLimitX96 <= spot) return VALIDATION_FAILED;
        uint256 v = _value(c, p, lo, hi, zeroForOne ? s.amountIn : 0, zeroForOne ? 0 : s.amountIn);
        return _charge(account, pool, c, v) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
    }

    /// Mint and increase at validation: a non-empty range, and the desired amounts charged to the budget. Desired
    /// amounts are an upper bound of what the manager takes: the budget is charged conservatively. LeftClaw M-2 (review
    /// P2 on ecc1c14): what the manager would take at the validation spot must also meet the submitted minimums, or the
    /// manager's own slippage check reverts the execution after the charge; refused here first (the library rounds
    /// down where the pool rounds up, so this errs on refusing).
    function _checkProvide(
        address account,
        address pool,
        Config memory c,
        PoolInfo memory p,
        uint256 a0,
        uint256 a1,
        int24 lower,
        int24 upper,
        uint256 min0,
        uint256 min1
    ) internal returns (uint256) {
        (bool ok, int24 lo, int24 hi) = _range(c, pool, true);
        if (!ok || !_spotIn(pool, lo, hi)) return VALIDATION_FAILED;
        {
            (uint160 spot,,,,,,) = IUniswapV3Pool(pool).slot0();
            uint160 sa = TickMath.getSqrtRatioAtTick(lower);
            uint160 sb = TickMath.getSqrtRatioAtTick(upper);
            (uint256 u0, uint256 u1) = LiquidityAmounts.getAmountsForLiquidity(
                spot, sa, sb, LiquidityAmounts.getLiquidityForAmounts(spot, sa, sb, a0, a1)
            );
            if (u0 < min0 || u1 < min1) return VALIDATION_FAILED;
        }
        return _charge(account, pool, c, _value(c, p, lo, hi, a0, a1)) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
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
        if (isPaused(account)) revert AccountPaused(account);
        (uint256 b0, uint256 b1) = _fund(account, m.token0, m.token1, m.amount0Desired, m.amount1Desired);
        // T6 I-7: checked right before the manager's call, after every token callback of the pulls/approvals.
        _requireSpotInRange(c, pool);
        (tokenId, liquidity, amount0, amount1) = NPM.mint(m);
        _settle(account, m.token0, m.token1, b0, b1);

        admittedPool[account][tokenId] = pool;
        emit Admitted(account, pool, tokenId);
        _locked = 1;
    }

    /**
     * @notice Called BY THE ACCOUNT (msg.sender) inside a session batch, after approving this contract for at most the
     * desired amounts (#171). Adds liquidity to a position admitted for the account that the account still owns, under
     * the account's current config of that position's pool, with the same checks as `mint`: not paused, and the pool's
     * spot price inside the range [lo, hi] right before the manager's call. Returns everything the manager did not
     * take. Admission does not change.
     */
    function increase(IncreaseLiquidityParams calldata n)
        external
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        address account = msg.sender;
        address pool = admittedPool[account][n.tokenId];
        if (pool == address(0) || !_isAdmitted(account, pool, n.tokenId)) revert NotAdmitted(n.tokenId);
        Config memory c = _config[account][pool];
        if (c.twapWindow == 0 || c.generation != generationOf[account]) revert NoConfig(account, pool);
        if (isPaused(account)) revert AccountPaused(account);
        PoolInfo memory p = _pool[pool];
        (uint256 b0, uint256 b1) = _fund(account, p.token0, p.token1, n.amount0Desired, n.amount1Desired);
        // As in mint (T6 I-7): checked right before the manager's call, after every token callback.
        _requireSpotInRange(c, pool);
        (liquidity, amount0, amount1) = NPM.increaseLiquidity(n);
        _settle(account, p.token0, p.token1, b0, b1);
        _locked = 1;
    }

    /// Mint and increase, before the manager's call: this contract's balances (for the refund), then the pull of the
    /// desired amounts from the account and the manager's approval for exactly them. The caller checks the spot after
    /// this (T6 I-7).
    function _fund(address account, address t0, address t1, uint256 a0, uint256 a1)
        internal
        returns (uint256 b0, uint256 b1)
    {
        b0 = IERC20Min(t0).balanceOf(address(this));
        b1 = IERC20Min(t1).balanceOf(address(this));
        _pull(t0, account, a0);
        _pull(t1, account, a1);
        _approve(t0, address(NPM), a0);
        _approve(t1, address(NPM), a1);
    }

    /// Mint and increase, after the manager's call: approvals back to 0, and everything the manager did not take back
    /// to the account. T6 I-5: from the balance delta, so WETH the manager funded from its own ETH comes back too.
    function _settle(address account, address t0, address t1, uint256 b0, uint256 b1) internal {
        _approve(t0, address(NPM), 0);
        _approve(t1, address(NPM), 0);
        uint256 r0 = IERC20Min(t0).balanceOf(address(this)) - b0;
        uint256 r1 = IERC20Min(t1).balanceOf(address(this)) - b1;
        if (r0 != 0) _push(t0, account, r0);
        if (r1 != 0) _push(t1, account, r1);
    }

    // ---------------------------------------------------------------- guardian: revoke-only

    /// Refuses every session action of `account` (checkAction, `mint`, `increase`) until `unpause` or until the owner
    /// renews (a higher generation). The owner's own path (the passkey, Stop, withdrawals) is not behind this policy.
    function pause(address account) external {
        if (msg.sender != GUARDIAN || GUARDIAN == address(0)) revert OnlyGuardian();
        uint64 g = generationOf[account];
        pausedAt[account] = g + 1;
        emit Paused(account, g);
    }

    /// Restores the same owner-signed envelope; it never widens it.
    function unpause(address account) external {
        if (msg.sender != GUARDIAN || GUARDIAN == address(0)) revert OnlyGuardian();
        pausedAt[account] = 0;
        emit Unpaused(account);
    }

    function isPaused(address account) public view returns (bool) {
        uint64 p = pausedAt[account];
        return p != 0 && p == generationOf[account] + 1;
    }

    // ---------------------------------------------------------------- views the engine and precheck use

    /// The price range [lo, hi] (ticks) every priced action of `account` in `pool` must stay in now. Reverts
    /// `RangeEmpty` when the two TWAPs are about 2 x band apart, or the range misses the anchor.
    function priceRange(address account, address pool) external view returns (int24 lo, int24 hi) {
        (lo, hi) = _rangeOrRevert(_current(account, pool), pool, true);
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
        (int24 lo, int24 hi) = _rangeOrRevert(_current(account, pool), pool, false); // M-6, as checkAction's decrease
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

    /// Two TWAPs from one `observe([long, short, 0])`, floor-rounded like `OracleLibrary.consult`. Same-block swaps
    /// cannot move either (observations are written per block).
    function _oracle(Config memory c, address pool) internal view returns (int24 tl, int24 ts) {
        uint32[] memory ago = new uint32[](3);
        ago[0] = c.twapWindow;
        ago[1] = c.twapShortWindow;
        (int56[] memory tc,) = IUniswapV3Pool(pool).observe(ago);
        tl = _meanTick(tc[2] - tc[0], c.twapWindow);
        ts = _meanTick(tc[2] - tc[1], c.twapShortWindow);
    }

    /// lo = max(long, short) - band + 1, hi = min(long, short) + band. The +1: both means are floored, so the true
    /// mean of the higher one can be up to one tick above it (T6 L-7). Then clipped to the anchor, if any and if
    /// `anchored` (every action but decrease: LeftClaw M-6, a depeg must not lock the position). `ok` is false when
    /// the result is empty: the TWAPs disagree by about 2 x band or more (a fast move, or a recent push: one block held
    /// D ticks away moves the short TWAP D/150 and the long D/900), or the price left the anchor.
    function _range(Config memory c, address pool, bool anchored) internal view returns (bool ok, int24 lo, int24 hi) {
        (int24 tl, int24 ts) = _oracle(c, pool);
        int24 top = tl > ts ? tl : ts;
        int24 bottom = tl > ts ? ts : tl;
        int256 l = int256(top) - int256(uint256(c.bandTicks)) + 1;
        int256 h = int256(bottom) + int256(uint256(c.bandTicks));
        if (anchored && c.anchorBand != 0) {
            int256 al = int256(c.anchorTick) - int256(uint256(c.anchorBand));
            int256 ah = int256(c.anchorTick) + int256(uint256(c.anchorBand));
            if (l < al) l = al;
            if (h > ah) h = ah;
        }
        lo = _clamp(l);
        hi = _clamp(h);
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

    function _rangeOrRevert(Config memory c, address pool, bool anchored) internal view returns (int24 lo, int24 hi) {
        bool ok;
        (ok, lo, hi) = _range(c, pool, anchored);
        if (!ok) {
            (int24 tl, int24 ts) = _oracle(c, pool);
            revert RangeEmpty(tl, ts);
        }
    }

    function _requireSpotInRange(Config memory c, address pool) internal view {
        (int24 lo, int24 hi) = _rangeOrRevert(c, pool, true);
        if (!_spotIn(pool, lo, hi)) {
            (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
            revert SpotOutsideRange(sqrtPriceX96, lo, hi);
        }
    }

    /// The pool's spot inside [lo, hi], compared as sqrt prices, not floored ticks (T6 L-7). Also at validation
    /// (LeftClaw M-2): a third party who pushed the spot out before the bundle lands makes the action fail before the
    /// budget is charged, instead of charging it for an execution that `mint`/`increase` or the router would refuse.
    function _spotIn(address pool, int24 lo, int24 hi) internal view returns (bool) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        return sqrtPriceX96 >= TickMath.getSqrtRatioAtTick(lo) && sqrtPriceX96 <= TickMath.getSqrtRatioAtTick(hi);
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
        if (i.twapShortWindow < MIN_SHORT_WINDOW || uint256(i.twapShortWindow) * MIN_WINDOW_RATIO > i.twapWindow) {
            revert BadInit(2); // LeftClaw M-1: also at least MIN_WINDOW_RATIO short windows in the long one
        }
        if (i.bandTicks < MIN_BAND || i.bandTicks > MAX_BAND) revert BadInit(3);
        if (i.generation > MAX_GENERATION) revert BadInit(4);
        if (i.anchorBand > MAX_BAND || i.anchorTick < TickMath.MIN_TICK || i.anchorTick > TickMath.MAX_TICK) {
            revert BadInit(5);
        }
        if (i.budgetWindow < MIN_BUDGET_WINDOW) revert BadInit(7);
        if (i.perWindow == 0 || i.total < i.perWindow) revert BadInit(8);
        if (i.admit.length > MAX_ADMIT) revert BadInit(10);
        // T6 L-4: at most one observation per block and blocks of at least 1 s, so the ring must hold at least
        // `twapWindow` observations for the long window to survive a dust swap in every block. Deploy step:
        // script/Deploy.s.sol raises `observationCardinalityNext` before any enable.
        (,,,, uint16 cardinalityNext,,) = IUniswapV3Pool(i.pool).slot0();
        if (cardinalityNext < i.twapWindow) revert ObservationCardinalityTooLow(cardinalityNext, i.twapWindow);
    }

    /// LeftClaw M-5: the smaller, in the budget unit, of what moving `pool`'s price `band` ticks takes in either
    /// direction, since a session's swap may sell either token. The other token's depth is valued at the band edge
    /// that values it lowest (token1 at the top edge, token0 at the bottom edge), as `_value` would charge at most.
    function _depthIn(address pool, PoolInfo memory p, uint24 band, bool in1) internal view returns (uint256) {
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 up = _depth(pool, band, true); // token1 sold
        uint256 down = _depth(pool, band, false); // token0 sold
        if (in1) {
            down = OracleLibrary.getQuoteAtTick(
                _clamp(int256(tick) - int256(uint256(band))), _u128(down), p.token0, p.token1
            );
        } else {
            up = OracleLibrary.getQuoteAtTick(
                _clamp(int256(tick) + int256(uint256(band))), _u128(up), p.token1, p.token0
            );
        }
        return up < down ? up : down;
    }

    /// What selling into `pool` takes to move its price `band` ticks (token1 moves it up, token0 down), walking every
    /// tick boundary in between and applying its liquidityNet, as the pool's own swap would. At most
    /// band / tickSpacing + 1 steps (MAX_BAND 500: ~501 cold `ticks` reads on a spacing-1 pool; production bands are
    /// 10 and 100); only at a config write, never at validation. (Base, block of the fork tests: stables ~48k USDT up
    /// / ~55k USDC down over 10 ticks; cbBTC ~4.6 BTC up / ~384k USDC down and WETH ~8.4M USDC up / ~3,455 WETH down
    /// over 100.)
    function _depth(address pool, uint24 band, bool up) internal view returns (uint256 d) {
        IUniswapV3Pool v = IUniswapV3Pool(pool);
        (uint160 sp, int24 tick,,,,,) = v.slot0();
        int256 liq = int256(uint256(v.liquidity()));
        int24 spacing = v.tickSpacing();
        int24 end = _clamp(up ? int256(tick) + int256(uint256(band)) : int256(tick) - int256(uint256(band)));
        int24 b = tick / spacing * spacing; // the boundary at or below the spot
        if (tick < 0 && tick % spacing != 0) b -= spacing;
        if (up) b += spacing;
        while (true) {
            bool last = up ? b >= end : b <= end;
            uint160 sb = TickMath.getSqrtRatioAtTick(last ? end : b);
            uint128 l = liq > 0 ? uint128(uint256(liq)) : 0;
            d += up
                ? LiquidityAmounts.getAmount1ForLiquidity(sp, sb, l)
                : LiquidityAmounts.getAmount0ForLiquidity(sb, sp, l);
            if (last) return d;
            (, int128 net,,,,,,) = v.ticks(b);
            liq = up ? liq + net : liq - net;
            sp = sb;
            b = up ? b + spacing : b - spacing;
        }
    }

    function _initHash(Init memory i) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                i.pool,
                i.twapWindow,
                i.twapShortWindow,
                i.bandTicks,
                i.generation,
                i.anchorTick,
                i.anchorBand,
                i.budgetIn1,
                i.budgetWindow,
                i.perWindow,
                i.total
            )
        );
    }

    /// T6 M-4: a position the account owns in this pool, named in owner-signed enable data, becomes manageable.
    function _admitAtEnable(address account, address pool, PoolInfo memory p, uint256 tokenId) internal {
        if (admittedPool[account][tokenId] == REVOKED) return; // the owner revoked it: never again (M-4)
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
        return pool != REVOKED && admittedPool[account][tokenId] == pool && NPM.ownerOf(tokenId) == account;
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
