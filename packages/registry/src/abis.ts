import { parseAbi } from 'viem'

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function increaseAllowance(address spender, uint256 increment) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, bytes signature)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
])

export const swapRouter02Abi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function exactInput(ExactInputParams params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  'function refundETH() payable',
  'function factory() view returns (address)',
])

export const nonfungiblePositionManagerAbi = parseAbi([
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function increaseLiquidity(IncreaseLiquidityParams params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function approve(address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function factory() view returns (address)',
  'function WETH9() view returns (address)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
])

export const uniswapV3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
])

export const uniswapV3FactoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
])

export const entryPointV07Abi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  'function balanceOf(address account) view returns (uint256)',
  'function depositTo(address account) payable',
  'error FailedOp(uint256 opIndex, string reason)',
  'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
])

export const safeAbi = parseAbi([
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function getStorageAt(uint256 offset, uint256 length) view returns (bytes)',
  'function domainSeparator() view returns (bytes32)',
  'function addOwnerWithThreshold(address owner, uint256 threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 threshold)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  'function changeThreshold(uint256 threshold)',
  'function enableModule(address module)',
  'function setGuard(address guard)',
  'function setFallbackHandler(address handler)',
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
])

export const safeProxyFactoryAbi = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address indexed proxy, address singleton)',
])

export const safe7579Abi = parseAbi([
  'function execute(bytes32 mode, bytes executionCalldata) payable',
  'function executeFromExecutor(bytes32 mode, bytes executionCalldata) payable returns (bytes[] returnData)',
  'function installModule(uint256 moduleType, address module, bytes initData)',
  'function uninstallModule(uint256 moduleType, address module, bytes deInitData)',
  'function isModuleInstalled(uint256 moduleType, address module, bytes additionalContext) view returns (bool)',
  'function isValidSignature(bytes32 hash, bytes data) view returns (bytes4)',
])

export const safe7579LaunchpadAbi = parseAbi([
  'struct ModuleInit { address module; bytes initData; }',
  'function addSafe7579(address safe7579, ModuleInit[] validators, ModuleInit[] executors, ModuleInit[] fallbacks, ModuleInit[] hooks, address[] attesters, uint8 threshold)',
])

export const smartSessionAbi = parseAbi([
  'struct PolicyData { address policy; bytes initData; }',
  'struct ERC7739Context { bytes32 appDomainSeparator; string[] contentName; }',
  'struct ERC7739Data { ERC7739Context[] allowedERC7739Content; PolicyData[] erc1271Policies; }',
  'struct ActionData { bytes4 actionTargetSelector; address actionTarget; PolicyData[] actionPolicies; }',
  'struct Session { address sessionValidator; bytes sessionValidatorInitData; bytes32 salt; PolicyData[] userOpPolicies; ERC7739Data erc7739Policies; ActionData[] actions; bool permitERC4337Paymaster; }',
  'function enableSessions(Session[] sessions) returns (bytes32[] permissionIds)',
  'function removeSession(bytes32 permissionId)',
  'function isPermissionEnabled(bytes32 permissionId, address account) view returns (bool)',
  'function isInitialized(address smartAccount) view returns (bool)',
  'function enableActionPolicies(bytes32 permissionId, ActionData[] actionPolicies)',
  'function enableUserOpPolicies(bytes32 permissionId, PolicyData[] userOpPolicies)',
  'function isValidSignatureWithSender(address sender, bytes32 hash, bytes signature) view returns (bytes4)',
])

export const moduleRegistryAbi = parseAbi([
  'struct AttestationRequest { address moduleAddress; uint48 expirationTime; bytes data; uint256[] moduleTypes; }',
  'struct AttestationRecord { uint48 time; uint48 expirationTime; uint48 revocationTime; uint32 moduleTypes; address moduleAddress; address attester; address dataPointer; bytes32 schemaUID; }',
  'function attest(bytes32 schemaUID, AttestationRequest[] requests)',
  'function trustAttesters(uint8 threshold, address[] attesters)',
  'function checkForAccount(address smartAccount, address module) view',
  'function findAttestation(address module, address attester) view returns (AttestationRecord)',
  'error InsufficientAttestations()',
  'error NoTrustedAttestersFound()',
  'error InvalidTrustedAttesterInput()',
])

export const safeWebAuthnSharedSignerAbi = parseAbi([
  'struct Signer { uint256 x; uint256 y; uint176 verifiers; }',
  'function configure(Signer signer)',
  'function getConfiguration(address account) view returns (Signer signer)',
])

export const multiSendCallOnlyAbi = parseAbi(['function multiSend(bytes transactions) payable'])

export const erc4626Abi = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function asset() view returns (address)',
])