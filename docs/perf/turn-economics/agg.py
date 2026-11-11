import json,glob,statistics as S,collections,re,math
def q(xs,p):
    xs=sorted(xs); 
    return xs[min(len(xs)-1,int(p*len(xs)))] if xs else float('nan')
def spearman(a,b):
    def rk(x):
        o=sorted(range(len(x)),key=lambda i:x[i]); r=[0]*len(x)
        for j,i in enumerate(o): r[i]=j
        return r
    ra,rb=rk(a),rk(b); n=len(a); ma=sum(ra)/n; mb=sum(rb)/n
    cov=sum((x-ma)*(y-mb) for x,y in zip(ra,rb)); va=sum((x-ma)**2 for x in ra); vb=sum((y-mb)**2 for y in rb)
    return cov/math.sqrt(va*vb)
ALL=collections.defaultdict(list)
rows=[]
for f in sorted(glob.glob('s_*.json')):
    if f=='s_2ded.json': continue
    s=json.load(open(f)); sid=f[2:10]
    turns=collections.defaultdict(list); prompts={}
    for x in s:
        if x['kind']=='prompt': prompts[x['turn']]=x
        else: turns[x['turn']].append(x)
    G=[];C=[];first=[];cpt=[];twall=[];ctxg=[];cls=collections.Counter();clsdur=collections.defaultdict(float);tiny=collections.Counter()
    indepN=0;indepS=0;steps_with_calls=0;par=0;br=[];deleg=0;inproc=0;turns_deleg=0;turns_big_self=0
    for t,st in turns.items():
        n=sum(len(x['calls']) for x in st); 
        if n==0 and t not in prompts: continue
        cpt.append(n)
        if st and t in prompts: 
            twall.append((st[-1].get('res_ts',st[-1]['last_ts']))-prompts[t]['ts'])
            first.append(st[0]['ts']-prompts[t]['ts'])
        prev=None; d=0; idx=0
        for x in st:
            if prev is not None and prev.get('res_ts'):
                g=x['ts']-prev['res_ts']
                if 0<=g<900:
                    G.append(g); ctxg.append((g,x['ctx'],x['out'],idx,x))
                    if x.get('indep'): indepN+=1; indepS+=g
            if x['calls']:
                steps_with_calls+=1; idx+=1
                if len(x['calls'])>1: par+=1
                for cl in x['calls']:
                    k=cl['c']; cls[k]+=1; du=cl.get('dur',0) or 0; clsdur[k]+=du
                    if du<1: tiny[k]+=1
                    C.append(du)
                    if k=='browser': br.append(cl)
                    if k=='subchat' and 'agent new' in cl['inp']: deleg+=1; d+=1
                    if k=='subagent-inproc': inproc+=1; d+=1
            prev=x if x['calls'] else prev
        if d: turns_deleg+=1
        elif n>=10: turns_big_self+=1
    ncalls=sum(cls.values())
    r=dict(sid=sid,turns=len(cpt),calls=ncalls,steps=steps_with_calls,par_steps=par,
      cpt_p50=q(cpt,.5),cpt_p90=q(cpt,.9),cpt_max=max(cpt) if cpt else 0,
      gap_p10=q(G,.1),gap_p50=q(G,.5),gap_p90=q(G,.9),gap_mean=S.mean(G) if G else 0,gap_total_h=sum(G)/3600,
      cmd_p50=q(C,.5),cmd_p90=q(C,.9),cmd_total_h=sum(C)/3600,
      tiny=sum(tiny.values()),indepN=indepN,indepS_h=indepS/3600,
      deleg=deleg,inproc=inproc,turns_deleg=turns_deleg,turns_big_self=turns_big_self,
      rho_ctx=spearman([c[1] for c in ctxg],[c[0] for c in ctxg]) if len(ctxg)>10 else None,
      rho_out=spearman([c[2] for c in ctxg],[c[0] for c in ctxg]) if len(ctxg)>10 else None,
      rho_idx=spearman([c[3] for c in ctxg],[c[0] for c in ctxg]) if len(ctxg)>10 else None)
    rows.append(r)
    for k in cls: ALL['cls'].append((k,cls[k],clsdur[k],tiny[k]))
    ALL['cpt']+=cpt;ALL['G']+=G;ALL['C']+=C;ALL['ctxg']+=[(g,c,o,i) for g,c,o,i,_ in ctxg];ALL['br']+=[(sid,b) for b in br];ALL['first']+=first;ALL['twall']+=twall
