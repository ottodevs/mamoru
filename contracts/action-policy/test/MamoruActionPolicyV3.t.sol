// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {MamoruActionPolicyV3, MamoruV3Routes, ConfigId} from "../src/MamoruActionPolicyV3.sol";

// The vault and bridge families of MamoruActionPolicyV3 (otto/mamoru#116 T1), unit tests without a fork. The Uniswap
// paths are V2's: MamoruActionPolicyV3Suites.t.sol runs every V1, T6, V2 and LeftClaw test against V3 on the Base fork.
// This file must not import V2's sources or tests: V2 and V3 compile under different profiles (foundry.toml).

address constant GUARDIAN = address(0x6A2d1A9);

contract MockVault {
    address public immutable asset;

    constructor(address a) {
        asset = a;
    }
}

interface IVault4626 {
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function mint(uint256 shares, address receiver) external returns (uint256);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
}

interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

interface IApprove {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract MamoruActionPolicyV3UnitTest is Test {
    address constant SS = address(0x5e55);
    address constant NPM = address(0x4e9);
    address constant ROUTER = address(0x2007e2);
    address constant FACTORY = address(0xfac);
    address constant MESSENGER = address(0x3e55);
    address constant USDC = address(0x05dc);
    address constant OTHER_TOKEN = address(0x07e2);
    uint32 constant DOMAIN = 15;

    ConfigId constant VID = ConfigId.wrap(bytes32(uint256(0xa1)));
    ConfigId constant BID = ConfigId.wrap(bytes32(uint256(0xb1)));

    MamoruActionPolicyV3 policy;
    address vaultA;
    address vaultB;
    address unlisted;
    address account = makeAddr("account");
    address attacker = makeAddr("attacker");

    function setUp() public {
        vaultA = address(new MockVault(USDC));
        vaultB = address(new MockVault(OTHER_TOKEN));
        unlisted = address(new MockVault(USDC));
        address[] memory vs = new address[](2);
        (vs[0], vs[1]) = (vaultA, vaultB);
        policy = new MamoruActionPolicyV3(SS, NPM, ROUTER, FACTORY, GUARDIAN, vs, MESSENGER, USDC, DOMAIN);
        _enable(VID, policy.FAMILY_VAULTS(), 1);
        _enable(BID, policy.FAMILY_BRIDGE(), 1);
    }

    function _enable(ConfigId id, uint256 family, uint64 gen) internal {
        vm.prank(SS);
        policy.initializeWithMultiplexer(account, id, abi.encode(family, gen));
    }

    function _check(ConfigId id, address target, bytes memory data) internal returns (uint256) {
        vm.prank(SS);
        return policy.checkAction(id, account, target, 0, data);
    }

    function _burn(
        uint256 amount,
        uint32 domain,
        bytes32 recipient,
        address token,
        bytes32 caller,
        uint256 fee,
        uint32 fin
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(ITokenMessengerV2.depositForBurn, (amount, domain, recipient, token, caller, fee, fin));
    }

    function _me() internal view returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    // ------------------------------------------------------------ construction

    function test_constructorListsVaultsWithTheirAsset() public view {
        assertEq(policy.ROUTES().vaultAsset(vaultA), USDC);
        assertEq(policy.ROUTES().vaultAsset(vaultB), OTHER_TOKEN);
        assertEq(policy.ROUTES().vaultAsset(unlisted), address(0));
        assertEq(policy.ROUTES().TOKEN_MESSENGER(), MESSENGER);
        assertEq(policy.ROUTES().BURN_TOKEN(), USDC);
        assertEq(policy.ROUTES().DESTINATION_DOMAIN(), DOMAIN);
    }

    function test_constructorRefusesBadLists() public {
        address[] memory dup = new address[](2);
        (dup[0], dup[1]) = (vaultA, vaultA);
        vm.expectRevert(abi.encodeWithSelector(MamoruV3Routes.BadVault.selector, vaultA));
        new MamoruActionPolicyV3(SS, NPM, ROUTER, FACTORY, GUARDIAN, dup, MESSENGER, USDC, DOMAIN);

        address[] memory noAsset = new address[](1);
        noAsset[0] = address(new MockVault(address(0)));
        vm.expectRevert(abi.encodeWithSelector(MamoruV3Routes.BadVault.selector, noAsset[0]));
        new MamoruActionPolicyV3(SS, NPM, ROUTER, FACTORY, GUARDIAN, noAsset, MESSENGER, USDC, DOMAIN);

        address[] memory none = new address[](0);
        vm.expectRevert(MamoruV3Routes.BadBridge.selector);
        new MamoruActionPolicyV3(SS, NPM, ROUTER, FACTORY, GUARDIAN, none, address(0), USDC, 0);
        vm.expectRevert(MamoruV3Routes.BadBridge.selector);
        new MamoruActionPolicyV3(SS, NPM, ROUTER, FACTORY, GUARDIAN, none, MESSENGER, address(0), DOMAIN);
        // No vaults and no bridge: a Uniswap-only deployment (Monad today) is fine.
        new MamoruActionPolicyV3(SS, NPM, ROUTER, FACTORY, GUARDIAN, none, address(0), address(0), 0);
    }

