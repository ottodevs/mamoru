// otto/mamoru#357: live 3 Nov (b54dda3a@143), a Monad RPC timeout threw out of a harvest before it was signed. The op
// stayed `proposed`, and every review after it held DECIDE_SLOT_BUSY until a restart. `runOp` is private: reached with a
// cast, like engine-vault.test.ts.
import { describe, expect, test } from 'bun:test'
import type { Decision } from '@mamoru/decide'
import { BaseError, ExecutionRevertedError, InternalRpcError, InvalidInputRpcError, ResourceUnavailableRpcError, RpcRequestError, TimeoutError } from 'viem'
import { Engine, isTransportError, repeatsDiscard, thrownSummary } from './engine.ts'
import { MemoryJournal, type OpRecord } from './journal.ts'

const timeout = () => new TimeoutError({ body: { method: 'eth_simulateV1', params: [] }, url: 'https://rpc.monad.example' })

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
      throw timeout()
    })
    await expect(runOp()).rejects.toThrow('The request took too long to respond.')
    expect(journal.live).toBeNull()
    expect(journal.op(op.opId).state).toBe('discarded')
    expect(journal.op(op.opId).stateCode).toBe('OBS_RPC_UNAVAILABLE')
    expect(journal.transitions.at(-1)?.detail).toBe('provider did not answer before signing: The request took too long to respond. (eth_simulateV1)')
    // The next decision gets a slot.
    expect(() => journal.propose(journal.recordDecision({ ...harvest, decisionId: '0xd2' as const }), 'collect')).not.toThrow()
  })

  test('a timeout after the simulation (the pre-sign reads): discarded from simulated too', async () => {
    const { journal, op, runOp } = setup(async (o, j) => {
      j.move(o.opId, 'prepared', 'EHG_OK')
      j.move(o.opId, 'simulated', 'EHG_OK')
      throw timeout()
    })
    await expect(runOp()).rejects.toThrow('took too long')
    expect(journal.op(op.opId).state).toBe('discarded')
    expect(journal.live).toBeNull()
  })

  test('a throw after signing leaves the op where it is: reconciliation settles it', async () => {
    const { journal, op, runOp } = setup(async (o, j) => {
      j.move(o.opId, 'prepared', 'EHG_OK')
      j.move(o.opId, 'simulated', 'EHG_OK')
      j.move(o.opId, 'signed', 'OP_SIGNED')
      throw timeout()
    })
    await expect(runOp()).rejects.toThrow('took too long')
    expect(journal.op(op.opId).state).toBe('signed')
    expect(journal.live?.opId).toBe(op.opId)
  })
})

