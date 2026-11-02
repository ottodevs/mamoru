// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/**
 * @title MamoruV4Chains (spec 010 "Pinned in V4", otto/mamoru#292): the per-chain tuple, keyed by block.chainid.
 * @notice Compiled into the bytecode of MamoruActionPolicyV4 and MamoruGasPolicyV2, identical on every chain (no
 * constructor argument chooses it), so "the same address" means "the same table" everywhere. The registry never
 * supplies any of it: a chain or a token outside this table needs a new V4 (the optional owner signature).
 *
 * Every address below was checked against packages/registry/base.json and monad.json (the repo's pinned registries,
 * with their code hashes) and read on chain at the fork blocks of the tests (Base 53,140,000; Monad 116,980,000;
 * Ethereum 26,328,000, otto/mamoru#307):
 *  - Uniswap v3 factory, NonfungiblePositionManager, SwapRouter02: base.json / monad.json entries of those names.
 *  - Stables: native USDC (Circle) on both; Base's USDT entry (6 decimals, base.json "stable del bucket stables").
 *    All pinned stables have 6 decimals, so the account bucket counts them 1:1 as USD units (test asserts it).
 *  - Assets: WETH and cbBTC on Base, WMON on Monad (base.json / monad.json), WETH on Ethereum.
 *  - Wrapped native (`wrapped`, the only target native value may go to, #307): assets[0] on every chain, a WETH9-style
 *    `deposit()` / `withdraw(uint256)` (WETH on Base and Ethereum, WMON on Monad; each simulated on chain).
 *  - CCTP domains: MessageTransmitterV2.localDomain() of the canonical TokenMessengerV2's localMessageTransmitter
 *    (0x81D40F21...) = 6 on Base, 15 on Monad, 0 on Ethereum.
 *  - Ethereum (#307): Uniswap v3 factory 0x1F98431c..., NonfungiblePositionManager 0xC36442b4... and SwapRouter02
 *    0x68b34658... (both report that factory and WETH9 = 0xC02aaA39...), native USDC 0xA0b86991... (6 decimals,
 *    `burnLimitsPerMessage` 1e13 on the canonical messenger's localMinter). USDT is left out there: its burn limit is
 *    0, so CCTP refuses it anyway, and its non-standard `approve` is one less surface. No MetaMorpho factory: no vault.
 *  - MetaMorpho factories (Base only): v1.0 0xA9c3D3a3... (`isMetaMorpho` is true for gtUSDCp and steakUSDC, the
 *    vaults spec 004 measured) and v1.1 0xFf62A7c2...; both return MORPHO() = Morpho Blue 0xBBBBBbbB... Monad has no
 *    MetaMorpho factory in the repo's registry: no vault is admissible there. Aave's static aToken factory exposes no
 *    membership view the repo has verified (spec 010 T2): Aave vaults are not admissible on any chain.
 * Left out, because nothing in the repo pins them yet (each needs its own verification before a V4 lists it):
 * Arbitrum, Optimism, Unichain. A route to one of them can be queued in the registry but V4 refuses it.
 */
library MamoruV4Chains {
    uint256 internal constant BASE = 8453;
    uint256 internal constant MONAD = 143;
    uint256 internal constant ETHEREUM = 1;

    /// The gas caps a remote session on this chain carries (MamoruGasPolicyV2.Caps, same field order).
    struct GasCaps {
        uint64 maxPriorityFeePerGas;
        uint32 maxVerificationGasLimit;
        uint32 maxCallGasLimit;
        uint32 maxPreVerificationGas;
        uint64 maxFeePerGas;
        uint32 maxPaymasterGas;
        uint128 perWindow; // wei of gas bucket per window
        uint32 window;
    }

    struct Chain {
        uint256 chainId; // 0 = not in the table
        uint32 domain; // CCTP domain
        address factory;
        address npm;
        address router;
        address[2] stables; // address(0) = unused slot
        address[2] assets;
        address wrapped; // WETH9-style wrapped native: the only target V4 lets native value reach (#307)
        address[2] vaultFactories; // MetaMorpho factories (isMetaMorpho)
        uint256 gasReview; // MamoruGasPolicyV2 GAS_REVIEW, wei
        GasCaps remoteCaps; // the gas policy init of a remote session on this chain
    }

    function byChainId(uint256 chainId) internal pure returns (Chain memory c) {
        if (chainId == BASE) {
            c.chainId = BASE;
            c.domain = 6;
            c.factory = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
            c.npm = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
            c.router = 0x2626664c2603336E57B271c5C0b26F421741e481;
            c.stables = [0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2];
            c.assets = [0x4200000000000000000000000000000000000006, 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf];
            c.wrapped = 0x4200000000000000000000000000000000000006;
            c.vaultFactories = [0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101, 0xFf62A7c278C62eD665133147129245053Bbf5918];
            c.gasReview = 0.01 ether;
            // packages/policy V4_GAS_CAPS (0.01 gwei priority, 3M / 2M / 200k, 0.1 gwei), bucket 0.002 ETH a day.
            c.remoteCaps = GasCaps(10_000_000, 3_000_000, 2_000_000, 200_000, 100_000_000, 0, 0.002 ether, 1 days);
        } else if (chainId == MONAD) {
            c.chainId = MONAD;
            c.domain = 15;
            c.factory = 0x204FAca1764B154221e35c0d20aBb3c525710498;
            c.npm = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
            c.router = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
            c.stables = [0x754704Bc059F8C67012fEd69BC8A327a5aafb603, address(0)];
            c.assets = [0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A, address(0)];
            c.wrapped = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
            c.gasReview = 5 ether;
            // packages/policy MONAD_GAS_CAPS (1 gwei priority, 3M / 2M / 200k, 1,000 gwei), bucket 1 MON a day.
            c.remoteCaps = GasCaps(1_000_000_000, 3_000_000, 2_000_000, 200_000, 1_000_000_000_000, 0, 1 ether, 1 days);
        } else if (chainId == ETHEREUM) {
            c.chainId = ETHEREUM;
            c.domain = 0;
            c.factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
            c.npm = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
            c.router = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
            c.stables = [0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, address(0)];
            c.assets = [0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, address(0)];
            c.wrapped = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
            // L1 gas: 0.1 gwei priority, 3M / 2M / 200k, 5 gwei max fee; a bucket of 0.01 ETH a day (a few ops at
            // today's ~0.3 gwei), and GAS_REVIEW 0.03 ETH. Ethereum is a chain where funds arrive and leave, not one
            // the engine trades on every hour.
            c.gasReview = 0.03 ether;
            c.remoteCaps = GasCaps(100_000_000, 3_000_000, 2_000_000, 200_000, 5_000_000_000, 0, 0.01 ether, 1 days);
        }
    }

    /// The chain id of a CCTP domain in the table, 0 when it is not in it. CCTP domain 0 is Ethereum: never a "no
    /// domain" sentinel here (#307).
    function chainOf(uint32 domain) internal pure returns (uint256) {
        return domain == 6 ? BASE : domain == 15 ? MONAD : domain == 0 ? ETHEREUM : 0;
    }

    function byDomain(uint32 domain) internal pure returns (Chain memory) {
        return byChainId(chainOf(domain)); // byChainId(0) is the empty entry
    }

    function isStable(Chain memory c, address t) internal pure returns (bool) {
        return t != address(0) && (t == c.stables[0] || t == c.stables[1]);
    }

    function isPinned(Chain memory c, address t) internal pure returns (bool) {
        return isStable(c, t) || (t != address(0) && (t == c.assets[0] || t == c.assets[1]));
    }
}
