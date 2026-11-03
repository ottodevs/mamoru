// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MamoruActionPolicyV4, InitV4} from "../src/MamoruActionPolicyV4.sol";
import {MamoruGasPolicyV2} from "../src/MamoruGasPolicyV2.sol";
import {MamoruV4Table} from "../src/MamoruV4Table.sol";
import {ConfigIdV4} from "../src/SmartSessionTypes.sol";

/// otto/mamoru#348 (review of #247): the TypeScript mirror of V4's checkAction (packages/account/one-auth
/// `a1CallRefusal`) against the real MamoruActionPolicyV4 on a Base fork, call by call, for every case of
/// test/fixtures/a1-batches.json (A1BatchParity.t.sol checks the same cases against the gas policy's shape). V4 runs at
/// the fixture's policy address (its code etched there, so `address(this)` is the fixture's V4), bound for the fixture
/// account by an owner-style init from SmartSession, with tokenIds 7 and 8 admitted for it. A case's `actions` says
/// whether the mirror admits every call; checkAction must then return 0 for each, and refuse (or revert on) at least
/// one otherwise.
///   nix shell nixpkgs#foundry --command forge test --match-path test/A1CheckActionParityFork.t.sol -vv
contract A1CheckActionParityForkTest is Test {
    address constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    uint256 constant BASE_BLOCK = 53_140_000;
    ConfigIdV4 constant ID = ConfigIdV4.wrap(bytes32(uint256(0x348)));

    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    string j;
    MamoruActionPolicyV4 v4;
    address account;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org")), BASE_BLOCK);
        j = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/a1-batches.json"));
        MamoruV4Table table = new MamoruV4Table();
        MamoruGasPolicyV2 gasPol = new MamoruGasPolicyV2(table);
        MamoruActionPolicyV4 deployed = new MamoruActionPolicyV4(address(gasPol), table);
        address at = vm.parseJsonAddress(j, ".policy");
        vm.etch(at, address(deployed).code);
        v4 = MamoruActionPolicyV4(at);
        account = vm.parseJsonAddress(j, ".account");
        vm.prank(SMART_SESSION);
        v4.initializeWithMultiplexer(account, ID, abi.encode(InitV4(10_000e6, 1, address(0), 0, new uint256[](0))));
        // _admitted (slot 3): mapping(uint256 tokenId => mapping(address account => address pool))
        for (uint256 id = 7; id <= 8; id++) {
            vm.store(at, keccak256(abi.encode(account, keccak256(abi.encode(id, uint256(3))))), bytes32(uint256(0xB7C)));
        }
        assertEq(v4.admittedPool(account, 7), address(0xB7C));
    }

    function decodeBatch(bytes calldata cd) external pure returns (Execution[] memory) {
        (bytes32 mode, bytes memory batch) = abi.decode(cd[4:], (bytes32, bytes));
        require(mode == bytes32(uint256(1) << 248), "not batch mode");
        return abi.decode(batch, (Execution[]));
    }

    function _admits(Execution memory x) internal returns (bool) {
        vm.prank(SMART_SESSION);
        try v4.checkAction(ID, account, x.target, x.value, x.callData) returns (uint256 r) {
            return r == 0;
        } catch {
            return false; // a revert (a dirty address word) refuses the op at validation too
        }
    }

    function test_checkActionMirrorAgreesWithV4() public {
        uint256 n = vm.parseJsonUint(j, ".count");
        uint256 checked;
        for (uint256 i; i < n; i++) {
            string memory k = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.parseJsonBool(j, string.concat(k, ".decodable"))) continue;
            string memory name = vm.parseJsonString(j, string.concat(k, ".name"));
            Execution[] memory xs = this.decodeBatch(vm.parseJsonBytes(j, string.concat(k, ".callData")));
            bool all = true;
            for (uint256 c; c < xs.length; c++) {
                if (!_admits(xs[c])) all = false;
            }
            assertEq(all, vm.parseJsonBool(j, string.concat(k, ".actions")), name);
            checked++;
        }
        assertGt(checked, 35);
        emit log_named_uint("cases run through V4.checkAction", checked);
    }
}
