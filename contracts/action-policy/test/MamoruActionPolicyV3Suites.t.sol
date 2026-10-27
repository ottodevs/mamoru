// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {MamoruActionPolicy} from "../src/MamoruActionPolicy.sol";
import {MamoruActionPolicyTest} from "./MamoruActionPolicy.t.sol";
import {T6FixesTest} from "./T6Fixes.t.sol";
import {MamoruActionPolicyV2Test, GUARDIAN} from "./MamoruActionPolicyV2.t.sol";
import {LeftClawV2Test} from "./LeftClawV2.t.sol";
import {Vm} from "forge-std/Vm.sol";

// otto/mamoru#116 T1: every Uniswap test of V1, T6, V2 and LeftClaw, against MamoruActionPolicyV3 on the same Base
// fork. V3 is deployed from its artifact (deployCode), not imported: this file imports V2's tests, and V2 and V3 compile
// under different profiles (foundry.toml), which one file cannot satisfy both of.

// Base (packages/registry/base.json, specs/004-loss-control/results/stables-4626-2026-10-23.md, PR #134).
address constant GT_USDCP = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61; // Gauntlet USDC Prime (MetaMorpho)
address constant WA_BAS_USDC = 0xC768c589647798a6EE01A91FdE98EF2ed046DBD6; // Aave v3 static aToken v2
address constant TOKEN_MESSENGER_V2 = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d; // CCTP V2 on Base
address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
uint32 constant CCTP_DOMAIN_MONAD = 15;

Vm constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

function deployV3(address smartSession, address npm, address router, address factory) returns (MamoruActionPolicy) {
    address[] memory vaults = new address[](2);
    (vaults[0], vaults[1]) = (GT_USDCP, WA_BAS_USDC);
    // V3's ABI is a superset of V1's and V2's on the Uniswap paths (same selectors, errors, Init): the fixtures drive
    // it through V1's type.
    return MamoruActionPolicy(
        VM.deployCode(
            "MamoruActionPolicyV3.sol:MamoruActionPolicyV3",
            abi.encode(
                smartSession, npm, router, factory, GUARDIAN, vaults, TOKEN_MESSENGER_V2, BASE_USDC, CCTP_DOMAIN_MONAD
            )
        )
    );
}

/// Every test of MamoruActionPolicy.t.sol, against V3.
contract MamoruActionPolicyTestOnV3 is MamoruActionPolicyTest {
    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV3(SMART_SESSION, NPM, ROUTER, FACTORY);
    }

    function _validatesSpot() internal pure override returns (bool) {
        return true;
    }
}

/// Every T6 finding's test, against V3.
contract T6FixesTestOnV3 is T6FixesTest {
    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV3(SMART_SESSION, NPM, ROUTER, FACTORY);
    }

    function _validatesSpot() internal pure override returns (bool) {
        return true;
    }
}

/// Every V2 addition's test (increase, guardian, swap deadline), against V3.
contract MamoruActionPolicyV2TestOnV3 is MamoruActionPolicyV2Test {
    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV3(SMART_SESSION, NPM, ROUTER, FACTORY);
    }
}

/// Every LeftClaw finding's test, against V3.
contract LeftClawTestOnV3 is LeftClawV2Test {
    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV3(SMART_SESSION, NPM, ROUTER, FACTORY);
    }
}

