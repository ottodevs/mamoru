// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MamoruActionPolicyV3} from "../src/MamoruActionPolicyV3.sol";
import {IModuleRegistry, IOraclePool} from "./Deploy.s.sol";

/**
 * Deployment of MamoruActionPolicyV3 (otto/mamoru#116 T1). Coordinator only, after Ot's decision; nothing here runs by
 * itself. Its own script because V3 compiles under its own profile (foundry.toml), like DeployV2.s.sol.
 *
 *   GUARDIAN=0x... forge script script/DeployV3.s.sol --rpc-url $BASE_RPC_URL --sender $DEPLOYER    # dry run, Base
 *   GUARDIAN=0x... forge script script/DeployV3.s.sol --rpc-url $MONAD_RPC_URL --sender $DEPLOYER   # dry run, Monad
 *
 * Deterministic: `ModuleRegistry.deployModule` creates the policy with CREATE2 from the registry (the registry itself
 * is at the same address on Base and Monad) with a deployer-prefixed salt, and writes its ERC-7484 ModuleRecord in the
 * same transaction. The policy's address is a function of (deployer, salt nonce, init code), and the init code includes
 * the creation code (with its metadata hash) and the constructor arguments, GUARDIAN among them. The per-chain
 * arguments below differ (the Uniswap v3 deployment, the vault list, the bridge), so Base and Monad get DIFFERENT
 * policy addresses; a chain with the same arguments would get the same one. A new vault or a new chain is a new
 * deployment with a new list, never a code change and never a setter.
 *
 * Pinned (#116 T1 round 2): `run()` deploys only with PINNED_DEPLOYER, PINNED_GUARDIAN and PINNED_NONCE, and only when
 * the init code hash and the predicted address equal this chain's pins (`expected`). Design D embeds V3-Monad's
 * address in every Base account's frozen initializer: a rebuild that changes the metadata hash, or another guardian,
 * would move it, and USDC bridged to Monad would wait at a Safe address whose setup calls a policy that does not exist.
 * test/DeployV3.t.sol fails on any such change; re-pinning is a deliberate edit of the constants below, made before
 * any account embeds the address.
 *
 * Deployment rule: V3-Monad must be live at its pinned address before any Base account embeds it, and before any
 * bridge-out grant is issued. Order: Monad deploy, check code at `expected(143)`, then Base deploy, then grants.
 *
 * Per-chain constructor arguments (block.chainid picks them; any other chain is refused):
 *
 * | arg               | Base 8453                                         | Monad 143                                  |
 * |-------------------|---------------------------------------------------|--------------------------------------------|
 * | smartSession      | 0x00000000002B0eCfbD0496EE71e01257dA0E37DE        | same                                       |
 * | npm               | 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1        | 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53 |
 * | router (Router02) | 0x2626664c2603336E57B271c5C0b26F421741e481        | 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900 |
 * | factory           | 0x33128a8fC17869897dcE68Ed026d694621f6FDfD        | 0x204FAca1764B154221e35c0d20aBb3c525710498 |
 * | guardian          | env GUARDIAN (revoke-only pause key, or 0x0)      | env GUARDIAN                               |
 * | vaults            | gtUSDCp 0xeE8F…4b61, waBasUSDC 0xC768…DBD6 (#201)  | none                                       |
 * | tokenMessenger    | CCTP TokenMessengerV2 0x28b5…cf5d                 | address(0): no bridge family               |
 * | burnToken         | USDC 0x8335…2913                                  | address(0)                                 |
 * | destinationDomain | 15 (Monad, #213)                                  | 0                                          |
 *
 * Monad gets no bridge family: #201 keeps Monad's harvested USDC on Monad. A bridge back to Base would be a Monad
 * deployment with TokenMessengerV2 of Monad, USDC of Monad and domain 6 (Base).
 *
 * Then, as DeployV2.s.sol, each listed pool's `observationCardinalityNext` is raised to CARDINALITY_TARGET when it is
 * not there already (Base: Deploy.s.sol did it for V1; Monad: DeployMonad.s.sol of #139 does it too).
 */
