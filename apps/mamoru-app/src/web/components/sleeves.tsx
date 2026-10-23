import type { SleeveView } from '@mamoru/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../api/client.ts'
import { queryKeys, useFunding, usePools } from '../api/queries.ts'
import { sleeveChain } from '../lib/chain.tsx'
import { shortHex } from '../lib/format.ts'
import { cbbtcPrice, split, usd } from '../lib/money.ts'
import { errorText } from '../lib/owner-flow.ts'

export const sleeveCopy = {
  label: 'Sleeves',
  add: (chain: string) => `Add a ${chain} sleeve`,
  adding: 'Opening',
  addNote: (chain: string) => `Same passkey, same address, a separate balance on ${chain}. Nothing is moved.`,
}

/** One sleeve's total, from the same funding poll Home reads (shared cache by account key). */
function SleeveTotal({ accountKey }: { accountKey: string }) {
  const f = useFunding(accountKey, true).data
  const price = cbbtcPrice(usePools().data)
  return <span className="font-mono text-[0.78rem]">{f ? `${usd(split(f, price).total)} USDC` : '…'}</span>
}

/**
 * otto/mamoru#67: the owner's sleeves, one per chain, each with its chain, short address and total. Picking one
 * switches every screen below it to that sleeve. Renders nothing for an owner with only Base and nothing to add,
 * which is every owner while the `monad_sleeves` flag is off: Home is then exactly what it was.
 */
export function SleeveSwitch({ sleeves, addable, selected, onSelect }: { sleeves: SleeveView[]; addable: number[]; selected: string; onSelect: (accountKey: string) => void }) {
  const api = useApi()
  const qc = useQueryClient()
  const add = useMutation({
    mutationFn: (chainId: number) => api.addSleeve(chainId),
    onSuccess: async (s) => {
      await qc.invalidateQueries({ queryKey: queryKeys.session })
      onSelect(s.accountKey)
    },
  })
  if (sleeves.length <= 1 && addable.length === 0) return null
  return (
    <nav className="mb-6 grid gap-2" aria-label={sleeveCopy.label} data-testid="sleeves">
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {sleeves.map((s) => {
          const on = s.accountKey === selected
          return (
            <li key={s.accountKey}>
              <button
                type="button"
                aria-pressed={on}
                data-testid={`sleeve-${s.chainId}`}
                onClick={() => onSelect(s.accountKey)}
                className={`grid min-w-[10.5rem] cursor-pointer gap-[0.15rem] border px-3 py-2 text-left ${on ? 'border-ink bg-ink/[0.04] text-ink' : 'border-wash bg-transparent text-stone hover:border-stone'}`}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[0.95rem] font-bold tracking-[0.02em]">{sleeveChain(s.chainId).name}</span>
                  <SleeveTotal accountKey={s.accountKey} />
                </span>
                <span className="font-mono text-[0.72rem] text-stone" title={s.address}>
                  {shortHex(s.address)}
                </span>
              </button>
            </li>
          )
        })}
        {addable.map((chainId) => (
          <li key={chainId} className="flex items-center">
            <button type="button" className="chipbtn" data-testid={`add-sleeve-${chainId}`} disabled={add.isPending} onClick={() => add.mutate(chainId)}>
              {add.isPending ? sleeveCopy.adding : sleeveCopy.add(sleeveChain(chainId).name)}
            </button>
          </li>
        ))}
      </ul>
      {addable.length ? <p className="m-0 text-[0.8rem] text-stone">{sleeveCopy.addNote(sleeveChain(addable[0]).name)}</p> : null}
      {add.error ? <p className="err m-0">{errorText(add.error)}</p> : null}
    </nav>
  )
}
