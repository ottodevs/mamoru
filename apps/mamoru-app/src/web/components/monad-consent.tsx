import type { PolicyVersion } from '@mamoru/policy'
import { sleeveChain } from '../lib/chain.tsx'
import { KNOWN_POLICIES as KNOWN, isMultichainTarget } from '../lib/policies.ts'
import { pairLabel } from '../lib/positions.ts'
import { ApprovalBody, ApprovalDialog } from './approval-dialog.tsx'
import { detectLocale, type Locale } from '../lib/price-divergence.ts'

export { isMultichainTarget }

/**
 * The mix before and after, from the two policies themselves (never a number typed here): every pool of either, its
 * chain, its share of the whole account. A pool the target drops shows as closed; one it adds shows from a dash.
 */
export function splitRows(fromId: string, toId: string): SplitRow[] {
  const from = KNOWN[fromId]
  const to = KNOWN[toId]
  if (!from || !to) return []
  type Share = { pool: string; chainId: number; bps: number }
  const shares = (p: PolicyVersion): Share[] => {
    const total = p.buckets.reduce((s, b) => s + b.preference, 0) + (p.remoteBuckets ?? []).reduce((s, b) => s + b.preference, 0)
    // A bucket at preference 0 is one being left (v6's USDC/cbBTC): not part of that mix.
    // otto/mamoru#210: a vault bucket (v7's Stable) shows as one row, its lending.
    const local = p.buckets.filter((b) => (b.pools[0] || b.vaults?.[0]) && b.preference > 0).map((b) => ({ pool: b.pools[0] ?? b.vaults![0]!, chainId: 8453, bps: Math.round((b.preference * 10_000) / total) }))
    const remote = (p.remoteBuckets ?? []).map((b) => ({ pool: b.pools[0]!, chainId: b.chainId as number, bps: Math.round((b.preference * 10_000) / total) }))
    return [...local, ...remote]
  }
  const before = shares(from)
  const after = shares(to)
  const keys = [...new Set([...before, ...after].map((x) => `${x.chainId}|${x.pool}`))]
  return keys
    .map((k) => {
      const [chainId, pool] = [Number(k.split('|')[0]), k.split('|')[1]!]
      const was = before.find((x) => x.chainId === chainId && x.pool === pool)
      const will = after.find((x) => x.chainId === chainId && x.pool === pool)
      return { pool: pool.startsWith('vault:') ? 'USDC lending' : pairLabel(pool), chain: sleeveChain(chainId).name, fromBps: was ? was.bps : null, toBps: will ? will.bps : 0 }
    })
    .sort((a, b) => b.toBps - a.toBps || (b.fromBps ?? 0) - (a.fromBps ?? 0))
}

/**
 * otto/mamoru#201, #251: an account that runs on Base is asked, once, to let Mamoru also work on Monad. One screen says
 * what changes in the mix and what does not, and one passkey signature approves all of it: the new mix on Base, the
 * move of the Monad share, and the Monad pool, in a Safe of the owner's own that Mamoru creates there.
 */
const copies = {
  en: {
    title: 'Mamoru now works on Monad too',
    lead: (pool: string, chain: string, pct: string) => `Your savings get a third home: a ${pool} pool on ${chain}. If you approve, Mamoru moves ${pct} there and rebalances the rest to the new mix below; a pool marked closed is unwound into the others.`,
    split: 'Your mix',
    now: 'Now',
    after: 'After',
    leaving: 'closed',
    points: [
      { title: 'Your own Safe on Monad', body: 'Mamoru creates it for you, owned by the same passkey. Only you can withdraw, on either chain.' },
      { title: 'Step by step, inside limits', body: 'Mamoru closes and opens positions gradually, within the limits you sign. Nothing moves until you approve.' },
      { title: 'One signature', body: 'This one approval covers the new mix on Base, the move to Monad and the pool there. Nothing else to sign.' },
    ],
    at: (pool: string, chain: string) => `${pool} on ${chain}`,
  },
  es: {
    title: 'Mamoru ahora también trabaja en Monad',
    lead: (pool: string, chain: string, pct: string) => `Tus ahorros tienen un tercer sitio: un pool ${pool} en ${chain}. Si apruebas, Mamoru mueve allí el ${pct} y reparte el resto según la nueva mezcla de abajo; un pool marcado como cerrado se deshace en los demás.`,
    split: 'Tu mezcla',
    now: 'Ahora',
    after: 'Después',
    leaving: 'cerrado',
    points: [
      { title: 'Tu propia Safe en Monad', body: 'Mamoru la crea para ti, con la misma passkey como dueña. Solo tú puedes retirar, en cualquiera de las dos redes.' },
      { title: 'Paso a paso, dentro de límites', body: 'Mamoru cierra y abre posiciones poco a poco, dentro de los límites que firmas. No se mueve nada hasta que apruebes.' },
      { title: 'Una sola firma', body: 'Esta aprobación cubre la nueva mezcla en Base, el paso a Monad y el pool de allí. No hay nada más que firmar.' },
    ],
    at: (pool: string, chain: string) => `${pool} en ${chain}`,
  },
  ja: {
    title: 'Mamoru は Monad でも動くようになりました',
    lead: (pool: string, chain: string, pct: string) => `貯蓄の置き場所が 3 つ目に増えます：${chain} 上の ${pool} プールです。承認すると、Mamoru は ${pct} をそこへ移し、残りを下の新しい配分に組み直します。「終了」のプールは他のプールへ解消されます。`,
    split: 'あなたの配分',
    now: '現在',
    after: '変更後',
    leaving: '終了',
    points: [
      { title: 'Monad 上のあなた自身の Safe', body: 'Mamoru があなたのために作成し、所有者は同じパスキーです。引き出せるのはあなただけで、どちらのチェーンでも可能です。' },
      { title: '上限の内側で少しずつ', body: 'Mamoru はあなたが署名した上限の内側で、ポジションを少しずつ閉じたり開いたりします。承認するまで何も動きません。' },
      { title: '署名は 1 回だけ', body: 'この 1 つの承認で、Base の新しい配分、Monad への移動、そこでのプールをすべてカバーします。他に署名するものはありません。' },
    ],
    at: (pool: string, chain: string) => `${chain} の ${pool}`,
  },
} satisfies Record<Locale, unknown>

