import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, parseEventLogs, stringToHex, toHex, type Hex } from 'viem'
import type { AccountContext, Address, OwnerSignature } from '@mamoru/domain'
import { address, safeAbi, safeProxyFactoryAbi, safeWebAuthnSharedSignerAbi } from '@mamoru/registry'
import { computeCaps, conservadorLabV1, instantiateGrant } from '@mamoru/policy'
import { approve, mint } from '@mamoru/uniswap-v3'
import { counterfactualAddress, accountSetup } from '../recovery/index.ts'
import { webAuthnSigner } from '../safe/index.ts'
import {
  activationBatch,
  assertionShape,
  browserOwnerSignature,
  clientDataFieldsOf,
  decodeOwnerSignature,
  deployCall,
  encodeWebAuthnSignature,
  execData,
  liveAccountFromContext,
  ownerSafeTx,
  ownerSignatureShape,
  parseDerSignature,
  P256_N,
  readSafeNonce,
  safeContractSignature,
  safeTxHashOf,
  stopBatch,
  transferBatch,
  verifyOwnerSignature,
  type LiveAccount,
} from './index.ts'
// Lab helpers (fork, whale, software passkey) live in the scenarios package.
import { startLabFork } from '../../scenarios/fork/lab-fork.ts'
import { startForkProxy } from '../../scenarios/proxy/index.ts'
import { loadManifest } from '../../scenarios/runner/manifest.ts'
import { Lab, devAccount } from '../../scenarios/fixtures/lab.ts'
import { POOL, WHALE, poolTick, rangeAround } from '../../scenarios/fixtures/world.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../scenarios/webauthn/index.ts'

const EXECUTION_SUCCESS = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'))

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString('base64url')

/** DER ECDSA-Sig-Value, as a browser returns it. */
function der(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    let b = Buffer.from(v.toString(16).padStart(64, '0'), 'hex')
    while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1)
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b])
    return Buffer.concat([Buffer.from([0x02, b.length]), b])
  }
  const body = Buffer.concat([int(r), int(s)])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

/** The software passkey's assertion in the shape the browser posts (OwnerSignature). */
function browserAssert(passkey: SoftwarePasskey, challenge: Hex, highS = false): OwnerSignature {
  const a = passkey.assert(challenge)
  return {
    prepareId: 'test',
    authenticatorData: b64url(Buffer.from(a.authenticatorData.slice(2), 'hex')),
    clientDataJSON: b64url(a.clientDataJSON),
    signature: b64url(der(a.r, highS ? P256_N - a.s : a.s)),
  }
}

