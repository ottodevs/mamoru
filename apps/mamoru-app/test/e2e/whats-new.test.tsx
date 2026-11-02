import { describe, expect, test } from 'bun:test'
import type { FundingView, WhatsNew } from '@mamoru/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { OpView } from '@mamoru/domain'
import { ApiContext, type ApiClient } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { cardGate, currentStepOf, gateNotice, preparedProblem, setWhatsNewDismissed, stepProgress, WhatsNewBody, WhatsNewFlow, WhatsNewRow, whatsNewDismissed, whatsNewOffered } from '../../src/web/components/whats-new.tsx'
import { renewAskFor } from '../../src/web/routes/home.tsx'
import { fixtureClient } from '../../src/web/fixtures/client.ts'
import { SUBMIT } from '../../src/web/lib/owner-flow.ts'
import { opLine } from '../../src/web/lib/ops.ts'
import { count, render } from './render.ts'

// otto/mamoru#295 part 2: the What's new screen (Brais, v4): one-line numbered points, the action first, the button right
// under it, every signed line behind "What you sign", counters only when two signatures are needed.

const NEW_SAFE = '0x9C1bE4d0aF53A8e6B27c1d0F4a3E85b7D6c92A10'
const one: WhatsNew = {
  policy: 'one-auth-v4',
  points: ['Growth also works on Monad', 'Safer price limits', 'Emergency pause. It never moves money.'],
  signatures: 1,
  currentStep: 0,
  steps: [{ chain: 'base', summary: ['Replace the approvals on your Safe', 'Nothing is moved'] }],
}
const two: WhatsNew = { ...one, signatures: 2, steps: [...one.steps, { chain: 'monad', summary: ['Replace the approvals on your Safe on Monad'], moveTo: NEW_SAFE }] }
const noop = () => {}
const body = (w: WhatsNew, step: number, over: { busy?: null | 'preparing' | 'signing'; error?: string | null } = {}) =>
  render(<WhatsNewBody whatsNew={w} step={step} summary={w.steps[step]!.summary} busy={over.busy ?? null} error={over.error ?? null} onApprove={noop} onLater={noop} onLearn={noop} />)

describe('the card', () => {
  test('eyebrow, title, numbered points, the reassurance, both buttons', () => {
    const { text } = body(one, 0)
    expect(text).toContain("What's new")
    expect(text).toContain('Mamoru got better')
    expect(text).toContain('01 Growth also works on Monad')
    expect(text).toContain('03 Emergency pause. It never moves money.')
    expect(text).toContain("If you don't accept, Mamoru keeps working as before. Learn more")
    expect(text).toContain('Not now')
    expect(text).toContain('Accept with passkey')
  })

  test('at most four points', () => {
    const { html } = body({ ...one, points: ['a', 'b', 'c', 'd', 'e'] }, 0)
    expect(count(html, 'text-emerald">0')).toBe(4)
  })

  test('the signed lines are behind "What you sign", closed, in order', () => {
    const { html, text } = body(one, 0)
    expect(html).toContain('<details')
    expect(html).not.toContain('<details open')
    expect(text).toContain('What you sign Replace the approvals on your Safe Nothing is moved')
  })

  test('the button comes after the lines and the error', () => {
    const { html } = body(one, 0, { error: 'Passkey closed. Nothing was signed.' })
    expect(html.indexOf('What you sign')).toBeLessThan(html.indexOf('Passkey closed'))
    expect(html.indexOf('Passkey closed')).toBeLessThan(html.indexOf('Accept with passkey'))
  })

  test('busy states label the button and disable it', () => {
    expect(body(one, 0, { busy: 'signing' }).text).toContain('Waiting for passkey')
    expect(body(one, 0, { busy: 'preparing' }).html).toContain('disabled')
  })
})

