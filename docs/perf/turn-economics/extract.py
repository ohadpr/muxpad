# Usage: extract.py <session.jsonl> <out.json>
# Streams one Claude Code transcript and emits one record per model STEP
# (one API response = one message.id) inside a user TURN.
import json,sys,re
from datetime import datetime
src,out=sys.argv[1],sys.argv[2]
TOK=re.compile(r'[A-Za-z0-9_][A-Za-z0-9_./-]{5,}|(?<![A-Za-z0-9])\d{2,}(?![0-9])')
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
def text_of(c):
    if isinstance(c,str): return c
    if isinstance(c,list): return ' '.join(text_of(b.get('text') or b.get('content') or '') if isinstance(b,dict) else str(b) for b in c)
    return ''
def cls(name,inp):
    if name=='Bash':
        s=inp.get('command','')
        h=s.strip()
        for k,p in [('test',r'vitest|\bpnpm\b[^|;&]*\btest\b|node --test|pytest|jest\b'),
                    ('build',r'\bbuild\b|\btsc\b|typecheck|biome'),
                    ('browser',r'playwright|chromium|connectOverCDP|puppeteer|screenshot|page\.goto'),
                    ('subchat',r'muxpad agent (new|send|wait)'),
                    ('muxpad',r'(^|[;&|(]\s*)muxpad\b|\$MUXPAD_BIN'),
                    ('git',r'(^|[;&|]\s*)git '),
                    ('http',r'\bcurl\b|\bwget\b'),
                    ('sleep',r'(^|[;&]\s*)sleep \d'),
                    ('edit',r'sed -i|perl -[a-z]*i|cat >|<<\s*[\'"]?EOF|\btee\b'),
                    ('read',r'^(cat|sed -n|head|tail|nl|less|awk)\b'),
                    ('search',r'^(grep|rg|find|ls|wc|jq|tree|du|stat|file)\b'),
                    ('script',r'^(python3?|node|npx|tsx)\b')]:
            if re.search(p,h): return k
        if re.search(r'\b(grep|rg)\b',h): return 'search'
        if re.search(r'\b(cat|sed -n|head|tail)\b',h): return 'read'
        return 'bash-other'
    if name=='Read': return 'read'
    if name in ('Grep','Glob','LS'): return 'search'
    if name in ('Edit','Write','MultiEdit','NotebookEdit'): return 'edit'
    if name.startswith('mcp__playwright'): return 'browser'
    if name in ('Agent','Task'): return 'subagent-inproc'
    if name.startswith('mcp__muxpad__'): return 'muxpad-voice'
    if name in ('TodoWrite','ToolSearch','Skill'): return 'meta'
    if name in ('WebSearch','WebFetch'): return 'web'
    return 'other:'+name
READONLY={'read','search'}
def ro(name,inp,c):
    if c in READONLY: return True
    if c=='git' and re.match(r'\s*git (log|show|diff|status|grep|branch|blame|rev-parse)',inp.get('command','')): return True
    if c=='muxpad' and re.search(r'muxpad (pane (list|read)|agent (list|transcript)|search|cron (list|show)|card (get|list)|app list)',inp.get('command','')): return True
    return False
seen_uuid=set();seen_tool=set();steps=[];cur=None;turn=-1;known=set();calls={};pending={};
def flush():
    global cur
    if cur: steps.append(cur)
    cur=None
for line in open(src):
    try: d=json.loads(line)
    except: continue
    t=d.get('type'); 
    if d.get('isSidechain') or d.get('isMeta'): continue
    u_=d.get('uuid')
    if u_ in seen_uuid: continue
    seen_uuid.add(u_)
    if t not in('user','assistant') or 'timestamp' not in d: continue
    T=ts(d['timestamp']); m=d.get('message') or {}; c=m.get('content')
    if t=='user':
        trs=[b for b in c if isinstance(b,dict) and b.get('type')=='tool_result'] if isinstance(c,list) else []
        if trs:
            for b in trs:
                i=b.get('tool_use_id'); 
                if i in calls and 'dur' not in next((c for c in calls[i]['calls'] if c['id']==i),{}):
                    st=calls[i]; st['res_ts']=max(st.get('res_ts',0),T)
                    for cl in st['calls']:
                        if cl['id']==i: cl['dur']=T-cl['ts']; cl['rlen']=len(text_of(b.get('content')))
                    st.setdefault('rtok',set()).update(TOK.findall(text_of(b.get('content'))[:200000]))
        else:
            flush(); turn+=1; known=set(TOK.findall(text_of(c)[:200000]))
            steps.append({'kind':'prompt','turn':turn,'ts':T,'len':len(text_of(c))})
        continue
    mid=m.get('id'); 
    if m.get('model')=='<synthetic>': continue
    if not cur or cur['mid']!=mid:
        flush(); cur={'kind':'step','mid':mid,'turn':turn,'ts':T,'calls':[],'ctx':0,'out':0}
        # dependency test against the PREVIOUS step's results
    u=m.get('usage') or {}
    cur['ctx']=max(cur['ctx'],(u.get('input_tokens') or 0)+(u.get('cache_read_input_tokens') or 0)+(u.get('cache_creation_input_tokens') or 0))
    cur['out']=max(cur['out'],u.get('output_tokens') or 0)
    cur['last_ts']=T
    for b in c if isinstance(c,list) else []:
        if b.get('type')=='tool_use':
            if b.get('id') in seen_tool: continue
            seen_tool.add(b.get('id'))
            inp=b.get('input') or {}; k=cls(b.get('name',''),inp)
            s=json.dumps(inp)[:4000]
            cl={'id':b.get('id'),'name':b.get('name'),'c':k,'ro':ro(b.get('name',''),inp,k),'ts':T,'inp':(s if k in ('browser','subchat','sleep') else s[:300]),'itok':list(set(TOK.findall(s)))}
            cur['calls'].append(cl); calls[b.get('id')]=cur
flush()
# second pass: dependency test, turn by turn
known=set(); batch_new=None; out=[]
for st in steps:
    if st['kind']=='prompt':
        known=set(); batch_new=None; out.append(st); continue
    st.pop('mid',None)
    itok=set(x for cl in st['calls'] for x in cl['itok'])
    allro=bool(st['calls']) and all(cl['ro'] for cl in st['calls'])
    st['indep']=False
    if allro and batch_new is not None:
        dep=itok & (batch_new-known)
        st['indep']=not dep
    rt=st.pop('rtok',set())
    if allro:
        if st['indep']: batch_new|=rt
        else:
            known|= (batch_new or set()); batch_new=set(rt)
    else:
        known|=(batch_new or set())|rt; batch_new=None
    known|=itok
    for cl in st['calls']: cl.pop('itok',None)
    out.append(st)
json.dump(out,open(out,'w') if False else open(sys.argv[2],'w'))
print(src.split('/')[-1][:8],'steps',sum(1 for s in out if s['kind']=='step'),'turns',turn+1)