    // ------------------------------------------------------------ init

    function test_familyInitOnlyFromSmartSession() public {
        vm.prank(attacker);
        vm.expectRevert(MamoruActionPolicyV3.OnlySmartSession.selector);
        policy.initializeWithMultiplexer(account, VID, abi.encode(uint256(1), uint64(1)));
    }

    function test_unknownFamilyRefused() public {
        vm.prank(SS);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV3.BadInit.selector, 12));
        policy.initializeWithMultiplexer(account, VID, abi.encode(uint256(4), uint64(1))); // 3 is setup mode
    }

    function test_bridgeFamilyRefusedWithoutMessenger() public {
        address[] memory none = new address[](0);
        MamoruActionPolicyV3 p =
            new MamoruActionPolicyV3(SS, NPM, ROUTER, FACTORY, GUARDIAN, none, address(0), address(0), 0);
        vm.prank(SS);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV3.BadInit.selector, 12));
        p.initializeWithMultiplexer(account, BID, abi.encode(uint256(2), uint64(1)));
    }

    function test_familyInitFollowsTheGenerationRules() public {
        // A jump of more than one after the first enable, and a stale generation, are refused as in V2.
        vm.prank(SS);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV3.BadInit.selector, 4));
        policy.initializeWithMultiplexer(account, VID, abi.encode(uint256(1), uint64(3)));
        _enable(ConfigId.wrap(bytes32(uint256(0xa2))), 1, 2); // renewal to 2
        vm.prank(SS);
        vm.expectRevert(abi.encodeWithSelector(MamoruActionPolicyV3.StaleGeneration.selector, 1, 2));
        policy.initializeWithMultiplexer(account, VID, abi.encode(uint256(1), uint64(1)));
    }

    function test_uninitializedActionReverts() public {
        vm.prank(SS);
        vm.expectRevert();
        policy.checkAction(
            ConfigId.wrap(bytes32(uint256(0xdead))),
            account,
            vaultA,
            0,
            abi.encodeCall(IVault4626.deposit, (1, account))
        );
    }

    // ------------------------------------------------------------ vaults

    function test_vaultDepositAndMintOnlyToTheAccount() public {
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.deposit, (1_000e6, account))), 0);
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.mint, (1_000e6, account))), 0);
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.deposit, (1_000e6, attacker))), 1, "wrong receiver");
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.mint, (1_000e6, attacker))), 1, "wrong receiver");
    }

    function test_vaultWithdrawAndRedeemOnlyOwnSharesToTheAccount() public {
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.withdraw, (1e6, account, account))), 0);
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.redeem, (1e6, account, account))), 0);
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.redeem, (1e6, attacker, account))), 1, "wrong receiver");
        assertEq(
            _check(VID, vaultA, abi.encodeCall(IVault4626.withdraw, (1e6, attacker, account))), 1, "wrong receiver"
        );
        assertEq(
            _check(VID, vaultA, abi.encodeCall(IVault4626.redeem, (1e6, account, attacker))), 1, "owner != account"
        );
        assertEq(
            _check(VID, vaultA, abi.encodeCall(IVault4626.withdraw, (1e6, account, attacker))), 1, "owner != account"
        );
    }

    function test_unlistedVaultRefused() public {
        assertEq(_check(VID, unlisted, abi.encodeCall(IVault4626.deposit, (1e6, account))), 1);
        assertEq(_check(VID, unlisted, abi.encodeCall(IVault4626.redeem, (1e6, account, account))), 1);
        assertEq(_check(VID, unlisted, abi.encodeCall(IApprove.approve, (unlisted, 1e6))), 1);
        assertEq(
            _check(VID, USDC, abi.encodeCall(IApprove.approve, (unlisted, 1e6))), 1, "approval to an unlisted vault"
        );
    }

    function test_vaultApprovalOnlyOfItsAssetToIt() public {
        assertEq(_check(VID, USDC, abi.encodeCall(IApprove.approve, (vaultA, 1e6))), 0);
        assertEq(_check(VID, OTHER_TOKEN, abi.encodeCall(IApprove.approve, (vaultB, 1e6))), 0);
        assertEq(_check(VID, OTHER_TOKEN, abi.encodeCall(IApprove.approve, (vaultA, 1e6))), 1, "not vaultA's asset");
        assertEq(_check(VID, USDC, abi.encodeCall(IApprove.approve, (vaultB, 1e6))), 1, "not vaultB's asset");
        assertEq(_check(VID, USDC, abi.encodeCall(IApprove.approve, (attacker, 1e6))), 1);
        assertEq(_check(VID, USDC, abi.encodeCall(IApprove.approve, (ROUTER, 1e6))), 1, "vault family never the router");
        assertEq(_check(VID, USDC, abi.encodeCall(IApprove.approve, (MESSENGER, 1e6))), 1, "vault family never CCTP");
    }

    function test_vaultFamilyRefusesEverythingElse() public {
        // Other selectors on a listed vault (transfer of shares, a non-standard entry point).
        assertEq(_check(VID, vaultA, abi.encodeWithSignature("transfer(address,uint256)", attacker, 1)), 1);
        assertEq(_check(VID, vaultA, abi.encodeWithSignature("depositATokens(uint256,address)", 1, account)), 1);
        // The bridge and Uniswap actions are not the vault family's.
        assertEq(_check(VID, MESSENGER, _burn(1e6, DOMAIN, _me(), USDC, 0, 0, 2000)), 1);
        assertEq(_check(VID, ROUTER, hex"04e45aaf"), 1);
        // Native value.
        vm.prank(SS);
        assertEq(policy.checkAction(VID, account, vaultA, 1, abi.encodeCall(IVault4626.deposit, (1, account))), 1);
    }

    // ------------------------------------------------------------ bridge

    function test_bridgeBurnToTheSameAccountOnThePinnedDomain() public {
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, _me(), USDC, 0, 0, 2000)), 0);
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, _me(), USDC, 0, 0, 2001)), 0, "slower finality is fine");
    }

    function test_bridgeRefusals() public {
        bytes32 other = bytes32(uint256(uint160(attacker)));
        assertEq(_check(BID, MESSENGER, _burn(100e6, 6, _me(), USDC, 0, 0, 2000)), 1, "wrong domain");
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, other, USDC, 0, 0, 2000)), 1, "wrong mintRecipient");
        // The account in the high bits instead of the low ones is another bytes32 (another address on a non-EVM domain).
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, bytes32(bytes20(account)), USDC, 0, 0, 2000)), 1);
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, _me(), OTHER_TOKEN, 0, 0, 2000)), 1, "wrong burn token");
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, _me(), USDC, other, 0, 2000)), 1, "pinned caller");
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, _me(), USDC, 0, 1, 2000)), 1, "fee");
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, _me(), USDC, 0, 0, 1000)), 1, "Fast finality");
        assertEq(_check(BID, MESSENGER, _burn(0, DOMAIN, _me(), USDC, 0, 0, 2000)), 1, "zero amount");
        assertEq(_check(BID, attacker, _burn(100e6, DOMAIN, _me(), USDC, 0, 0, 2000)), 1, "wrong messenger");
        assertEq(_check(BID, MESSENGER, abi.encodeWithSignature("depositForBurnWithHook()")), 1, "other selector");
    }

    function test_bridgeApprovalOnlyOfTheBurnTokenToTheMessenger() public {
        assertEq(_check(BID, USDC, abi.encodeCall(IApprove.approve, (MESSENGER, 100e6))), 0);
        assertEq(_check(BID, USDC, abi.encodeCall(IApprove.approve, (attacker, 100e6))), 1);
        assertEq(_check(BID, USDC, abi.encodeCall(IApprove.approve, (vaultA, 100e6))), 1, "bridge family never a vault");
        assertEq(_check(BID, OTHER_TOKEN, abi.encodeCall(IApprove.approve, (MESSENGER, 100e6))), 1);
    }

    // ------------------------------------------------------------ renewal and pause apply to the new families

    function test_renewalRetiresOlderVaultAndBridgeGrants() public {
        _enable(ConfigId.wrap(bytes32(uint256(0xa2))), 1, 2);
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.deposit, (1e6, account))), 1);
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, _me(), USDC, 0, 0, 2000)), 1);
    }

    function test_guardianPauseStopsVaultAndBridge() public {
        vm.prank(GUARDIAN);
        policy.pause(account);
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.redeem, (1e6, account, account))), 1);
        assertEq(_check(BID, MESSENGER, _burn(100e6, DOMAIN, _me(), USDC, 0, 0, 2000)), 1);
        vm.prank(GUARDIAN);
        policy.unpause(account);
        assertEq(_check(VID, vaultA, abi.encodeCall(IVault4626.redeem, (1e6, account, account))), 0);
    }

    function test_onlySmartSessionValidates() public {
        vm.prank(attacker);
        assertEq(policy.checkAction(VID, account, vaultA, 0, abi.encodeCall(IVault4626.deposit, (1, account))), 1);
    }

    /// The bindings are per account: another account's grant does not exist for this one.
    function test_bindingIsPerAccount() public {
        vm.prank(SS);
        vm.expectRevert();
        policy.checkAction(VID, attacker, vaultA, 0, abi.encodeCall(IVault4626.deposit, (1, attacker)));
    }

    function test_fitsEip170() public view {
        console2.log("MamoruActionPolicyV3 runtime bytes:", address(policy).code.length);
        assertLe(address(policy).code.length, 24_576);
    }
}
