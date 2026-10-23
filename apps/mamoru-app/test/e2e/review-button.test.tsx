import { describe, expect, test } from 'bun:test'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { Review } from '../../src/web/routes/home.tsx'

// otto/mamoru#155 (security review on 1c54819): `approve(accept?)` now takes an optional argument. If Review's
// buttons ever called their handlers as `onClick={onApprove}` (passing the click SyntheticEvent straight
// through) instead of `onClick={() => onApprove()}`, a future caller that forwards `flow.approve` unwrapped
// would leak that event into the submit body. These tests call Review directly as a plain function (it uses no
// hooks) and invoke the button elements' own onClick from the returned element tree, with no DOM and no
// renderer involved, to prove the wiring never forwards its argument.

type ButtonEl = ReactElement<{ onClick?: (e?: unknown) => void }>

function findButtons(node: ReactNode, found: ButtonEl[] = []): ButtonEl[] {
  const items: ReactNode[] = Array.isArray(node) ? node : [node]
  for (const child of items) {
    if (!isValidElement(child)) continue
    if (child.type === 'button') found.push(child as ButtonEl)
    const kids = (child.props as { children?: ReactNode }).children
    if (kids !== undefined) findButtons(kids, found)
  }
  return found
}

const fakeEvent = { type: 'click', target: {}, nativeEvent: {}, preventDefault: () => {}, stopPropagation: () => {} }

describe('Review: its buttons never forward their click argument to the handler props', () => {
  test('single-button mode (every caller but WithdrawDialog-with-a-warning): onApprove() is called with nothing', () => {
    let calls: unknown[][] = []
    const onApprove = (...args: unknown[]) => {
      calls.push(args)
    }
    const el = Review({ scope: 's', lines: ['a line'], busy: null, error: null, onApprove })
    const buttons = findButtons(el)
    expect(buttons).toHaveLength(1)
    buttons[0]!.props.onClick?.(fakeEvent)
    expect(calls).toEqual([[]])
  })
  test('two-button mode (WithdrawDialog with a divergence warning): neither onCancel() nor onApprove() receives the event', () => {
    const approveCalls: unknown[][] = []
    const cancelCalls: unknown[][] = []
    const onApprove = (...args: unknown[]) => approveCalls.push(args)
    const onCancel = (...args: unknown[]) => cancelCalls.push(args)
    const el = Review({ scope: 's', lines: [], busy: null, error: null, onApprove, onCancel, cancelLabel: 'Wait', confirmLabel: 'Withdraw anyway' })
    const buttons = findButtons(el)
    expect(buttons).toHaveLength(2)
    buttons[0]!.props.onClick?.(fakeEvent) // Wait
    buttons[1]!.props.onClick?.(fakeEvent) // Withdraw anyway
    expect(cancelCalls).toEqual([[]])
    expect(approveCalls).toEqual([[]])
  })
})
