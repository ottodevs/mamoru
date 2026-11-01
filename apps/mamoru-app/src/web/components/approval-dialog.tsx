import { Fragment, type ReactNode } from 'react'
import { detectLocale, type Locale } from '../lib/price-divergence.ts'
import { readApproval, type ApprovalRead, type Change, type ChangeKind } from '../lib/approval-read.ts'
import { Modal } from './ui.tsx'

/**
 * otto/mamoru#176, #225: one dialog for every approval of a running account (a renewal, a move to another policy, the
 * grants an activation left out). The passkey signs the operator's own lines (`summary`), word for word (#41). This
 * dialog lays them out by meaning (lib/approval-read.ts): what changes, the limits per pool, the bridge, the fee, the
 * promises. Every signed line is in that view, either read (each of its figures shown) or word for word when no reader
 * knows it; the exact text, in its order, is one tap away under the brief.
 */
const copy = {
  en: {
    points: [
      { title: 'Nothing moves now', body: 'Your money stays in your Safe, where it is.' },
      { title: 'Only inside fixed limits', body: 'Every limit is listed below. Mamoru cannot go past them.' },
      { title: 'Paid only to your Safe', body: 'Whatever Mamoru collects or swaps comes back to you. Stop or withdraw any time.' },
    ],
    review: 'Review',
    preparing: 'Preparing',
    approve: 'Approve with passkey',
    signing: 'Waiting for passkey',
    later: 'Not now',
    validFor: 'Valid for',
    days: 'days',
    sizedFor: 'Sized for up to',
    pools: 'Pools',
    oneSignature: 'One passkey signature',
    changes: 'What changes',
    tag: { new: 'New', safer: 'Safer', wound: 'Wound down', replaced: 'Replaced', cap: 'Cap', paused: 'Ends a pause' } as Record<ChangeKind, string>,
    change: {
      onchain: 'Trades only near the market price, and only the positions Mamoru opened.',
      guardian: 'A guardian key can pause Mamoru at any time. That key can never move your funds; your next renewal ends a pause.',
      add: 'Can add to a position it already holds instead of opening another one.',
      revoked: 'Your current approval is revoked in the same transaction.',
      paused: 'A guardian key has paused Mamoru on this Safe. Approving ends that pause: do it only if you know why.',
      wound: (pool: string) => `${pool}: only wound down. Nothing new goes in.`,
      remote: (share: string, bucket: string, chain: string) => `${share} of your savings (${bucket}) moves to your own Safe on ${chain}. Same owner: your passkey.`,
      capChange: (from: string, to: string) => `Your cap goes from ${from} to ${to} USDC. The limits below are sized for the new one.`,
    },
    sameActions: 'The same kinds of actions as now. Limits start again from zero.',
    finish: 'Finishes this approval, within the same cap.',
    engineKey: 'Engine key',
    limits: 'Limits per pool',
    band: 'Price band',
    bandNote: 'of the 30- and 5-min average',
    peg: (p: string) => `and ±${p} of 1:1`,
    perDay: 'Per day',
    total: 'In total',
    scope: 'Band: swaps, new positions and withdrawals. Amounts: swaps and new positions.',
    on: (chain: string) => `On ${chain}`,
    remoteBody: (pools: string, until: string | null) => `Swaps and liquidity only in ${pools}, near the market price, paid only to that Safe${until ? `, until ${until}` : ''}.`,
    remoteBridge: "USDC crosses only to that Safe, through Circle's bridge (CCTP), at no fee.",
    bridge: (chain: string) => `Bridge to ${chain}`,
    perTime: 'Per transfer',
    bridgeBody: (pause: boolean) => `Only to your own address, never any fee.${pause ? ' A guardian pause stops it.' : ''}`,
    fee: (eth: string, gwei: string, txs: string) => `Network fee: at most ${eth} ETH per engine transaction (at most ${gwei} gwei), from your Safe's ETH. Up to ${txs} transactions.`,
    always: 'Always',
    promise: {
      nothingMoves: 'Nothing moves now: your positions stay as they are.',
      paidToSafe: 'Whatever it collects, mints or swaps is paid to your Safe, never to anyone else.',
      noAsking: 'It acts without asking you again, only inside these limits.',
      positionsStay: (n: number) => `Your ${n} open position${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''} under Mamoru's management.`,
    },
    alsoSigned: 'Also in this approval',
    details: 'Exact text your passkey signs',
    lines: (n: number) => `${n} lines`,
  },
  es: {
    points: [
      { title: 'Ahora no se mueve nada', body: 'Tu dinero sigue en tu Safe, donde está.' },
      { title: 'Solo dentro de límites fijos', body: 'Abajo están todos los límites. Mamoru no puede pasarse de ellos.' },
      { title: 'Solo se paga a tu Safe', body: 'Lo que Mamoru cobre o cambie vuelve a ti. Para o retira cuando quieras.' },
    ],
    review: 'Revisar',
    preparing: 'Preparando',
    approve: 'Aprobar con passkey',
    signing: 'Esperando a la passkey',
    later: 'Ahora no',
    validFor: 'Válida',
    days: 'días',
    sizedFor: 'Pensada para hasta',
    pools: 'Pools',
    oneSignature: 'Una sola firma con passkey',
    changes: 'Qué cambia',
    tag: { new: 'Nuevo', safer: 'Más seguro', wound: 'Se cierra', replaced: 'Sustituye', cap: 'Límite', paused: 'Quita la pausa' } as Record<ChangeKind, string>,
    change: {
      onchain: 'Solo opera cerca del precio de mercado, y solo con las posiciones que abrió Mamoru.',
      guardian: 'Una clave guardiana puede pausar Mamoru en cualquier momento. Esa clave nunca puede mover tus fondos; tu próxima renovación quita la pausa.',
      add: 'Puede ampliar una posición que ya tiene en vez de abrir otra.',
      revoked: 'Tu aprobación actual se revoca en la misma transacción.',
      paused: 'Una clave guardiana ha pausado Mamoru en esta Safe. Aprobar quita esa pausa: hazlo solo si sabes por qué se pausó.',
      wound: (pool: string) => `${pool}: solo se va cerrando. No entra nada nuevo.`,
      remote: (share: string, bucket: string, chain: string) => `El ${share} de tus ahorros (${bucket}) pasa a tu propia Safe en ${chain}. Mismo dueño: tu passkey.`,
      capChange: (from: string, to: string) => `Tu límite pasa de ${from} a ${to} USDC. Los límites de abajo están pensados para el nuevo.`,
    },
    sameActions: 'Las mismas acciones que ahora. Los límites vuelven a contar desde cero.',
    finish: 'Completa esta aprobación, con el mismo límite.',
    engineKey: 'Clave del motor',
    limits: 'Límites por pool',
    band: 'Banda de precio',
    bandNote: 'sobre la media de 30 y 5 min',
    peg: (p: string) => `y ±${p} de 1:1`,
    perDay: 'Al día',
    total: 'En total',
    scope: 'Banda: swaps, posiciones nuevas y retiradas. Importes: swaps y posiciones nuevas.',
    on: (chain: string) => `En ${chain}`,
    remoteBody: (pools: string, until: string | null) => `Swaps y liquidez solo en ${pools}, cerca del precio de mercado, pagado solo a esa Safe${until ? `, hasta el ${until}` : ''}.`,
    remoteBridge: 'Los USDC solo cruzan a esa Safe, por el bridge de Circle (CCTP), sin comisión.',
    bridge: (chain: string) => `Bridge a ${chain}`,
    perTime: 'Por envío',
    bridgeBody: (pause: boolean) => `Solo a tu propia dirección, nunca con comisión.${pause ? ' Una pausa de la clave guardiana lo detiene.' : ''}`,
    fee: (eth: string, gwei: string, txs: string) => `Comisión de red: como mucho ${eth} ETH por transacción del motor (como mucho ${gwei} gwei), del ETH de tu Safe. Hasta ${txs} transacciones.`,
    always: 'Siempre',
    promise: {
      nothingMoves: 'Ahora no se mueve nada: tus posiciones siguen como están.',
      paidToSafe: 'Lo que cobre, acuñe o cambie se paga a tu Safe, nunca a nadie más.',
      noAsking: 'Actúa sin volver a preguntarte, solo dentro de estos límites.',
      positionsStay: (n: number) => (n === 1 ? 'Tu posición abierta sigue gestionada por Mamoru.' : `Tus ${n} posiciones abiertas siguen gestionadas por Mamoru.`),
    },
    alsoSigned: 'También en esta aprobación (en inglés)',
    details: 'Texto exacto que firma tu passkey (en inglés)',
    lines: (n: number) => `${n} líneas`,
  },
  ja: {
    points: [
      { title: '今は何も動きません', body: '資金はあなたの Safe にそのまま残ります。' },
      { title: '決まった上限の内側だけ', body: '上限はすべて下に表示しています。Mamoru はそれを超えられません。' },
      { title: '支払先はあなたの Safe だけ', body: 'Mamoru が回収・交換したものはあなたに戻ります。いつでも停止・引き出しできます。' },
    ],
    review: '確認する',
    preparing: '準備中',
    approve: 'パスキーで承認',
    signing: 'パスキーを待っています',
    later: '今はしない',
    validFor: '有効期間',
    days: '日',
    sizedFor: '想定する上限',
    pools: 'プール',
    oneSignature: 'パスキーの署名は 1 回だけ',
    changes: '変更点',
    tag: { new: '新規', safer: 'より安全', wound: '縮小', replaced: '置き換え', cap: '上限', paused: '一時停止を解除' } as Record<ChangeKind, string>,
    change: {
      onchain: '市場価格の近くでのみ取引し、Mamoru が開いたポジションだけを扱います。',
      guardian: 'ガーディアン鍵はいつでも Mamoru を一時停止できます。その鍵が資金を動かすことはできず、次の更新で一時停止は解除されます。',
      add: '新しく開く代わりに、既存のポジションに追加できます。',
      revoked: '現在の承認は同じトランザクションで取り消されます。',
      paused: 'ガーディアン鍵がこの Safe で Mamoru を一時停止しています。承認すると解除されます。理由が分かっている場合のみ承認してください。',
      wound: (pool: string) => `${pool}：縮小のみ。新たな資金は入りません。`,
      remote: (share: string, bucket: string, chain: string) => `貯蓄の ${share}（${bucket}）を ${chain} 上のあなた自身の Safe に移します。所有者は同じ（あなたのパスキー）です。`,
      capChange: (from: string, to: string) => `上限が ${from} から ${to} USDC に変わります。下の上限は新しい値に合わせています。`,
    },
    sameActions: '今と同じ種類の操作です。上限はゼロから数え直します。',
    finish: '同じ上限のまま、この承認を完了します。',
    engineKey: 'エンジン鍵',
    limits: 'プールごとの上限',
    band: '価格帯',
    bandNote: '30分・5分平均から',
    peg: (p: string) => `かつ 1:1 から ±${p}`,
    perDay: '1日あたり',
    total: '合計',
    scope: '価格帯：スワップ・新規ポジション・引き出し。金額：スワップと新規ポジション。',
    on: (chain: string) => `${chain} 上`,
    remoteBody: (pools: string, until: string | null) => `${pools} でのみ、市場価格の近くでスワップと流動性提供を行い、その Safe にだけ支払います${until ? `（${until} まで）` : ''}。`,
    remoteBridge: 'USDC は Circle のブリッジ（CCTP）で、手数料なしで、その Safe にだけ送られます。',
    bridge: (chain: string) => `${chain} へのブリッジ`,
    perTime: '1回あたり',
    bridgeBody: (pause: boolean) => `送り先はあなた自身のアドレスのみ、手数料なし。${pause ? 'ガーディアンの一時停止で止まります。' : ''}`,
    fee: (eth: string, gwei: string, txs: string) => `ネットワーク手数料：エンジンのトランザクション 1 件あたり最大 ${eth} ETH（最大 ${gwei} gwei）、Safe の ETH から支払います。最大 ${txs} 件。`,
    always: '常に',
    promise: {
      nothingMoves: '今は何も動きません。ポジションはそのままです。',
      paidToSafe: '回収・発行・交換したものはすべてあなたの Safe に支払われ、他の誰にも渡りません。',
      noAsking: '再確認なしで動きますが、この上限の内側だけです。',
      positionsStay: (n: number) => `${n} 件の保有ポジションは引き続き Mamoru が管理します。`,
    },
    alsoSigned: 'この承認に含まれるその他の内容（英語）',
    details: 'パスキーが署名する原文（英語）',
    lines: (n: number) => `${n} 行`,
  },
} satisfies Record<Locale, unknown>

