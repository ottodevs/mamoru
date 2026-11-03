// otto/mamoru#338: the guardian reads its key from an encrypted keystore plus a password file, never a plaintext key at rest.
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decryptKeystore, loadGuardianKeystore } from '../src/key.ts'

// Anvil's public test key #0, imported with `cast wallet import --unsafe-password test-password` (scrypt n=8192).
const ANVIL0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const CAST_KEYSTORE = '{"crypto":{"cipher":"aes-128-ctr","cipherparams":{"iv":"52d1e4ed1c8638e9b41a0d24a129621d"},"ciphertext":"cc4d038d2da28dcd407e59eb183089910fea3a07c859755a74c34b887f746a0a","kdf":"scrypt","kdfparams":{"dklen":32,"n":8192,"p":1,"r":8,"salt":"f21d6749e5d5d88ca835ab7b3b23560ae30ee4759e16cb32252edfd70aa9bc97"},"mac":"7a41d56369f1bd317d56cf51c306583515fafbda9b50ac8bc001737806936392"},"id":"8aa7c4bc-6773-48dc-98a6-cf87b2876027","version":3}'
// The Web3 Secret Storage v3 PBKDF2 test vector (ethereum wiki), password "testpassword".
const PBKDF2_VECTOR = JSON.stringify({ version: 3, crypto: { cipher: 'aes-128-ctr', cipherparams: { iv: '6087dab2f9fdbbfaddc31a909735c1e6' }, ciphertext: '5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46', kdf: 'pbkdf2', kdfparams: { c: 262144, dklen: 32, prf: 'hmac-sha256', salt: 'ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd' }, mac: '517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2' } })

const files = (ks: string, pass: string, mode = 0o600) => {
  const d = mkdtempSync(join(tmpdir(), 'guardian-ks-'))
  writeFileSync(join(d, 'ks'), ks)
  writeFileSync(join(d, 'pass'), pass)
  chmodSync(join(d, 'ks'), mode)
  chmodSync(join(d, 'pass'), mode)
  return { ks: join(d, 'ks'), pass: join(d, 'pass') }
}

describe('guardian keystore', () => {
  test('a cast keystore (scrypt) gives the key of its address', () => {
    const f = files(CAST_KEYSTORE, 'test-password')
    expect(loadGuardianKeystore(f.ks, f.pass).address).toBe(ANVIL0)
  })

  test('a password file with a trailing newline still opens it; other whitespace is part of the password', () => {
    expect(loadGuardianKeystore(files(CAST_KEYSTORE, 'test-password\n').ks, files(CAST_KEYSTORE, 'test-password\n').pass).address).toBe(ANVIL0)
    const f = files(CAST_KEYSTORE, ' test-password')
    expect(() => loadGuardianKeystore(f.ks, f.pass)).toThrow('wrong password')
  })

  test('the pbkdf2 test vector decrypts to its known key', () => {
    expect(decryptKeystore(PBKDF2_VECTOR, 'testpassword')).toBe('0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d')
  })

  test('a wrong password fails on the MAC, and the error carries neither password nor key', () => {
    const f = files(CAST_KEYSTORE, 'nope-secret')
    const err = (() => { try { loadGuardianKeystore(f.ks, f.pass) } catch (e) { return e as Error } })()!
    expect(err.message).toBe('MAMORU_GUARDIAN_KEYSTORE: wrong password or corrupt keystore')
    expect(err.message).not.toContain('nope-secret')
  })

  test('a keystore or password readable by group/other is refused before reading', () => {
    const f = files(CAST_KEYSTORE, 'test-password', 0o640)
    expect(() => loadGuardianKeystore(f.ks, f.pass)).toThrow('MAMORU_GUARDIAN_KEYSTORE: permissions too open')
    const g = files(CAST_KEYSTORE, 'test-password')
    chmodSync(g.pass, 0o644)
    expect(() => loadGuardianKeystore(g.ks, g.pass)).toThrow('MAMORU_GUARDIAN_KEYSTORE_PASSWORD_FILE: permissions too open')
  })

  test('malformed keystores are refused with a reason, never decrypted', () => {
    expect(() => decryptKeystore('{', 'x')).toThrow('not JSON')
    expect(() => decryptKeystore(JSON.stringify({ version: 1 }), 'x')).toThrow('not a v3 keystore')
    const v = JSON.parse(CAST_KEYSTORE)
    expect(() => decryptKeystore(JSON.stringify({ ...v, crypto: { ...v.crypto, cipher: 'aes-256-gcm' } }), 'x')).toThrow('unsupported cipher')
    expect(() => decryptKeystore(JSON.stringify({ ...v, crypto: { ...v.crypto, kdf: 'argon2' } }), 'x')).toThrow('unsupported kdf')
    expect(() => decryptKeystore(JSON.stringify({ ...v, crypto: { ...v.crypto, kdfparams: { ...v.crypto.kdfparams, n: 1 << 30 } } }), 'x')).toThrow('bad n')
    expect(() => decryptKeystore(JSON.stringify({ ...v, crypto: { ...v.crypto, kdfparams: { ...v.crypto.kdfparams, n: 3000 } } }), 'x')).toThrow('bad n')
  })
})
