// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployMamoruV4} from "../script/DeployV4.s.sol";
import {MamoruRegistry} from "../src/MamoruRegistry.sol";
import {MamoruActionPolicyV4, MamoruV4Helper, PoolEntryV4} from "../src/MamoruActionPolicyV4.sol";

/**
 * T7 (otto/mamoru#292, #307): script/DeployV4.s.sol on forks of Base, Monad and Ethereum. The same addresses on the three
 * chains, the wiring checks, a resumed run that deploys nothing twice, and the first registry entries: queued by the
 * admin Safe, executed after DELAY, and each pool one V4 accepts (factory pool of pinned tokens,
 * entry within V4's hard bounds, observation ring long enough).
 *
 *   nix shell nixpkgs#foundry --command forge test --match-path test/DeployV4Fork.t.sol -vv
 */
/// The script's steps as a given sender (forge scripts take it from --sender; a test cannot prank a broadcast).
contract DeployV4Harness is DeployMamoruV4 {
    function runAs(address sender) external returns (Stack memory) {
        return _run(sender);
    }

    function queueAs(address sender) external {
        _queueListings(sender);
    }

    function executeAs(address sender) external {
        _executeListings(sender);
    }
}

contract DeployV4ForkTest is Test {
    DeployV4Harness script;
    address constant DEPLOYER = 0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0;

    function _fork(uint256 chainId) internal {
        if (chainId == 8453) vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")));
        else if (chainId == 143) vm.createSelectFork(vm.envOr("MONAD_FORK_RPC_URL", string("https://rpc.monad.xyz")));
        else vm.createSelectFork(vm.envOr("ETHEREUM_FORK_RPC_URL", string("https://eth.drpc.org")));
        script = new DeployV4Harness();
        vm.deal(DEPLOYER, 100 ether);
    }

    function _deployAndList(uint256 chainId) internal returns (DeployMamoruV4.Stack memory s) {
        _fork(chainId);
        s = script.runAs(DEPLOYER);
        DeployMamoruV4.Stack memory p = script.predict();
        assertEq(s.policy, p.policy);
        // resumable: a second run deploys nothing and checks the same stack
        DeployMamoruV4.Stack memory again = script.runAs(DEPLOYER);
        assertEq(again.policy, s.policy);
        // the first entries
        script.queueAs(DEPLOYER);
        DeployMamoruV4.Listing[] memory l = script.listingsFor(chainId);
        assertEq(MamoruRegistry(s.registry).nonce(), l.length, "every entry queued");
        // (before DELAY the registry refuses execute: MamoruRegistry.t.sol; a reverted broadcast cannot be re-entered here)
        vm.warp(block.timestamp + script.DELAY());
        script.executeAs(DEPLOYER);
        MamoruActionPolicyV4 v4 = MamoruActionPolicyV4(s.policy);
        MamoruV4Helper h = v4.HELPER();
        for (uint256 i; i < l.length; i++) {
            if (l[i].kind == MamoruRegistry.Kind.Route) {
                assertTrue(MamoruRegistry(s.registry).routeOn(uint32(uint256(l[i].key))), "route on");
                continue;
            }
            address pool = address(uint160(uint256(l[i].key)));
            PoolEntryV4 memory e = v4.REGISTRY().poolOf(pool);
            assertTrue(e.active, "pool active");
            h.poolInfo(pool); // a factory pool of pinned tokens, a pinned stable on one side
            h.priceRange(pool); // V4's range over the entry: inside the hard bounds, a non-empty band
            (,,,, uint16 next,,) = IPoolSlot0(pool).slot0();
            assertGe(next, e.twapWindow, "observation ring covers the window (V4 _priced)");
        }
    }

    function test_base() public {
        DeployMamoruV4.Stack memory s = _deployAndList(8453);
        assertEq(s.policy, script.predict().policy);
    }

    function test_monad() public {
        _deployAndList(143);
    }

    function test_ethereum() public {
        _deployAndList(1);
    }

    function test_sameAddressesEverywhere() public {
        _fork(8453);
        DeployMamoruV4.Stack memory b = script.predict();
        _fork(143);
        DeployMamoruV4.Stack memory m = script.predict();
        _fork(1);
        DeployMamoruV4.Stack memory e = script.predict();
        assertEq(b.policy, m.policy);
        assertEq(b.policy, e.policy);
        assertEq(b.registry, e.registry);
        assertEq(b.gasPolicy, e.gasPolicy);
        assertEq(b.admin, e.admin);
        assertEq(b.check, e.check);
        assertEq(e.policy, script.EXPECTED_POLICY(), "pinned");
    }

    function test_onlyThePinnedDeployer() public {
        _fork(8453);
        vm.expectRevert(bytes("DeployV4: not the pinned deployer"));
        script.runAs(makeAddr("someone"));
    }
}

interface IPoolSlot0 {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}
