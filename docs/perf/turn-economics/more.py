# The second-pass numbers in turn-economics.md. Run after extract.py (run.sh) and agg.py.
import json,glob,collections,re,random
import numpy as np
def q(xs,p):
    xs=sorted(xs); return xs[min(len(xs)-1,int(p*len(xs)))] if xs else float('nan')
S={f[2:10]:json.load(open(f)) for f in sorted(glob.glob('s_*.json')) if f!='s_2ded.json'}
def pairs():
    for sid,s in S.items():
        prev=None
        for x in s:
            if x['kind']=='prompt': prev=None; continue
            if prev and prev.get('res_ts'):
                g=x['ts']-prev['res_ts']
                if 0<=g<900: yield sid,prev,x,g
            if x['calls']: prev=x
P=[(g,x['ctx'],x['out']) for _,_,x,g in pairs()]
print('## gap p50 by context, within an output-token band')
for olo,ohi in [(0,300),(300,1000),(1000,3000)]:
    print(f' out {olo}-{ohi}:',' '.join(f'{int(lo/1e3)}-{int(hi/1e3)}k:{q([p[0] for p in P if olo<=p[2]<ohi and lo<=p[1]<hi],.5):.1f}' for lo,hi in [(0,100e3),(100e3,200e3),(200e3,300e3),(300e3,500e3),(500e3,2e6)]))
Q=[p for p in P if p[0]<120]
co,*_=np.linalg.lstsq(np.array([[1,p[2],p[1]/1e5] for p in Q]),np.array([p[0] for p in Q]),rcond=None)
print('OLS (gap<120s, n=%d): gap = %.2f s + %.2f ms/out-token + %.2f s/100k ctx'%(len(Q),co[0],co[1]*1e3,co[2]))
tot=sum(p[0] for p in P); print('decomposition of %.1f h: fixed %.1f h, output tokens %.1f h, context %.1f h'%(tot/3600,len(P)*co[0]/3600,sum(p[2] for p in P)*co[1]/3600,sum(p[1] for p in P)/1e5*co[2]/3600))
print('median context of a step: %d tokens'%q([p[1] for p in P],.5))
N=sum(1 for *_,x,g in pairs() if x.get('indep')); G=sum(g for *_,x,g in pairs() if x.get('indep'))
sav=sum(min(g,co[0]+co[2]*x['ctx']/1e5) for *_,x,g in pairs() if x.get('indep'))
print(f'\n## independent read-only follow-ups: {N} of {len(P)} ({100*N/len(P):.1f}%); their gaps {G/3600:.1f} h; fixed+context part {sav/3600:.1f} h')
par=sum(1 for s in S.values() for x in s if x['kind']=='step' and len(x['calls'])>1); stp=sum(1 for s in S.values() for x in s if x['kind']=='step' and x['calls'])
print(f'steps with >1 call: {par} of {stp} ({100*par/stp:.1f}%)')
byc=collections.defaultdict(lambda:[0,0.0,[]])
for _,_,x,g in pairs():
    if x['calls']: a=byc[x['calls'][0]['c']]; a[0]+=1;a[1]+=g;a[2].append(x['out'])
print('\n## model time attributed to the call it produced: class, steps, h, p50 out-tokens')
for k,(n,g,o) in sorted(byc.items(),key=lambda x:-x[1][1])[:12]: print(f'  {k:18s}{n:6d}{g/3600:7.1f}{q(o,.5):7d}')
# browser
runs=[];kinds=collections.Counter();kd=collections.defaultdict(list);scripts=[]
for sid,s in S.items():
    cur=[];prev=None
    for x in s:
        if x['kind']=='prompt':
            if len(cur)>1: runs.append(cur)
            cur=[];prev=None;continue
        if not x['calls']: continue
        c=x['calls'][0]
        if c['c']=='browser':
            if prev and prev.get('res_ts'): cur.append((x['ts']-prev['res_ts'],x['ctx']))
            else: cur.append((0,x['ctx']))
        elif cur:
            if len(cur)>1: runs.append(cur)
            cur=[]
        for cl in x['calls']:
            if cl['c']!='browser': continue
            i=cl['inp'];n=cl['name']
            k='mcp:'+n.split('__')[-1] if n.startswith('mcp__') else 'bash:cdp-script' if 'connectOverCDP' in i else 'bash:launch-script' if re.search(r'launch\(',i) else 'bash:other'
            kinds[k]+=1;kd[k].append(cl.get('dur',0) or 0)
            if not n.startswith('mcp__') and 'goto' in i:
                w=sum(int(v) for v in re.findall(r'waitForTimeout\((\d+)\)',i))+sum(int(float(v)*1000) for v in re.findall(r'(?:^|[;&\s])sleep (\d+(?:\.\d+)?)',i))
                scripts.append((cl.get('dur',0) or 0,w))
        prev=x
