import { describe, expect, test } from 'bun:test'
import { unitEnvironment, unitTarget } from './operator.ts'

const HOME = '/home/otto'
const DEFAULT_ENV = `${HOME}/.config/mamoru-operator/env`
const files: Record<string, string> = {
  [DEFAULT_ENV]: 'OPERATOR_SECRET=x\nMAMORU_LIVE=1\n',
  [`${HOME}/.config/mamoru-operator-monad/env`]: 'OPERATOR_SECRET=x\nPORT=8788\n',
}
const facts = (workingDirectory: string, environment: string) => ({ workingDirectory, environment, envFileText: (p: string) => files[p] ?? null, realpath: (p: string) => p.replace(/^~/, HOME) })
const BASE = facts(`${HOME}/.local/share/mamoru-operator/current`, 'MAMORU_LIVE=1')
const MONAD = facts(`${HOME}/.cursor/worktrees/mamoru/op-monad`, `MAMORU_OPERATOR_ENV=${HOME}/.config/mamoru-operator-monad/env MAMORU_OPERATOR_STATE_DIR=${HOME}/.local/state/mamoru-operator-monad`)

describe('unitTarget (otto/mamoru#241)', () => {
  test('the Base unit: its dir, the default env file, port 8787', () => {
    expect(unitTarget('mamoru-operator', BASE, {}, DEFAULT_ENV)).toEqual({ dir: `${HOME}/.local/share/mamoru-operator/current`, envFile: DEFAULT_ENV, metricsUrl: 'http://127.0.0.1:8787/metrics' })
  })

  test('naming only the Monad unit gives the Monad dir, env and port: never the Base operator', () => {
    expect(unitTarget('mamoru-operator-monad', MONAD, {}, DEFAULT_ENV)).toEqual({ dir: `${HOME}/.cursor/worktrees/mamoru/op-monad`, envFile: `${HOME}/.config/mamoru-operator-monad/env`, metricsUrl: 'http://127.0.0.1:8788/metrics' })
  })

  test('overrides that agree are accepted (the 27-oct four-variable form still works)', () => {
    const t = unitTarget('mamoru-operator-monad', MONAD, { dir: '~/.cursor/worktrees/mamoru/op-monad', envFile: `${HOME}/.config/mamoru-operator-monad/env`, metricsUrl: 'http://127.0.0.1:8788/metrics/' }, DEFAULT_ENV)
    expect(typeof t).toBe('object')
  })

  test('an override that names another operator is refused', () => {
    expect(unitTarget('mamoru-operator-monad', MONAD, { dir: `${HOME}/.local/share/mamoru-operator/current` }, DEFAULT_ENV)).toContain('is not unit mamoru-operator-monad')
    expect(unitTarget('mamoru-operator-monad', MONAD, { envFile: DEFAULT_ENV }, DEFAULT_ENV)).toContain('env file')
    expect(unitTarget('mamoru-operator-monad', MONAD, { metricsUrl: 'http://127.0.0.1:8787/metrics' }, DEFAULT_ENV)).toContain('PORT')
  })

  test('a unit that is not installed, or whose env file is unreadable, is refused', () => {
    expect(unitTarget('nope', facts('', ''), {}, DEFAULT_ENV)).toContain('no WorkingDirectory')
    expect(unitTarget('x', facts('/d', 'MAMORU_OPERATOR_ENV=/missing'), {}, DEFAULT_ENV)).toContain('not readable')
  })

  test('Environment= values, quoted or not', () => {
    expect(unitEnvironment('A=1 B="two words" C=')).toEqual({ A: '1', B: 'two words', C: '' })
  })
})