contract DeployMamoruActionPolicyV3 is Script {
    address constant REGISTRY = 0x000000000069E2a187AEFFb852bF3cCdC95151B2;
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    /// The resolver Mamoru's other session policies are registered under (TimeFramePolicy's record, both chains).
    address constant RESOLVER_REFERENCE = 0x8177451511dE0577b911C254E9551D981C26dc72;
    uint16 constant CARDINALITY_STEP = 500;

    /// Who deploys (V2's ModuleRecord sender on Base) and which guardian (V2's GUARDIAN), at which salt nonce.
    address public constant PINNED_DEPLOYER = 0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0;
    address public constant PINNED_GUARDIAN = 0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD;
    uint96 public constant PINNED_NONCE = 4;

    /// keccak256(init code) and the CREATE2 address for each chain, with the pinned deployer, guardian and nonce.
    function expected(uint256 chainId) public pure returns (bytes32 initCodeHash, address policy) {
        if (chainId == 8453) {
            return (
                0xaa6d97ba560085d28cc2c28e101db8f75ca9fa9516c4fbb6ef7b79d3c289a6d0,
                0xb5799C0cCaaFECB641621F7e5a271B1DC829213A
            );
        }
        if (chainId == 143) {
            return (
                0x8c1437c3f44b559dd1233eab25f4cf073ff8e95e3b056a3ac3c6535e831bdb8c,
                0x009FFD70c0F9b4Aa8aC83Aaf38b2EB03651520ad
            );
        }
        revert("DeployV3: Base (8453) or Monad (143) only");
    }

    /// The gate `run()` applies: refuses any deployer, guardian, nonce or init code that does not give the pinned
    /// address on this chain.
    function checkPinned(uint256 chainId, address deployer, address guardian, uint96 nonce)
        public
        pure
        returns (address policy)
    {
        require(
            deployer == PINNED_DEPLOYER && guardian == PINNED_GUARDIAN && nonce == PINNED_NONCE, "DeployV3: not pinned"
        );
        bytes32 h = keccak256(initCode(guardian, argsFor(chainId)));
        (bytes32 wantHash, address want) = expected(chainId);
        require(h == wantHash, "DeployV3: init code hash moved (rebuild or source change): re-pin deliberately");
        policy =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), REGISTRY, saltFor(deployer, nonce), h)))));
        require(policy == want, "DeployV3: predicted address is not the pinned one");
    }

    struct Args {
        address npm;
        address router;
        address factory;
        address[] vaults;
        address tokenMessenger;
        address burnToken;
        uint32 destinationDomain;
        address[] pools;
    }

    function argsFor(uint256 chainId) public pure returns (Args memory a) {
        if (chainId == 8453) {
            a.npm = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
            a.router = 0x2626664c2603336E57B271c5C0b26F421741e481;
            a.factory = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
            a.vaults = new address[](2);
            a.vaults[0] = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61; // gtUSDCp (Gauntlet USDC Prime, MetaMorpho)
            a.vaults[1] = 0xC768c589647798a6EE01A91FdE98EF2ed046DBD6; // waBasUSDC (Aave v3 static aToken v2)
            a.tokenMessenger = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
            a.burnToken = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
            a.destinationDomain = 15;
            a.pools = new address[](3);
            a.pools[0] = 0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1; // USDC/USDT 0.01%
            a.pools[1] = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef; // USDC/cbBTC 0.05%
            a.pools[2] = 0x6c561B446416E1A00E8E93E221854d6eA4171372; // WETH/USDC 0.3%
        } else if (chainId == 143) {
            a.npm = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
            a.router = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
            a.factory = 0x204FAca1764B154221e35c0d20aBb3c525710498;
            a.vaults = new address[](0);
            a.pools = new address[](1);
            a.pools[0] = 0x659bD0BC4167BA25c62E05656F78043E7eD4a9da; // WMON/USDC 0.3%
        } else {
            revert("DeployV3: Base (8453) or Monad (143) only");
        }
    }

    function run() external returns (address policy) {
        address guardian = vm.envAddress("GUARDIAN");
        // Salt nonces 1 to 3 are V1, MamoruGasPolicy and V2 (Deploy.s.sol, DeployV2.s.sol).
        uint96 nonce = uint96(vm.envOr("POLICY_V3_SALT_NONCE", uint256(PINNED_NONCE)));
        uint16 target = uint16(vm.envOr("CARDINALITY_TARGET", uint256(1_800)));
        address want = checkPinned(block.chainid, msg.sender, guardian, nonce);
        policy = deploy(msg.sender, saltFor(msg.sender, nonce), guardian, argsFor(block.chainid), target);
        require(policy == want, "DeployV3: deployed address is not the pinned one");
    }

    function saltFor(address deployer, uint96 nonce) public pure returns (bytes32) {
        return bytes32(abi.encodePacked(deployer, nonce));
    }

    function initCode(address guardian, Args memory a) public pure returns (bytes memory) {
        return abi.encodePacked(
            type(MamoruActionPolicyV3).creationCode,
            abi.encode(
                SMART_SESSION,
                a.npm,
                a.router,
                a.factory,
                guardian,
                a.vaults,
                a.tokenMessenger,
                a.burnToken,
                a.destinationDomain
            )
        );
    }

    function deploy(address deployer, bytes32 salt, address guardian, Args memory a, uint16 cardinalityTarget)
        public
        returns (address policy)
    {
        IModuleRegistry r = IModuleRegistry(REGISTRY);
        bytes32 resolverUID = r.findModule(RESOLVER_REFERENCE).resolverUID;
        vm.startBroadcast(deployer);
        policy = r.deployModule(salt, resolverUID, initCode(guardian, a), "", "");
        for (uint256 i; i < a.pools.length; i++) {
            raiseCardinality(a.pools[i], cardinalityTarget);
        }
        vm.stopBroadcast();
        IModuleRegistry.ModuleRecord memory rec = r.findModule(policy);
        require(rec.resolverUID == resolverUID, "ModuleRecord: unexpected resolver");
        require(rec.sender == deployer, "ModuleRecord: registered by someone else");
        MamoruActionPolicyV3 p = MamoruActionPolicyV3(policy);
        require(p.GUARDIAN() == guardian, "GUARDIAN");
        require(
            p.ROUTES().TOKEN_MESSENGER() == a.tokenMessenger && p.ROUTES().DESTINATION_DOMAIN() == a.destinationDomain,
            "bridge"
        );
        for (uint256 i; i < a.vaults.length; i++) {
            require(p.ROUTES().vaultAsset(a.vaults[i]) != address(0), "vault list");
        }
        console2.log("MamoruActionPolicyV3:", policy);
        console2.log("GUARDIAN:", guardian);
    }

    function raiseCardinality(address pool, uint16 target) public {
        (,,,, uint16 next,,) = IOraclePool(pool).slot0();
        while (next < target) {
            uint16 n = target - next > CARDINALITY_STEP ? next + CARDINALITY_STEP : target;
            IOraclePool(pool).increaseObservationCardinalityNext(n);
            next = n;
        }
    }
}