function contextFor(passkey: SoftwarePasskey, chainId: number, saltNonce: bigint): AccountContext {
  const owners = [address('SafeWebAuthnSharedSigner')]
  const webauthn = webAuthnSigner(passkey.x, passkey.y)
  return {
    accountKey: 'test',
    chainId,
    address: counterfactualAddress(accountSetup(owners, saltNonce, webauthn)),
    owners,
    saltNonce: saltNonce.toString(),
    passkey: { credentialId: 'test', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
  }
}

describe('live owner path: pure', () => {
  test('clientDataFields are what SafeWebAuthnSharedSigner rebuilds around the challenge', () => {
    const json = '{"type":"webauthn.get","challenge":"AbC_-","origin":"https://app.mamoru.lol","crossOrigin":false}'
    expect(clientDataFieldsOf(json)).toEqual({ challenge: 'AbC_-', fields: '"origin":"https://app.mamoru.lol","crossOrigin":false' })
    expect(() => clientDataFieldsOf('{"challenge":"x","type":"webauthn.get"}')).toThrow()
  })

  test('DER parse normalizes to low s', () => {
    const p = new SoftwarePasskey(PASSKEY_SCALARS.a1)
    const a = p.assert(('0x' + '11'.repeat(32)) as Hex)
    expect(parseDerSignature(der(a.r, P256_N - a.s))).toEqual({ r: a.r, s: a.s })
    expect(parseDerSignature(der(a.r, a.s))).toEqual({ r: a.r, s: a.s })
  })

  test('DER is strict: each malformed shape is refused, and what authenticators emit passes', () => {
    const hex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/\s+/g, ''), 'hex'))
    const one = '0201' + '01'
    const top = '0221' + '00' + 'ff'.padEnd(64, '0') // 33 bytes: 0x00 then a value with the high bit set
    const order = P256_N.toString(16)
    const cases: [string, string, string][] = [
      ['trailing byte after the sequence', '3006' + one + one + '00', 'bad length'],
      ['sequence length shorter than the content', '3005' + one + one, 'bad length'],
      ['sequence length longer than the content', '3007' + one + one, 'bad length'],
      ['long-form sequence length', '308106' + one + one, 'bad length'],
      ['not a sequence', '3106' + one + one, 'expected SEQUENCE'],
      ['not an integer', '3006' + '030101' + one, 'expected INTEGER'],
      ['empty integer', '3005' + '0200' + one, 'bad INTEGER'],
      ['negative integer (high bit set, no leading zero)', '3006' + '020181' + one, 'negative INTEGER'],
      ['non-minimal integer (needless leading zero)', '3007' + '02020001' + one, 'non-minimal INTEGER'],
      ['integer longer than 33 bytes', '3027' + '0222' + '0000' + 'ff'.repeat(32) + one, 'bad INTEGER'],
      ['integer running past the sequence', '3006' + '0205' + '01020101', 'bad INTEGER'],
      ['a third element inside the sequence', '3009' + one + one + one, 'trailing data'],
      ['r = 0', '3006' + '020100' + one, 'out of range'],
      ['s = 0', '3006' + one + '020100', 'out of range'],
      ['r = n', '3026' + '022100' + order + one, 'out of range'],
      ['s = n', '3026' + one + '022100' + order, 'out of range'],
      ['empty input', '', 'bad length'],
    ]
    for (const [what, input, why] of cases) expect(() => parseDerSignature(hex(input)), what).toThrow(why)
    // Minimal encodings real authenticators produce: a leading 0x00 when the high bit is set, short values without padding.
    expect(parseDerSignature(hex('3026' + top + one))).toEqual({ r: BigInt('0x' + 'ff'.padEnd(64, '0')), s: 1n })
    expect(parseDerSignature(hex('3006' + one + one))).toEqual({ r: 1n, s: 1n })
    expect(parseDerSignature(hex('3026' + one + '022100' + (P256_N - 1n).toString(16)))).toEqual({ r: 1n, s: 1n })
    for (const scalar of [PASSKEY_SCALARS.a1, PASSKEY_SCALARS.a2]) {
      const k = new SoftwarePasskey(scalar)
      for (let i = 0; i < 16; i++) {
        const a = k.assert(toHex(i, { size: 32 }))
        expect(parseDerSignature(der(a.r, a.s))).toEqual({ r: a.r, s: a.s })
        expect(parseDerSignature(der(a.r, P256_N - a.s))).toEqual({ r: a.r, s: a.s })
      }
    }
  })

  test('the owner signature verifies off chain only for this key and this safeTxHash', async () => {
    const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
    const other = new SoftwarePasskey(PASSKEY_SCALARS.a2)
    const hash = `0x${'ab'.repeat(32)}` as const
    for (const highS of [false, true]) {
      const sig = browserOwnerSignature(browserAssert(passkey, hash, highS), hash)
      expect(await verifyOwnerSignature(sig, hash, passkey)).toBe(true)
      // Another key, another transaction (Safe, chain or nonce change the hash), a forged or altered signature.
      expect(await verifyOwnerSignature(sig, hash, other)).toBe(false)
      expect(await verifyOwnerSignature(sig, `0x${'ac'.repeat(32)}`, passkey)).toBe(false)
      expect(await verifyOwnerSignature(browserOwnerSignature(browserAssert(other, hash, highS), hash), hash, passkey)).toBe(false)
      const d = decodeOwnerSignature(sig)
      const forge = (p: Partial<typeof d>) => safeContractSignature(address('SafeWebAuthnSharedSigner'), encodeWebAuthnSignature({ ...d, ...p }))
      expect(await verifyOwnerSignature(forge({}), hash, passkey)).toBe(true)
      expect(await verifyOwnerSignature(forge({ r: d.r + 1n }), hash, passkey)).toBe(false)
      expect(await verifyOwnerSignature(forge({ s: 0n }), hash, passkey)).toBe(false)
      expect(await verifyOwnerSignature(forge({ clientDataFields: `${d.clientDataFields},"x":1` }), hash, passkey)).toBe(false)
      // User verification is required on chain; without the flag the signature is refused here too (and no longer matches).
      const noUv = (d.authenticatorData.slice(0, 66) + '01' + d.authenticatorData.slice(68)) as Hex
      expect(await verifyOwnerSignature(forge({ authenticatorData: noUv }), hash, passkey)).toBe(false)
    }
    // Not a SafeWebAuthnSharedSigner contract signature at all.
    const sig = browserOwnerSignature(browserAssert(passkey, hash), hash)
    expect(await verifyOwnerSignature(`0x${'11'.repeat(97)}`, hash, passkey)).toBe(false)
    expect(await verifyOwnerSignature('0x', hash, passkey)).toBe(false)
    expect(await verifyOwnerSignature(safeContractSignature(`0x${'22'.repeat(20)}`, `0x${sig.slice(2 + 97 * 2)}`), hash, passkey)).toBe(false)
    expect(await verifyOwnerSignature(`${sig}00`, hash, passkey)).toBe(false)
  })

  test('the assertion shape for the log holds sizes, flags and key order, nothing secret', () => {
    const p = new SoftwarePasskey(PASSKEY_SCALARS.a1)
    const hash = `0x${'cd'.repeat(32)}` as const
    const sig = browserAssert(p, hash, true)
    const bytes = (v: string) => Uint8Array.from(Buffer.from(v, 'base64url'))
    const shape = assertionShape({ authenticatorData: bytes(sig.authenticatorData), clientDataJSON: bytes(sig.clientDataJSON), signature: bytes(sig.signature) })
    expect(shape).toMatchObject({ authenticatorDataLength: 37, flags: '0x05', signCountZero: false, clientDataKeys: ['type', 'challenge', 'origin', 'crossOrigin'], clientDataPrefixOk: true, signatureDer: 'ok', highS: true })
    expect(JSON.stringify(shape)).not.toContain('app.mamoru.lol')
    // An authenticator that writes other keys, extension data and a broken signature still gets a shape, not a throw.
    const odd = assertionShape({ authenticatorData: new Uint8Array(80).fill(0x81), clientDataJSON: new TextEncoder().encode('{"challenge":"x","type":"webauthn.get","other":1}'), signature: new Uint8Array([0x30, 0x00]) })
    expect(odd).toMatchObject({ authenticatorDataLength: 80, flags: '0x81', clientDataKeys: ['challenge', 'type', '+1'], clientDataPrefixOk: false, highS: null })
    expect(odd.signatureDer).not.toBe('ok')
    expect(assertionShape({ authenticatorData: new Uint8Array(), clientDataJSON: new Uint8Array([0xff]), signature: new Uint8Array() })).toMatchObject({ flags: null, clientDataKeys: null })
    expect(ownerSignatureShape(browserOwnerSignature(sig, hash))).toEqual({ decodes: true, authenticatorDataLength: 37, flags: '0x05', clientDataKeys: ['type', 'challenge', 'origin', 'crossOrigin'] })
    expect(ownerSignatureShape('0x1234')).toEqual({ decodes: false })
  })

  test('context is refused when the address does not match', () => {
    const ctx = contextFor(new SoftwarePasskey(PASSKEY_SCALARS.a1), 8453, 7n)
    expect(liveAccountFromContext(ctx).safe).toBe(ctx.address as Address)
    expect(() => liveAccountFromContext({ ...ctx, saltNonce: '8' })).toThrow()
  })

  test('a challenge other than the safeTxHash is refused', () => {
    const p = new SoftwarePasskey(PASSKEY_SCALARS.a1)
    const sig = browserAssert(p, ('0x' + '22'.repeat(32)) as Hex)
    expect(() => browserOwnerSignature(sig, ('0x' + '33'.repeat(32)) as Hex)).toThrow()
  })
})