type Copy = (typeof copy)['en']
const copyOf = (locale: Locale): Copy => copy[locale] as Copy

/** The English copy, as before (#176): other modules and tests read the labels from here. */
export const approvalCopy = copy.en

/** What the brief can state from the signed lines themselves; anything it cannot find is left out, never guessed. */
export type SignedFacts = { days: number | null; capUsdc: string | null; pools: string[] }

const POOL_LINE = /^In (.+?): (.*)$/

export function signedFacts(lines: string[]): SignedFacts {
  const text = lines.join('\n')
  const days = text.match(/for (\d+) (?:more )?days/)
  const cap = text.match(/deposits up to ([\d,.]+) USDC/)
  const pools = [...new Set(lines.map((l) => l.match(POOL_LINE)?.[1]).filter((p): p is string => !!p))]
  return { days: days ? Number(days[1]) : null, capUsdc: cap ? cap[1]! : null, pools }
}

/**
 * A signed line with its figures set in bold and addresses in mono. The text itself is untouched: what it renders
 * reads exactly as the line the passkey signs.
 */
export function Emph({ text }: { text: string }) {
  // A figure stands alone: the 3 in "Uniswap v3" or the 0.05% inside a pool name are not amounts, and neither is any
  // part of one (the 0 of "0.30%" once its fraction is refused).
  const parts = text.split(/(0x[0-9a-fA-F]{40}|(?<![\w./])\d[\d,]*(?:\.\d+)?(?![\w%]|\.\d))/)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 0 ? (
          <Fragment key={i}>{p}</Fragment>
        ) : p.startsWith('0x') ? (
          <code key={i} className="signed-addr">
            {p}
          </code>
        ) : (
          <strong key={i} className="signed-num">
            {p}
          </strong>
        ),
      )}
    </>
  )
}

