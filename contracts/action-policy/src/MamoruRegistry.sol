// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/**
 * @title MamoruRegistry (spec 010 T2, otto/mamoru#292). Not deployed.
 * @notice The timelocked list of what MamoruActionPolicyV4 may use on this chain: pools, vaults and chain routes, with
 * their parameters. It never names a token, a router, a position manager, a messenger, a Safe stack or a remote
 * account: those are V4 constants (spec 010 "Pinned in V4"). An entry only chooses AMONG things V4 already trusts, and
 * V4 checks each one again at every use (factory pool of pinned tokens, MetaMorpho factory membership, a destination in
 * its chain table, the hard bounds below).
 *
 * I8, additions wait and removals don't:
 *  - every addition, re-activation or loosening is `queue`d by the admin and takes effect only through `execute`, at
 *    least `DELAY` later. Each queued change is public (`Queued`, with its full parameters), and the admin or the
 *    guardian can `cancel` it until it executes (I7).
 *  - removal and tightening take effect at once (`remove*`, `tighten*`). A removed pool keeps its parameters with
 *    `active = false`, so V4 can still price the exit of positions in it (exit-only); a removed vault keeps its entry so
 *    V4 still redeems from it.
 *
 * Shape (deploy rule, T7): no proxy, no owner change, no setter beyond the above. `ADMIN` (the team Safe, 2 of 2),
 * `GUARDIAN` (the watchdog key, separate from the operator) and `DELAY` are constructor arguments and MUST be the same on
 * every chain: the registry is CREATE2-deployed with the same init code everywhere, so it has the same address on every
 * chain and V4 pins that one address. A chain where the admin Safe or the guardian would be a different address cannot
 * host this registry at the pinned address, so it cannot host V4's registry at all.
 *
 * Bounds are V3's hard bounds on the Uniswap parameters (MamoruActionPolicyV3 MIN_/MAX_ constants, LeftClaw M-1's
 * window ratio), `ratioBps <= 10,000`, `DELAY >= 48 h`, and at most MAX_CHAINS chains per account (the home chain plus
 * at most MAX_CHAINS - 1 routes). V4 holds the same constants and refuses an entry outside them.
 */
