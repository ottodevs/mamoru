# Leave Mamoru with only your recovery kit

Your Mamoru account is a Safe smart account on Base (chain id 8453). You own it. Mamoru's servers never hold an owner key. This guide shows how to take everything out without Mamoru: no app, no engine, no indexer, no support from us.

In v1, Mamoru runs in simulation mode and deposits are closed, so an account made today holds nothing. This guide is for the day it does, and it is what our tests do on a Base fork (see "What we tested" at the end).

## What you need

1. **Your recovery kit.** The JSON file you downloaded during onboarding. It holds only public data: the chain, the account address, how the Safe is set up, its modules, its owners, the session ids and the Uniswap position ids. It holds no secret.
2. **An owner.** Either your passkey (on the device where you created it) or your backup owner.
3. **A little ETH on Base in any wallet**, to pay gas. The owner only signs. Any address can send the transaction and pay for it.
4. **A tool that can send a contract call on Base** with calldata you prepare (a wallet that accepts raw calldata, or a script with a library such as viem).

## Step 1. Check the kit

Open the kit and check:

- `chainId` is `8453` (Base).
- `address` is the account address you saw in the app.
- `owners` lists your owners. With a passkey, the Safe owner is the Safe WebAuthn shared signer `0x94a4F6affBd8975951142c3999aEAB7ecee555c2`, and the kit's `webauthn` block holds your passkey's public key (`x`, `y`), the verifier setting (`verifiers`) and the signer address (`signer`). No private key is in the kit.
- `setup.factory` is SafeProxyFactory 1.4.1 `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` and `setup.singleton` is SafeL2 1.4.1 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`.

## Step 2. Deploy the Safe, if it is not deployed yet

Your account address exists before the Safe does (it is counterfactual). Anything sent to that address waits there. To use it, deploy the Safe exactly as the kit says:

- Call `createProxyWithNonce(singleton, initializer, saltNonce)` on `setup.factory`, with `setup.singleton`, `setup.initializer` and `setup.saltNonce` from the kit.
- Check that the new Safe's address equals `address` in the kit. If it does not, stop: the parameters are wrong.

The initializer sets the owners, threshold 1, the Safe7579 adapter and the Smart Sessions module with no sessions. With a passkey owner, the same setup also configures your passkey on the shared signer through a MultiSend 1.4.1 delegatecall (kit fields `setup.to` and `setup.data`), so the account address commits to your passkey: a different passkey gives a different address.

If the Safe is already deployed (it is once Mamoru has operated for you), skip this step.

## Step 3. Build one batch

Everything happens in one Safe transaction that runs a batch through MultiSendCallOnly 1.4.1 (`0x9641d764fc13c8B624c04430C7356C1C7C8102e2`, called with operation delegatecall). The batch contains, in this order:

1. **Revoke every session.** For each id in `permissionIds`: `removeSession(permissionId)` on Smart Sessions `0x00000000002B0eCfbD0496EE71e01257dA0E37DE`. After this, no session key can act for the account.
2. **Close every Uniswap position.** For each id in `tokenIds`, on the NonfungiblePositionManager `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`:
   - `decreaseLiquidity` with all the liquidity still in the position (skip it if the liquidity is already 0),
   - `collect` with the account as recipient,
   - `burn`.
3. **Move the tokens to you.** `transfer` on USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` and on cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`, to an address you choose, for the amounts the account holds after the collects. The recipient cannot be the account itself.

Developers can build this batch with `walkawayCalls` in [`packages/account/owner/index.ts`](../packages/account/owner/index.ts) and the factory call with `deployCallFromKit` in [`packages/account/recovery/index.ts`](../packages/account/recovery/index.ts). Neither needs Mamoru's servers.

## Step 4. Sign and send

- Sign the Safe transaction (the standard Safe EIP-712 `SafeTx` for the account, chain id 8453, the account's current nonce) with your passkey or with your backup owner. With the passkey, the Safe checks the signature through the WebAuthn shared signer.
- Send `execTransaction` on the account from any address with ETH for gas.

## Step 5. Check

- The transaction succeeded.
- The USDC and cbBTC are at the address you chose.
- The positions are burned.
- Any session operation on the account now fails.

## What we tested

On a local fork of Base pinned at block 51811000 (chain id 31337), with Mamoru's engine, app and the MultiBaas indexer all switched off. The fork is our test bench, not real funds. Last recorded run: [`evidence/scenarios/fork-run-20260926T185126Z-84632e.md`](../evidence/scenarios/fork-run-20260926T185126Z-84632e.md).

| Scenario | What it shows |
|---|---|
| WALK-01 | The backup owner signs one Safe transaction with the batch above; another account sends and pays for it. Afterwards, a session swap and a session collect are both rejected by the chain. |
| WALK-02 | The same, signed with a passkey through the Safe WebAuthn shared signer, sent by another account. A passkey signature over a different Safe transaction is refused. |
| WALK-04 | A counterfactual account holding USDC: the owner deploys the Safe from the kit parameters and withdraws. The deployed address equals the kit address. |
| LAB-08 | Passkey (P-256) signatures verify on the fork, both through the RIP-7212 precompile and through the pinned P256Verifier contract `0xc2b78104907F722DABAc4C69f826a522B2754De4` when the precompile is absent. |

What we did not test: the steps on Base mainnet with real funds, or with any specific wallet app.
