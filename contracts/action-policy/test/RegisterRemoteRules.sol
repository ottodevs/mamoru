// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/// UniActionPolicy (Rhinestone, 0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F) ActionConfig, as its initData decodes it.
struct LimitUsageT {
    uint256 limit;
    uint256 used;
}

struct ParamRuleT {
    uint8 condition;
    uint64 offset;
    bool isLimited;
    bytes32 ref;
    LimitUsageT usage;
}

struct ParamRulesT {
    uint256 length;
    ParamRuleT[16] rules;
}

struct ActionConfigT {
    uint256 valueLimitPerUse;
    ParamRulesT paramRules;
}

/// otto/mamoru#356: the UniActionPolicy init data of a V4 home session's (V4, registerRemote) action.
library RegisterRemoteRules {
    uint8 constant EQUAL = 0;
    uint8 constant LESS_THAN = 2;

    function encode(ParamRuleT[] memory rs) internal pure returns (bytes memory) {
        ActionConfigT memory c;
        c.paramRules.length = rs.length;
        for (uint256 i; i < rs.length; i++) {
            c.paramRules.rules[i] = rs[i];
        }
        return abi.encode(c);
    }

    /// registerRemote(uint32 domain, address sessionKey): domain EQUAL `domain`, sessionKey EQUAL `key`.
    function pinned(uint32 domain, address key) internal pure returns (bytes memory) {
        ParamRuleT[] memory rs = new ParamRuleT[](2);
        rs[0] = ParamRuleT(EQUAL, 0, false, bytes32(uint256(domain)), LimitUsageT(0, 0));
        rs[1] = ParamRuleT(EQUAL, 32, false, bytes32(uint256(uint160(key))), LimitUsageT(0, 0));
        return encode(rs);
    }

    /// No remote for this account: domain LESS_THAN 0, which no call meets.
    function none() internal pure returns (bytes memory) {
        ParamRuleT[] memory rs = new ParamRuleT[](1);
        rs[0] = ParamRuleT(LESS_THAN, 0, false, bytes32(0), LimitUsageT(0, 0));
        return encode(rs);
    }
}