describe('one signature or two', () => {
  test('one signature: no counter and no "two taps"', () => {
    const { text } = body(one, 0)
    expect(text).not.toContain('Step ')
    expect(text).not.toContain('Two taps')
  })

  test('two signatures: said up front, then Base, then Monad, each with its own lines', () => {
    const a = body(two, 0).text
    expect(a).toContain('Two taps with your passkey')
    expect(a).toContain('Step 1 of 2 · Base')
    expect(a).toContain('Replace the approvals on your Safe Nothing is moved')
    const b = body(two, 1).text
    expect(b).toContain('Step 2 of 2 · Monad')
    expect(b).toContain('Replace the approvals on your Safe on Monad')
    expect(b).not.toContain('Nothing is moved')
  })
})

describe('the way back in', () => {
  test('the quiet row names the notice and offers Review', () => {
    expect(render(<WhatsNewRow onOpen={noop} />).text).toBe('Mamoru got better Review')
  })

  test('"Not now" holds for the session and can be undone', () => {
    expect(whatsNewDismissed('acct_x')).toBe(false)
    setWhatsNewDismissed('acct_x', true)
    expect(whatsNewDismissed('acct_x')).toBe(true)
    setWhatsNewDismissed('acct_x', false)
    expect(whatsNewDismissed('acct_x')).toBe(false)
  })
})

describe('one notice, not several', () => {
  const approval = (extra: Partial<NonNullable<FundingView['approval']>>) => ({ active: true, address: '0x1', approval: { validUntil: 1, renewDue: true, expired: false, ...extra } }) as unknown as FundingView
  test('a due renewal is asked for on arrival, unless What\'s new is offered', () => {
    expect(renewAskFor(approval({}), false)).not.toBeNull()
    expect(renewAskFor(approval({ whatsNew: one }), false)).toBeNull()
  })

  // Security review: What's new never overrides a safety state.
  test('paused: nothing is offered; ended and spent keep their own notice and ask', () => {
    expect(whatsNewOffered({ validUntil: 1, renewDue: false, expired: false, whatsNew: one }, false)).toEqual(one)
    expect(whatsNewOffered({ validUntil: 1, renewDue: false, expired: false, paused: true, whatsNew: one }, false)).toBeNull()
    expect(whatsNewOffered({ validUntil: 1, renewDue: true, expired: true, whatsNew: one }, false)).toBeNull()
    expect(whatsNewOffered({ validUntil: 1, renewDue: false, expired: false, usage: { action: 'enter', pool: null, usedBps: 10000, spent: true }, whatsNew: one }, false)).toBeNull()
    expect(renewAskFor(approval({ expired: true, whatsNew: one }), false)).not.toBeNull()
    expect(renewAskFor(approval({ renewDue: false, usage: { action: 'enter', pool: null, usedBps: 10000, spent: true }, whatsNew: one }), false)).not.toBeNull()
  })

  test('after "Not now" a due renewal is offered again, so declining never strands the account', () => {
    expect(whatsNewOffered({ validUntil: 1, renewDue: true, expired: false, whatsNew: one }, false)).toEqual(one)
    expect(whatsNewOffered({ validUntil: 1, renewDue: true, expired: false, whatsNew: one }, true)).toBeNull()
    expect(renewAskFor(approval({ whatsNew: one }), false, true)).not.toBeNull()
  })
})

