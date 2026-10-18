#!/usr/bin/env bun
// `bun run coord <status|claim|heartbeat|release|take> [--as <session>] [--note "<what>"] [--reason "<why>"]`
// The coordinator lease (lib/lease.ts). Only its live holder may merge, cut releases or redeploy the operator; the
// release, merge and operator scripts check it. Claims, hand-overs and takes are also written on otto/mamoru#83.
//   status     who holds it, since when, last seen, and what for
//   claim      take a free or lapsed lease (or renew your own)
//   heartbeat  renew your own lease (every coordinator command does this too)
//   release    give it back when you are done; the next session can claim at once
//   take       take a live lease from another session; needs --reason, and says so on #83
//   assert     exit 0 only if you hold the live lease (renews it); scripts/merge-pr.sh calls this
import { $ } from 'bun'
import { claim, isLive, leasePath, LEASE_TTL_MS, lockBusy, OP_LOCK, readLease, requireLease, sessionName, withDirLock, writeLease } from './lib/lease.ts'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'status'
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? '') : ''
}
const who = sessionName(argv)
const path = leasePath()

async function note83(text: string): Promise<void> {
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ')
  await $`tk comment forgejo:otto/mamoru#83 ${`${at} UTC [coord] ${text}`}`.quiet().nothrow()
}

function fail(reason: string): never {
  console.error(`refusing: ${reason}`)
  process.exit(1)
}

if (cmd === 'status') {
  const lease = readLease(path)
  if (!lease || !isLive(lease, Date.now())) console.log(lease ? `free (last holder ${lease.holder}, lapsed; last seen ${lease.heartbeatAt})` : 'free')
  else console.log(`held by ${lease.holder} since ${lease.claimedAt}, last seen ${lease.heartbeatAt}, lapses ${new Date(Date.parse(lease.heartbeatAt) + LEASE_TTL_MS).toISOString()}: ${lease.note}`)
  process.exit(0)
}

if (!who) fail('pass --as <your session name> or set MAMORU_COORD_AS')

if (cmd === 'assert') {
  requireLease(who, path)
  process.exit(0)
}

if (cmd === 'claim' || cmd === 'take' || cmd === 'heartbeat') {
  if (cmd === 'take' && !flag('reason')) fail('take needs --reason "<why the holder is gone or agreed>"')
  const prev = readLease(path)
  // A release or redeploy in progress finishes under the coordinator that started it: nobody takes over mid-way.
  if (cmd !== 'heartbeat' && lockBusy(OP_LOCK) && prev?.holder !== who) fail(`a coordinator operation is running right now (held by ${prev?.holder ?? 'a lapsed lease'}): try again when it ends`)
  const out = withDirLock(`${path}.lck`, () => {
    const current = readLease(path)
    if (cmd === 'heartbeat' && (!current || !isLive(current, Date.now()) || current.holder !== who)) return { error: 'you do not hold the lease' }
    const r = claim(current, who!, flag('note'), Date.now(), cmd === 'take')
    if ('lease' in r) writeLease(r.lease, path)
    return r
  })
  if ('error' in out) fail(out.error)
  const fresh = !(prev && isLive(prev, Date.now()) && prev.holder === who)
  if (cmd === 'take') await note83(`${who} took the coordinator lease from ${prev?.holder ?? 'nobody'}: ${flag('reason')}. For: ${out.lease.note}`)
  else if (fresh) await note83(`${who} is coordinator. For: ${out.lease.note || '(no note)'}`)
  console.log(`coordinator: ${who}`)
  process.exit(0)
}

if (cmd === 'release') {
  const released = withDirLock(`${path}.lck`, () => {
    const current = readLease(path)
    if (!current || !isLive(current, Date.now()) || current.holder !== who) return false
    writeLease(null, path)
    return true
  })
  if (!released) fail('you do not hold the lease')
  await note83(`${who} released the coordinator lease${flag('note') ? `: ${flag('note')}` : ''}`)
  console.log('released')
  process.exit(0)
}

fail(`unknown command ${cmd}: status | claim | heartbeat | release | take | assert`)