const RUN_FORK = !!process.env.RPC_URL && !!Bun.which('anvil')

describe.skipIf(!RUN_FORK)('live owner path on a Base fork', () => {
  let stop: () => Promise<void> = async () => {}
  let lab: Lab
  let acct: LiveAccount
  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const relayer = devAccount(0)
  let permissionIds: Hex[] = []

  beforeAll(async () => {
    const manifest = await loadManifest()
    const proxy = startForkProxy('RPC_URL')
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-live-'))
    const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: join(dir, 'anvil.log') })
    stop = async () => {
      await handle.stop()
      proxy.stop()
    }
    lab = new Lab(handle.url, manifest.fork.chainId)
  }, 180_000)

  afterAll(async () => {
    await stop()
  })

  async function ownerExec(calls: Parameters<typeof ownerSafeTx>[0], highS = false) {
    const { deployed, nonce } = await readSafeNonce(lab.client, acct.safe)
    expect(deployed).toBe(true)
    const tx = ownerSafeTx(calls, nonce)
    const hash = safeTxHashOf(acct, tx)
    const onchain = await lab.client.readContract({
      address: acct.safe,
      abi: safeAbi,
      functionName: 'getTransactionHash',
      args: [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', tx.nonce],
    })
    expect(onchain).toBe(hash)
    const signature = browserOwnerSignature(browserAssert(passkey, hash, highS), hash)
    const r = await lab.send(relayer, acct.safe, execData(tx, signature))
    expect(r.ok).toBe(true)
    // Safe 1.4.1 indexes txHash, so match topic0 and topic1 instead of decoding with the registry ABI.
    const ok = r.receipt.logs.filter((l) => l.address.toLowerCase() === acct.safe.toLowerCase() && l.topics[0] === EXECUTION_SUCCESS)
    expect(ok.length).toBe(1)
    expect(ok[0]!.topics[1] ?? ok[0]!.data.slice(0, 66)).toBe(hash)
    expect((await readSafeNonce(lab.client, acct.safe)).nonce).toBe(nonce + 1n)
    return r
  }

  test('deploy from context: counterfactual address, passkey bound', async () => {
    acct = liveAccountFromContext(contextFor(passkey, lab.chainId, 0x6d616d6f7275n))
    expect(await readSafeNonce(lab.client, acct.safe)).toEqual({ deployed: false, nonce: 0n })
    const call = deployCall(acct)
    const r = await lab.send(relayer, call.to, call.data)
    expect(r.ok).toBe(true)
    const proxy = parseEventLogs({ abi: safeProxyFactoryAbi, logs: r.receipt.logs, eventName: 'ProxyCreation' })[0]!.args.proxy
    expect(proxy.toLowerCase()).toBe(acct.safe.toLowerCase())
    const bound = await lab.client.readContract({ address: address('SafeWebAuthnSharedSigner'), abi: safeWebAuthnSharedSignerAbi, functionName: 'getConfiguration', args: [acct.safe] })
    expect(bound.x).toBe(passkey.x)
    await lab.whaleTransfer('USDC', WHALE, acct.safe, 20_000_000n)
    expect(await lab.balanceOf('USDC', acct.safe)).toBe(20_000_000n)
  }, 180_000)

  test('activation batch signed by a browser-shaped assertion (high s from DER normalized)', async () => {
    const now = Number(await lab.timestamp())
    const { sqrtPriceX96 } = await poolTick(lab)
    const caps = computeCaps(conservadorLabV1, 20_000_000n, { cbBTC: { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n } })
    const grants = (['enter-swap', 'enter-mint'] as const).map((name, i) =>
      instantiateGrant(conservadorLabV1, name, {
        account: acct.safe,
        sessionKey: devAccount(5).address,
        chainId: lab.chainId,
        salt: toHex(i + 1, { size: 32 }),
        validAfter: now - 60,
        validUntil: now + conservadorLabV1.session.validitySeconds,
        caps,
        admittedTokenIds: [],
      }),
    )
    const act = activationBatch(acct, grants, [])
    await ownerExec(act.calls, true)
    permissionIds = act.permissionIds
    expect(permissionIds.length).toBe(2)
  }, 180_000)

  test('transfer batch sends 2 USDC to a fresh address', async () => {
    const to = '0x000000000000000000000000000000000000dEaD' as Address
    const before = await lab.balanceOf('USDC', to)
    const deadline = (await lab.timestamp()) + 3600n
    await ownerExec(transferBatch({ account: acct.safe, to, amountUsdc: 2_000_000n, reduce: [], deadline }))
    expect((await lab.balanceOf('USDC', to)) - before).toBe(2_000_000n)
    expect(await lab.balanceOf('USDC', acct.safe)).toBe(18_000_000n)
  }, 180_000)

  test('stop batch: revoke, close and burn an owner position, swap cbBTC back to USDC', async () => {
    await lab.whaleTransfer('cbBTC', WHALE, acct.safe, 10_000n)
    const { tick } = await poolTick(lab)
    const range = rangeAround(tick, 4000, 10)
    const deadline = (await lab.timestamp()) + 3600n
    const usdcIn = 5_000_000n
    const cbbtcIn = 5_000n
    const m = await ownerExec(
      [
        approve('USDC', 'NonfungiblePositionManager', usdcIn),
        approve('cbBTC', 'NonfungiblePositionManager', cbbtcIn),
        mint({ account: acct.safe, pool: POOL, ...range, amount0Desired: usdcIn, amount1Desired: cbbtcIn, amount0Min: 1n, amount1Min: 1n, deadline }),
        approve('USDC', 'NonfungiblePositionManager', 0n),
        approve('cbBTC', 'NonfungiblePositionManager', 0n),
      ].map((c) => ({ to: c.to, value: 0n, data: c.data })),
    )
    const npm = address('NonfungiblePositionManager').toLowerCase()
    const { nonfungiblePositionManagerAbi } = await import('@mamoru/registry')
    const tokenId = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: m.receipt.logs, eventName: 'Transfer' }).find((l) => l.address.toLowerCase() === npm)!.args.tokenId
    const pos = await lab.client.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] })
    const liquidity = pos[7]
    expect(liquidity > 0n).toBe(true)

    // cbBTC after collect = what the Safe holds now plus what the position returns; swap what it holds now (the minted remainder).
    const cbbtcHeld = await lab.balanceOf('cbBTC', acct.safe)
    const usdcBefore = await lab.balanceOf('USDC', acct.safe)
    await ownerExec(
      stopBatch({
        account: acct.safe,
        permissionIds,
        positions: [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n }],
        swapCbbtc: { amountIn: cbbtcHeld, amountOutMinimum: 1n },
        deadline: (await lab.timestamp()) + 3600n,
      }),
    )
    expect(await lab.balanceOf('USDC', acct.safe) > usdcBefore).toBe(true)
    expect(await lab.balanceOf('cbBTC', acct.safe) < cbbtcHeld + cbbtcIn).toBe(true)
    // the position is burned
    await expect(
      lab.client.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] }),
    ).rejects.toThrow()
  }, 180_000)
})

describe('assertion shape logging', () => {
  test('only WebAuthn-defined clientDataJSON key names are kept; others are counted', async () => {
    const { assertionShape, safeClientDataKeys } = await import('./index.ts')
    expect(safeClientDataKeys(['type', 'challenge', 'origin', 'crossOrigin'])).toEqual(['type', 'challenge', 'origin', 'crossOrigin'])
    expect(safeClientDataKeys(['type', 'cred-AAAAsecretBBBB', 'challenge', '0xdeadbeef'])).toEqual(['type', 'challenge', '+2'])
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', 'leak-my-credential-id': 1, challenge: 'x' }))
    const shape = assertionShape({ authenticatorData: new Uint8Array(37), clientDataJSON, signature: new Uint8Array(8) })
    expect(JSON.stringify(shape)).not.toContain('leak-my-credential-id')
    expect(shape.clientDataKeys).toEqual(['type', 'challenge', '+1'])
  })
})