describe('only a provider that did not answer frees the slot (review of #357)', () => {
  test('a bug (any other throw) keeps the op live: fail-stop, as before', async () => {
    const { journal, op, runOp } = setup(async () => {
      throw new TypeError('cannot read properties of undefined')
    })
    await expect(runOp()).rejects.toThrow(TypeError)
    expect(journal.live?.opId).toBe(op.opId)
    expect(journal.op(op.opId).state).toBe('proposed')
  })

  test('a timeout wrapped by a contract read (cause chain) is a provider error', async () => {
    const wrapped = new BaseError('ContractFunctionExecutionError', { cause: new BaseError('CallExecutionError', { cause: timeout() }) })
    expect(isTransportError(wrapped)).toBe(true)
    expect(thrownSummary(wrapped)).toContain('(eth_simulateV1)')
    const { journal, runOp } = setup(async () => {
      throw wrapped
    })
    await expect(runOp()).rejects.toBe(wrapped)
    expect(journal.live).toBeNull()
  })

  test('a provider that answers it failed (-32603, -32002) frees the slot; a revert or bad params do not (live 4 Nov)', async () => {
    const answered = (code: number, message: string) => new RpcRequestError({ body: { method: 'eth_call' }, error: { code, message }, url: 'https://rpc.monad.example' })
    expect(isTransportError(new InternalRpcError(answered(-32603, 'internal error')))).toBe(true)
    expect(isTransportError(new ResourceUnavailableRpcError(answered(-32002, 'unavailable')))).toBe(true)
    expect(isTransportError(answered(-32602, 'invalid params'))).toBe(false)
    expect(isTransportError(new BaseError('execution reverted'))).toBe(false)
    // Gate (Opus): a node that reports a revert as -32603. viem keeps the InternalRpcError as the cause.
    expect(isTransportError(new ExecutionRevertedError({ cause: new InternalRpcError(answered(-32603, 'execution reverted')) }))).toBe(false)
    const withData = new RpcRequestError({ body: { method: 'eth_call' }, error: { code: -32603, message: 'internal', data: '0x08c379a0' + '00'.repeat(4) }, url: 'https://rpc.monad.example' })
    expect(isTransportError(new InternalRpcError(withData))).toBe(false)
    const { journal, runOp } = setup(async () => {
      throw new InternalRpcError(answered(-32603, 'internal error'))
    })
    await expect(runOp()).rejects.toThrow('An internal error was received.')
    expect(journal.live).toBeNull()
  })

  test('a provider failure viem has no class for (bare RpcRequestError) frees the slot; a malformed request does not (live 11 Nov)', async () => {
    const getLogs = (code: number, message: string, data?: string) => new RpcRequestError({ body: { method: 'eth_getLogs' }, error: { code, message, ...(data ? { data } : {}) }, url: 'https://base.example' })
    expect(isTransportError(getLogs(429, 'compute units exceeded'))).toBe(true)
    expect(isTransportError(getLogs(-32050, 'backend failure'))).toBe(true)
    for (const code of [-32700, -32600, -32601, -32602]) expect(isTransportError(getLogs(code, 'bad request'))).toBe(false)
    // A class viem mapped decides by itself: an invalid input (-32000) stays a refusal.
    expect(isTransportError(new InvalidInputRpcError(getLogs(-32000, 'nonce too low')))).toBe(false)
    expect(isTransportError(getLogs(-32050, 'execution reverted'))).toBe(false)
    expect(isTransportError(getLogs(-32050, 'failed', '0x08c379a0'))).toBe(false)
    expect(thrownSummary(getLogs(429, 'compute units exceeded'))).toBe('RPC Request failed. (eth_getLogs, code 429)')
    const { journal, op, runOp } = setup(async () => {
      throw getLogs(429, 'compute units exceeded')
    })
    await expect(runOp()).rejects.toThrow('RPC Request failed.')
    expect(journal.op(op.opId).state).toBe('discarded')
    expect(journal.live).toBeNull()
  })

  test('a discard that fails never hides the provider error', async () => {
    const { journal, runOp } = setup(async () => {
      throw timeout()
    })
    journal.discardUnsigned = () => {
      throw new Error('journal broke')
    }
    await expect(runOp()).rejects.toThrow('took too long')
  })
})

describe('a proposal discarded for a provider failure is proposed again (otto/mamoru#392)', () => {
  test('the same premise after a provider discard is retried; after any other discard it waits for a new premise', async () => {
    const { journal, op, runOp } = setup(async () => {
      throw timeout()
    })
    await expect(runOp()).rejects.toThrow('took too long')
    const discarded = journal.lastDiscarded()!
    expect(discarded.opId).toBe(op.opId)
    expect(repeatsDiscard(discarded, harvest.premiseHash)).toBe(false)
    expect(repeatsDiscard({ premiseHash: harvest.premiseHash, stateCode: 'EHG_SWAP_IMPACT_OVER_LIMIT' }, harvest.premiseHash)).toBe(true)
    expect(repeatsDiscard({ premiseHash: harvest.premiseHash, stateCode: 'EHG_SWAP_IMPACT_OVER_LIMIT' }, '0x02')).toBe(false)
    expect(repeatsDiscard(undefined, harvest.premiseHash)).toBe(false)
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

  test('never throws itself (PR #268 gate): a throwing getter, a revoked Proxy, a value without toString', () => {
    const r = Proxy.revocable({}, {})
    r.revoke()
    for (const odd of [{ get message() { throw new Error('getter') } }, r.proxy, Object.create(null)]) expect(thrownSummary(odd)).toBe('an unreadable thrown value')
  })
})
