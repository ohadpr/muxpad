# Sub-chat spawn -> report latency: pair each `muxpad agent new` call's printed
# pane/tab ULIDs with the first <muxpad-delivery>/<muxpad-report> naming them.
import json,re,sys
from datetime import datetime
U=re.compile(r'01[0-9A-HJKMNP-TV-Z]{24}')
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
lat=[]
for f in sys.argv[1:]:
    spawn={}; newids={}; seen=set()
    for l in open(f):
        d=json.loads(l)
        if d.get('uuid') in seen: continue
        seen.add(d.get('uuid'))
        if d.get('type')=='assistant':
            for b in (d['message'].get('content') or []):
                if isinstance(b,dict) and b.get('type')=='tool_use' and 'muxpad agent new' in json.dumps(b.get('input')): newids[b['id']]=ts(d['timestamp'])
        elif d.get('type')=='user':
            c=d['message'].get('content')
            if isinstance(c,list):
                for b in c:
                    if isinstance(b,dict) and b.get('type')=='tool_result' and b.get('tool_use_id') in newids:
                        for u in U.findall(json.dumps(b.get('content'))): spawn.setdefault(u,newids[b['tool_use_id']])
            txt=c if isinstance(c,str) else json.dumps(c)
            if '<muxpad-delivery' in txt[:3000] or '<muxpad-report' in txt[:3000]:
                T=ts(d['timestamp'])
                for u in set(U.findall(txt)):
                    if u in spawn and T>spawn[u]: lat.append(T-spawn.pop(u))
lat.sort(); n=len(lat)
print('n',n,'p25 %.0f p50 %.0f p75 %.0f p90 %.0f s'%(lat[n//4],lat[n//2],lat[3*n//4],lat[9*n//10]))
