// otto/mamoru#412: live 13 Nov on Monad, the relayer at 0.07 MON: every harvest of seven accounts was refused at the send
// ("Signer had insufficient balance") and settled RECON_UNINCLUDABLE. relayerShortNow is what the engines ask before an
// op opens. Reached through the prototype with a stub client, like monad-writes.test.ts.
import { describe, expect, test } from 'bun:test'
import { Operator } from '../src/operator.ts'

function operator(balance: () => bigint, gasPrice: () => bigint) {
  let reads = 0
  const op = Object.assign(Object.create(Operator.prototype), {
    cfg: { chainId: 143 },
    relayer: { address: '0xE41175b9CEBD25b9F45B745C922002BC052B5C88' },
    relayerBalanceCache: null,
    relayerGasPriceCache: null,
    relayerShortLoggedAt: Date.now(),
    client: {
      getBalance: async () => (reads++, balance()),
      getGasPrice: async () => (reads++, gasPrice()),
    },
  }) as Operator
  return { op, reads: () => reads }
}

describe('the relayer check before an engine op (otto/mamoru#412)', () => {
  test('under one bundle at the gas price: a reason naming the relayer and the chain', async () => {
    const { op } = operator(() => 74_736_754_138_936_107n, () => 102_000_000_000n)
    const why = await op.relayerShortNow()
    expect(why).toContain('0xE41175b9CEBD25b9F45B745C922002BC052B5C88')
    expect(why).toContain('chain 143')
    expect(why).toContain('engine ops wait')
  })

  test('enough for one bundle (2M gas): null', async () => {
    const { op } = operator(() => 2_000_000n * 102_000_000_000n, () => 102_000_000_000n)
    expect(await op.relayerShortNow()).toBeNull()
  })

  test('balance and gas price are cached: many reviews in a minute read each once', async () => {
    const { op, reads } = operator(() => 1n, () => 1_000n)
    for (let i = 0; i < 5; i++) await op.relayerShortNow()
    expect(reads()).toBe(2)
  })

  test('a read that fails throws (the engine then lets the op go)', async () => {
    const { op } = operator(() => {
      throw new Error('timeout')
    }, () => 1n)
    await expect(op.relayerShortNow()).rejects.toThrow('timeout')
  })
})
