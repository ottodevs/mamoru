// otto/mamoru#357: live 3 Nov (b54dda3a@143), a Monad RPC timeout threw out of a harvest before it was signed. The op
// stayed `proposed`, and every review after it held DECIDE_SLOT_BUSY until a restart. `runOp` is private: reached with a
// cast, like engine-vault.test.ts.
import { describe, expect, test } from 'bun:test'
import type { Decision } from '@mamoru/decide'
import { TimeoutError } from 'viem'
import { Engine, thrownSummary } from './engine.ts'
import { MemoryJournal, type OpRecord } from './journal.ts'

const harvest = {
  decisionId: '0xd1',
  premiseHash: '0x01',
  reason: 'DECIDE_HARVEST',
  proposal: { kind: 'harvest', grant: 'collect', bucket: 'growth', pool: 'pool:WMON/USDC/3000', tokenId: 49417n },
  observationRef: { block: 1n, hash: '0x02' },
  policyRef: { version: 'live-wmon-usdc-monad-v6' },
} as unknown as Decision

function setup(run: (op: OpRecord, j: MemoryJournal) => Promise<void>) {
  const journal = new MemoryJournal()
  const engine = Object.assign(Object.create(Engine.prototype) as Engine, { journal, run: (op: OpRecord) => run(op, journal) })
  const op = journal.propose(journal.recordDecision(harvest), 'collect')
  const runOp = () => (engine as unknown as { runOp: (op: OpRecord, obs: unknown, d: Decision) => Promise<void> }).runOp(op, {}, harvest)
  return { journal, op, runOp }
}

describe('a throw before signing frees the slot (otto/mamoru#357)', () => {
  test('a timeout while proposed: the op is discarded with OBS_RPC_UNAVAILABLE, the error still reaches the caller', async () => {
    const { journal, op, runOp } = setup(async () => {
      throw new Error('The request took too long to respond.\nURL: https://rpc.monad.example')
    })
    await expect(runOp()).rejects.toThrow('The request took too long to respond.')
    expect(journal.live).toBeNull()
    expect(journal.op(op.opId).state).toBe('discarded')
    expect(journal.op(op.opId).stateCode).toBe('OBS_RPC_UNAVAILABLE')
    expect(journal.transitions.at(-1)?.detail).toBe('thrown before signing: The request took too long to respond.')
    // The next decision gets a slot.
    expect(() => journal.propose(journal.recordDecision({ ...harvest, decisionId: '0xd2' as const }), 'collect')).not.toThrow()
  })

  test('a timeout after the simulation (the pre-sign reads): discarded from simulated too', async () => {
    const { journal, op, runOp } = setup(async (o, j) => {
      j.move(o.opId, 'prepared', 'EHG_OK')
      j.move(o.opId, 'simulated', 'EHG_OK')
      throw new Error('timeout')
    })
    await expect(runOp()).rejects.toThrow('timeout')
    expect(journal.op(op.opId).state).toBe('discarded')
    expect(journal.live).toBeNull()
  })

  test('a throw after signing leaves the op where it is: reconciliation settles it', async () => {
    const { journal, op, runOp } = setup(async (o, j) => {
      j.move(o.opId, 'prepared', 'EHG_OK')
      j.move(o.opId, 'simulated', 'EHG_OK')
      j.move(o.opId, 'signed', 'OP_SIGNED')
      throw new Error('timeout')
    })
    await expect(runOp()).rejects.toThrow('timeout')
    expect(journal.op(op.opId).state).toBe('signed')
    expect(journal.live?.opId).toBe(op.opId)
  })
})

describe('thrownSummary (otto/mamoru#357)', () => {
  test('a viem timeout names the methods of its batch, never the URL', () => {
    const e = new TimeoutError({ body: [{ method: 'eth_call', params: [] }, { method: 'eth_simulateV1', params: [] }, { method: 'eth_call', params: [] }], url: 'https://monad-mainnet.g.alchemy.com/v2/secret' })
    expect(thrownSummary(e)).toBe('The request took too long to respond. (eth_call, eth_simulateV1)')
  })

  test('any other throw: its first line', () => {
    expect(thrownSummary(new Error('boom\nmore'))).toBe('boom')
    expect(thrownSummary('plain')).toBe('plain')
  })
})
