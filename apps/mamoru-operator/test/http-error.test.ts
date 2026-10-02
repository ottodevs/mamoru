import { describe, expect, test } from 'bun:test'
import { HttpError, safeHttpError } from '../src/operator.ts'

describe('safeHttpError', () => {
  // safeHttpError takes no message argument at all, so a call site cannot pass a raw exception/RPC string for
  // one of these codes even by mistake: TypeScript only accepts one of the fixed SAFE_ERROR_MESSAGE keys below,
  // and the message is always the table's own text.
  test('always returns the closed-table message for the given code', () => {
    expect(safeHttpError(400, 'ACCOUNT_MISMATCH')).toMatchObject({ status: 400, code: 'ACCOUNT_MISMATCH', message: 'accountKey is bound to another Safe' })
    expect(safeHttpError(503, 'SIMULATION_UNAVAILABLE').message).toBe('the operator could not simulate this transaction right now; try again shortly')
    expect(safeHttpError(400, 'BAD_SIGNATURE').message).toBe('the signature could not be verified')
    expect(safeHttpError(500, 'OPERATOR_ERROR').message).toBe('the operator hit an unexpected error handling this request')
    expect(safeHttpError(503, 'OWNER_CHECK_UNAVAILABLE').message).toBe('the signature could not be checked right now; try again in a moment')
    expect(safeHttpError(429, 'OWNER_FAILURE_BUDGET').message).toContain('activations of this account failed in 24 hours')
  })
})

describe('HttpError', () => {
  // HttpError itself stores whatever message it is given: the guarantee that a table code never leaks a raw
  // exception/RPC message lives in `safeHttpError` (which cannot be called with anything but the fixed table
  // text, by construction) and in the audit of every `new HttpError(...)` call site in operator.ts, not in the
  // constructor — because some codes legitimately carry more than one distinct, equally safe, operator-authored
  // message depending on which call site threw them (e.g. BAD_SIGNATURE on a proven chain revert), and a
  // constructor-level override by code would silently clobber those too.
  test('stores exactly the message it is constructed with', () => {
    const e = new HttpError(400, 'ACCOUNT_MISMATCH', 'accountKey is bound to another Safe')
    expect(e.message).toBe('accountKey is bound to another Safe')
    expect(e.status).toBe(400)
    expect(e.code).toBe('ACCOUNT_MISMATCH')
  })

  test('a code outside the safe-message table keeps its own (operator-authored) message', () => {
    const e = new HttpError(409, 'CAP_EXCEEDED', 'the Safe holds 123.45 USDC, cap is 100.00 USDC')
    expect(e.message).toBe('the Safe holds 123.45 USDC, cap is 100.00 USDC')
  })

  test('a code with more than one safe message keeps each one distinct (BAD_SIGNATURE)', () => {
    expect(new HttpError(400, 'BAD_SIGNATURE', 'the signature could not be verified').message).toBe('the signature could not be verified')
    expect(new HttpError(400, 'BAD_SIGNATURE', 'the passkey signature does not match this account and transaction').message).toBe(
      'the passkey signature does not match this account and transaction',
    )
  })
})