function PointIcon({ i }: { i: number }) {
  // Drawn in one stroke weight: a resting stone, a fence, a return arrow.
  const paths = ['M3 11.5c0-2.6 2.2-4.5 5-4.5s5 1.9 5 4.5H3Z', 'M3 4v9M8 4v9M13 4v9M3 7h10M3 10.5h10', 'M12.5 6.5H6a3 3 0 0 0 0 6h4M12.5 6.5 10 4M12.5 6.5 10 9']
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[i]} />
    </svg>
  )
}

export function KeyPoints({ locale = detectLocale() }: { locale?: Locale }) {
  const t = copyOf(locale)
  return (
    <ul className="approve-points" aria-label="In short">
      {t.points.map((p, i) => (
        <li key={p.title}>
          <span className="approve-icon">
            <PointIcon i={i} />
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

function Facts({ facts, t }: { facts: SignedFacts; t: Copy }) {
  if (facts.days === null && facts.capUsdc === null) return null
  return (
    <dl className="approve-facts">
      {facts.days !== null ? (
        <div>
          <dt>{t.validFor}</dt>
          <dd>
            {facts.days} <span className="approve-unit">{t.days}</span>
          </dd>
        </div>
      ) : null}
      {facts.capUsdc !== null ? (
        <div>
          <dt>{t.sizedFor}</dt>
          <dd>
            {facts.capUsdc} <span className="approve-unit">USDC</span>
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

function changeText(c: Change, t: Copy): ReactNode {
  switch (c.key) {
    case 'wound':
      return t.change.wound(c.pool)
    case 'remote':
      return (
        <>
          {t.change.remote(c.share, c.bucket, c.chain)} <code className="signed-addr">{c.safe}</code>
        </>
      )
    case 'capChange':
      return t.change.capChange(c.from, c.to)
    default:
      return t.change[c.key]
  }
}

/** The Safe on another chain is a change only when this approval moves the account to it; a renewal already has it. */
const remoteIsNew = (read: ApprovalRead) => !!read.head?.move

function Changes({ read, t }: { read: ApprovalRead; t: Copy }) {
  const shown = read.changes.filter((c) => c.key !== 'remote' || remoteIsNew(read))
  if (!shown.length) return null
  // A pause it ends first, then what is new, what gets safer, what winds down, and what it replaces last.
  const order: ChangeKind[] = ['paused', 'new', 'cap', 'safer', 'wound', 'replaced']
  const changes = [...shown].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  return (
    <section className="approve-section" aria-label={t.changes}>
      <h3 className="approve-h">{t.changes}</h3>
      <ul className="approve-changes">
        {changes.map((c) => (
          <li key={c.line} className={`chg chg-${c.kind}`}>
            <span className="chg-tag">{t.tag[c.kind]}</span>
            <span className="chg-text">{changeText(c, t)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Metric({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">
        {value}
        {unit ? <span className="approve-unit"> {unit}</span> : null}
      </span>
      {note ? <span className="metric-note">{note}</span> : null}
    </div>
  )
}

function Limits({ read, t }: { read: ApprovalRead; t: Copy }) {
  const engine = read.engine?.form
  if (!read.pools.length && !engine) return null
  return (
    <section className="approve-section" aria-label={t.limits}>
      <h3 className="approve-h">{t.limits}</h3>
      {read.pools.length ? <p className="pool-card-scope">{t.scope}</p> : null}
      {engine ? (
        <p className="approve-engine">
          {engine === 'renew' ? t.sameActions : t.finish}{' '}
          <span className="approve-engine-key">
            {t.engineKey} <code className="signed-addr">{read.engine!.key}</code>
          </span>
        </p>
      ) : null}
      <div className="pool-cards">
        {read.pools.map((p) => (
          <article key={p.line} className="pool-card">
            <header className="pool-card-head">
              <span className="pool-card-name">{p.pool}</span>
            </header>
            <div className="pool-card-metrics">
              <Metric label={t.band} value={`±${p.band}`} note={p.peg ? `${t.bandNote} ${t.peg(p.peg)}` : t.bandNote} />
              <Metric label={t.perDay} value={p.dayUsdc} unit="USDC" />
              <Metric label={t.total} value={p.totalUsdc} unit="USDC" />
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function Elsewhere({ read, t }: { read: ApprovalRead; t: Copy }) {
  const { remote, bridge } = read
  if (!remote && !bridge) return null
  const own = read.changes.find((c) => c.key === 'remote')
  return (
    <div className="pool-cards">
      {remote && (remote.pools || remote.crosses || (own && !remoteIsNew(read))) ? (
        <article className="pool-card pool-card-remote">
          <header className="pool-card-head">
            <span className="pool-card-name">{t.on(remote.chain ?? read.bridge?.chain ?? '')}</span>
          </header>
          {own && !remoteIsNew(read) ? <p className="pool-card-body">{changeText(own, t)}</p> : null}
          {remote.pools ? <p className="pool-card-body">{t.remoteBody(remote.pools, remote.until)}</p> : null}
          {remote.crosses ? <p className="pool-card-body">{t.remoteBridge}</p> : null}
        </article>
      ) : null}
      {bridge ? (
        <article className="pool-card">
          <header className="pool-card-head">
            <span className="pool-card-name">{t.bridge(bridge.chain)}</span>
            <span className="pool-card-scope">{t.bridgeBody(bridge.pause)}</span>
          </header>
          <div className="pool-card-metrics pool-card-metrics-2">
            <Metric label={t.perTime} value={bridge.perTxUsdc} unit="USDC" />
            <Metric label={t.total} value={bridge.totalUsdc} unit="USDC" />
          </div>
        </article>
      ) : null}
    </div>
  )
}

function Promises({ read, t }: { read: ApprovalRead; t: Copy }) {
  if (!read.promises.length) return null
  return (
    <section className="approve-section" aria-label={t.always}>
      <h3 className="approve-h">{t.always}</h3>
      <ul className="approve-promises">
        {read.promises.map((p) => (
          <li key={p.line}>{p.key === 'positionsStay' ? t.promise.positionsStay(p.count ?? 0) : t.promise[p.key]}</li>
        ))}
      </ul>
    </section>
  )
}

/** Lines no reader knows (and a split approval's steps), word for word, in the view itself: nothing signed is only folded. */
function AlsoSigned({ read, lines, t }: { read: ApprovalRead; lines: string[]; t: Copy }) {
  const own = [...read.text.map((x) => x.line), ...(read.steps ? [read.steps.line] : [])].sort((a, b) => a - b)
  if (!own.length) return null
  return (
    <section className="approve-section" aria-label={t.alsoSigned}>
      <h3 className="approve-h">{t.alsoSigned}</h3>
      <ul className="signed-list" data-testid="also-signed">
        {own.map((i) => {
          const pool = lines[i]!.match(POOL_LINE)
          return pool ? (
            <li key={i} className="signed-pool">
              <span className="signed-pool-name">In {pool[1]}:</span> <Emph text={pool[2]!} />
            </li>
          ) : (
            <li key={i}>
              <Emph text={lines[i]!} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Every signed line, word for word and in its order, under a disclosure (#41: one tap from Approve, never paraphrased). */
export function SignedLines({ lines, locale = detectLocale() }: { lines: string[]; locale?: Locale }) {
  const t = copyOf(locale)
  return (
    <details className="signed" data-testid="review">
      <summary>
        {t.details}
        <span className="signed-count">{t.lines(lines.length)}</span>
      </summary>
      <ol className="signed-list">
        {lines.map((l, i) => (
          <li key={i}>
            <Emph text={l} />
          </li>
        ))}
      </ol>
    </details>
  )
}

/** The read approval: the facts, what changes, the limits, the rest, the promises. */
export function ApprovalView({ lines, locale = detectLocale() }: { lines: string[]; locale?: Locale }) {
  const t = copyOf(locale)
  const read = readApproval(lines)
  return (
    <>
      <Facts facts={signedFacts(lines)} t={t} />
      <Changes read={read} t={t} />
      <Limits read={read} t={t} />
      <Elsewhere read={read} t={t} />
      <AlsoSigned read={read} lines={lines} t={t} />
      {read.gas ? <p className="approve-fee">{t.fee(read.gas.perTxEth, read.gas.gwei, read.gas.txs)}</p> : null}
      <Promises read={read} t={t} />
    </>
  )
}

/** The dialog's body for one approval: the brief, then (once prepared) the read approval and its exact text. */
/** `context`: shown under the lead (the Monad move's mix); `points`: in place of the usual key points. */
export function ApprovalBody({ lead, summary, busy, error, onPrepare, onApprove, onLater, context, points, locale = detectLocale() }: { lead: ReactNode; summary: string[] | null; busy: string | null; error: string | null; onPrepare: () => void; onApprove: () => void; onLater: () => void; context?: ReactNode; points?: ReactNode; locale?: Locale }) {
  const t = copyOf(locale)
  return (
    <div className="approve" data-testid="renew-body">
      <p className="approve-lead">{lead}</p>
      {context}
      {summary ? <ApprovalView lines={summary} locale={locale} /> : (points ?? <KeyPoints locale={locale} />)}
      {summary ? <SignedLines lines={summary} locale={locale} /> : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="approve-actions">
        {summary && !readApproval(summary).steps ? <span className="approve-once">{t.oneSignature}</span> : null}
        <button type="button" className="approve-later" onClick={onLater} disabled={busy === 'signing'}>
          {t.later}
        </button>
        {summary ? (
          <button key="approve" type="button" className="cta" onClick={onApprove} disabled={busy !== null}>
            {busy === 'signing' ? t.signing : t.approve}
          </button>
        ) : (
          <button key="review" type="button" className="cta" onClick={onPrepare} disabled={busy !== null}>
            {busy === 'preparing' ? t.preparing : t.review}
          </button>
        )}
      </div>
    </div>
  )
}

export function ApprovalDialog({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div data-testid="renew-dialog">{children}</div>
    </Modal>
  )
}