describe('steps follow the operator and the confirmed op', () => {
  test('the step is the operator\'s currentStep, so a reload resumes it', () => {
    expect(currentStepOf({ ...two, currentStep: 0 })).toBe(0)
    expect(currentStepOf({ ...two, currentStep: 1 })).toBe(1)
    expect(currentStepOf({ ...two, currentStep: 7 })).toBe(1)
    expect(currentStepOf(one)).toBe(0)
  })

  test('a failed step is a retry at once; confirmed and everything else are not', () => {
    expect(stepProgress('failed')).toBe('failed')
    expect(stepProgress('confirmed')).toBe('confirmed')
    expect(stepProgress('submitted')).toBe('wait')
    expect(stepProgress('proposed')).toBe('wait')
    expect(stepProgress(undefined)).toBe('wait')
  })

  test('the card says it is waiting for confirmation and keeps the button off', () => {
    const { html, text } = render(<WhatsNewBody whatsNew={two} step={0} summary={[]} busy={null} waiting error={null} onApprove={noop} onLater={noop} onLearn={noop} />)
    expect(text).toContain('Waiting for confirmation')
    expect(html).toContain('disabled')
  })

  test('the fixtures offer step 2 of 2 with a destination', async () => {
    const s1 = await fixtureClient.migratePrepare('acct_fixture_01', 1)
    expect(s1.chainId).toBe(143)
  })
})

describe('the effect is said outside the disclosure', () => {
  test('a fixed scope line sits between the details and the button, never inside the list', () => {
    const { html, text } = body(one, 0)
    expect(text).toContain("This replaces Mamoru's approvals with one that does not expire. You are asked again only to withdraw or stop.")
    const scope = html.indexOf('whats-new-scope')
    expect(html.indexOf('</details>')).toBeLessThan(scope)
    expect(scope).toBeLessThan(html.indexOf('Accept with passkey'))
  })

  test('the Monad step also says where the funds go, the whole address, outside the disclosure', () => {
    const { html, text } = body(two, 1)
    expect(text).toContain('It moves your funds to your new Safe on Monad:')
    expect(text).toContain(NEW_SAFE)
    expect(html.indexOf('</details>')).toBeLessThan(html.indexOf(NEW_SAFE))
    expect(body(two, 0).text).not.toContain('It moves your funds')
  })
})

describe('the operator contract in the fixtures', () => {
  test('each step prepares its own lines; the Monad step is on Monad', async () => {
    const s0 = await fixtureClient.migratePrepare('acct_fixture_01', 0)
    expect(s0.summary.length).toBeGreaterThan(0)
    expect(s0.chainId).toBe(8453)
  })

  test('the op reads as a plain line in the history', () => {
    expect(opLine({ opId: 'own-1', kind: 'migrate-v4', state: 'confirmed', updatedAt: '' } as never)).toBe('Mamoru updated to one approval')
  })
})

const op = (state: OpView['state'], migrateStep?: number, kind: OpView['kind'] = 'migrate-v4'): OpView => ({ opId: `own-${kind}-${state}-${migrateStep}`, kind, state, migrateStep, updatedAt: '' }) as OpView

describe('the gate reads the ops list, as renewing does', () => {
  test('nothing is prepared before the ops are read', () => {
    expect(cardGate(0, undefined).gate).toBe('loading')
  })

  test('P1-1: a migrate-v4 op still running holds the card, whatever the step', () => {
    expect(cardGate(0, [op('submitted', 0)])).toMatchObject({ gate: 'inflight', inFlight: { opId: 'own-migrate-v4-submitted-0' } })
    expect(cardGate(0, [op('proposed')]).gate).toBe('inflight')
    expect(cardGate(0, [op('failed', 0)]).gate).toBe('ready')
    expect(cardGate(0, [op('submitted', 0, 'renew')]).gate).toBe('ready')
  })

  test('N1: a step whose op is confirmed is never offered again, whatever funding still says', () => {
    expect(cardGate(0, [op('confirmed', 0)]).gate).toBe('done')
    expect(cardGate(1, [op('confirmed', 0)]).gate).toBe('ready')
    expect(cardGate(1, [op('confirmed', 0), op('confirmed', 1)]).gate).toBe('done')
    expect(cardGate(0, [op('confirmed', 1)]).gate).toBe('done')
  })

  test('N2: ops that fail to load are an error state, not a spinner', () => {
    expect(cardGate(0, undefined, true).gate).toBe('error')
    expect(cardGate(0, undefined, false).gate).toBe('loading')
  })

  test('P1-2: step 1 needs step 0 confirmed in the ops, whatever currentStep says', () => {
    expect(cardGate(1, []).gate).toBe('previous')
    expect(cardGate(1, [op('failed', 0)]).gate).toBe('previous')
    expect(cardGate(1, [op('confirmed', 1)]).gate).toBe('done')
    expect(cardGate(1, [op('confirmed', 0)]).gate).toBe('ready')
    // An unlabelled op satisfies nothing.
    expect(cardGate(1, [op('confirmed')]).gate).toBe('previous')
    expect(cardGate(0, [op('confirmed')]).gate).toBe('ready')
    expect(cardGate(0, []).gate).toBe('ready')
  })
})

