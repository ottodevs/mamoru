# Tables of the v7-like section: python3 tables.py > tables.md (reads train.json and test.json beside it)
import json,os,statistics as st
D=os.path.dirname(os.path.abspath(__file__))
def load(f):
    d=json.load(open(os.path.join(D,f))); return [c for c in d['cells'] if c['status']=='ok'],[v['name'] for v in d['variants']]
cells,variants=load('train.json')
def agg(v,r,dep):
    m=[c['metrics'] for c in cells if c['variant']==v and c['regime']==r and c['deposit']==dep]; n=len(m)
    p=sum(x['vsHoldPct'] for x in m)/n
    return f"| {v} | {n} | {p*dep/100:+.2f} | {p:+.3f} | {max(x['maxDrawdownPct'] for x in m):.2f} | {sum(x['gas'] for x in m)/n:.2f} | {sum(x['ops'] for x in m)/n:.1f} | {sum(x['opsByKind'].get('rerange',0) for x in m)/n:.1f} |"
H='| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |\n|---|---|---|---|---|---|---|---|'
for r,nm in [('calm','sep2026, calm-2025-09, calm-2026-04'),('crash','oct2025, feb2025, mar2025'),('rally','dec2024')]:
    print(f"#### v7-like, {r} ({nm}): mean per window\n")
    for dep in [100,1000,10000]:
        print(f"Deposit {dep} USDC\n\n{H}"); [print(agg(v,r,dep)) for v in variants]; print()
print("#### v7-like, all 7 TRAIN windows: mean vs hold % / worst window %\n\n| Variant | 100 | 1,000 | 10,000 |\n|---|---|---|---|")
for v in variants:
    cs=[]
    for dep in [100,1000,10000]:
        x=[c['metrics']['vsHoldPct'] for c in cells if c['variant']==v and c['deposit']==dep]; cs.append(f"{st.mean(x):+.3f} / {min(x):+.3f}")
    print(f"| {v} | "+' | '.join(cs)+' |')
tc,tv=load('test.json')
print("\n#### v7-like, TEST (run once): net vs hold USD (%), gas USD, reranges\n")
for dep in [100,1000,10000]:
    print(f"Deposit {dep} USDC\n\n| Window | Regime | "+' | '.join(tv)+" |\n|---|---|---|---|")
    for w,r in [('apr2025','crash'),('may2025','rally'),('jun2025','calm'),('calm-2026-05','calm'),('feb2026','stable-stress')]:
        row=[]
        for v in tv:
            m=[c['metrics'] for c in tc if c['variant']==v and c['window']==w and c['deposit']==dep][0]
            row.append(f"{m['vsHoldPct']*dep/100:+.2f} ({m['vsHoldPct']:+.2f}%), gas {m['gas']:.2f}, {m['opsByKind'].get('rerange',0)} rr")
        print(f"| {w} | {r} | "+' | '.join(row)+' |')
    print()