json.dump(rows,open('rows.json','w'),indent=0)
hdr=['sid','turns','calls','steps','par_steps','cpt_p50','cpt_p90','cpt_max','gap_p10','gap_p50','gap_p90','gap_mean','gap_total_h','cmd_p50','cmd_p90','cmd_total_h','tiny','indepN','indepS_h','deleg','inproc','turns_deleg','turns_big_self','rho_ctx','rho_out','rho_idx']
print('\t'.join(hdr))
for r in rows: print('\t'.join(f'{r[h]:.2f}' if isinstance(r[h],float) else str(r[h]) for h in hdr))
print('\n== calls/turn histogram (all sessions)')
cpt=ALL['cpt']; 
for lo,hi in [(0,0),(1,2),(3,5),(6,10),(11,20),(21,50),(51,100),(101,10**6)]:
    n=sum(1 for c in cpt if lo<=c<=hi); calls=sum(c for c in cpt if lo<=c<=hi)
    print(f'{lo}-{hi}\tturns {n}\tcalls {calls}')
G=ALL['G'];C=ALL['C']
print('\n== gap (result->next step) all: n',len(G),'p10 %.1f p25 %.1f p50 %.1f p75 %.1f p90 %.1f p99 %.1f mean %.1f total h %.1f'%(q(G,.1),q(G,.25),q(G,.5),q(G,.75),q(G,.9),q(G,.99),S.mean(G),sum(G)/3600))
print('== command all: n',len(C),'p50 %.2f p75 %.2f p90 %.1f p99 %.1f mean %.1f total h %.1f'%(q(C,.5),q(C,.75),q(C,.9),q(C,.99),S.mean(C),sum(C)/3600))
print('   share of commands <1s: %.0f%%, <0.1s: %.0f%%; time in cmds >60s: %.1f h'%(100*sum(c<1 for c in C)/len(C),100*sum(c<.1 for c in C)/len(C),sum(c for c in C if c>60)/3600))
print('== first-response latency (prompt->first step) p50 %.1f p90 %.1f'%(q(ALL['first'],.5),q(ALL['first'],.9)))
print('== turn wall p50 %.0f p90 %.0f p99 %.0f s'%(q(ALL['twall'],.5),q(ALL['twall'],.9),q(ALL['twall'],.99)))
agg=collections.defaultdict(lambda:[0,0.0,0])
for k,n,d,t in ALL['cls']: a=agg[k]; a[0]+=n;a[1]+=d;a[2]+=t
print('\n== classes: calls, tiny(<1s), cmd hours')
for k,(n,d,t) in sorted(agg.items(),key=lambda x:-x[1][0])[:22]: print(f'{k:22s}{n:7d}{t:7d}{d/3600:8.2f}')
cg=ALL['ctxg']
print('\n== gap median by context size bucket (tokens)')
for lo,hi in [(0,50e3),(50e3,100e3),(100e3,150e3),(150e3,200e3),(200e3,300e3),(300e3,1e9)]:
    g=[x[0] for x in cg if lo<=x[1]<hi]; 
    if g: print(f'{int(lo/1e3)}-{int(min(hi,1e6)/1e3)}k\tn {len(g)}\tp50 {q(g,.5):.1f}\tp90 {q(g,.9):.1f}\tmean {S.mean(g):.1f}')
print('== gap median by output tokens of the step')
for lo,hi in [(0,100),(100,300),(300,1000),(1000,3000),(3000,1e9)]:
    g=[x[0] for x in cg if lo<=x[2]<hi]
    if g: print(f'{lo}-{hi}\tn {len(g)}\tp50 {q(g,.5):.1f}\tp90 {q(g,.9):.1f}')
print('== gap median by step index in turn')
for lo,hi in [(0,5),(5,20),(20,50),(50,100),(100,1e9)]:
    g=[x[0] for x in cg if lo<=x[3]<hi]
    if g: print(f'{lo}-{hi}\tn {len(g)}\tp50 {q(g,.5):.1f}')
print('rho(gap,ctx) all %.3f  rho(gap,out) all %.3f'%(spearman([x[1] for x in cg],[x[0] for x in cg]),spearman([x[2] for x in cg],[x[0] for x in cg])))
json.dump(ALL['br'],open('browser.json','w'))
