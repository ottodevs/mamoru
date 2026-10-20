import { describe, expect, test } from 'bun:test'
import { calibratedGasModel, fitPrefixBySimulation, V4_TX_GAS_TARGET } from './v4-grants.ts'

// otto/mamoru#151: one owner transaction of an approval takes as many whole sessions as its SIMULATED gas allows under
// V4_TX_GAS_TARGET (14.5M, ~2.2M under 2^24); the 590k-per-action model only seeds the search.
const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
const actions = [3, 3, 9, 3, 3, 9, 3, 3, 9] // v5: enter-swap, enter-mint, manage-any per pool
const perAction = 560_000n
const overhead = 1_900_000n // nine revokes and an attestation
function simulator(per = perAction, over = overhead) {
  const asked: number[] = []
  const simulate = async (ks: string[]) => {
    asked.push(ks.length)
    return over + per * BigInt(ks.reduce((n, k) => n + actions[keys.indexOf(k)]!, 0))
  }
  return { asked, simulate }
}

describe('fitPrefixBySimulation', () => {
  test('grows past a cautious guess while the simulation stays under the target', async () => {
    const s = simulator()
    const r = await fitPrefixBySimulation(keys, 4, s.simulate)
    // 21 actions = 13.66M fits; 30 actions = 18.7M does not.
    expect(r).toEqual({ n: 5, gas: overhead + perAction * 21n, simulated: true })
    expect(r.gas! <= V4_TX_GAS_TARGET).toBe(true)
    expect(s.asked).toEqual([4, 5, 6])
  })

  test('shrinks an optimistic guess until the simulation fits', async () => {
    const s = simulator()
    const r = await fitPrefixBySimulation(keys, 7, s.simulate)
    expect(r.n).toBe(5)
    expect(s.asked).toEqual([7, 6, 5])
  })

  test('the rest of the v5 move: 24 actions without revokes fit one more transaction (two in all)', async () => {
    const rest = keys.slice(5)
    const s = { simulate: async (ks: string[]) => 150_000n + perAction * BigInt(ks.reduce((n, k) => n + actions[keys.indexOf(k)]!, 0)) }
    expect((await fitPrefixBySimulation(rest, 1, s.simulate)).n).toBe(4)
  })

  test('falls back to three when the simulation says the rest does not fit', async () => {
    const heavy = { simulate: async (ks: string[]) => 150_000n + 640_000n * BigInt(ks.reduce((n, k) => n + actions[keys.indexOf(k)]!, 0)) }
    expect((await fitPrefixBySimulation(keys.slice(5), 4, heavy.simulate)).n).toBe(3) // 24 x 640k = 15.5M > 14.5M
  })

  test('not simulable: the static guess stands, nothing grown', async () => {
    expect(await fitPrefixBySimulation(keys, 4, async () => null)).toEqual({ n: 4, gas: null, simulated: false })
  })

  test('not even one session fits: n 0', async () => {
    expect((await fitPrefixBySimulation(keys, 2, async () => 20_000_000n)).n).toBe(0)
  })

  test('calibratedGasModel: gas less overhead per action, rounded up', () => {
    expect(calibratedGasModel(overhead + perAction * 21n, overhead, 21).perActionGas).toBe(perAction)
    expect(calibratedGasModel(overhead + perAction * 21n + 1n, overhead, 21).perActionGas).toBe(perAction + 1n)
  })
})
