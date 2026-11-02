// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/// The Safe 1.4.1 + Safe7579 entry points the canonical remote initializer encodes and its setup step calls.
interface ISafeSetupV4 {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function enableModule(address module) external;
}

interface ISafeProxyFactoryV4 {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

interface IMultiSendV4 {
    function multiSend(bytes memory transactions) external payable;
}

/// SafeWebAuthnSharedSigner (safe-modules), the passkey owner of a Mamoru Safe: configure is delegatecalled in setup and
/// writes the (x, y, verifiers) of the account into the account's own storage; getConfiguration reads it back.
interface ISharedSignerV4 {
    struct Signer {
        uint256 x;
        uint256 y;
        uint176 verifiers;
    }

    function configure(Signer calldata signer) external;
    function getConfiguration(address account) external view returns (Signer memory);
}

/// Safe7579's DataTypes.sol (Initializer.initializeAccount), deployed at 0x7579EE8307284F293B1927136486880611F20002.
struct ModuleInitV4 {
    address module;
    bytes initData;
}

struct RegistryInitV4 {
    address registry;
    address[] attesters;
    uint8 threshold;
}

interface ISafe7579InitV4 {
    function initializeAccount(
        ModuleInitV4[] calldata validators,
        ModuleInitV4[] calldata executors,
        ModuleInitV4[] calldata fallbacks,
        ModuleInitV4[] calldata hooks,
        RegistryInitV4 calldata registryInit
    ) external;
}

/**
 * @title MamoruRemoteInit (spec 010 I4, T1b; otto/mamoru#292). Not deployed.
 * @notice The one setup step of a Mamoru remote Safe, delegatecalled by `Safe.setup` (directly, or through MultiSend
 * 1.4.1 next to SafeWebAuthnSharedSigner.configure). It does what Safe7579Launchpad.addSafe7579 does (enable Safe7579 as
 * a module, initialize it with SmartSession as the only validator), with one difference: Safe7579 is initialized with
 * NO ERC-7484 registry (`RegistryInit(address(0), [], 0)`), so installing SmartSession reads no registry state.
 *
 * Why not the spec's self-attestation (T1b, results/t2-t4-contracts-2026-11-02.md §1): it works today, but the
 * attestation goes through ModuleRegistry's resolver for SmartSession's module record (resolverUID 0xdbca873b...,
 * resolver 0xF0f46857..., an upgradeable proxy whose resolver owner is the Rhinestone attester, who can also point the
 * UID at another resolver with `setResolver`). A resolver that returns false or reverts makes `attest` revert, so a
 * self-attesting initializer is undeployable at the will of a third party, after funds were minted to its address: the
 * r2 P0-1 vector the spec meant to close. T1b's fork test does exactly that and the self-attested setup reverts, while
 * this one still deploys.
 *
 * SmartSession is installed in UNSAFE_ENABLE mode (0x02), which never consults a registry for the session's policies
 * or validator (SmartSession `onInstall` -> `_enableSessions(sessions, useRegistry = false)`). The result: the remote
 * Safe's deployment reads only code and immutable state of the canonical stack (Safe singleton, factory, MultiSend,
 * Safe7579 and its ModuleInstallUtil, SmartSession, the session's policies and validator).
 *
 * Stateless, no owner. `SELF` makes a direct call (not a delegatecall) revert, so nobody can run it against this
 * contract's own (empty) storage. Its address is part of every remote initializer, so it is CREATE2-deployed with
 * chain-independent init code, like MamoruActionPolicyV4, which creates it (MamoruActionPolicyV4's constructor).
 */
contract MamoruRemoteInit {
    address public constant SAFE7579 = 0x7579EE8307284F293B1927136486880611F20002;
    address public constant SMART_SESSION = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    /// SmartSessionMode.UNSAFE_ENABLE: enable the sessions in `onInstall` without registry checks.
    uint8 internal constant UNSAFE_ENABLE = 0x02;

    address private immutable SELF;

    error DelegatecallOnly();

    constructor() {
        SELF = address(this);
    }

    /// @param sessions `abi.encode(Session[])`, SmartSession's install payload after the mode byte.
    function init(bytes calldata sessions) external {
        if (address(this) == SELF) revert DelegatecallOnly();
        // Safe.setup already set Safe7579 as fallback handler (its `fallbackHandler` argument); the module must also be
        // enabled for Safe7579 to call SmartSession.onInstall through execTransactionFromModule. `enableModule` is
        // `authorized` (msg.sender == the Safe): this CALL comes from the Safe's own context.
        ISafeSetupV4(address(this)).enableModule(SAFE7579);
        ModuleInitV4[] memory validators = new ModuleInitV4[](1);
        validators[0] = ModuleInitV4(SMART_SESSION, abi.encodePacked(UNSAFE_ENABLE, sessions));
        ModuleInitV4[] memory none = new ModuleInitV4[](0);
        // Through the Safe's fallback handler (Safe7579, `onlyEntryPointOrSelf`: the appended sender is the Safe).
        ISafe7579InitV4(address(this)).initializeAccount(
            validators, none, none, none, RegistryInitV4(address(0), new address[](0), 0)
        );
    }
}

/**
 * @title MamoruRemoteSafe (spec 010 I4): the canonical remote initializer and its address, in Solidity.
 * @notice Pure encoders, internal only (inlined into MamoruActionPolicyV4's helper). Every byte follows the TypeScript
 * that builds today's Safes (packages/account/safe `safeInitializer`, `setupDelegate`, `configureSharedSigner`,
 * `createProxyCall`; packages/account/recovery `counterfactualAddress`): same `Safe.setup` arguments (Safe7579 as
 * fallback handler, no payment), MultiSend 1.4.1 entries packed as `uint8 op ‖ address ‖ uint256 value ‖ uint256 len
 * ‖ bytes`, the shared signer's `configure` delegatecalled only when it is an owner, and SafeProxyFactory 1.4.1's
 * CREATE2 (`salt = keccak(keccak(initializer) ‖ saltNonce)`). The one change from today's setup is the step it
 * delegatecalls: MamoruRemoteInit instead of the launchpad (see that contract). test/V4RemoteParity.t.sol checks the
 * shared encoders against the TypeScript fixture byte for byte.
 */
library MamoruRemoteSafe {
    address internal constant SAFE_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762; // SafeL2 1.4.1
    address internal constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67; // SafeProxyFactory 1.4.1
    address internal constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526; // MultiSend 1.4.1
    address internal constant SAFE7579 = 0x7579EE8307284F293B1927136486880611F20002;
    address internal constant SHARED_SIGNER = 0x94a4F6affBd8975951142c3999aEAB7ecee555c2; // SafeWebAuthnSharedSigner
    /// keccak256(SafeProxyFactory_141.proxyCreationCode() ‖ uint256(SAFE_SINGLETON)), read on Base and Monad (identical).
    bytes32 internal constant PROXY_INIT_CODE_HASH = 0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee;
    uint8 internal constant DELEGATECALL = 1;

    /// What a remote copies from its home account: owners and threshold, and the passkey (x, y, verifiers) that
    /// SafeWebAuthnSharedSigner holds for the account when it is an owner (zeros otherwise).
    struct OwnerState {
        address[] owners;
        uint256 threshold;
        uint256 x;
        uint256 y;
        uint176 verifiers;
    }

    error PasskeyNotConfigured();

    function ownsWithPasskey(OwnerState memory o) internal pure returns (bool) {
        for (uint256 i; i < o.owners.length; i++) {
            if (o.owners[i] == SHARED_SIGNER) return true;
        }
        return false;
    }

    /// The commitment to the owner state: a remote, its address salt and its readiness are bound to it.
    function ownersHash(OwnerState memory o) internal pure returns (bytes32) {
        return keccak256(abi.encode(o.owners, o.threshold, o.x, o.y, o.verifiers));
    }

    /// The `Safe.setup` call of the remote: `remoteInit.init(sessions)` as the setup delegatecall, through MultiSend
    /// with the passkey's `configure` when the shared signer is an owner (TypeScript `setupDelegate`'s shape).
    function initializer(OwnerState memory o, address remoteInit, bytes memory sessions)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory init = abi.encodeCall(MamoruRemoteInit.init, (sessions));
        address to = remoteInit;
        bytes memory data = init;
        if (ownsWithPasskey(o)) {
            if (o.x == 0 && o.y == 0) revert PasskeyNotConfigured();
            bytes memory cfg = abi.encodeCall(ISharedSignerV4.configure, (ISharedSignerV4.Signer(o.x, o.y, o.verifiers)));
            to = MULTISEND;
            data = abi.encodeCall(IMultiSendV4.multiSend, (abi.encodePacked(entry(remoteInit, init), entry(SHARED_SIGNER, cfg))));
        }
        return abi.encodeCall(
            ISafeSetupV4.setup, (o.owners, o.threshold, to, data, SAFE7579, address(0), 0, payable(address(0)))
        );
    }

    /// One MultiSend 1.4.1 entry, a delegatecall with no value.
    function entry(address to, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(DELEGATECALL, to, uint256(0), data.length, data);
    }

    /// The relayer's call: anyone may send it, and it can only ever deploy this initializer at this address.
    function createProxyCall(bytes memory init, uint256 saltNonce) internal pure returns (bytes memory) {
        return abi.encodeCall(ISafeProxyFactoryV4.createProxyWithNonce, (SAFE_SINGLETON, init, saltNonce));
    }

    function proxyAddress(bytes memory init, uint256 saltNonce) internal pure returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(init), saltNonce));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), SAFE_FACTORY, salt, PROXY_INIT_CODE_HASH)))));
    }
}
