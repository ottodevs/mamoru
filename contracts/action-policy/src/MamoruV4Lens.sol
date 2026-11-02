// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {MamoruActionPolicyV4, MamoruV4Helper, PoolInfoV4, PoolEntryV4} from "./MamoruActionPolicyV4.sol";

/**
 * @title MamoruV4Lens (spec 010, otto/mamoru#316): the engine's and precheck's views over MamoruActionPolicyV4.
 * @notice Views only, no state but the policy it reads, no owner. Nothing on chain calls it: the operator, the precheck
 * and /ops read V3's `priceRange`, `swapBounds` and `decreaseMins` and the relayer's remote deployment here, over the
 * same checks V4 runs (MamoruV4Helper), so V4's helper stays under EIP-170. It can be deployed anywhere, at any time.
 */
contract MamoruV4Lens {
    MamoruActionPolicyV4 public immutable POLICY;
    MamoruV4Helper public immutable HELPER;

    error RangeEmpty();
    error UnknownRemote(uint32 domain);

    constructor(MamoruActionPolicyV4 policy) {
        POLICY = policy;
        HELPER = policy.HELPER();
    }

    /// The price range [lo, hi] every priced action in `pool` must stay in now (reverts when `pool` is not eligible).
    function priceRange(address pool) external view returns (int24 lo, int24 hi) {
        (, PoolEntryV4 memory e,) = HELPER.priced(pool);
        return HELPER.priceRangeAt(pool, e);
    }

    /// Smallest `amountOutMinimum` and the farthest `sqrtPriceLimitX96` V4.swap accepts now.
    function swapBounds(address pool, address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256 minOut, uint160 sqrtPriceLimitX96)
    {
        (PoolInfoV4 memory p, PoolEntryV4 memory e,) = HELPER.priced(pool);
        return HELPER.swapBoundsAt(pool, p, e, tokenIn == p.token0, amountIn);
    }

    /// Smallest amount0Min / amount1Min V4's `checkExit` accepts for decreasing `liquidity` of `tokenId` now.
    function decreaseMins(address account, uint256 tokenId, uint128 liquidity)
        external
        view
        returns (uint256, uint256)
    {
        address pool = POLICY.admittedPool(account, tokenId);
        (bool ok, uint256 min0, uint256 min1) =
            HELPER.exitMins(pool, HELPER.exitEntry(pool), POLICY.TABLE().chain(block.chainid).npm, tokenId, liquidity);
        if (!ok) revert RangeEmpty();
        return (min0, min1);
    }

    /// The relayer's permissionless deployment of `account`'s registered remote on `domain`, from the account's current
    /// owners and the registration's C and session key. It equals the registered address only while the owners have
    /// not changed.
    function remoteDeployment(address account, uint32 domain)
        external
        view
        returns (address at, bytes memory createCall)
    {
        MamoruActionPolicyV4.Remote memory r = POLICY.remoteOf(account, domain);
        if (r.remote == address(0)) revert UnknownRemote(domain);
        (at,, createCall) =
            HELPER.remote(account, domain, r.sessionKey, r.capUsd, POLICY.TABLE().chain(block.chainid).domain);
    }
}
