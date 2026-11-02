// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {V4Fixture, IERC20T, ISmartSessionT} from "./V4Fixture.sol";
import {MamoruActionPolicyV4, MamoruV4Helper, InitV4, SwapParams} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruRegistry} from "../src/MamoruRegistry.sol";
import {Session, PolicyData, ActionData} from "../src/SmartSessionTypes.sol";

/**
 * otto/mamoru#309 against what T7 deployed on Ethereum mainnet (2 Nov, the same addresses on the three chains), on a fork
 * at a block after the deploy: a Safe set up as a Mamoru account (before V4 existed) enables a V4 SIBLING session through
 * the PRODUCTION owner flow, one owner Safe transaction: trust the Rhinestone attester and the Safe itself, self-attest
 * V4 and MamoruGasPolicyV2 (their ModuleRecords come from T7's deployModule), then SmartSession.enableSessions. No ENABLE
 * signature (no-enable-mode). Then the session wraps ETH and the burn home waits for the guardian.
 *
 *   ETHEREUM_FORK_RPC_URL=... forge test --match-path test/V4DeployedSiblingFork.t.sol -vv
 */
contract V4DeployedSiblingForkTest is V4Fixture {
    address constant DEPLOYED_V4 = 0xb1383F8E5045aFdcfF2031743d3c25082C8858a4;
    address constant DEPLOYED_GAS = 0xe58dad8B381FF93A28Aa2A43De80acb96F535C7B;
    address constant DEPLOYED_REGISTRY = 0x2a70976970964faB1FBadaFF2f0b3851C2Cb74C7;
    address constant E_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant AFTER_T7 = 26_328_900;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETHEREUM_FORK_RPC_URL", string("https://eth.drpc.org")), AFTER_T7);
        v4 = MamoruActionPolicyV4(DEPLOYED_V4);
        gasPol = MamoruGasPolicyV2(DEPLOYED_GAS);
        reg = MamoruRegistry(DEPLOYED_REGISTRY);
        helper = v4.HELPER();
        require(address(v4).code.length != 0, "T7 not on this fork");
    }

    function _sibling(address account) internal view returns (Session memory s) {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(sessionKey);
        s.sessionValidator = OWNABLE_VALIDATOR;
        s.sessionValidatorInitData = abi.encode(uint256(1), signers);
        s.salt = keccak256("mamoru.v4.remote-session");
        s.userOpPolicies = new PolicyData[](1);
        s.userOpPolicies[0] = PolicyData(address(gasPol), abi.encode(MamoruGasPolicyV2.Caps(100_000_000, 3_000_000, 2_000_000, 200_000, 5_000_000_000, 0, 0.01 ether, 1 days)));
        s.actions = new ActionData[](1);
        s.actions[0].actionTarget = address(1);
        s.actions[0].actionTargetSelector = 0x00000001;
        s.actions[0].actionPolicies = new PolicyData[](1);
        s.actions[0].actionPolicies[0] = PolicyData(address(v4), abi.encode(InitV4(1_000e6, 1, account, 6, new uint256[](0))));
    }

    function test_productionOwnerFlowEnablesTheSiblingOnTheDeployedV4() public {
        address safe = _newSafe(309);
        vm.deal(safe, 0.055 ether);
        assertEq(ISmartSessionT(SMART_SESSION).getPermissionIDs(safe).length, 0, "a Safe set up before V4: no session");
        (bytes32 pid, uint256 g) = _enableV4(safe, _sibling(safe));
        emit log_named_uint("enable (owner Safe tx: enableSessions after trust + attest)", g);
        MamoruActionPolicyV4.Config memory c = v4.configOf(safe);
        assertTrue(c.set);
        assertEq(c.home, safe, "a sibling");
        assertEq(c.homeDomain, 6);
        // the session runs under the deployed V4: wrap is admitted, a value transfer elsewhere is not
        Execution[] memory xs = new Execution[](1);
        xs[0] = Execution(E_WETH, 0.01 ether, abi.encodeWithSignature("deposit()"));
        _run(safe, _batch(xs), pid);
        assertEq(IERC20T(E_WETH).balanceOf(safe), 0.01 ether);
        xs[0] = Execution(attacker, 0.001 ether, "");
        _rejected(safe, _batch(xs), pid);
        assertFalse(v4.isReady(safe, 6), "no burn home before the guardian");
    }
}
