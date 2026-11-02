// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployMamoruV4} from "../script/DeployV4.s.sol";
import {MamoruActionPolicyV4, MamoruV4Helper} from "../src/MamoruActionPolicyV4.sol";
import {IMamoruV4Table} from "../src/MamoruV4Table.sol";

/**
 * T7 + A1 (otto/mamoru#292, #307, #316): script/DeployV4.s.sol on forks of Base, Monad and Ethereum. The same addresses
 * on the three chains, the wiring checks (table, gas policy, helper, no forbidden selector), and a resumed run that
 * deploys nothing twice. There is no registry and nothing to list: the pools a chain's V4 may use are the table's
 * classes, checked on each chain here (each reference pool passes V4's eligibility rules and serves its class's window).
 *
 *   nix shell nixpkgs#foundry --command forge test --match-path test/DeployV4Fork.t.sol -vv
 */
/// The script's steps as a given sender (forge scripts take it from --sender; a test cannot prank a broadcast).
contract DeployV4Harness is DeployMamoruV4 {
    function runAs(address sender) external returns (Stack memory) {
        return _run(sender);
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

    function _deploy(uint256 chainId, address[] memory refs) internal returns (DeployMamoruV4.Stack memory s) {
        _fork(chainId);
        s = script.runAs(DEPLOYER);
        assertEq(s.policy, script.predict().policy);
        // resumable: a second run deploys nothing and checks the same stack
        DeployMamoruV4.Stack memory again = script.runAs(DEPLOYER);
        assertEq(again.policy, s.policy);
        MamoruV4Helper h = MamoruActionPolicyV4(s.policy).HELPER();
        assertEq(IMamoruV4Table(s.table).chain(chainId).chainId, chainId);
        for (uint256 i; i < refs.length; i++) {
            h.priced(refs[i]); // each class's reference pool is eligible on this chain today (rules 1-4, 7 trivially)
        }
    }

    function test_base() public {
        address[] memory refs = new address[](3);
        refs[0] = 0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1; // USDC/USDT 0.01 %
        refs[1] = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef; // USDC/cbBTC 0.05 %
        refs[2] = 0x6c561B446416E1A00E8E93E221854d6eA4171372; // WETH/USDC 0.3 %
        _deploy(8453, refs);
    }

    function test_monad() public {
        address[] memory refs = new address[](1);
        refs[0] = 0x659bD0BC4167BA25c62E05656F78043E7eD4a9da; // WMON/USDC 0.3 %
        _deploy(143, refs);
    }

    function test_ethereum() public {
        address[] memory refs = new address[](1);
        refs[0] = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640; // USDC/WETH 0.05 %
        _deploy(1, refs);
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
        assertEq(b.table, e.table);
        assertEq(b.gasPolicy, e.gasPolicy);
        assertEq(b.check, e.check);
        assertEq(e.policy, script.EXPECTED_POLICY(), "pinned");
        assertEq(e.table, script.EXPECTED_TABLE(), "pinned");
    }

    function test_onlyThePinnedDeployerAndATableChain() public {
        _fork(8453);
        vm.expectRevert(bytes("DeployV4: not the pinned deployer"));
        script.runAs(makeAddr("someone"));
        vm.chainId(42161);
        vm.expectRevert(bytes("DeployV4: chain outside V4's table"));
        script.runAs(DEPLOYER);
    }
}