describe('P1-3: what is shown is what is signed', () => {
  type Prep = Parameters<typeof preparedProblem>[0]
  const tx = (over: object): NonNullable<Prep> => ({ step: 1, tx: { safe: '0x1', chainId: 143, safeTxHash: '0x2', summary: [], expiresAt: '', prepareId: 'p', moveTo: NEW_SAFE, ...over } }) as unknown as NonNullable<Prep>
  test('the right step, chain and destination pass', () => {
    expect(preparedProblem(tx({}), { ...two, currentStep: 1 }, 1)).toBeNull()
    expect(preparedProblem(tx({ moveTo: NEW_SAFE.toLowerCase() }), { ...two, currentStep: 1 }, 1)).toBeNull()
    expect(preparedProblem(null, two, 0)).toBeNull()
  })

  test('another chain, another destination, a missing or unannounced one, or another step: refused', () => {
    const w = { ...two, currentStep: 1 }
    expect(preparedProblem(tx({ chainId: 8453 }), w, 1)).toContain('does not match')
    expect(preparedProblem(tx({ moveTo: '0x0000000000000000000000000000000000000bad' }), w, 1)).toContain('does not match')
    // A step with nothing to move prepares no destination even if the offer named one: accepted; a different one is not.
    expect(preparedProblem(tx({ moveTo: undefined }), w, 1)).toBeNull()
    expect(preparedProblem(tx({ moveTo: '0x0000000000000000000000000000000000000bad' }), w, 1)).toContain('does not match')
    expect(preparedProblem(tx({}), { ...w, steps: [w.steps[0]!, { chain: 'monad', summary: [] }] }, 1)).toContain('does not match')
    expect(preparedProblem({ ...tx({}), step: 0 }, w, 1)).toContain('does not match')
    expect(preparedProblem({ step: 0, tx: { chainId: 8453, moveTo: NEW_SAFE } } as never, one, 0)).toContain('does not match')
  })
})

