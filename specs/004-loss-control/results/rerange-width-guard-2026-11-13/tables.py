# Tables of the report from sweep.json: python3 tables.py > tables.md
import json,collections,sys
d=json.load(open(__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)),'sweep.json')))
cells=[c for c in d['cells'] if c['status']=='ok']
variants=[v['name'] for v in d['variants']]
reg=collections.defaultdict(list)
for c in cells: reg[(c['variant'],c['regime'],c['deposit'])].append(c)
def agg(v,r,dep):
    cs=reg[(v,r,dep)]; n=len(cs)
    m=[c['metrics'] for c in cs]
    return dict(n=n,vsUsd=sum(x['vsHoldPct'] for x in m)/n*dep/100, vsPct=sum(x['vsHoldPct'] for x in m)/n,
      worstDD=max(x['maxDrawdownPct'] for x in m), gas=sum(x['gas'] for x in m)/n, ops=sum(x['ops'] for x in m)/n,
      rr=sum(x['opsByKind'].get('rerange',0) for x in m)/n, ret=sum(x['returnPct'] for x in m)/n)
sel=['prod-baseline','w2000-mpw1-guardoff','w2000-mpw3-guardoff','w2000-mpw5-guardoff','w2000-mpwinf-guardoff','w2000-mpw2-guardon','w2000-mpw3-guardon','wvol-mpw2-guardoff','wvol-mpw2-guardon','w4000-mpw2-guardoff','w4000-mpw2-guardon']
H='| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |\n|---|---|---|---|---|---|---|---|'
def row(v,r,dep):
    a=agg(v,r,dep); return f"| {v} | {a['n']} | {a['vsUsd']:+.2f} | {a['vsPct']:+.3f} | {a['worstDD']:.2f} | {a['gas']:.2f} | {a['ops']:.1f} | {a['rr']:.1f} |"
out=[]
for r,names in [('calm','sep2026, calm-2025-09, calm-2026-04'),('crash','oct2025, feb2025, mar2025'),('rally','dec2024')]:
  out.append(f"### {r.capitalize()} ({names}): mean per window\n")
  for dep in [100,1000,10000]:
    out.append(f"Deposit {dep} USDC\n\n{H}")
    for v in sel: out.append(row(v,r,dep))
    out.append('')
out.append('## Appendix A: full grid, deposit 1000 USDC\n')
for r in ['calm','crash','rally']:
  out.append(f"{r}\n\n{H}")
  for v in variants: out.append(row(v,r,1000))
  out.append('')
# per window
wins=['sep2026','calm-2025-09','calm-2026-04','oct2025','feb2025','mar2025','dec2024']
pv=['prod-baseline','w2000-mpwinf-guardoff','w2000-mpw2-guardon','w2000-mpw3-guardon','wvol-mpw2-guardon','w4000-mpw2-guardoff','w4000-mpw2-guardon']
idx={(c['variant'],c['window'],c['deposit']):c['metrics'] for c in cells}
out.append('## Appendix B: per window, net vs hold in USD (deposit 1000; 10000 in brackets) and reranges\n')
out.append('| Window | '+' | '.join(pv)+' |\n|---|'+'---|'*len(pv))
for w in wins:
  cs=[]
  for v in pv:
    m=idx[(v,w,1000)]; m2=idx[(v,w,10000)]
    cs.append(f"{m['vsHoldPct']*10:+.2f} ({m2['vsHoldPct']*100:+.1f}) / {m['opsByKind'].get('rerange',0)}rr")
  out.append(f"| {w} | "+' | '.join(cs)+' |')
print('\n'.join(out))
