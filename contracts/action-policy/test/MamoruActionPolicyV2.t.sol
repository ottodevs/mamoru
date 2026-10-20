// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {MamoruActionPolicyTest} from "./MamoruActionPolicy.t.sol";
import {T6FixesTest} from "./T6Fixes.t.sol";
import {MamoruActionPolicy} from "../src/MamoruActionPolicy.sol";
import {MamoruActionPolicyV2} from "../src/MamoruActionPolicyV2.sol";

function deployV2(address smartSession, address npm, address router, address factory)
    returns (MamoruActionPolicy)
{
    // V2's ABI is a superset of V1's (same selectors, errors, Init): the V1 fixture drives it through V1's type.
    return MamoruActionPolicy(address(new MamoruActionPolicyV2(smartSession, npm, router, factory)));
}

/// Every test of MamoruActionPolicy.t.sol, against V2: nothing the deployed contract does changes.
contract MamoruActionPolicyTestOnV2 is MamoruActionPolicyTest {
    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV2(SMART_SESSION, NPM, ROUTER, FACTORY);
    }
}

/// Every T6 finding's test, against V2.
contract T6FixesTestOnV2 is T6FixesTest {
    function _newPolicy() internal override returns (MamoruActionPolicy) {
        return deployV2(SMART_SESSION, NPM, ROUTER, FACTORY);
    }
}
