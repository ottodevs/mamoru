// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Smart Sessions policy config id (erc7579/smartsessions contracts/DataTypes.sol).
type ConfigId is bytes32;

/// erc7579/smartsessions contracts/interfaces/IPolicy.sol, reduced to what an action policy implements.
interface IActionPolicy {
    function initializeWithMultiplexer(address account, ConfigId configId, bytes calldata initData) external;
    function checkAction(ConfigId id, address account, address target, uint256 value, bytes calldata data)
        external
        returns (uint256);
}

import {PoolKey} from "./PoolKey.sol";

/// The two PositionManager reads the policy makes for an action on an existing tokenId.
interface IPositionManagerReads {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256 info);
}

/**
 * @title MamoruV4LiquidityPolicy (otto/mamoru#182). Not audited, not deployed. Not for live funds before an external audit.
 * @notice A Smart Sessions action policy for Uniswap v4 `PositionManager.modifyLiquidities(bytes unlockData, uint256
 * deadline)`. UniActionPolicy cannot bound that call: `unlockData` is `abi.encode(bytes actions, bytes[] params)`, a
 * variable-length program. This policy decodes the program and admits it only when every step is one of:
 *
 *   MINT_POSITION       pool allowlisted, ticks inside the pool's range, amounts under the pool's caps, owner = account
 *   INCREASE_LIQUIDITY  position owned by the account, in an allowlisted pool, ticks inside the range, amounts capped
 *   DECREASE_LIQUIDITY  position owned by the account, in an allowlisted pool (liquidity 0 = collect fees)
 *   BURN_POSITION       position owned by the account, in an allowlisted pool
 *   SETTLE_PAIR         both currencies belong to an allowlisted pool (pays the open debt via Permit2 from the account)
 *   TAKE_PAIR           both currencies allowlisted, recipient = the account (exact address, no ActionConstants alias)
 *   CLOSE_CURRENCY      currency allowlisted (settles a debt from, or takes a credit to, the locker = the account)
 *
 * with empty hookData everywhere, at most one liquidity-adding step per call, at most MAX_ACTIONS steps, no native value,
 * and the exact canonical ABI encoding (re-encoded and compared, so no parser differential with PositionManager's
 * assembly decoder). Everything else is refused: SETTLE/TAKE/SWEEP with free recipients or payers, CLEAR_OR_TAKE (forfeits
 * a credit), the *_FROM_DELTAS steps (deprecated upstream, sandwichable), WRAP/UNWRAP, unknown action bytes.
 *
 * Deadline: the policy returns validAfter = deadline - maxDeadlineWindow and validUntil = deadline as ERC-4337
 * validation data. The EntryPoint then enforces that the userOp lands inside that window, so the policy bounds the
 * deadline without reading TIMESTAMP during validation. Smart Sessions intersects it with the other policies' ranges.
 *
 * Storage is per (configId, multiplexer, account) like UniActionPolicy, with the account as the innermost mapping key
 * (ERC-7562 associated storage). Re-initialization bumps an epoch, so pools allowlisted by an earlier init are dead.
 *
 * ERC-7562: steps on an existing tokenId read PositionManager state (ownerOf, getPoolAndPositionInfo) during
 * validation, which public-mempool bundlers reject. Mamoru bundles its own userOps; the same tradeoff as spec 007
 * (otto/mamoru#151). MINT/SETTLE/TAKE/CLOSE-only programs read nothing outside the policy's own associated storage.
 */