print('\n## browser calls: kind, calls, p50 s, total min')
for k,n in kinds.most_common(10): print(f'  {k:32s}{n:5d}{q(kd[k],.5):7.1f}{sum(kd[k])/60:8.1f}')
L=[len(r) for r in runs]; later=[g for r in runs for g,_ in r[1:]]
fixed=sum(co[0]+co[2]*c/1e5 for r in runs for _,c in r[1:])
print(f'runs of >=2 consecutive browser steps: {len(L)}, {sum(L)} steps, p50 len {q(L,.5)}; gaps after the first step {sum(later)/3600:.1f} h, fixed+context part {fixed/3600:.1f} h')
print(f'hand-written scripts that navigate: {len(scripts)}, {sum(d for d,_ in scripts)/60:.0f} cmd min, {sum(1 for _,w in scripts if w)} with a fixed wait (median {q([w/1000 for _,w in scripts if w],.5)} s, total {sum(w for _,w in scripts)/60000:.0f} min)')
# polling
n=t=to=0
for s in S.values():
    for x in s:
        for cl in x.get('calls',[]):
            d=cl.get('dur',0) or 0
            if d<20000 and cl['name']=='Bash' and re.search(r'\b(until|while)\b[^\n]{0,200}\bsleep\b',cl['inp']): n+=1;t+=d;to+=d>=590
print(f'\n## hand-rolled poll loops: {n} calls, {t/3600:.1f} h, {to} hit the ~600 s timeout')
# turns: wall split and delegation
tl=[];inv=0;invd=0;dt=0;big=0
for s in S.values():
    turns=collections.defaultdict(list);pr={}
    for x in s: (turns[x['turn']].append(x) if x['kind']=='step' else pr.__setitem__(x['turn'],x))
    for t_,st in turns.items():
        g=c=n_=0;prev=None;ro=mx=0;dl=0
        for x in st:
            if prev and prev.get('res_ts'): g+=max(0,x['ts']-prev['res_ts'])
            for cl in x['calls']:
                c+=cl.get('dur',0) or 0;n_+=1
                if cl['c']=='subagent-inproc' or (cl['c']=='subchat' and 'agent new' in cl['inp']): dl+=1
            if x['calls']:
                ro=ro+1 if all(cl['ro'] for cl in x['calls']) else 0; mx=max(mx,ro); prev=x
        if t_ in pr and st: tl.append((st[-1].get('res_ts',st[-1]['last_ts'])-pr[t_]['ts'],g,c,n_))
        if mx>=8: inv+=1; invd+=dl>0
        dt+=dl>0; big+= (dl==0 and n_>=10)
print('\n## turn wall split')
for lo,hi in [(0,60),(60,300),(300,1200),(1200,1e9)]:
    T=[x for x in tl if lo<=x[0]<hi]
    print(f' {lo}-{int(min(hi,99999))}s: n {len(T)} model {100*sum(x[1] for x in T)/sum(x[0] for x in T):.0f}% commands {100*sum(x[2] for x in T)/sum(x[0] for x in T):.0f}% median calls {sorted(x[3] for x in T)[len(T)//2]}')
print(f'\n## delegation: turns that delegated {dt}; turns with >=10 calls and no delegation {big}; turns with a read-only streak >=8 steps {inv}, of which delegated {invd}')
