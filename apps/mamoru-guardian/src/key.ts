// otto/mamoru#293 (spec 010 I7): the guardian key lives only in a file, never in env, argv or logs.
// otto/mamoru#338: or in an encrypted keystore (Web3 Secret Storage v3, what `cast wallet new` writes) plus a password
// file, both 0600. The key is decrypted in memory at start and never written out in plaintext.
import { createDecipheriv, pbkdf2Sync, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/

/** Reads a regular file of mode 0600 or stricter. Errors name `label`, never the content. */
function readSecret(path: string, label: string): string {
  const st = statSync(path)
  if (!st.isFile()) throw new Error(`${label}: not a regular file`)
  if ((st.mode & 0o077) !== 0) throw new Error(`${label}: permissions too open, chmod 600 it`)
  return readFileSync(path, 'utf8')
}

/** Loads the key from `path`; refuses a file readable by group/other. Errors never carry the file content. */
export function loadGuardianAccount(path: string) {
  const raw = readSecret(path, 'MAMORU_GUARDIAN_KEY_FILE').trim()
  if (!PRIVATE_KEY.test(raw)) throw new Error('MAMORU_GUARDIAN_KEY_FILE: expected 0x + 64 hex characters')
  return privateKeyToAccount(raw as Hex)
}

const hex = (s: unknown, label: string): Buffer => {
  if (typeof s !== 'string' || !/^(0x)?([0-9a-fA-F]{2})+$/.test(s)) throw new Error(`MAMORU_GUARDIAN_KEYSTORE: bad ${label}`)
  return Buffer.from(s.replace(/^0x/, ''), 'hex')
}
const int = (n: unknown, label: string, max: number): number => {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`MAMORU_GUARDIAN_KEYSTORE: bad ${label}`)
  return n
}

/** Decrypts a v3 keystore (scrypt or pbkdf2-sha256, aes-128-ctr). A wrong password fails on the MAC, before any key. */
export function decryptKeystore(json: string, password: string): Hex {
  let ks: { version?: unknown; crypto?: Record<string, any>; Crypto?: Record<string, any> }
  try {
    ks = JSON.parse(json)
  } catch {
    throw new Error('MAMORU_GUARDIAN_KEYSTORE: not JSON')
  }
  const c = ks.crypto ?? ks.Crypto
  if (ks.version !== 3 || !c || typeof c !== 'object') throw new Error('MAMORU_GUARDIAN_KEYSTORE: not a v3 keystore')
  if (c.cipher !== 'aes-128-ctr') throw new Error('MAMORU_GUARDIAN_KEYSTORE: unsupported cipher')
  const p = c.kdfparams ?? {}
  const salt = hex(p.salt, 'salt')
  const dklen = int(p.dklen, 'dklen', 64)
  if (dklen < 32) throw new Error('MAMORU_GUARDIAN_KEYSTORE: bad dklen')
  let dk: Buffer
  if (c.kdf === 'scrypt') {
    const N = int(p.n, 'n', 1 << 20), r = int(p.r, 'r', 32), pp = int(p.p, 'p', 16)
    if ((N & (N - 1)) !== 0) throw new Error('MAMORU_GUARDIAN_KEYSTORE: bad n')
    dk = scryptSync(password, salt, dklen, { N, r, p: pp, maxmem: 256 * N * r + (1 << 20) })
  } else if (c.kdf === 'pbkdf2') {
    if (p.prf !== 'hmac-sha256') throw new Error('MAMORU_GUARDIAN_KEYSTORE: unsupported prf')
    dk = pbkdf2Sync(password, salt, int(p.c, 'c', 10_000_000), dklen, 'sha256')
  } else throw new Error('MAMORU_GUARDIAN_KEYSTORE: unsupported kdf')
  const ct = hex(c.ciphertext, 'ciphertext')
  const mac = hex(c.mac, 'mac')
  const want = Buffer.from(keccak256(Buffer.concat([dk.subarray(16, 32), ct])).slice(2), 'hex')
  if (mac.length !== 32 || !timingSafeEqual(mac, want)) throw new Error('MAMORU_GUARDIAN_KEYSTORE: wrong password or corrupt keystore')
  const iv = hex(c.cipherparams?.iv, 'iv')
  if (iv.length !== 16) throw new Error('MAMORU_GUARDIAN_KEYSTORE: bad iv')
  const d = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), iv)
  const key = `0x${Buffer.concat([d.update(ct), d.final()]).toString('hex')}`
  if (!PRIVATE_KEY.test(key)) throw new Error('MAMORU_GUARDIAN_KEYSTORE: decrypted key is not 32 bytes')
  return key as Hex
}

/** Loads the key from an encrypted keystore and its password file, both 0600. Errors never carry either content. */
export function loadGuardianKeystore(keystorePath: string, passwordPath: string) {
  const json = readSecret(keystorePath, 'MAMORU_GUARDIAN_KEYSTORE')
  // `cast wallet new` reads the password as given; only a trailing newline from an editor is dropped.
  const password = readSecret(passwordPath, 'MAMORU_GUARDIAN_KEYSTORE_PASSWORD_FILE').replace(/\r?\n$/, '')
  return privateKeyToAccount(decryptKeystore(json, password))
}
