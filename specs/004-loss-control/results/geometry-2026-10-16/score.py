"""Score sweep variants against the baseline with the pre-declared objective.

Objective (declared before the TRAIN grid ran):
  primary: lower mean max drawdown, lower worst max drawdown, higher worst-window return, at 1k and 100k.
  score = sum over deposits of (-d mean DD) + (-d worst DD) + (d worst return), in pp.
  constraint: mean return >= baseline - 0.10 pp at both deposits.
  candidates: the two best scores that pass the constraint with score > 0. Gas and ops reported, not scored.
"""
import json, sys
from collections import defaultdict

path = sys.argv[1]
prefix = sys.argv[2] if len(sys.argv) > 2 else ''
mode = sys.argv[3] if len(sys.argv) > 3 else 'rank'
d = json.load(open(path))
cells = [c for c in d['cells'] if c['status'] == 'ok']
by = defaultdict(dict)  # (variant, deposit) -> window -> metrics
for c in cells:
    by[(c['variant'], c['deposit'])][c['window']] = c['metrics']
deps = d['deposits']
variants = [v['name'] for v in d['variants']]

def summary(v, dep):
    ms = by[(v, dep)]
    r = [m['returnPct'] for m in ms.values()]
    dd = [m['maxDrawdownPct'] for m in ms.values()]
    return dict(mean=sum(r) / len(r), worst=min(r), meanDD=sum(dd) / len(dd), worstDD=max(dd),
                ops=sum(m['ops'] for m in ms.values()), gas=sum(m['gas'] for m in ms.values()), fees=sum(m['fees'] for m in ms.values()), n=len(r))

rows = []
for v in variants:
    if v == 'baseline':
        continue
    s, ok, parts, wins = 0.0, True, {}, {}
    for dep in deps:
        a, b = summary('baseline', dep), summary(v, dep)
        dm, ddd, dwd, dw = b['mean'] - a['mean'], b['meanDD'] - a['meanDD'], b['worstDD'] - a['worstDD'], b['worst'] - a['worst']
        s += -ddd - dwd + dw
        ok = ok and dm >= -0.10
        ws = by[('baseline', dep)].keys()
        ddw = sum(1 for w in ws if by[(v, dep)][w]['maxDrawdownPct'] < by[('baseline', dep)][w]['maxDrawdownPct'] - 1e-9)
        ddl = sum(1 for w in ws if by[(v, dep)][w]['maxDrawdownPct'] > by[('baseline', dep)][w]['maxDrawdownPct'] + 1e-9)
        rw = sum(1 for w in ws if by[(v, dep)][w]['returnPct'] > by[('baseline', dep)][w]['returnPct'] + 1e-9)
        rl = sum(1 for w in ws if by[(v, dep)][w]['returnPct'] < by[('baseline', dep)][w]['returnPct'] - 1e-9)
        parts[dep] = (dm, ddd, dwd, dw, b['ops'] - a['ops'], b['gas'] - a['gas'])
        wins[dep] = (ddw, ddl, rw, rl, len(ws))
    rows.append((v, s, ok, parts, wins))

if mode == 'rank':
    rows = [r for r in rows if r[0].startswith(prefix)]
    rows.sort(key=lambda r: -r[1])
    print('| Variant | Score pp | Pass | ' + ' | '.join(f'{dep}: d mean ret / d mean DD / d worst DD / d worst ret / d ops / d gas / DD better-worse / ret better-worse' for dep in deps) + ' |')
    for v, s, ok, parts, wins in rows:
        cols = []
        for dep in deps:
            dm, ddd, dwd, dw, dops, dgas = parts[dep]
            ddw, ddl, rw, rl, n = wins[dep]
            cols.append(f'{dm:+.2f} / {ddd:+.2f} / {dwd:+.2f} / {dw:+.2f} / {dops:+d} / {dgas:+.2f} / {ddw}-{ddl} / {rw}-{rl}')
        print(f'| {v} | {s:+.2f} | {"yes" if ok else "no"} | ' + ' | '.join(cols) + ' |')
    print()
    for dep in deps:
        b = summary('baseline', dep)
        print(f'baseline {dep}: mean {b["mean"]:.2f} worst {b["worst"]:.2f} meanDD {b["meanDD"]:.2f} worstDD {b["worstDD"]:.2f} ops {b["ops"]} gas {b["gas"]:.2f} n {b["n"]}')
else:
    # per-window deltas for the named variants (comma list in prefix)
    names = prefix.split(',')
    for dep in deps:
        print(f'\n#### Deposit {dep}\n')
        print('| Window | Baseline ret % / DD % | ' + ' | '.join(f'{n}: d ret / d DD' for n in names) + ' |')
        print('|---|---|' + '---|' * len(names))
        for w, m in by[('baseline', dep)].items():
            cols = []
            for n in names:
                x = by[(n, dep)][w]
                cols.append(f'{x["returnPct"] - m["returnPct"]:+.2f} / {x["maxDrawdownPct"] - m["maxDrawdownPct"]:+.2f}')
            print(f'| {w} | {m["returnPct"]:.2f} / {m["maxDrawdownPct"]:.2f} | ' + ' | '.join(cols) + ' |')
        rowsum = []
        for n in names:
            s = summary(n, dep)
            rowsum.append(f'{s["mean"]:.2f} / {s["worst"]:.2f} / {s["meanDD"]:.2f} / {s["worstDD"]:.2f} / {s["ops"]} / {s["gas"]:.2f}')
        b = summary('baseline', dep)
        print(f'| **mean / worst ret, mean / worst DD, ops, gas** | {b["mean"]:.2f} / {b["worst"]:.2f} / {b["meanDD"]:.2f} / {b["worstDD"]:.2f} / {b["ops"]} / {b["gas"]:.2f} | ' + ' | '.join(rowsum) + ' |')