contract MamoruRegistry {
    uint256 public constant MIN_DELAY = 48 hours;
    /// Chains one account may hold funds on: its home chain and MAX_CHAINS - 1 routes (threat model: 4 x per chain).
    uint256 public constant MAX_CHAINS = 4;
    uint32 public constant MIN_TWAP_WINDOW = 600;
    uint32 public constant MAX_TWAP_WINDOW = 86_400;
    uint32 public constant MIN_SHORT_WINDOW = 60;
    uint32 public constant MIN_WINDOW_RATIO = 4;
    uint24 public constant MIN_BAND = 2;
    uint24 public constant MAX_BAND = 500;
    int24 public constant MAX_TICK = 887_272;
    uint16 public constant MAX_RATIO_BPS = 10_000;

    enum Kind {
        Pool,
        Vault,
        Route
    }

    /// One slot. `bandTicks`, `anchorTick`, `anchorBand` and both windows are V3's Init fields of the same name;
    /// `ratioBps` is the pool's share of the account's bucket (I5).
    struct PoolEntry {
        uint32 twapWindow;
        uint32 twapShortWindow;
        uint24 bandTicks;
        int24 anchorTick;
        uint24 anchorBand;
        uint16 ratioBps;
        bool active;
    }

    struct VaultEntry {
        uint16 ratioBps;
        bool active;
    }

    address public immutable ADMIN;
    address public immutable GUARDIAN;
    uint256 public immutable DELAY;

    mapping(address pool => PoolEntry) internal _pools;
    mapping(address vault => VaultEntry) internal _vaults;
    mapping(uint32 domain => bool) public routeOn;
    uint256 public routeCount;
    /// Every pool and vault ever listed (the engine filters by `active`, #293 `activePools`).
    address[] internal _poolList;
    address[] internal _vaultList;
    mapping(address => bool) internal _everListed;

    /// id => earliest execution time; 0 = not queued (never, executed or cancelled).
    mapping(bytes32 id => uint256 eta) public etaOf;
    uint256 public nonce;

    event Queued(bytes32 indexed id, Kind indexed kind, bytes32 indexed key, bytes params, uint256 nonce, uint256 eta);
    event Executed(bytes32 indexed id, Kind indexed kind, bytes32 indexed key, bytes params);
    event Cancelled(bytes32 indexed id, address indexed by);
    event Removed(Kind indexed kind, bytes32 indexed key);
    event Tightened(Kind indexed kind, bytes32 indexed key, bytes params);

    error OnlyAdmin();
    error OnlyAdminOrGuardian();
    error BadConstructor();
    error NotQueued(bytes32 id);
    error TooEarly(bytes32 id, uint256 eta);
    error BadEntry(uint256 field);
    error NotTighter();
    error TooManyRoutes();

    modifier onlyAdmin() {
        if (msg.sender != ADMIN) revert OnlyAdmin();
        _;
    }

    /// @param admin the team Safe; @param guardian the watchdog key (cancel only); @param delay >= MIN_DELAY (72 h in
    /// production). All three identical on every chain (see the contract's notice).
    constructor(address admin, address guardian, uint256 delay) {
        if (admin == address(0) || guardian == address(0) || admin == guardian || delay < MIN_DELAY) {
            revert BadConstructor();
        }
        ADMIN = admin;
        GUARDIAN = guardian;
        DELAY = delay;
    }

    // ---------------------------------------------------------------- additions: queue, wait DELAY, execute (I8)

    /// Queues a pool (`params` = abi.encode(PoolEntry) without `active`, i.e. the six fields), a vault
    /// (abi.encode(uint16 ratioBps)) or a route (abi.encode(bool true)). `key` is the pool or vault address, or the
    /// CCTP domain, as bytes32. Bounds are checked here and again at execution.
    function queue(Kind kind, bytes32 key, bytes calldata params) external onlyAdmin returns (bytes32 id) {
        _check(kind, key, params);
        uint256 n = nonce++;
        id = keccak256(abi.encode(kind, key, params, n));
        uint256 eta = block.timestamp + DELAY;
        etaOf[id] = eta;
        emit Queued(id, kind, key, params, n, eta);
    }

    function execute(Kind kind, bytes32 key, bytes calldata params, uint256 n) external onlyAdmin {
        bytes32 id = keccak256(abi.encode(kind, key, params, n));
        uint256 eta = etaOf[id];
        if (eta == 0) revert NotQueued(id);
        if (block.timestamp < eta) revert TooEarly(id, eta);
        delete etaOf[id];
        _check(kind, key, params);
        if (kind == Kind.Pool) {
            address pool = _addr(key);
            (uint32 w, uint32 ws, uint24 band, int24 at, uint24 ab, uint16 ratio) =
                abi.decode(params, (uint32, uint32, uint24, int24, uint24, uint16));
            _pools[pool] = PoolEntry(w, ws, band, at, ab, ratio, true);
            if (!_everListed[pool]) {
                _everListed[pool] = true;
                _poolList.push(pool);
            }
        } else if (kind == Kind.Vault) {
            address vault = _addr(key);
            _vaults[vault] = VaultEntry(abi.decode(params, (uint16)), true);
            if (!_everListed[vault]) {
                _everListed[vault] = true;
                _vaultList.push(vault);
            }
        } else {
            uint32 domain = uint32(uint256(key));
            if (!routeOn[domain]) {
                if (routeCount + 1 > MAX_CHAINS - 1) revert TooManyRoutes();
                routeOn[domain] = true;
                routeCount++;
            }
        }
        emit Executed(id, kind, key, params);
    }

    /// I7: the guardian (or the admin) cancels any queued change before it executes.
    function cancel(bytes32 id) external {
        if (msg.sender != ADMIN && msg.sender != GUARDIAN) revert OnlyAdminOrGuardian();
        if (etaOf[id] == 0) revert NotQueued(id);
        delete etaOf[id];
        emit Cancelled(id, msg.sender);
    }

    // ---------------------------------------------------------------- removals and tightening: immediate (I8)

    function removePool(address pool) external onlyAdmin {
        _pools[pool].active = false; // parameters kept: V4 still prices the exit of positions in it
        emit Removed(Kind.Pool, bytes32(uint256(uint160(pool))));
    }

    function removeVault(address vault) external onlyAdmin {
        _vaults[vault].active = false; // entry kept: V4 still redeems from it
        emit Removed(Kind.Vault, bytes32(uint256(uint160(vault))));
    }

    function removeRoute(uint32 domain) external onlyAdmin {
        if (routeOn[domain]) {
            routeOn[domain] = false;
            routeCount--;
        }
        emit Removed(Kind.Route, bytes32(uint256(domain)));
    }

    /// A lower share and/or a narrower band (never below MIN_BAND), on an active pool, at once. Anything else waits.
    function tightenPool(address pool, uint16 ratioBps, uint24 bandTicks) external onlyAdmin {
        PoolEntry storage p = _pools[pool];
        if (!p.active || ratioBps > p.ratioBps || bandTicks > p.bandTicks || bandTicks < MIN_BAND) revert NotTighter();
        (p.ratioBps, p.bandTicks) = (ratioBps, bandTicks);
        emit Tightened(Kind.Pool, bytes32(uint256(uint160(pool))), abi.encode(ratioBps, bandTicks));
    }

    function tightenVault(address vault, uint16 ratioBps) external onlyAdmin {
        VaultEntry storage v = _vaults[vault];
        if (!v.active || ratioBps > v.ratioBps) revert NotTighter();
        v.ratioBps = ratioBps;
        emit Tightened(Kind.Vault, bytes32(uint256(uint160(vault))), abi.encode(ratioBps));
    }

    // ---------------------------------------------------------------- views (V4 reads these at every use)

    function poolOf(address pool) external view returns (PoolEntry memory) {
        return _pools[pool];
    }

    function vaultOf(address vault) external view returns (VaultEntry memory) {
        return _vaults[vault];
    }

    function activePools() external view returns (address[] memory out) {
        return _active(_poolList, true);
    }

    function activeVaults() external view returns (address[] memory out) {
        return _active(_vaultList, false);
    }

    // ---------------------------------------------------------------- internals

    function _check(Kind kind, bytes32 key, bytes calldata params) internal pure {
        if (kind == Kind.Route) {
            if (params.length != 32 || !abi.decode(params, (bool))) revert BadEntry(20);
            if (uint256(key) > type(uint32).max) revert BadEntry(21);
            return;
        }
        if (uint256(key) > type(uint160).max || key == bytes32(0)) revert BadEntry(0);
        if (kind == Kind.Vault) {
            if (params.length != 32) revert BadEntry(10);
            uint16 r = abi.decode(params, (uint16));
            if (r == 0 || r > MAX_RATIO_BPS) revert BadEntry(11);
            return;
        }
        if (params.length != 6 * 32) revert BadEntry(1);
        (uint32 w, uint32 ws, uint24 band, int24 at, uint24 ab, uint16 ratio) =
            abi.decode(params, (uint32, uint32, uint24, int24, uint24, uint16));
        if (w < MIN_TWAP_WINDOW || w > MAX_TWAP_WINDOW) revert BadEntry(2);
        if (ws < MIN_SHORT_WINDOW || uint256(ws) * MIN_WINDOW_RATIO > w) revert BadEntry(3);
        if (band < MIN_BAND || band > MAX_BAND) revert BadEntry(4);
        if (ab > MAX_BAND || at < -MAX_TICK || at > MAX_TICK) revert BadEntry(5);
        if (ratio == 0 || ratio > MAX_RATIO_BPS) revert BadEntry(6);
    }

    function _addr(bytes32 key) internal pure returns (address) {
        return address(uint160(uint256(key)));
    }

    function _active(address[] storage list, bool pools) internal view returns (address[] memory out) {
        uint256 n;
        out = new address[](list.length);
        for (uint256 i; i < list.length; i++) {
            address a = list[i];
            if (pools ? _pools[a].active : _vaults[a].active) out[n++] = a;
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }
}
