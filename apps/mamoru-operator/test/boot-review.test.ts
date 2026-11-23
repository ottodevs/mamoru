// otto/mamoru#454: at boot every engine reviewed at once; a provider's -32603 on that first review left it a REVIEW_ERROR
// until the next review period (5 min on Monad), past the redeploy's 4 min watch, which read it as unverified.
import { describe, expect, test } from 'bun:test'
import { CallExecutionError, ContractFunctionExecutionError, HttpRequestError, InternalRpcError, LimitExceededRpcError, ResourceUnavailableRpcError, RpcRequestError, TimeoutError, ExecutionRevertedError, InvalidParamsRpcError } from 'viem'
import { BOOT_REVIEW_SPREAD_MS, bootReviewDelay, quickRetry, transientRpcError } from '../src/operator.ts'

const rpc = (code: number, message = 'x') => new RpcRequestError({ body: {}, error: { code, message }, url: 'http://127.0.0.1:1' })
const wrapped = (cause: Error) => new ContractFunctionExecutionError(new CallExecutionError(cause as never, {} as never) as never, { abi: [], functionName: 'f' } as never)

describe('transientRpcError: a provider blip, never a revert or a bug', () => {
  test("viem's transient errors, wrapped as an eth_call failure is", () => {
    for (const e of [new InternalRpcError(rpc(-32603)), new LimitExceededRpcError(rpc(-32005)), new ResourceUnavailableRpcError(rpc(-32002)), new HttpRequestError({ url: 'u', status: 429 }), new TimeoutError({ body: {}, url: 'u' })]) {
      expect(transientRpcError(e)).toBe(true)
      expect(transientRpcError(wrapped(e))).toBe(true)
    }
  })
  test('a revert, invalid params, an HTTP 500 without a code, a plain bug: not transient', () => {
    for (const e of [new ExecutionRevertedError({ message: 'execution reverted' }), new InvalidParamsRpcError(rpc(-32602)), new HttpRequestError({ url: 'u', status: 500 }), new TypeError("Cannot read properties of undefined (reading 'x')"), 'a string', null, undefined]) {
      expect(transientRpcError(e)).toBe(false)
      if (e instanceof Error) expect(transientRpcError(wrapped(e))).toBe(false)
    }
  })
})

test('quickRetry: one quick follow-up per streak; the next review that decides resets it', () => {
  const runner: { transientRetried?: boolean } = {}
  const blip = new InternalRpcError(rpc(-32603))
  expect(quickRetry(new TypeError('bug'), runner)).toBe(false)
  expect(quickRetry(blip, runner)).toBe(true)
  expect(quickRetry(blip, runner)).toBe(false) // the provider keeps failing: back to the review period
  runner.transientRetried = false // a review decided
  expect(quickRetry(blip, runner)).toBe(true)
})

test('bootReviewDelay: first reviews spread evenly over min(BOOT_REVIEW_SPREAD_MS, reviewMs)', () => {
  expect(bootReviewDelay(0, 1, 300_000)).toBe(0)
  const monad = Array.from({ length: 14 }, (_, i) => bootReviewDelay(i, 14, 300_000))
  expect(monad[0]).toBe(0)
  expect(Math.max(...monad)).toBeLessThan(BOOT_REVIEW_SPREAD_MS)
  expect(new Set(monad).size).toBe(14)
  // A review period shorter than the spread bounds it (tests and e2e run at 1-2 s).
  expect(Math.max(...Array.from({ length: 4 }, (_, i) => bootReviewDelay(i, 4, 2_000)))).toBeLessThan(2_000)
})
