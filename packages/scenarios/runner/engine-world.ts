import { parseEventLogs } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { address, safeProxyFactoryAbi } from '@mamoru/registry'
import type { PolicyVersion } from '@mamoru/policy'
import { configureSharedSigner, createProxyCall, packVerifiers } from '@mamoru/account/safe'
import { registryTrustCalls } from '@mamoru/account/sessions'
import { SessionLedger } from '@mamoru/account/precheck'
import { devAccount, type Lab } from '../fixtures/lab.ts'
import { GAS_RESERVE_WEI, ownerBatch, ownerExec, type AccountFixture, type World } from '../fixtures/world.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../webauthn/index.ts'

/**
 * World of the engine scenarios: fx-owners, fx-safe and fx-gas only. The
 * session key is generated here, in the test process, and never written.
 * Deposits, sessions and positions are fixtures of each scenario.
 */
export async function buildEngineWorld(lab: Lab, policy: PolicyVersion, engineNow: () => Promise<number>): Promise<World> {
  const relayer = devAccount(0)
  const backupOwner = devAccount(1)
  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const call = createProxyCall({
    owners: [address('SafeWebAuthnSharedSigner'), backupOwner.address],
    threshold: 1n,
    validators: [{ module: address('SmartSession'), initData: '0x' }],
    saltNonce: 1n,
  })
  const r = await lab.send(relayer, call.to, call.data)
  if (!r.ok) throw new Error('engine world: Safe deployment failed')
  const safe = parseEventLogs({ abi: safeProxyFactoryAbi, logs: r.receipt.logs, eventName: 'ProxyCreation' })[0]!.args.proxy
  const a1: AccountFixture = {
    label: 'A1',
    safe,
    backupOwner,
    passkey,
    sessionKey: privateKeyToAccount(generatePrivateKey()),
    caps: {},
    grants: [],
    managedTokenIds: [],
    ownerTokenIds: [],
    ledger: new SessionLedger(),
    signedOwnerTxs: [],
  }
  const cfg = configureSharedSigner(passkey.x, passkey.y, packVerifiers(0x100, address('P256Verifier')))
  if (!(await ownerExec(lab, relayer, a1, cfg)).ok) throw new Error('engine world: passkey configure failed')
  if (!(await ownerBatch(lab, relayer, a1, registryTrustCalls(safe))).ok) throw new Error('engine world: registry trust failed')
  const gasPayer = devAccount(2)
  if (!(await lab.send(gasPayer, safe, '0x', GAS_RESERVE_WEI)).ok) throw new Error('engine world: fx-gas failed')
  return {
    lab,
    policy,
    relayer,
    gasPayer,
    attacker: devAccount(9),
    a1,
    a2: undefined as never,
    fixtures: ['fx-owners', 'fx-safe', 'fx-gas'],
    t0: Number(await lab.timestamp()),
    saltCounter: 0,
    opLog: [],
    context: 'fixtures',
    engineNow,
  }
}