contract MamoruV4LiquidityPolicy is IActionPolicy {
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;

    /// modifyLiquidities(bytes,uint256)
    bytes4 internal constant MODIFY_LIQUIDITIES = 0xdd46508f;

    // v4-periphery src/libraries/Actions.sol
    uint256 internal constant INCREASE_LIQUIDITY = 0x00;
    uint256 internal constant DECREASE_LIQUIDITY = 0x01;
    uint256 internal constant MINT_POSITION = 0x02;
    uint256 internal constant BURN_POSITION = 0x03;
    uint256 internal constant SETTLE_PAIR = 0x0d;
    uint256 internal constant TAKE_PAIR = 0x11;
    uint256 internal constant CLOSE_CURRENCY = 0x12;

    uint256 public constant MAX_ACTIONS = 8;
    uint256 public constant MAX_POOLS = 8;
    uint256 public constant MAX_HOOKS = 4;

    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    /// v4-core Hooks.sol: AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG. A hook with
    /// either flag can charge or skim the liquidity provider's deltas; refused even when the owner allowlists it.
    uint160 internal constant LIQUIDITY_DELTA_FLAGS = (1 << 1) | (1 << 0);

    /// One allowlisted pool. Caps bound one liquidity-adding step (MINT or INCREASE), which is at most one per call.
    struct PoolRule {
        PoolKey key;
        int24 minTickLower;
        int24 maxTickUpper;
        uint128 maxAmount0;
        uint128 maxAmount1;
    }

    /// Owner-signed init data of the modifyLiquidities action (abi.encode of this struct).
    struct Init {
        address positionManager;
        uint32 maxDeadlineWindow; // seconds; a deadline more than this ahead of the inclusion time is refused
        address[] allowedHooks; // besides address(0); empty = hook-less pools only
        PoolRule[] pools;
    }

    struct Config {
        address positionManager;
        uint32 maxDeadlineWindow;
        uint64 epoch;
    }

    struct StoredPool {
        bool allowed;
        int24 minTickLower;
        int24 maxTickUpper;
        uint128 maxAmount0;
        uint128 maxAmount1;
    }

    mapping(ConfigId id => mapping(address multiplexer => mapping(address account => Config))) internal _config;
    /// scope = keccak256(id, multiplexer, epoch, poolId)
    mapping(bytes32 scope => mapping(address account => StoredPool)) internal _pools;
    /// scope = keccak256(id, multiplexer, epoch, currency)
    mapping(bytes32 scope => mapping(address account => bool)) internal _currencies;

    event PolicySet(ConfigId id, address multiplexer, address account);

    error PolicyNotInitialized(ConfigId id, address multiplexer, address account);
    error InvalidInit();
    error InvalidPool(uint256 index);

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        // smartsessions: type(IPolicy).interfaceId == initializeWithMultiplexer.selector and
        // type(IActionPolicy).interfaceId == checkAction.selector (interface ids exclude inherited functions).
        return interfaceID == 0x01ffc9a7 || interfaceID == IActionPolicy.checkAction.selector
            || interfaceID == IActionPolicy.initializeWithMultiplexer.selector;
    }

    // ------------------------------------------------------------------ init (owner-signed, via Smart Sessions)

    /// @dev No external calls (smartsessions guidance for policy init). Reverting makes enableSessions revert.
    function initializeWithMultiplexer(address account, ConfigId configId, bytes calldata initData) external {
        Init memory i = abi.decode(initData, (Init));
        if (
            i.positionManager == address(0) || i.maxDeadlineWindow == 0 || i.pools.length == 0
                || i.pools.length > MAX_POOLS || i.allowedHooks.length > MAX_HOOKS
        ) revert InvalidInit();

        Config storage c = _config[configId][msg.sender][account];
        uint64 epoch = c.epoch + 1;
        c.positionManager = i.positionManager;
        c.maxDeadlineWindow = i.maxDeadlineWindow;
        c.epoch = epoch;

        for (uint256 k; k < i.pools.length; k++) {
            PoolRule memory r = i.pools[k];
            if (!_validPool(r, i.allowedHooks)) revert InvalidPool(k);
            _pools[_scope(configId, msg.sender, epoch, _poolId(r.key))][account] = StoredPool({
                allowed: true,
                minTickLower: r.minTickLower,
                maxTickUpper: r.maxTickUpper,
                maxAmount0: r.maxAmount0,
                maxAmount1: r.maxAmount1
            });
            _currencies[_scope(configId, msg.sender, epoch, bytes32(uint256(uint160(r.key.currency0))))][account] = true;
            _currencies[_scope(configId, msg.sender, epoch, bytes32(uint256(uint160(r.key.currency1))))][account] = true;
        }
        emit PolicySet(configId, msg.sender, account);
    }

    function _validPool(PoolRule memory r, address[] memory allowedHooks) internal pure returns (bool) {
        PoolKey memory k = r.key;
        // Native currency is address(0) and always sorts first: refused (this policy admits no msg.value).
        if (k.currency0 == address(0) || k.currency0 >= k.currency1) return false;
        if (k.tickSpacing <= 0) return false;
        if (r.minTickLower < MIN_TICK || r.maxTickUpper > MAX_TICK || r.minTickLower >= r.maxTickUpper) return false;
        if (k.hooks == address(0)) return true;
        if (uint160(k.hooks) & LIQUIDITY_DELTA_FLAGS != 0) return false;
        for (uint256 h; h < allowedHooks.length; h++) {
            if (allowedHooks[h] == k.hooks) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ validation (Smart Sessions -> policy)

    function checkAction(ConfigId id, address account, address target, uint256 value, bytes calldata data)
        external
        view
        returns (uint256)
    {
        Config memory c = _config[id][msg.sender][account];
        if (c.positionManager == address(0)) revert PolicyNotInitialized(id, msg.sender, account);
        if (value != 0 || target != c.positionManager) return VALIDATION_FAILED;
        if (data.length < 4 || bytes4(data[:4]) != MODIFY_LIQUIDITIES) return VALIDATION_FAILED;

        (bytes memory unlockData, uint256 deadline) = abi.decode(data[4:], (bytes, uint256));
        if (keccak256(abi.encodeWithSelector(MODIFY_LIQUIDITIES, unlockData, deadline)) != keccak256(data)) {
            return VALIDATION_FAILED;
        }
        // 0 would read as "no expiry" in validationData; past uint48 it does not fit.
        if (deadline == 0 || deadline > type(uint48).max) return VALIDATION_FAILED;

        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));
        if (keccak256(abi.encode(actions, params)) != keccak256(unlockData)) return VALIDATION_FAILED;
        uint256 n = actions.length;
        if (n == 0 || n > MAX_ACTIONS || params.length != n) return VALIDATION_FAILED;

        Ctx memory x = Ctx({id: id, account: account, c: c, added: false});
        for (uint256 k; k < n; k++) {
            if (!_step(x, uint8(actions[k]), params[k])) return VALIDATION_FAILED;
        }

        uint256 validAfter = deadline > c.maxDeadlineWindow ? deadline - c.maxDeadlineWindow : 0;
        // ERC-4337 validationData: authorizer 0 (valid) | validUntil << 160 | validAfter << 208.
        return (deadline << 160) | (validAfter << 208);
    }

    struct Ctx {
        ConfigId id;
        address account;
        Config c;
        bool added; // a MINT or INCREASE was already admitted in this call
    }

    function _step(Ctx memory x, uint256 action, bytes memory p) internal view returns (bool) {
        if (action == MINT_POSITION) return _mint(x, p);
        if (action == INCREASE_LIQUIDITY) return _increase(x, p);
        if (action == DECREASE_LIQUIDITY || action == BURN_POSITION) return _remove(x, action, p);
        if (action == SETTLE_PAIR) {
            (address c0, address c1) = abi.decode(p, (address, address));
            return keccak256(abi.encode(c0, c1)) == keccak256(p) && _currency(x, c0) && _currency(x, c1);
        }
        if (action == TAKE_PAIR) {
            (address c0, address c1, address to) = abi.decode(p, (address, address, address));
            return keccak256(abi.encode(c0, c1, to)) == keccak256(p) && to == x.account && _currency(x, c0)
                && _currency(x, c1);
        }
        if (action == CLOSE_CURRENCY) {
            address c0 = abi.decode(p, (address));
            return keccak256(abi.encode(c0)) == keccak256(p) && _currency(x, c0);
        }
        return false;
    }

    struct MintStep {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint256 liquidity;
        uint128 amount0Max;
        uint128 amount1Max;
        address owner;
        bytes hookData;
    }

    function _mint(Ctx memory x, bytes memory p) internal view returns (bool) {
        if (x.added) return false;
        x.added = true;
        MintStep memory m = _decodeMint(p);
        if (keccak256(_encodeMint(m)) != keccak256(p)) return false;
        if (m.owner != x.account || m.hookData.length != 0) return false;
        StoredPool memory s = _pool(x, m.key);
        return s.allowed && _ticksOk(s, m.tickLower, m.tickUpper) && m.amount0Max <= s.maxAmount0
            && m.amount1Max <= s.maxAmount1;
    }

    function _decodeMint(bytes memory p) internal pure returns (MintStep memory m) {
        (m.key, m.tickLower, m.tickUpper, m.liquidity, m.amount0Max, m.amount1Max, m.owner, m.hookData) =
            abi.decode(p, (PoolKey, int24, int24, uint256, uint128, uint128, address, bytes));
    }

    function _encodeMint(MintStep memory m) internal pure returns (bytes memory) {
        return abi.encode(m.key, m.tickLower, m.tickUpper, m.liquidity, m.amount0Max, m.amount1Max, m.owner, m.hookData);
    }

    function _increase(Ctx memory x, bytes memory p) internal view returns (bool) {
        if (x.added) return false;
        x.added = true;
        (uint256 tokenId, uint256 liquidity, uint128 a0, uint128 a1, bytes memory hookData) =
            abi.decode(p, (uint256, uint256, uint128, uint128, bytes));
        if (keccak256(abi.encode(tokenId, liquidity, a0, a1, hookData)) != keccak256(p) || hookData.length != 0) {
            return false;
        }
        (bool ok, StoredPool memory s, int24 lower, int24 upper) = _ownedPosition(x, tokenId);
        return ok && _ticksOk(s, lower, upper) && a0 <= s.maxAmount0 && a1 <= s.maxAmount1;
    }

    /// DECREASE (tokenId, liquidity, amount0Min, amount1Min, hookData) or BURN (tokenId, amount0Min, amount1Min,
    /// hookData). Leaving is allowed whatever the ticks, so an exit never depends on the range config.
    function _remove(Ctx memory x, uint256 action, bytes memory p) internal view returns (bool) {
        uint256 tokenId;
        bytes memory hookData;
        if (action == DECREASE_LIQUIDITY) {
            uint256 liquidity;
            uint128 m0;
            uint128 m1;
            (tokenId, liquidity, m0, m1, hookData) = abi.decode(p, (uint256, uint256, uint128, uint128, bytes));
            if (keccak256(abi.encode(tokenId, liquidity, m0, m1, hookData)) != keccak256(p)) return false;
        } else {
            uint128 m0;
            uint128 m1;
            (tokenId, m0, m1, hookData) = abi.decode(p, (uint256, uint128, uint128, bytes));
            if (keccak256(abi.encode(tokenId, m0, m1, hookData)) != keccak256(p)) return false;
        }
        if (hookData.length != 0) return false;
        (bool ok,,,) = _ownedPosition(x, tokenId);
        return ok;
    }

    /// The position must exist, be owned by the account (not merely approved to it) and sit in an allowlisted pool.
    function _ownedPosition(Ctx memory x, uint256 tokenId)
        internal
        view
        returns (bool ok, StoredPool memory s, int24 lower, int24 upper)
    {
        address pm = x.c.positionManager;
        (bool success, bytes memory ret) = pm.staticcall(abi.encodeCall(IPositionManagerReads.ownerOf, (tokenId)));
        if (!success || ret.length != 32 || abi.decode(ret, (address)) != x.account) return (false, s, 0, 0);
        (PoolKey memory key, uint256 info) = IPositionManagerReads(pm).getPoolAndPositionInfo(tokenId);
        s = _pool(x, key);
        // v4-periphery PositionInfoLibrary: tickLower at bit 8, tickUpper at bit 32, 24 bits each, signed.
        // forge-lint: disable-next-line(unsafe-typecast) -- truncation to the packed 24-bit field is the decoding
        lower = int24(uint24(info >> 8));
        // forge-lint: disable-next-line(unsafe-typecast)
        upper = int24(uint24(info >> 32));
        ok = s.allowed;
    }

    function _ticksOk(StoredPool memory s, int24 lower, int24 upper) internal pure returns (bool) {
        return lower >= s.minTickLower && upper <= s.maxTickUpper && lower < upper;
    }

    function _pool(Ctx memory x, PoolKey memory key) internal view returns (StoredPool memory) {
        return _pools[_scope(x.id, msg.sender, x.c.epoch, _poolId(key))][x.account];
    }

    function _currency(Ctx memory x, address currency) internal view returns (bool) {
        return _currencies[_scope(x.id, msg.sender, x.c.epoch, bytes32(uint256(uint160(currency))))][x.account];
    }

    function _poolId(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key)); // = v4-core PoolIdLibrary.toId
    }

    function _scope(ConfigId id, address mux, uint64 epoch, bytes32 item) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, mux, epoch, item));
    }

    // ------------------------------------------------------------------ views for the engine and for audits

    function configOf(ConfigId id, address multiplexer, address account) external view returns (Config memory) {
        return _config[id][multiplexer][account];
    }

    function poolRuleOf(ConfigId id, address multiplexer, address account, PoolKey calldata key)
        external
        view
        returns (StoredPool memory)
    {
        Config memory c = _config[id][multiplexer][account];
        return _pools[_scope(id, multiplexer, c.epoch, _poolId(key))][account];
    }
}
