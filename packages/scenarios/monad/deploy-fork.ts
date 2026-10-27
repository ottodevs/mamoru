// otto/mamoru#214: MamoruGasPolicy and MamoruActionPolicyV2 deployed on an anvil fork of Monad mainnet, nothing sent to
// the real chain. Runs contracts/action-policy/script/DeployMonad.s.sol against the fork with an impersonated, funded
// deployer (no key exists anywhere in this run), then reads the result back.
//
//   bun run scenarios:monad:deploy-fork          fork https://rpc.monad.xyz (or $MONAD_RPC_URL) at its latest block
//
// Needs foundry (forge, anvil: PATH=$HOME/.foundry/bin:$PATH) and contracts/action-policy/install.sh run once. Env:
//   GUARDIAN        guardian address (default: Base's, 0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD)
//   CARDINALITY_TARGET   passed to the script (default: the script's 1,800)
import { createPublicClient, http, keccak256, parseAbi, type Address, type Hex } from 'viem'
import { monadRegistry, address as regAddress } from '@mamoru/registry'
import { repoPath } from '../runner/manifest.ts'

const UPSTREAM = process.env.MONAD_RPC_URL ?? 'https://rpc.monad.xyz'
const GUARDIAN = (process.env.GUARDIAN ?? '0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD') as Address
const DEPLOYER = '0x00000000000000000000000000000000DeadBeef' as Address
const PORT = Number(process.env.DEPLOY_FORK_PORT ?? 18543)
const LOCAL = `http://127.0.0.1:${PORT}`
const REGISTRY = '0x000000000069E2a187AEFFb852bF3cCdC95151B2' as Address
const TIME_FRAME = '0x8177451511dE0577b911C254E9551D981C26dc72' as Address
const FOUNDRY = `${process.env.HOME}/.foundry/bin`
const env = { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` }

let passed = 0
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`MONAD-DEPLOY FAILED: ${what}`)
  passed++
  console.log(`ok  ${what}`)
}

const anvil = Bun.spawn(['anvil', '--fork-url', UPSTREAM, '--port', String(PORT), '--auto-impersonate', '--gas-limit', '150000000', '--silent'], { env, stdout: 'ignore', stderr: 'inherit' })
try {
  const client = createPublicClient({ transport: http(LOCAL) })
  for (let i = 0; ; i++) {
    try {
      await client.getChainId()
      break
    } catch {
      if (i > 120) throw new Error('anvil did not start')
      await Bun.sleep(500)
    }
  }
  check((await client.getChainId()) === 143, 'fork reports chain id 143')
  const forkBlock = await client.getBlockNumber()
  console.log(`forked ${new URL(UPSTREAM).hostname} at block ${forkBlock}`)
  await client.request({ method: 'anvil_setBalance' as never, params: [DEPLOYER, '0x56BC75E2D63100000'] as never }) // 100 MON; Monad charges the gas limit, anvil the gas used: the budget is not proven here

  const forge = Bun.spawn(['forge', 'script', 'script/DeployMonad.s.sol', '--rpc-url', LOCAL, '--sender', DEPLOYER, '--unlocked', '--broadcast', '--slow', '--non-interactive'], {
    cwd: repoPath('contracts/action-policy'),
    env: { ...env, GUARDIAN, ...(process.env.CARDINALITY_TARGET ? { CARDINALITY_TARGET: process.env.CARDINALITY_TARGET } : {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(forge.stdout).text(), new Response(forge.stderr).text(), forge.exited])
  if (forge.exitCode !== 0) throw new Error(`forge script exited ${forge.exitCode}\n${out.slice(-2000)}\n${err.slice(-2000)}`)
  const logLines = out.split('\n').filter((l) => /^(MamoruGasPolicy|MamoruActionPolicyV2|GUARDIAN|WMON\/USDC)/.test(l.trim()))
  for (const l of logLines) console.log(`  script: ${l.trim()}`)
  const gasPolicy = out.match(/MamoruGasPolicy:\s+(0x[0-9a-fA-F]{40})/)?.[1] as Address
  const policy = out.match(/MamoruActionPolicyV2:\s+(0x[0-9a-fA-F]{40})/)?.[1] as Address
  check(!!gasPolicy && !!policy, 'script printed both addresses')

  // Gas of every transaction the script sent (the cardinality steps are the ones to size).
  const last = await client.getBlockNumber()
  const gas: { to: string; used: bigint; limit: bigint }[] = []
  for (let b = forkBlock + 1n; b <= last; b++) {
    const blk = await client.getBlock({ blockNumber: b, includeTransactions: true })
    for (const tx of blk.transactions) {
      const rc = await client.getTransactionReceipt({ hash: tx.hash })
      check(rc.status === 'success', `tx ${tx.hash.slice(0, 10)} succeeded`)
      gas.push({ to: tx.to ?? 'create', used: rc.gasUsed, limit: tx.gas })
    }
  }
  const cardSteps = gas.filter((g) => g.to.toLowerCase() === regAddress('pool:WMON/USDC/3000', monadRegistry).toLowerCase())
  console.log(`  txs: ${gas.length}; deployModule gas used: ${gas.filter((g) => g.to.toLowerCase() === REGISTRY.toLowerCase()).map((g) => g.used).join(', ')}`)
  console.log(`  cardinality steps: ${cardSteps.length}, gas used each: ${cardSteps.map((g) => g.used).join(', ')}; max gas limit set: ${cardSteps.reduce((m, g) => (g.limit > m ? g.limit : m), 0n)}`)
  check(cardSteps.every((g) => g.limit < 20_000_000n), 'every cardinality step has a gas limit under 20M (Ethereum schedule; Monad cold-slot cost unverified)')
  const limitSum = gas.reduce((m, g) => m + g.limit, 0n)
  console.log(`  sum of gas limits: ${limitSum} (x 100 gwei = ${Number(limitSum) / 1e7} MON upper bound at that fee, since Monad charges the limit)`)

  // Resume: the same command again (as after a partial broadcast) skips both modules, raises nothing, sends nothing.
  const rerun = Bun.spawn(['forge', 'script', 'script/DeployMonad.s.sol', '--rpc-url', LOCAL, '--sender', DEPLOYER, '--unlocked', '--broadcast', '--slow', '--non-interactive'], {
    cwd: repoPath('contracts/action-policy'),
    env: { ...env, GUARDIAN, ...(process.env.CARDINALITY_TARGET ? { CARDINALITY_TARGET: process.env.CARDINALITY_TARGET } : {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [rout, rerr] = await Promise.all([new Response(rerun.stdout).text(), new Response(rerun.stderr).text(), rerun.exited])
  if (rerun.exitCode !== 0) throw new Error(`rerun exited ${rerun.exitCode}\n${rout.slice(-1500)}\n${rerr.slice(-1500)}`)
  check(rout.includes('already deployed, skipped') && (await client.getBlockNumber()) === last, 'rerun skips both modules and sends no transaction')

  // Bytecode, record, immutables, cardinality.
  const abi = parseAbi([
    'function GUARDIAN() view returns (address)',
    'function SMART_SESSION() view returns (address)',
    'function NPM() view returns (address)',
    'function ROUTER() view returns (address)',
    'function FACTORY() view returns (address)',
    'function findModule(address) view returns ((bytes32 resolverUID, address sender, bytes metadata))',
    'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  ])
  const rec = async (a: Address) => client.readContract({ address: REGISTRY, abi, functionName: 'findModule', args: [a] })
  const ref = await rec(TIME_FRAME)
  for (const [name, a] of [['MamoruGasPolicy', gasPolicy], ['MamoruActionPolicyV2', policy]] as const) {
    const code = await client.getCode({ address: a })
    check(!!code && code.length > 2, `${name} has code at ${a} (${(((code?.length ?? 2) - 2) / 2)} bytes, keccak ${keccak256((code ?? '0x') as Hex)})`)
    const r = await rec(a)
    check(r.resolverUID === ref.resolverUID && r.sender.toLowerCase() === DEPLOYER.toLowerCase(), `${name} ModuleRecord: resolver of TimeFramePolicy's record (${r.resolverUID.slice(0, 10)}), sender = deployer`)
  }
  check(((await client.getCode({ address: policy }))!.length - 2) / 2 <= 24_576, 'MamoruActionPolicyV2 runtime within EIP-170')
  const read = (fn: 'GUARDIAN' | 'SMART_SESSION' | 'NPM' | 'ROUTER' | 'FACTORY') => client.readContract({ address: policy, abi, functionName: fn })
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  check(eq(await read('GUARDIAN'), GUARDIAN), `GUARDIAN immutable = ${GUARDIAN}`)
  check(eq(await read('SMART_SESSION'), regAddress('SmartSession', monadRegistry)), 'SMART_SESSION immutable = monad.json SmartSession')
  check(eq(await read('NPM'), regAddress('NonfungiblePositionManager', monadRegistry)), 'NPM immutable = monad.json NonfungiblePositionManager')
  check(eq(await read('ROUTER'), regAddress('SwapRouter02', monadRegistry)), 'ROUTER immutable = monad.json SwapRouter02')
  check(eq(await read('FACTORY'), regAddress('UniswapV3Factory', monadRegistry)), 'FACTORY immutable = monad.json UniswapV3Factory')
  const s0 = await client.readContract({ address: regAddress('pool:WMON/USDC/3000', monadRegistry), abi, functionName: 'slot0' })
  const target = Number(process.env.CARDINALITY_TARGET ?? 1800)
  check(s0[4] >= target, `WMON/USDC observationCardinalityNext = ${s0[4]} (>= ${target}; was 1000 on mainnet)`)
  console.log(`MONAD-DEPLOY ok: ${passed} checks`)
} finally {
  anvil.kill()
}
