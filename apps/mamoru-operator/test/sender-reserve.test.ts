import { describe, expect, test } from 'bun:test'
import { SENDER_RESERVE_WEI } from '../src/operator'

// Monad's protocol reserve (docs.monad.xyz/developer-essentials/reserve-balance): a value transfer that leaves the
// sender under 10 MON reverts and still pays gas, so the relayer must keep it on top of an activation's cost.
describe('relayer reserve per chain', () => {
  test('Monad keeps 10 MON; Base has none', () => {
    expect(SENDER_RESERVE_WEI[143]).toBe(10n * 10n ** 18n)
    expect(SENDER_RESERVE_WEI[8453]).toBeUndefined()
  })
})
