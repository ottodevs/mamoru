// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MamoruActionPolicyV4} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruRegistry} from "../src/MamoruRegistry.sol";
import {MamoruMigrationCheck} from "../src/MamoruMigrationCheck.sol";
import {MamoruRemoteSafe} from "../src/MamoruRemoteSafe.sol";
import {IModuleRegistry} from "./Deploy.s.sol";

interface ISafeAdminV4 {
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
        bytes calldata signatures
    ) external payable returns (bool);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

interface ISafeFactoryV4 {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address);
}

/**
 * Spec 010 T7 (otto/mamoru#292, #307): the one-authorization stack on Base, Monad and Ethereum, at the SAME addresses on
 * all three. Coordinator only, with Ot's GO (given 2 Nov in the deploying session). Nothing here runs by itself.
 *
 *   forge script script/DeployV4.s.sol --rpc-url <chain> --sender 0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0          # dry run
 *   forge script script/DeployV4.s.sol --rpc-url <chain> --sender 0x8F7D… --broadcast --private-key <from env>      # deploy
 *   forge script script/DeployV4.s.sol --sig "queueListings()" ...    # then, as the registry admin: queue (72 h)
 *   forge script script/DeployV4.s.sol --sig "executeListings()" ...  # after DELAY: execute
 *
 * What, and how (each address follows from chain-independent init code, so it is the same everywhere):
 *  1. The registry ADMIN: a Safe 1.4.1, 1 of 1, owned by the ops deployer key (Ot 2 Nov: temporary, a hardening pass
 *     moves it to an offline team Safe; the registry's ADMIN is immutable but this Safe's owners are not, so that is an
 *     owner change, not a redeploy). Created through SafeProxyFactory 1.4.1 with a fixed initializer and salt nonce.
 *  2. MamoruRegistry(admin, guardian, 72 h) and MamoruMigrationCheck through the deterministic deployer (CREATE2).
 *  3. MamoruGasPolicyV2(guardian) and MamoruActionPolicyV4(registry, gas policy, guardian) through
 *     ModuleRegistry.deployModule (CREATE2 from the ModuleRegistry, the same address on the three chains, verified with
 *     calcModuleAddress), so both have an ERC-7484 ModuleRecord: the owner enable flow (trust + self-attest +
 *     enableSessions) attests them. The resolver is the one SmartSession's record uses, present on all three chains.
 * The guardian is the revoke-only key of V2/V3 (0xA8E6…), the same for V4 and the gas policy (V4's constructor checks).
 * `run()` refuses any other deployer, and any chain outside V4's table; it skips what is already deployed, so a run
 * that stopped half-way resumes, and checks every address and wiring after.
 */