describe('WhatsNewFlow, first render', () => {
  const api = {} as ApiClient
  const flow = (w: WhatsNew, ops: OpView[] | undefined) => {
    const qc = new QueryClient()
    if (ops) qc.setQueryData([...queryKeys.ops('acct'), 'migrate-v4'], { ops })
    return render(
      <QueryClientProvider client={qc}>
        <ApiContext.Provider value={api}>
          <WhatsNewFlow accountKey="acct" whatsNew={w} onLater={noop} onLearn={noop} />
        </ApiContext.Provider>
      </QueryClientProvider>,
    )
  }
  const disabledAccept = (html: string) => /<button[^>]*disabled=""[^>]*>(?:Waiting for confirmation|Accept with passkey)</.test(html)

  test('ops not read yet, or a migrate-v4 op in flight: the button is off', () => {
    expect(disabledAccept(flow(one, undefined).html)).toBe(true)
    const inflight = flow(one, [op('submitted', 0)])
    expect(inflight.text).toContain('Waiting for confirmation')
    expect(flow(one, [op('confirmed', 0)]).text).toContain('Waiting for confirmation')
    expect(disabledAccept(inflight.html)).toBe(true)
  })

  test('N2: "Not now" is never off because of the gate', () => {
    const notNowOff = (html: string) => /<button[^>]*disabled=""[^>]*>Not now</.test(html)
    for (const [w, ops] of [[one, undefined], [one, [op('submitted', 0)]], [one, [op('confirmed', 0)]], [{ ...two, currentStep: 1 }, []]] as const) expect(notNowOff(flow(w, ops as OpView[] | undefined).html)).toBe(false)
    expect(notNowOff(render(<WhatsNewBody whatsNew={one} step={0} summary={[]} busy="signing" error={null} onApprove={noop} onLater={noop} onLearn={noop} />).html)).toBe(true)
  })

  test('N2: a gate that holds the button says why, with a retry when the status could not be read', () => {
    expect(gateNotice('previous', noop)).toEqual({ text: 'Waiting for the Base step to confirm.' })
    expect(gateNotice('error', noop)?.text).toBe("Couldn't check your account's status.")
    expect(gateNotice('error', noop)?.retry).toBe(noop)
    expect(gateNotice('ready', noop)).toBeUndefined()
    expect(flow({ ...two, currentStep: 1 }, []).text).toContain('Waiting for the Base step to confirm.')
    const err = render(<WhatsNewBody whatsNew={one} step={0} summary={[]} busy={null} off notice={gateNotice('error', noop)} error={null} onApprove={noop} onLater={noop} onLearn={noop} />)
    expect(err.text).toContain("Couldn't check your account's status. Try again")
  })

  test('step 2 with step 1 not confirmed: off and waiting; confirmed: on', () => {
    const w = { ...two, currentStep: 1 }
    expect(disabledAccept(flow(w, []).html)).toBe(true)
    const ready = flow(w, [op('confirmed', 0)])
    expect(ready.text).toContain('Step 2 of 2 · Monad')
    expect(ready.text).toContain(NEW_SAFE)
    expect(ready.text).not.toContain('Waiting for confirmation')
    expect(flow(one, []).html).not.toMatch(/<button[^>]*disabled=""[^>]*>Accept/)
  })
})

describe('the submit step reaches migrate-v4 only', () => {
  test('activate, transfer, stop and renew are called with exactly (accountKey, sig)', async () => {
    const calls: Record<string, unknown[]> = {}
    const rec = (name: string) => async (...args: unknown[]) => {
      calls[name] = args
      return {} as OpView
    }
    const api = { activate: rec('activate'), transfer: rec('transfer'), stop: rec('stop'), renew: rec('renew'), migrate: rec('migrate') } as unknown as ApiClient
    const sig = { prepareId: 'p' } as never
    for (const kind of ['activate', 'transfer', 'stop', 'renew'] as const) {
      await SUBMIT[kind](api)('k', sig, 1)
      expect(calls[kind]).toEqual(['k', sig])
    }
    await SUBMIT['migrate-v4'](api)('k', sig, 1)
    expect(calls.migrate).toEqual(['k', sig, 1])
  })
})

describe('step 1 with nothing to move', () => {
  test('the card says no funds move on Monad, and shows no destination', () => {
    const w = { ...two, currentStep: 1 }
    const { text } = render(<WhatsNewBody whatsNew={w} step={1} summary={[]} busy={null} shown={{ chain: 'monad', moveTo: undefined }} error={null} onApprove={noop} onLater={noop} onLearn={noop} />)
    expect(text).toContain('No funds to move on Monad: this step only replaces the approvals.')
    expect(text).not.toContain('It moves your funds')
    expect(text).not.toContain(NEW_SAFE)
  })

  test('with a destination it shows it in full, not the no-move line', () => {
    const { text } = render(<WhatsNewBody whatsNew={{ ...two, currentStep: 1 }} step={1} summary={[]} busy={null} shown={{ chain: 'monad', moveTo: NEW_SAFE }} error={null} onApprove={noop} onLater={noop} onLearn={noop} />)
    expect(text).toContain(NEW_SAFE)
    expect(text).not.toContain('No funds to move')
  })
})
