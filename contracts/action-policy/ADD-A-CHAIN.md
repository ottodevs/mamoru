# Adding a chain to Mamoru V4 (spec 010 A1, otto/mamoru#316)

V4 has no admin, so a new chain (or a new token, vault or pool class) is a **new V4 version**: the same contract code
with a new table. Users adopt it with one opt-in signature on the "What's new" screen; the old version keeps working.
This procedure keeps that cheap: only data changes, and one script and one checklist serve every EVM chain.

## What a chain needs

The chain qualifies only if every item holds; each is read on chain, never assumed.

1. **Canonical deployers**: the deterministic deployer `0x4e59b448…956C` (CREATE2) and the ERC-7484 ModuleRegistry
   `0x000000000069E2a1…51B2` at their usual addresses, so V4's addresses match the other chains.
2. **The Safe stack at the canonical addresses, with the code hashes V4 pins** (`MamoruV4Helper.checkStack`):
   SafeL2 1.4.1, SafeProxyFactory 1.4.1, MultiSend 1.4.1, Safe7579 + launchpad, SafeWebAuthnSharedSigner,
   SmartSession, OwnableValidator. A different hash means a different V4 constant, so a new V4 code version (and a
   review), not just a table row.
3. **ERC-4337 EntryPoint v0.7** and a **P-256 precompile** (RIP-7212) or the pinned P-256 verifier, for the passkey
   owner.
4. **CCTP V2** at the canonical `TokenMessengerV2` and `MessageTransmitterV2` with the pinned code hash, a domain
   (`localDomain()`), and a USDC burn limit above 0 on the messenger's `localMinter`. A chain without CCTP V2 cannot
   bridge or prove readiness in this version. Check Circle's Standard-transfer fee on the chain: it must fit under the
   row's `cctpFeeCapBps` (10 bps today, hard bound `MAX_CCTP_FEE_CAP_BPS` = 100), or every burn there is refused.
5. **Uniswap v3** factory, NonfungiblePositionManager and SwapRouter02 that report that factory and the chain's wrapped
   native (WETH9-style `deposit` / `withdraw`, simulated from a Safe).
6. **Tokens**: the stables (6 decimals, counted 1:1 as USD units) and the assets the chain's classes use.
7. **One reference pool per pair**: the pair's deep, arbitraged pool (`factory.getPool`, in-range liquidity, an
   observation ring that serves the class's long window). A pair without one has no eligible pool.
8. **Gas**: per-op caps a remote session carries and the rate G per W, from the engine's measured use on similar chains.
9. **A public ERC-4337 bundler** that accepts EntryPoint v0.7 on the chain (the owner's and the user's way out without
   Mamoru, spec 009 WLK).

## Steps

1. **Data**, in one commit:
   - a row in `src/MamoruV4Chains.sol` (`byChainId`, `chainOf`) with every address above, and the chain's
     `gasPerWindow`, `gasWindow`, `remoteCaps` and `cctpFeeCapBps` (#345);
   - the chain's classes and reference pools in `src/MamoruV4Classes.sol` (`classOf`), and its vaults, if any, by exact
     address (`vaultOf`);
   - the TypeScript twins: `packages/policy/src/one-auth-v4.ts` (`GAS_CAPS_V2_BY_CHAIN`, `V4_DOMAIN_BY_CHAIN`,
     `V4_PINNED`) and `packages/registry/<chain>.json`.
2. **Tests**:
   - `test/MamoruV4Classes.t.sol` gets the chain's rows (hard bounds, pinned tokens, ratios);
   - `test/DeployV4Fork.t.sol` gets the chain (deploy on a fork, every reference pool eligible there, same addresses);
   - a fork of the chain in `V4RemoteFork`-style coverage: a remote registered from a home chain, deployed after a mint,
     proven ready by a CCTP message in both directions, bridging home;
   - `test/V4Erc7562Fork.t.sol` on the chain: no ERC-7562 violation in a session op's validation.
3. **Addresses**: the table's bytecode changed, so `MamoruV4Table`, `MamoruGasPolicyV2` and `MamoruActionPolicyV4`
   move. Re-pin `EXPECTED_*` in `script/DeployV4.s.sol` from `predict()` deliberately. The code of the policy and gas
   policy is unchanged byte for byte (only constructor arguments move), so the review of a chain addition is the data
   diff plus the tests above.
4. **Review**: the high-stakes peer gate, as for any V4 change.
5. **Deploy** (coordinator, with Ot's GO): `forge script script/DeployV4.s.sol --rpc-url <chain> --sender
   0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0` on **every** chain of the new table (the new version must exist on every
   chain an account uses, since readiness only passes between identical V4 instances). The script refuses a chain
   outside the table, a moved address, and bytecode with a guardian, pause or admin selector.
6. **Verify on each chain, live** (#345 P2-3): after the broadcast, `forge script script/DeployV4.s.sol --sig
   "verify()" --rpc-url <chain>` against that chain's real RPC, not a fork. It is `check(predict())` with the pinned
   addresses: code at each address, the wiring, no forbidden selector, the table's rows and reference pools, the
   ModuleRecords. `run()`'s own check ran inside forge's simulation; only this read proves what the chain holds. A
   chain where it fails is not announced and not offered for adoption.
7. **Adoption**: the app's "What's new" offers the new version; an owner adopts it on every chain of the account at
   once (one prompt per chain until #116). Accounts that do not stay on the old version, which keeps working.

## What never changes for a chain

No admin key, no registry, no guardian, no pause: a chain is data in a table whose address is a constructor argument of
code that has no setter. Nothing in this procedure gives anyone a power over a deployed V4.