contract DeployMamoruV4 is Script {
    address constant MODULE_REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;

    address public constant PINNED_DEPLOYER = 0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0;
    address public constant PINNED_GUARDIAN = 0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD;
    uint256 public constant DELAY = 72 hours;

    uint256 public constant ADMIN_SALT_NONCE = uint256(keccak256("mamoru.v4.registry-admin"));
    bytes32 public constant REGISTRY_SALT = keccak256("mamoru.v4.registry");
    bytes32 public constant CHECK_SALT = keccak256("mamoru.v4.migration-check");
    uint96 public constant GAS_POLICY_NONCE = 5; // ModuleRegistry salts deployer ‖ nonce (V3 took 4)
    uint96 public constant POLICY_NONCE = 6;

    /// The addresses the dry runs gave on Base, Monad and Ethereum (2 Nov). A source or compiler change moves them:
    /// `run()` then refuses, and re-pinning is a deliberate commit (as DeployV3's init code hashes).
    address public constant EXPECTED_ADMIN = 0x109a3483F18FdF866955f13CC1a45C944d182e46;
    address public constant EXPECTED_REGISTRY = 0x2a70976970964faB1FBadaFF2f0b3851C2Cb74C7;
    address public constant EXPECTED_GAS_POLICY = 0xe58dad8B381FF93A28Aa2A43De80acb96F535C7B;
    address public constant EXPECTED_POLICY = 0xb1383F8E5045aFdcfF2031743d3c25082C8858a4;
    address public constant EXPECTED_CHECK = 0xc04046b4649471875372FA9e800143491cD4fB31;

    struct Stack {
        address admin;
        address registry;
        address gasPolicy;
        address policy;
        address check;
    }

    // ------------------------------------------------------------ addresses (pure functions of the init code)

    function adminInitializer() public pure returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = PINNED_DEPLOYER;
        return abi.encodeCall(
            ISafeAdminV4.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
    }

    function registryInitCode(address admin) public pure returns (bytes memory) {
        return abi.encodePacked(type(MamoruRegistry).creationCode, abi.encode(admin, PINNED_GUARDIAN, DELAY));
    }

    function gasPolicyInitCode() public pure returns (bytes memory) {
        return abi.encodePacked(type(MamoruGasPolicyV2).creationCode, abi.encode(PINNED_GUARDIAN));
    }

    function policyInitCode(address registry, address gasPolicy) public pure returns (bytes memory) {
        return abi.encodePacked(type(MamoruActionPolicyV4).creationCode, abi.encode(registry, gasPolicy, PINNED_GUARDIAN));
    }

    function moduleSalt(uint96 nonce) public pure returns (bytes32) {
        return bytes32(abi.encodePacked(PINNED_DEPLOYER, nonce));
    }

    function _create2(address deployer, bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, keccak256(initCode))))));
    }

    function predict() public pure returns (Stack memory s) {
        s.admin = MamoruRemoteSafe.proxyAddress(adminInitializer(), ADMIN_SALT_NONCE);
        s.registry = _create2(CREATE2_DEPLOYER, REGISTRY_SALT, registryInitCode(s.admin));
        s.check = _create2(CREATE2_DEPLOYER, CHECK_SALT, type(MamoruMigrationCheck).creationCode);
        s.gasPolicy = _create2(MODULE_REGISTRY, moduleSalt(GAS_POLICY_NONCE), gasPolicyInitCode());
        s.policy = _create2(MODULE_REGISTRY, moduleSalt(POLICY_NONCE), policyInitCode(s.registry, s.gasPolicy));
    }

    // ------------------------------------------------------------ deploy

    function run() external returns (Stack memory) {
        return _run(msg.sender);
    }

    function _run(address sender) internal returns (Stack memory s) {
        require(sender == PINNED_DEPLOYER, "DeployV4: not the pinned deployer");
        require(block.chainid == 8453 || block.chainid == 143 || block.chainid == 1, "DeployV4: chain outside V4's table");
        s = predict();
        require(
            s.admin == EXPECTED_ADMIN && s.registry == EXPECTED_REGISTRY && s.gasPolicy == EXPECTED_GAS_POLICY
                && s.policy == EXPECTED_POLICY && s.check == EXPECTED_CHECK,
            "DeployV4: predicted addresses moved (source or compiler change): re-pin deliberately"
        );
        IModuleRegistry mr = IModuleRegistry(MODULE_REGISTRY);
        require(mr.calcModuleAddress(moduleSalt(GAS_POLICY_NONCE), gasPolicyInitCode()) == s.gasPolicy, "DeployV4: gas policy address");
        require(
            mr.calcModuleAddress(moduleSalt(POLICY_NONCE), policyInitCode(s.registry, s.gasPolicy)) == s.policy,
            "DeployV4: policy address"
        );
        bytes32 resolverUID = mr.findModule(SMART_SESSION).resolverUID;
        require(resolverUID != bytes32(0), "DeployV4: no resolver");

        vm.startBroadcast(sender);
        if (s.admin.code.length == 0) {
            ISafeFactoryV4(MamoruRemoteSafe.SAFE_FACTORY).createProxyWithNonce(
                MamoruRemoteSafe.SAFE_SINGLETON, adminInitializer(), ADMIN_SALT_NONCE
            );
        }
        if (s.registry.code.length == 0) _viaDeterministic(REGISTRY_SALT, registryInitCode(s.admin));
        if (s.check.code.length == 0) _viaDeterministic(CHECK_SALT, type(MamoruMigrationCheck).creationCode);
        if (s.gasPolicy.code.length == 0) mr.deployModule(moduleSalt(GAS_POLICY_NONCE), resolverUID, gasPolicyInitCode(), "", "");
        if (s.policy.code.length == 0) {
            mr.deployModule(moduleSalt(POLICY_NONCE), resolverUID, policyInitCode(s.registry, s.gasPolicy), "", "");
        }
        vm.stopBroadcast();
        check(s);
        console2.log("admin Safe            ", s.admin);
        console2.log("MamoruRegistry        ", s.registry);
        console2.log("MamoruGasPolicyV2     ", s.gasPolicy);
        console2.log("MamoruActionPolicyV4  ", s.policy);
        console2.log("MamoruV4Helper        ", address(MamoruActionPolicyV4(s.policy).HELPER()));
        console2.log("MamoruRemoteInit      ", address(MamoruActionPolicyV4(s.policy).REMOTE_INIT()));
        console2.log("MamoruMigrationCheck  ", s.check);
    }

    function _viaDeterministic(bytes32 salt, bytes memory initCode) internal {
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok, "DeployV4: deterministic deployer");
    }

    /// Every address has code, and the wiring is the one predicted (after `run`, or alone to audit a chain).
    function check(Stack memory s) public view {
        address[] memory owners = ISafeAdminV4(s.admin).getOwners();
        require(owners.length == 1 && owners[0] == PINNED_DEPLOYER && ISafeAdminV4(s.admin).getThreshold() == 1, "admin Safe");
        MamoruRegistry r = MamoruRegistry(s.registry);
        require(r.ADMIN() == s.admin && r.GUARDIAN() == PINNED_GUARDIAN && r.DELAY() == DELAY, "registry");
        require(MamoruGasPolicyV2(s.gasPolicy).GUARDIAN() == PINNED_GUARDIAN, "gas policy");
        MamoruActionPolicyV4 p = MamoruActionPolicyV4(s.policy);
        require(address(p.REGISTRY()) == s.registry && p.GUARDIAN() == PINNED_GUARDIAN, "policy");
        require(address(p.GAS_POLICY()) == s.gasPolicy, "policy gas");
        p.HELPER().checkStack(); // the pinned Safe stack has the expected code on this chain
        require(s.check.code.length != 0, "migration check");
        IModuleRegistry mr = IModuleRegistry(MODULE_REGISTRY);
        require(mr.findModule(s.policy).sender == PINNED_DEPLOYER, "ModuleRecord policy");
        require(mr.findModule(s.gasPolicy).sender == PINNED_DEPLOYER, "ModuleRecord gas policy");
    }

    // ------------------------------------------------------------ the registry's first entries (admin, 72 h)

    struct Listing {
        MamoruRegistry.Kind kind;
        bytes32 key;
        bytes params;
    }

    function _pool(address pool, uint32 tw, uint32 ts, uint24 band, int24 anchorTick, uint24 anchorBand, uint16 ratio)
        internal
        pure
        returns (Listing memory)
    {
        return Listing(
            MamoruRegistry.Kind.Pool,
            bytes32(uint256(uint160(pool))),
            abi.encode(tw, ts, band, anchorTick, anchorBand, ratio)
        );
    }

    function _route(uint32 domain) internal pure returns (Listing memory) {
        return Listing(MamoruRegistry.Kind.Route, bytes32(uint256(domain)), abi.encode(true));
    }

    /// The first entries per chain: v6's pools and shares (packages/policy V4_POOLS, V4_POOLS_MONAD), the routes of
    /// design C (Base <-> Monad), and Ethereum's USDC/WETH 0.05 % for the sibling (#307: its observation ring holds 723,
    /// so a 720 s window; no route, a sibling only bridges home).
    function listingsFor(uint256 chainId) public pure returns (Listing[] memory l) {
        if (chainId == 8453) {
            l = new Listing[](4);
            l[0] = _pool(0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1, 1800, 300, 10, 0, 40, 5_000); // USDC/USDT 0.01 %
            l[1] = _pool(0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef, 1800, 300, 100, 0, 0, 3_500); // USDC/cbBTC 0.05 %
            l[2] = _pool(0x6c561B446416E1A00E8E93E221854d6eA4171372, 1800, 300, 100, 0, 0, 1_500); // WETH/USDC 0.3 %
            l[3] = _route(15);
        } else if (chainId == 143) {
            l = new Listing[](2);
            l[0] = _pool(0x659bD0BC4167BA25c62E05656F78043E7eD4a9da, 1800, 300, 100, 0, 0, 10_000); // WMON/USDC 0.3 %
            l[1] = _route(6);
        } else if (chainId == 1) {
            l = new Listing[](1);
            l[0] = _pool(0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640, 720, 180, 100, 0, 0, 10_000); // USDC/WETH 0.05 %
        } else {
            revert("DeployV4: chain outside V4's table");
        }
    }

    /// The admin Safe (1 of 1, the deployer key) queues every first entry; each becomes executable after DELAY.
    function queueListings() external {
        _queueListings(msg.sender);
    }

    function _queueListings(address sender) internal {
        require(sender == PINNED_DEPLOYER, "DeployV4: not the pinned deployer");
        Stack memory s = predict();
        check(s);
        Listing[] memory l = listingsFor(block.chainid);
        require(MamoruRegistry(s.registry).nonce() == 0, "DeployV4: registry already has queued entries");
        vm.startBroadcast(sender);
        for (uint256 i; i < l.length; i++) {
            _asAdmin(s.admin, s.registry, abi.encodeCall(MamoruRegistry.queue, (l[i].kind, l[i].key, l[i].params)));
        }
        vm.stopBroadcast();
    }

    /// After DELAY: executes the first entries (queue nonces 0..n-1, in `listingsFor` order).
    function executeListings() external {
        _executeListings(msg.sender);
    }

    function _executeListings(address sender) internal {
        require(sender == PINNED_DEPLOYER, "DeployV4: not the pinned deployer");
        Stack memory s = predict();
        Listing[] memory l = listingsFor(block.chainid);
        vm.startBroadcast(sender);
        for (uint256 i; i < l.length; i++) {
            _asAdmin(s.admin, s.registry, abi.encodeCall(MamoruRegistry.execute, (l[i].kind, l[i].key, l[i].params, i)));
        }
        vm.stopBroadcast();
    }

    /// A Safe tx of the 1-of-1 admin Safe, sent by its owner (pre-validated signature: v = 1, r = the owner).
    function _asAdmin(address admin, address to, bytes memory data) internal {
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(PINNED_DEPLOYER))), bytes32(0), uint8(1));
        require(
            ISafeAdminV4(admin).execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sig),
            "DeployV4: admin Safe tx"
        );
    }
}
