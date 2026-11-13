# Tables of the regime-shift report: python3 tables.py [train|test] (reads train.json / test.json beside it)
import json,os,sys,statistics as st
D=os.path.dirname(os.path.abspath(__file__))
DEPS=[100,1000,10000]
def load(f):
    d=json.load(open(os.path.join(D,f))); return [c for c in d['cells'] if c['status']=='ok'],[v['name'] for v in d['variants']]
def row(cells,v,sel,dep):
    m=[c['metrics'] for c in cells if c['variant']==v and sel(c) and c['deposit']==dep]; n=len(m)
    p=sum(x['vsHoldPct'] for x in m)/n
    sh=sum(x.get('regime',{}).get('shifts',0) for x in m)/n
    dh=sum(x.get('regime',{}).get('defensiveHours',0) for x in m)/n
    return dict(n=n,usd=p*dep/100,pct=p,dd=max(x['maxDrawdownPct'] for x in m),gas=sum(x['gas'] for x in m)/n,swaps=sum(x['opsByKind'].get('enter_swap',0) for x in m)/n,red=sum(x['opsByKind'].get('reduce',0) for x in m)/n,shifts=sh,defh=dh,ref=sum(x['refused'] for x in m)/n)
H='| Variant | n | net vs hold USD | % | worst DD % | gas USD | swaps | reduces | shifts | defensive h | refused |\n|---|---|---|---|---|---|---|---|---|---|---|'
def line(v,r): return f"| {v} | {r['n']} | {r['usd']:+.2f} | {r['pct']:+.3f} | {r['dd']:.2f} | {r['gas']:.2f} | {r['swaps']:.1f} | {r['red']:.1f} | {r['shifts']:.1f} | {r['defh']:.0f} | {r['ref']:.1f} |"
mode=sys.argv[1] if len(sys.argv)>1 else 'train'
if mode=='train':
    cells,variants=load('train.json')
    # Picking rule, fixed before any TRAIN or TEST table was read: highest mean vs hold % over the 7 TRAIN windows and
    # the 3 deposits (each window x deposit weighs the same), among regime variants whose dec2024 (rally) cost against
    # their own comparator (same guard setting) is at most 0.25 points at every deposit and whose calm windows average at
    # most 1 shift. Ties within 0.02 points: fewer shifts, then guard off.
    allv=lambda v:st.mean(c['metrics']['vsHoldPct'] for c in cells if c['variant']==v)
    print("#### All 7 TRAIN windows: mean vs hold % (100 / 1,000 / 10,000), worst window %, mean of the three, shifts per window\n")
    print("| Variant | 100 | 1,000 | 10,000 | worst window % | mean | shifts/window |\n|---|---|---|---|---|---|---|")
    for v in sorted(variants,key=lambda v:-allv(v)):
        xs=[st.mean(c['metrics']['vsHoldPct'] for c in cells if c['variant']==v and c['deposit']==d) for d in DEPS]
        wst=min(c['metrics']['vsHoldPct'] for c in cells if c['variant']==v)
        sh=st.mean(c['metrics'].get('regime',{}).get('shifts',0) for c in cells if c['variant']==v and c['deposit']==1000)
        print(f"| {v} | "+' | '.join(f"{x:+.3f}" for x in xs)+f" | {wst:+.3f} | {allv(v):+.3f} | {sh:.2f} |")
    print()
    elig=[]
    for v in variants:
        if not v.startswith('rs-'): continue
        comp='w2000-mpw2-guardon' if v.endswith('gon') else 'prod-baseline'
        rally=all(row(cells,comp,lambda c:c['regime']=='rally',d)['pct']-row(cells,v,lambda c:c['regime']=='rally',d)['pct']<=0.25 for d in DEPS)
        calm=row(cells,v,lambda c:c['regime']=='calm',1000)['shifts']<=1
        if rally and calm: elig.append(v)
    best=max(allv(v) for v in elig) if elig else None
    tied=[v for v in elig if allv(v)>=best-0.02]
    tied.sort(key=lambda v:(st.mean(c['metrics'].get('regime',{}).get('shifts',0) for c in cells if c['variant']==v), v.endswith('gon'), -allv(v)))
    print(f"Eligible under the rule: {len(elig)} of {sum(v.startswith('rs-') for v in variants)}; best mean {best:+.3f}; within 0.02: {', '.join(tied)}; picked: **{tied[0]}**\n")
    for r,nm in [('calm','sep2026, calm-2025-09, calm-2026-04'),('crash','oct2025, feb2025, mar2025'),('rally','dec2024')]:
        print(f"#### TRAIN {r} ({nm}): mean per window\n")
        for dep in DEPS:
            print(f"Deposit {dep} USDC\n\n{H}")
            for v in variants: print(line(v,row(cells,v,lambda c:c['regime']==r,dep)))
            print()
    print("#### TRAIN crash windows one by one, 1,000 USDC: net vs hold USD / shifts\n")
    ws=['oct2025','feb2025','mar2025']
    print("| Variant | "+' | '.join(ws)+" |\n|---|---|---|---|")
    for v in variants:
        print(f"| {v} | "+' | '.join(f"{row(cells,v,lambda c,w=w:c['window']==w,1000)['usd']:+.2f} / {row(cells,v,lambda c,w=w:c['window']==w,1000)['shifts']:.0f}" for w in ws)+" |")
else:
    cells,variants=load('test.json')
    for dep in DEPS:
        print(f"#### TEST (run once), deposit {dep} USDC\n\n| Window | Regime | Variant | net vs hold USD | % | worst DD % | gas USD | swaps | reduces | shifts | defensive h | refused |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
        for w,rg in [('apr2025','crash'),('may2025','rally'),('jun2025','calm'),('calm-2026-05','calm'),('feb2026','stable-stress')]:
            for v in variants:
                r=row(cells,v,lambda c,w=w:c['window']==w,dep)
                print(f"| {w} | {rg} | {v} | {r['usd']:+.2f} | {r['pct']:+.3f} | {r['dd']:.2f} | {r['gas']:.2f} | {r['swaps']:.0f} | {r['red']:.0f} | {r['shifts']:.0f} | {r['defh']:.0f} | {r['ref']:.0f} |")
        print()
    print("#### TEST, all 5 windows: mean vs hold % (100 / 1,000 / 10,000), worst window %\n\n| Variant | 100 | 1,000 | 10,000 | worst window % |\n|---|---|---|---|---|")
    for v in variants:
        xs=[st.mean(c['metrics']['vsHoldPct'] for c in cells if c['variant']==v and c['deposit']==d) for d in DEPS]
        print(f"| {v} | "+' | '.join(f"{x:+.3f}" for x in xs)+f" | {min(c['metrics']['vsHoldPct'] for c in cells if c['variant']==v):+.3f} |")