/** The English copy, as before: tests and other modules read the labels from here. */
export const monadCopy = copies.en
const copyOf = (locale: Locale): typeof monadCopy => copies[locale] as typeof monadCopy


/** One row of the before/after mix: a pool on a chain and its share of the account, in basis points. */
export type SplitRow = { pool: string; chain: string; fromBps: number | null; toBps: number }

const pct = (bps: number) => `${Math.round(bps / 100)}%`

export function SplitTable({ rows, locale = detectLocale() }: { rows: SplitRow[]; locale?: Locale }) {
  const monadCopy = copyOf(locale)
  return (
    <table className="split" data-testid="monad-split">
      <caption className="split-caption">{monadCopy.split}</caption>
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Pool</span>
          </th>
          <th scope="col">{monadCopy.now}</th>
          <th scope="col">{monadCopy.after}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const change = r.fromBps !== r.toBps
          return (
            <tr key={`${r.chain}:${r.pool}`} className={change ? 'split-change' : undefined}>
              <th scope="row">
                <span className="split-pool">{r.pool}</span>
                <span className="split-chain">{r.chain}</span>
              </th>
              <td>{r.fromBps === null ? '—' : pct(r.fromBps)}</td>
              <td>{r.toBps === 0 ? <span className="split-leaving">{monadCopy.leaving}</span> : pct(r.toBps)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Points({ locale }: { locale: Locale }) {
  const monadCopy = copyOf(locale)
  return (
    <ul className="approve-points" aria-label="In short">
      {monadCopy.points.map((p, i) => (
        <li key={p.title}>
          <span className="approve-icon" aria-hidden="true">
            {i + 1}
          </span>
          <span>
            <span className="approve-point-title">{p.title}</span>
            <span className="approve-point-body">{p.body}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The pool opening on another chain and its share, read from the rows (never typed). */
export function remoteOf(rows: SplitRow[]): SplitRow | undefined {
  return rows.find((r) => r.fromBps === null && r.toBps > 0 && r.chain !== 'Base')
}

/** "50% USDC / USDT on Base, 35% USDC / WETH on Base, 15% USDC / WMON on Monad", from the rows. */
export function mixLine(rows: SplitRow[], locale: Locale = 'en'): string {
  const at = copyOf(locale).at
  return rows.filter((r) => r.toBps > 0).map((r) => `${pct(r.toBps)} ${at(r.pool, r.chain)}`).join(locale === 'ja' ? '、' : ', ')
}

export type MonadFlow = {
  busy: string | null
  error: string | null
  summary: string[] | null
  prepare: () => void
  approve: () => void
}

/**
 * The whole dialog, one screen: what changes (lead, mix, the three points), then the approval itself, the same owner flow
 * every other approval uses (its signed lines name the Monad Safe's address), and one passkey tap.
 */
export function MonadConsentDialog({ open, rows, flow, onClose, locale = detectLocale() }: { open: boolean; rows: SplitRow[]; flow: MonadFlow; onClose: () => void; locale?: Locale }) {
  const remote = remoteOf(rows)
  const monadCopy = copyOf(locale)
  return (
    <ApprovalDialog title={monadCopy.title} open={open} onClose={onClose}>
      <div data-testid="monad-intro">
        <ApprovalBody
          lead={remote ? monadCopy.lead(remote.pool, remote.chain, pct(remote.toBps)) : mixLine(rows, locale)}
          context={<SplitTable rows={rows} locale={locale} />}
          points={<Points locale={locale} />}
          locale={locale}
          summary={flow.summary}
          busy={flow.busy}
          error={flow.error}
          onPrepare={flow.prepare}
          onApprove={flow.approve}
          onLater={onClose}
        />
      </div>
    </ApprovalDialog>
  )
}
